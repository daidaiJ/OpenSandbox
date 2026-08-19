# Pod 生命周期钩子 Cookbook（preStart / postStop）

在 BatchSandbox `taskTemplate` 上配置 `preStart` / `postStop`，于 task 启停时在沙箱侧执行初始化或清理。

**前提**

| 项 | 约定 |
|---|---|
| 部署 | 池化；钩子写在 BatchSandbox，不在 Pool |
| 访问 | 经 proxy；proxy **不**触发钩子 |
| 生命周期 | 申请 → 使用 → 释放；不使用 pause/resume |

触发链：控制器根据 CR 下发 Task → task-executor Start/Stop → 执行钩子。

当前 `POST /sandboxes` 无 lifecycle 字段；经 API 创建的沙箱默认无钩子。手写 CR 可用；对外暴露见 §1。

## 目录

- [1. 规划：server API 暴露 postStop（未落地）](#1-规划server-api-暴露-poststop未落地)
- [2. 钩子行为](#2-钩子行为)
- [3. execMode](#3-execmode)
- [4. 启停顺序与失败语义](#4-启停顺序与失败语义)
- [5. 手写 BatchSandbox CR](#5-手写-batchsandbox-cr)
- [6. 能力对照](#6-能力对照)
- [参考](#参考)

---

## 1. 规划：server API 暴露 postStop（未落地）

> **规划（未落地）**：以下为后续改动将支持的能力，当前 `POST /sandboxes` 尚不支持 `lifecycle`。控制器与 task-executor 已支持钩子；缺口在 API → 写入 CR。落地后，业务方即可通过 API 直接配置释放回调，无需手写 CR。

### 1.1 建议请求体

```json
POST /sandboxes
{
  "extensions": { "poolRef": "my-pool" },
  "env": { "OSB_USER_ID": "u1" },
  "timeout": 600,
  "lifecycle": {
    "postStop": {
      "command": ["/bin/sh", "-c", "curl -s -X POST http://callback.example.com/released -d '{\"userId\":\"u1\"}' || true"],
      "execMode": "Remote",
      "timeoutSeconds": 30
    }
  }
}
```

可选同形支持 `lifecycle.preStart`。动态参数由调用方写入 `command`，或由 server 做占位符替换；不要假设钩子能读 `env`。

主容器执行固定推荐 `execMode: "Remote"`；Pool 须配置 `SANDBOX_MAIN_CONTAINER`；`timeoutSeconds` 建议必填（例如 1–300）。

### 1.2 API → CR

| API | BatchSandbox CR |
|---|---|
| `lifecycle.postStop.command` | `spec.taskTemplate.spec.process.lifecycle.postStop.exec.command` |
| `lifecycle.postStop.execMode` | `...postStop.execMode` |
| `lifecycle.postStop.timeoutSeconds` | `...postStop.timeoutSeconds` |

### 1.3 改造清单

**契约**

| 项 | 内容 |
|---|---|
| `specs/sandbox-lifecycle.yml` | `CreateSandboxRequest` 增加可选 `lifecycle` |
| 示例 | 池化 + `postStop` + `execMode: Remote` |
| 兼容 | 省略 = 现状（无钩子） |

**Server**

| 项 | 内容 |
|---|---|
| `api/schema.py` | hook 模型与校验（command 非空、execMode 枚举、timeout 范围） |
| `_build_task_template` | 写入 `process.lifecycle` |
| `needs_task_template` | 有 lifecycle 时必须生成 taskTemplate（禁止快路径丢钩子） |
| 校验提示 | Remote 依赖 Pool 的 `SANDBOX_MAIN_CONTAINER` |

**通常不必改**：控制器 `convertLifecycle`、task-executor 钩子执行（含 Remote nsenter）。

**建议同步**：SDK / CLI、Pool 样板与运维文档、`_build_task_template` 单测与 e2e（API create → delete → Remote postStop）。

### 1.4 产品约定

1. `postStop` 在删除 / 到期停 task 时跑，不在 proxy 访问时跑
2. 失败默认报 `PostStopHookFailed`；回调场景可约定命令 `|| true`
3. 仅配 lifecycle、不改 entrypoint 时，仍不能走池化快路径
4. 少把长期 token 拼进 command；可用「主进程写脚本 + postStop 只执行脚本」

建议落地顺序：Spec + schema + `_build_task_template`（先 postStop）→ 池化 e2e → SDK → 可选 preStart / 占位符。

---

## 2. 钩子行为

| 钩子 | 时机 | 用途 |
|---|---|---|
| `preStart` | 主进程启动前 | 初始化、就绪回调 |
| `postStop` | 主进程停止后 | 清理、释放回调 |

顺序：`preStart` → 主进程 → `postStop`。

```text
BatchSandbox.spec.taskTemplate.spec.process.lifecycle
        ↓
控制器生成 Task（含 lifecycle）并下发
        ↓
task-executor Start / Stop
        ↓
执行 preStart / postStop
```

| 事件 | 是否跑钩子 |
|---|---|
| `/sandboxes/{id}/proxy/{port}` | 否（可续约，不跑钩子） |
| `DELETE` / 到期 / 停 task | 是（Stop → `postStop`） |

### 2.1 配置位置

| 层级 | 行为 |
|---|---|
| Pool | 仅 pod 模板；无 taskTemplate / lifecycle |
| BatchSandbox | `lifecycle` 可选；`execMode` 默认 `Local` |
| 控制器 | 不注入缺省钩子，只读 CR |
| server `_build_task_template` | 当前只写 `command` + `env` |

每个沙箱须在自身 `taskTemplate` 中显式配置。

### 2.2 经 server API

| 路径 | 结果 |
|---|---|
| `POST /sandboxes` / SDK / CLI | 写不进 lifecycle |
| 直接创建/修改 BatchSandbox | 可用 |
| `extensions` 透传 | 不会变成 lifecycle |

---

## 3. execMode

| ExecMode | 执行位置 | 主容器文件系统 / 进程 / 网络 |
|---|---|---|
| `Local`（默认） | task-executor 侧 | 否（除非共享卷） |
| `Remote` | nsenter 进主容器 | 是 |

主容器内操作：

```yaml
execMode: Remote
timeoutSeconds: 30
```

Pool 容器 env 须含 `SANDBOX_MAIN_CONTAINER`（官方 sample 值为 `main`）。缺失则 Remote 找不到目标 PID。

环境变量：

- `Local`：继承 executor 的 `os.Environ()`，不继承 task `process.env`
- `Remote`：继承主容器进程环境，仍不是 create 注入的 `process.env`
- 会话参数：写入钩子 `command` 字符串；不要依赖钩子读取 `env`

---

## 4. 启停顺序与失败语义

### 4.1 启动

```text
create（poolRef + 可选 env/entrypoint/lifecycle）
  → 写入 BatchSandbox（API 路径当前无 lifecycle）
  → 分配预热 pod
  → task-executor Start
       ① preStart
       ② 主进程（bootstrap.sh + entrypoint；process.env 在此生效）
  → Ready；业务经 proxy 使用
```

### 4.2 停止

```text
DELETE / 到期 / 停 task
  → 控制器 Stop
       ① 停主进程
       ② postStop
```

### 4.3 preStart 与 env

`process.env` 仅作用于主进程。preStart 在主进程之前，且不继承 `process.env`。

把 `userId` / `sandboxId` / 回调 URL 渲染进 `preStart.command`，或放到主进程 / `postStop`。不要在 preStart 依赖主进程才写入的文件。

### 4.4 超时与失败

| 项 | 行为 |
|---|---|
| `timeoutSeconds` | 建议设置；超时 SIGKILL 进程组。省略则无超时 |
| 重试 | 无；失败即失败（命令内可自行 `curl --retry` / `\|\| true`） |
| 非 0 退出 | 失败；输出前 8KiB + 后 8KiB |
| `preStart` 失败 | 主进程不启动（`PreStartHookFailed`） |
| `postStop` 失败 | 主进程已停，报 `PostStopHookFailed`（可能拖清理） |

回调类 `postStop` 若不希望挡住回收，命令末尾可用 `|| true`。

---

## 5. 手写 BatchSandbox CR

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: BatchSandbox
metadata:
  name: my-sandbox
  namespace: opensandbox
spec:
  replicas: 1
  poolRef: my-pool
  taskTemplate:
    spec:
      process:
        command: ["/bin/sh", "-c"]
        args:
          - |
            echo "main process started"
            while true; do sleep 1; done
        env:
          - name: OSB_USER_ID
            value: user-12345
        lifecycle:
          preStart:
            exec:
              command:
                - /bin/sh
                - -c
                - |
                  set -eu
                  curl -s -X POST http://callback.example.com/sandbox-ready \
                    -d '{"sandboxId":"my-sandbox","userId":"user-12345","status":"ready"}' || true
            execMode: Remote
            timeoutSeconds: 30
          postStop:
            exec:
              command:
                - /bin/sh
                - -c
                - |
                  set -eu
                  curl -s -X POST http://callback.example.com/sandbox-released \
                    -d '{"sandboxId":"my-sandbox","userId":"user-12345","status":"released"}' || true
            execMode: Remote
            timeoutSeconds: 30
```

释放逻辑较长时：主进程把脚本写到主容器（如 `/workspace/release.sh`），`postStop`（Remote）执行该脚本。`preStart` 不能依赖主进程写入的文件。

| CR 字段 | 含义 | 当前 `POST /sandboxes` |
|---|---|---|
| `process.command` / `args` | 主进程 | ≈ `entrypoint`（server 包 bootstrap） |
| `process.env` | 主进程环境 | = `env` |
| `lifecycle.preStart` | 启动前钩子 | 无 |
| `lifecycle.postStop` | 停止后钩子 | 无 |
| `execMode` | Local / Remote | — |
| `timeoutSeconds` | 钩子限时 | — |

---

## 6. 能力对照

| 需求 | 机制 | 池化 | 经 API |
|---|---|---|---|
| 通知已就绪 | `preStart`（Remote） | 机制有 | 需 CR 或扩展 API |
| 通知已释放 | `postStop`（Remote） | 机制有 | 需 CR 或扩展 API |
| 申请时注入配置 | `env` / `entrypoint` | 有 | 有 |

API 未扩展前，释放回调可放在业务调用 `DELETE` 前后自行处理。

---

## 参考

| 路径 | 说明 |
|---|---|
| `kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go` | `ProcessLifecycle` / `LifecycleHandler` / `ExecMode` |
| `kubernetes/pkg/task-executor/types.go` | executor 侧类型 |
| `kubernetes/internal/task-executor/runtime/process.go` | `execLifecycleHook` |
| `kubernetes/internal/controller/strategy/task_scheduling_strategy_default.go` | `convertLifecycle` |
| `kubernetes/internal/controller/batchsandbox_controller.go` | 调度 / 删除时停 task |
| `server/opensandbox_server/services/k8s/batchsandbox_provider.py` | `_build_task_template`（当前无 lifecycle） |
| `kubernetes/config/samples/sandbox_v1alpha1_pool.yaml` | `SANDBOX_MAIN_CONTAINER` 样板 |
| `kubernetes/test/e2e/testdata/batchsandbox-with-host-copy-lifecycle.yaml` | CR 钩子示例 |
