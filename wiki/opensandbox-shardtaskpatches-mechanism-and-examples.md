# shardTaskPatches 机制详解与示例

> 日期：2026-08-22
> 关联：`wiki/batchsandbox-task-3s-polling-exploration.md`（3s 轮询执行链路）、`wiki/opensandbox-create-sandbox-params-reference.md`（server 侧参数暴露情况）、`docs/kubernetes/index.md`（官方文档）
> 代码位置：`kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go`、`kubernetes/internal/controller/strategy/task_scheduling_strategy_default.go`、`kubernetes/pkg/task-executor/types.go`

---

## 1. 是什么

`shardTaskPatches` 是 `BatchSandbox` CR 上的一个字段，用于**按副本下标（index）对默认 `taskTemplate` 做差异化覆盖**，实现"批量创建 N 个沙箱、每个沙箱跑不同任务"的异构任务分发。

```yaml
spec:
  replicas: 3
  taskTemplate:            # 默认任务模板（所有副本的基线）
    spec:
      process:
        command: ["echo", "default"]
  shardTaskPatches:        # 按下标 0,1,2 对齐，逐个覆盖
  - spec:                  # → 副本 0 的任务
      process:
        command: ["echo", "shard-0"]
  - spec:                  # → 副本 1 的任务
      process:
        command: ["echo", "shard-1"]
  # 副本 2 没有对应 patch → 用默认 taskTemplate
```

**一句话**：`taskTemplate` 是批量任务的"公共基线"，`shardTaskPatches[i]` 是第 i 个副本的"个性化补丁"。

## 2. 机制原理

### 2.1 数据结构

```go
// batchsandbox_types.go
type BatchSandboxSpec struct {
    ...
    TaskTemplate *TaskTemplateSpec `json:"taskTemplate,omitempty"`       // 默认任务模板
    ShardTaskPatches []runtime.RawExtension `json:"shardTaskPatches,omitempty"` // 按下标对齐的补丁
    TaskResourcePolicyWhenCompleted *TaskResourcePolicy `json:"taskResourcePolicyWhenCompleted,omitempty"` // Retain(默认)/Release
}
```

- `ShardTaskPatches` 是 `[]runtime.RawExtension`（任意 JSON/YAML 片段），**Schemaless**，CRD 不校验内部结构，错误在合并时才暴露。
- 每个 patch 的结构与 `TaskTemplateSpec` 同构（`spec.process.{command,args,env,workingDir,execMode,lifecycle}` + `spec.timeoutSeconds`）。

### 2.2 合并算法（strategic merge patch）

`task_scheduling_strategy_default.go` 的 `getTaskSpec(idx)`：

```go
if len(s.Spec.ShardTaskPatches) > 0 && idx < len(s.Spec.ShardTaskPatches) {
    taskTemplate := s.Spec.TaskTemplate.DeepCopy()
    cloneBytes, _ := json.Marshal(taskTemplate)
    patch := s.Spec.ShardTaskPatches[idx]
    modified, err := strategicpatch.StrategicMergePatch(cloneBytes, patch.Raw, &sandboxv1alpha1.TaskTemplateSpec{})
    ...
    task.Process = convertProcessSpec(newTaskTemplate.Spec.Process, s.Spec.TaskTemplate.Spec.TimeoutSeconds)
} else if s.Spec.TaskTemplate != nil && s.Spec.TaskTemplate.Spec.Process != nil {
    task.Process = convertProcessSpec(s.Spec.TaskTemplate.Spec.Process, s.Spec.TaskTemplate.Spec.TimeoutSeconds)
}
```

关键语义：

| 规则 | 行为 |
|---|---|
| **下标对齐** | `ShardTaskPatches[i]` 只作用于第 i 个副本；`idx >= len(patches)` 的副本用基础 `taskTemplate` |
| **合并方式** | K8s `strategicpatch.StrategicMergePatch`，patch 合并到 taskTemplate 的**深拷贝**上，原模板不被修改 |
| **标量字段** | patch 中出现的字段覆盖模板值（如 `command`、`args`、`workingDir`） |
| **env 数组** | **按 `name` merge**（`+patchMergeKey=name`），同名 env 被 patch 覆盖，其余保留——不是整体替换 |
| **未 patch 字段** | 继承模板值 |
| **timeoutSeconds** | 取**基础模板**的 `TaskTemplate.Spec.TimeoutSeconds`（patch 里没有独立 timeout 字段） |
| **任务命名** | `task.Name = <BatchSandboxName>-<idx>` |

### 2.3 执行链路（与 3s 轮询的关系）

```
strategy.GenerateTaskSpecs()         策略层：每下标 i 生成 api.Task{Name: bsName-i}
  （ShardTaskPatches 做 strategic merge patch）
        │
        ▼
defaultTaskScheduler（控制器进程内纯内存）   调度层：一个 pod 只跑一个 task
  每 3s：refreshFreePods → collectTaskStatus(GET :5758/getTasks)
        → scheduleTaskNodes(POST :5758/setTasks)
        │
        ▼
pod 内 task-executor（:5758 HTTP server）  执行层
  taskManager（maxConcurrentTasks=1）
  500ms reconcileLoop：Inspect 进程、超时终止、preStart/postStop 钩子
  本地落盘 /var/lib/sandbox/tasks/<name>/{pid,exit,stdout,stderr}
        │
        ▼
controller 聚合（每 3s）              状态层
  status.taskRunning/taskSucceed/taskFailed/... → CR printcolumn
  taskResourcePolicyWhenCompleted=Release → 任务完成即释放 pod 回 Pool
```

> 详细轮询机制见 `wiki/batchsandbox-task-3s-polling-exploration.md`。

### 2.4 ExecMode（进程在哪跑）

| 模式 | 执行位置 | 适用 |
|---|---|---|
| `Local`（默认） | task-executor sidecar 容器内 | 任务与主容器解耦，不污染业务进程 |
| `Remote` | **主容器内**（nsenter 进入） | 需要访问主容器的文件系统/进程/网络栈 |

Pool 模板需 `shareProcessNamespace: true` + task-executor sidecar（端口 5758）才能用 Remote 模式。

## 3. 与 `shardPatches` 的区别

`BatchSandbox` 还有另一个 patch 字段 `shardPatches`，两者容易混淆：

| | `shardPatches` | `shardTaskPatches` |
|---|---|---|
| 作用对象 | **Pod 模板**（`spec.template`，容器镜像/资源/命令） | **任务模板**（`spec.taskTemplate`，任务进程） |
| 典型用途 | 每个沙箱用不同镜像/资源规格 | 每个沙箱跑不同任务/参数 |
| 合并方式 | 同样 strategic merge patch | 同样 strategic merge patch |

两者可同时使用：`shardPatches` 差异化"沙箱环境"，`shardTaskPatches` 差异化"沙箱里跑什么"。

## 4. 适用场景

### 4.1 异构任务批量分发（RL 训练 / 评测）

官方定位：*"high-throughput agentic-RL scenarios"*。一次创建 N 个沙箱，每个沙箱跑不同的 agent 环境/评测用例，`BatchSandbox` 批量交付 O(1)（100 个沙箱 0.92s），任务由控制器自动下发。

### 4.2 数据分片 / 参数扫描

一个大任务切成 N 片（按数据范围/参数组合），每片一个沙箱并行执行，天然隔离、互不干扰。

### 4.3 多用户差异化服务

每个用户一个沙箱，任务按用户不同（如不同租户的初始化脚本、不同模型的推理服务），`shardTaskPatches` 按下标注入用户差异。

### 4.4 A/B 测试 / 分支实验

同一代码库，不同副本跑不同版本/配置，结果对比。

### 4.5 与 Pool 结合：池化沙箱 + 按需任务

Pool 预热沙箱（无任务），`BatchSandbox` 分配时通过 `taskTemplate` + `shardTaskPatches` 注入任务——**server 的池化分配路径正是这么做的**（`_build_task_template` 每次分配时生成，见 `wiki/opensandbox-task-template-user-info-injection-example.md`）。

## 5. 完整示例

### 5.1 基础：默认任务 + 差异化 patch

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: BatchSandbox
metadata:
  name: shard-demo
  namespace: opensandbox
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: main
        image: ubuntu:latest
        command: ["sleep", "3600"]
      - name: task-executor          # 必须：任务执行 sidecar
        image: <task-executor-image>:<tag>
        securityContext:
          capabilities:
            add: ["SYS_PTRACE"]      # Remote 模式需要
  shareProcessNamespace: true        # Remote 模式需要
  taskTemplate:
    spec:
      process:
        command: ["echo", "default-task"]
        env:
        - name: REGION
          value: cn-hangzhou
  shardTaskPatches:
  - spec:                            # 副本 0：完全替换命令
      process:
        command: ["python", "-m", "http.server"]
        args: ["8080"]
  - spec:                            # 副本 1：只改 args + 追加 env（env 按 name merge）
      process:
        args: ["3600"]
        env:
        - name: REGION
          value: cn-shanghai          # 覆盖同名 env
        - name: SHARD_ID
          value: "1"                  # 新增 env
  # 副本 2：无 patch → 跑默认任务 echo default-task（REGION=cn-hangzhou）
```

最终三个副本的任务：

| 副本 | 任务 | env |
|---|---|---|
| 0 | `python -m http.server 8080` | REGION=cn-hangzhou |
| 1 | `echo 3600`（args 覆盖） | REGION=cn-shanghai, SHARD_ID=1 |
| 2 | `echo default-task` | REGION=cn-hangzhou |

### 5.2 参数扫描：同一命令不同参数

```yaml
spec:
  replicas: 4
  taskTemplate:
    spec:
      process:
        command: ["python", "train.py"]
        args: ["--epochs", "10"]
  shardTaskPatches:
  - spec: { process: { args: ["--epochs", "10", "--lr", "1e-3"] } }
  - spec: { process: { args: ["--epochs", "10", "--lr", "1e-4"] } }
  - spec: { process: { args: ["--epochs", "20", "--lr", "1e-3"] } }
  - spec: { process: { args: ["--epochs", "20", "--lr", "1e-4"] } }
```

### 5.3 任务完成即释放资源（配合 Pool）

```yaml
spec:
  replicas: 5
  poolRef: task-example-pool          # 从预热池分配
  taskResourcePolicyWhenCompleted: Release   # 任务完成 → pod 释放回 Pool
  taskTemplate:
    spec:
      process:
        command: ["/opt/opensandbox/bootstrap.sh"]
  shardTaskPatches:
  - spec: { process: { args: ["--case", "case-01"] } }
  - spec: { process: { args: ["--case", "case-02"] } }
  # ...
```

> `Release` 模式下任务完成即归还资源，适合"用完即焚"场景（见 `wiki/opensandbox-ephemeral-sandbox-orchestration-pattern.md`）；`Retain`（默认）保留 pod 直到 BatchSandbox 删除。

### 5.4 生命周期钩子差异化（preStart/postStop）

```yaml
spec:
  replicas: 2
  taskTemplate:
    spec:
      process:
        command: ["run-task"]
        lifecycle:
          preStart:
            exec: { command: ["/bin/sh", "-c", "prepare-inputs"] }
            timeoutSeconds: 30
          postStop:
            exec: { command: ["/bin/sh", "-c", "persist-outputs"] }
            timeoutSeconds: 30
  shardTaskPatches:
  - spec:
      process:
        lifecycle:
          postStop:                    # 副本 0 用不同的产物回写脚本
            exec: { command: ["/bin/sh", "-c", "persist-outputs --shard 0"] }
```

> `postStop` 在任务到达终态（成功/失败/超时/删除）时**必执行**，是"销毁前持久化产物"的官方钩子。

## 6. 注意事项与坑

1. **server 侧 API 不暴露 `shardTaskPatches`**：`opensandbox-create-sandbox-params-reference.md` 明确"server 侧没暴露"。只能**直接操作 CR**（kubectl apply / 自研 controller）。server 创建的沙箱走 `_build_task_template` 单任务模板路径，无 shard 能力。
2. **patch 数量与 replicas 不匹配**：
   - `len(patches) < replicas`：超出部分用基础 `taskTemplate`（静默，无告警）；
   - `len(patches) > replicas`：多余 patch 被忽略。
3. **env 是 merge 语义**：按 `name` 合并，同名覆盖、异名保留。想"清空 env"做不到（patch 无法删除模板中的 env 项）。
4. **timeoutSeconds 取基础模板**：patch 里没有独立 timeout 字段，差异化超时只能改 `taskTemplate.spec.timeoutSeconds`（全局生效）。
5. **patch 结构错误在合并时才报错**：`StrategicMergePatch` 失败会返回 `batchsandbox: failed to merge patch raw ...`，整个 `GenerateTaskSpecs` 失败，任务全部不下发。
6. **一个 pod 只跑一个 task**：task-executor `maxConcurrentTasks=1`，任务与 pod 一一对应。
7. **任务在控制器内存中**：无独立 CRD，控制器重启后任务状态从 pod 内 `/getTasks` 重新对账（3s 轮询），但进行中的任务可能中断。
8. **Remote 模式前置条件**：Pool/模板需 `shareProcessNamespace: true` + task-executor sidecar + `SYS_PTRACE` 能力，否则 nsenter 进不了主容器。
9. **池化模式注意**：Pool pod 是预热创建的，`shardTaskPatches` 只影响任务下发，不影响 pod 本身；pod 级差异化用 `shardPatches`（但池化分配不支持改 pod 模板，见 `wiki/opensandbox-pool-template-update-and-allocation.md`）。

## 7. 快速检索

| 想做什么 | 用什么 |
|---|---|
| 批量沙箱跑不同任务 | `shardTaskPatches`（按下标） |
| 批量沙箱用不同镜像/资源 | `shardPatches`（按下标，非池化） |
| 任务完成释放资源 | `taskResourcePolicyWhenCompleted: Release` |
| 任务前后执行钩子 | `process.lifecycle.preStart/postStop` |
| 任务在业务容器内执行 | `process.execMode: Remote`（需 shareProcessNamespace） |
| 查看任务状态 | `kubectl get batchsandbox`（TASK_RUNNING/SUCCEED/FAILED 列） |