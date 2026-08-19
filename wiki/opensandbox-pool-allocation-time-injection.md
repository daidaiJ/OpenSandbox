# 池化模式：分配时间点动态注入配置/脚本的技术调研

- 日期：2026-08-19
- 状态：调研
- 关联：`wiki/opensandbox-pooled-session-s3-sync-middleware.md`、`wiki/opensandbox-pool-template-update-and-allocation.md`、`wiki/opensandbox-sandbox-config-and-env-reference.md`

---

## 1. 背景与问题定义

### 1.1 场景

池化（`extensions.poolRef`）模式下，Pool 的 pod 是**预热的**（`Pool.spec.template` 提前创建好并保持运行）。当业务 `create` 一个池化沙箱时，server 从池里取到一个**已运行**的 pod，把它分配给这个 BatchSandbox。

**"动态注入"特指分配时间点**：从池取到预热 pod 之后、把沙箱交给用户之前，做初始化注入（写配置文件）和脚本调用（执行初始化命令）。

**接口定位（本调研的关键前提）**：下游业务侧在 **create 时传参**（`user_id` + `user_auth_token`），**server 在分配时自动注入**（业务侧不直接调 exec）。注入形式为**写文件 + 调用脚本**。该注入是 **taskTemplate 的补充**：taskTemplate 注入基础信息，本注入补充动态/敏感信息。

**关键结论（先给答案）**：因为**只要分配时注入**、且**业务侧 create 时传参、server 自动注入**，所以 **taskTemplate 命令注入完全够用，无需 k8s exec 接口**——taskTemplate 是 server 每次分配时生成的，create 时已知的 user_id + token 在生成时就能渲染进命令，执行天然发生在分配后（controller 3s 轮询下发到已分配 pod）。详见 §5.1b / §5.1c。

因此，本调研的"业务层面技术"站在**下游业务侧**的视角：下游业务侧除了调用你新增的 exec 接口之外，还有哪些方式能完成同样的"分配时写文件 + 调用脚本"注入。

### 1.2 核心约束：复用已建 pod，不重建

**必须复用 pool 已经建好的 pod，不能重新建 pod。** 这是池化模式分配时间点注入的根本约束，直接决定了哪些技术可用：

- 池化 pod 在分配前**已经存在并运行**（预热），分配时**不能重建 / 不能改 spec**
- 因此所有"创建时生效"的注入技术（initContainer、ConfigMap 预挂载、PVC 预挂载、bootstrap 预脚本、env 注入）**都无法在分配时对已存在的 pod 生效**——它们只在 pod 创建那一刻起作用
- 分配时能做的，只有**在运行中的容器内执行动作**（写文件 / 跑命令）

### 1.3 目标

调研在**分配时间点**（复用已建 pod、不重建），**下游业务侧 create 时传参、server 自动注入**（`user_id` + `user_auth_token`，写文件 + 调用脚本）的场景下，除了"server 侧新增 k8s exec 接口"之外，还有哪些**业务层面**的技术能完成同样的注入，并给出对比与推荐。**核心结论：只要分配时注入，taskTemplate 命令注入即可，无需 k8s exec。**

---

## 2. 分配时间点的完整流程（现状）

```
业务 create(poolRef, env?, entrypoint?)
  → server _create_workload_from_pool() 创建 BatchSandbox CR
      ├─ 有 env/自定义 entrypoint → spec.taskTemplate = _build_task_template(...)
      └─ 无 → 快路径（不注入，池 pod 继续跑自己的 warm entrypoint）
  → PoolReconciler 分配一个预热 pod 给该 BatchSandbox（alloc-status 注解）
  → BatchSandboxReconciler 通过 TaskScheduler 把 taskTemplate 下发到 pod 内 task-executor
  → task-executor 在 pod 内执行 bootstrap.sh <entrypoint>
  → server 等 pod Ready → 返回 create 成功
```

**关键代码**：
- `server/opensandbox_server/services/k8s/batchsandbox_provider.py` — `_create_workload_from_pool()` / `_build_task_template()`
- `kubernetes/internal/controller/pool_controller.go` — `PoolReconciler` 分配
- `kubernetes/internal/controller/batchsandbox_controller.go` — 任务调度
- `kubernetes/internal/scheduler/default_scheduler.go` — `TaskScheduler` 下发任务
- `kubernetes/internal/task-executor/` — pod 内执行守护进程

---

## 3. 分配时间点可用的注入技术（除 k8s exec 外）

> **筛选前提**：以下技术按"是否能在分配时对**已存在的 pod** 生效"筛选。凡只在 pod 创建时生效的（initContainer / ConfigMap 预挂载 / PVC 预挂载 / bootstrap 预脚本 / env 注入），**不满足"复用已建 pod"约束**，仅作对照列出。

| 技术 | 复用已建 pod | 注入文件 | 调用脚本 | 按会话动态 |
|---|---|---|---|---|
| **taskTemplate + task-executor** | ✅ | ❌（仅命令+env） | ✅ | ✅ |
| **lifecycle hooks（preStart/postStop）** | ✅ | ✅（命令可写） | ✅ | ❌ 静态 |
| **k8s exec（新增）** | ✅ | ✅ | ✅ | ✅ |
| bootstrap 预脚本 | ❌ 仅 pod 创建时 | ✅ | ✅ | ❌ |
| ConfigMap 挂载 | ❌ 需预挂载 | ✅ 静态 | ❌ | ❌ |
| initContainer | ❌ 仅 pod 创建时 | ✅ | ❌ | ❌ |
| PVC 预挂载 | ❌ 需预挂载 | ✅ 静态 | ❌ | ❌ |
| env 注入 | ❌ 仅 pod 创建时 | ❌ | ❌ | ❌ |

**真正满足"复用已建 pod + 分配时注入 + 调用脚本"的只有三类**：`taskTemplate + task-executor`、`lifecycle hooks`、`k8s exec`。下面逐一展开。

### 3.1 taskTemplate + task-executor（现有主路径）

**机制**：server 在创建 BatchSandbox 时，把用户 `entrypoint` + `env` 打包成 `spec.taskTemplate.process`，由 `TaskScheduler` 下发到 pod 内 task-executor（sidecar，HTTP 5758），task-executor 通过 `nsenter` 进入主容器执行 `bootstrap.sh <entrypoint>`。

**能注入**：命令 / 脚本（作为 entrypoint）/ 环境变量。
**不能注入**：任意文件内容（只能通过命令间接写文件）。

**代码**：
- `batchsandbox_provider.py:_build_task_template()` — 组 `command` + `env`
- `task-executor/runtime/process.go` — `Start()` 按 `ExecMode` 用 `nsenter` 进主容器执行

**局限**：
- 只能注入命令 + env，不能直接注入文件
- 无自定义 entrypoint/env 时走快路径，完全不注入（连 `OPENSANDBOX_ID` 都注入不了）

### 3.2 lifecycle hooks（preStart / postStop）

**机制**：task-executor 的 `Process.Lifecycle` 支持 `preStart` / `postStop` 钩子，通过 exec 在容器内执行命令（`process.go:execLifecycleHook`）。`preStart` 在任务启动前执行，`postStop` 在任务停止后执行。

**能注入**：任意命令（可写文件、跑脚本）。
**代码**：
- `kubernetes/pkg/task-executor/types.go` — `ProcessLifecycle` / `LifecycleHandler` / `ExecAction`
- `task-executor/runtime/process.go:execLifecycleHook()`
- `kubernetes/internal/controller/strategy/task_scheduling_strategy_default.go` — `convertLifecycle()`

**局限**：
- 钩子命令是**静态**写在 taskTemplate 里的，无法携带"按会话动态"的用户信息（如 S3 前缀）
- Local 钩子当前只继承 `os.Environ()`，**不继承** `process.env`（见 S3 同步文档 §2），所以不能靠"固定钩子 + 用户 env"区分多用户

### 3.3 bootstrap.sh 预脚本（EXECD_BOOTSTRAP_PRE_SCRIPT）

**机制**：`components/execd/bootstrap.sh` 支持 `EXECD_BOOTSTRAP_PRE_SCRIPT` 环境变量，在启动 execd 前 **source 一个用户脚本**（其 export 的变量传播给 execd 和后续命令）。

**能注入**：脚本（启动前 source）。
**代码**：`components/execd/bootstrap.sh`

**局限**：
- 脚本路径是**静态**的（env 指定），内容需预先放在容器里或由其他机制写入
- 在池化 pod 里，bootstrap 只在 pod 启动时跑一次，**不是每次分配都跑**——除非配合 taskTemplate 每次下发

### 3.4 EXECD_ENVS（env 文件注入）

**机制**：`components/execd/pkg/runtime/env.go` 从 `EXECD_ENVS` 指向的 `key=value` 文件合并注入子进程环境变量（默认 `/opt/opensandbox/.env`）。

**能注入**：环境变量（通过文件）。
**代码**：`components/execd/pkg/runtime/env.go` — `loadExtraEnvFromFile()`

**局限**：只注入 env，不注入文件/脚本；文件内容需预先放置。

### 3.5 ConfigMap 挂载（配置注入）

**机制**：把 ConfigMap 挂载到 pod 的卷，再通过 env 指向配置文件。OSEP-0018 硬化隔离配置即用此方式（`EXECD_ISOLATION_CONFIG` 指向挂载的 TOML）。

**能注入**：配置文件（静态）。
**代码**：
- `server/opensandbox_server/examples/e2e.batchsandbox-template.yaml` — ConfigMap 挂载样板
- `components/execd/pkg/isolation/config.go` — `LoadConfig()` 读 TOML

**局限**：
- **Pool 模式下 ConfigMap 必须在 Pool 模板里预先挂载**（pod 已存在，分配时无法新增挂载）
- 内容静态，无法按会话动态

### 3.6 initContainer 注入二进制/脚本

**机制**：Pool 模板用 initContainer 把 task-executor / execd 二进制和 `bootstrap.sh` 拷进共享卷 `/opt/opensandbox`。

**能注入**：可执行文件 / 脚本（创建时）。
**代码**：
- `kubernetes/config/samples/sandbox_v1alpha1_pool.yaml` — `task-executor-installer` / `execd-installer`
- `server/.../provider_common.py:_build_execd_init_container()`

**局限**：只在 pod 创建时跑一次，**不是每次分配**；内容静态。

### 3.7 PVC / 共享卷预挂载

**机制**：Pool 模式把共享 PVC 预挂在 `Pool.spec.template`，分配后直接读写。

**能注入**：共享数据 / 工作区（静态预挂载）。
**代码**：`docs/examples/kubernetes-pvc-volume-mount.md`

**局限**：卷内容静态预置；分配时无法新增挂载。

### 3.8 环境变量注入（server 固定契约）

**机制**：server 固定注入 `EXECD=/opt/opensandbox/execd`，用户 `env` 透传，`sandbox_id` 通过 label 传递。

**能注入**：环境变量。
**代码**：`provider_common.py:_build_main_container()`

**局限**：只注入 env；池化快路径下连 env 都注入不了。

---

## 4. 与 k8s exec 接口的对比

用户新增的 **server 侧 k8s exec 接口**：在分配时间点，通过 K8s `pods/exec` 子资源在**已运行的池化 pod 内**执行命令，写入配置文件 / 启动脚本。

**用户的具体方案（模板渲染 + exec 注入）**：
1. **模板**：server 代码里定义脚本/配置模板（如 `.osb-sync-out.sh` 模板），接受动态参数（如 `S3_USER_PREFIX`、`sessionId`）
2. **渲染**：server 用动态参数渲染模板，得到具体内容
3. **exec 注入**：通过 exec 命令把渲染后的内容写入容器文件（`cat > file <<'EOF' ... EOF`）
4. **调用**：执行脚本（`sh file`）

**需求拆解**：分配时间点实际需要**两个动作**——
1. **注入**：把脚本 / 配置文件写入容器（写文件）
2. **调用**：执行脚本 / 命令（跑起来）

**关键洞察：taskTemplate 也能做"模板渲染 + 动态参数注入"**。因为 server **每次分配时**生成 taskTemplate，生成时就知道动态参数，所以完全可以在 taskTemplate 的命令里渲染模板（`cat > file <<'EOF' ... EOF` 写文件 + `sh file` 调用）——**不需要 k8s exec**。lifecycle hooks 同理（taskTemplate 是 server 生成的，钩子命令也能带动态参数）。

**本场景（只要分配时注入 + create 传参 + server 自动注入）下的决定性结论**：动态参数（`user_id` + `user_auth_token`）在 **create 时已知**，且**只要分配时注入一次**——这正是 taskTemplate 的适用区间。**taskTemplate 命令注入即可，无需 k8s exec 接口。** k8s exec 只在需要"分配后才知道的信息"（pod IP、分配状态）或"运行中任意时刻注入"时才必要，本场景两者都不需要。

下表按"注入"与"调用"两个能力分别对比（含"复用已建 pod"约束）：

| 维度 | k8s exec 接口 | taskTemplate+executor | lifecycle hooks | bootstrap 预脚本 | ConfigMap |
|---|---|---|---|---|---|
| **复用已建 pod** | ✅ | ✅ | ✅ | ❌ 仅 pod 创建时 | ❌ 需预挂载 |
| 注入时机 | 分配时（任意时刻） | 分配时 | 任务启停时 | pod 启动时 | pod 创建时 |
| **注入**文件内容 | ✅ 直接写 | ✅ 命令可写（含动态参数） | ✅ 命令可写（含动态参数） | ✅ 脚本 | ✅ 静态 |
| **调用**脚本/命令 | ✅ 直接执行 | ✅ 执行 entrypoint | ✅ 执行钩子命令 | ✅ 启动时执行 | ❌ 只挂载不执行 |
| 注入+调用一体 | ✅ 一次 exec 完成 | ✅ 命令内可写+跑 | ✅ 钩子命令内可写+跑 | ✅ 脚本内可写+跑 | ❌ 需另配执行 |
| **模板渲染 + 动态参数** | ✅ | ✅（server 生成时渲染） | ✅（server 生成时渲染） | ❌ 静态 | ❌ 静态 |
| 业务侧 create 传参、server 自动注入 | ✅ | ✅（零新增） | ✅ | ❌ | ❌ |
| 需改 pod spec | ❌ 不需要 | ❌ 不需要 | ❌ 不需要 | ❌ 不需要 | ❌（但需预挂载） |
| 到期/销毁回写 | 需配合 postStop | 需配合 postStop | ✅ 天然 | ❌ | ❌ |
| 复杂度 | 中（需 exec 客户端） | 低（现有） | 低（现有） | 低 | 低 |

**关键结论**：在"**复用已建 pod、不重建**"的约束下，能同时覆盖"注入 + 调用 + 模板渲染动态参数"的，有 **k8s exec**、**taskTemplate+executor**、**lifecycle hooks** 三类。bootstrap 预脚本 / ConfigMap / initContainer / PVC 不满足复用约束。**其中 taskTemplate 是零新增、最贴合"分配时注入"的现成方案。**

**k8s exec 与 taskTemplate 的关键差异**：
- **taskTemplate / lifecycle hooks**：server 在**创建 BatchSandbox 时**渲染模板并生成命令。能带"创建时已知"的动态参数（如 `S3_USER_PREFIX`、`sessionId`）。
- **k8s exec**：在**pod 已分配后**注入。能带"分配后才知道"的信息（如 pod IP、分配状态、运行时探测结果），且注入时机更灵活（可在 Ready 后、返回前任意时刻）。
- 若你的动态参数在**创建时已知**（如 S3 前缀、sessionId），**taskTemplate 命令注入即可，无需 k8s exec**；只有需要"分配后才知道"的信息时才需要 k8s exec。

### 4.1 task 模板能否在"分配后"执行注入脚本？——能，但机制不同

**结论：能。** taskTemplate 的执行天然发生在"分配后"，因为它的执行由 controller 的 reconcile 循环驱动，而 reconcile 只有在 pod 被 Pool 分配后才会把 task 下发到 pod 内 task-executor。

**执行链路**（`kubernetes/internal/controller/batchsandbox_controller.go`）：
```
server 创建 BatchSandbox（含 taskTemplate）
  → BatchSandboxReconciler.reconcileTasks() 每 3s 轮询（DurationStore.Push 3s）
  → getTaskScheduler() 用 taskTemplate 生成 task specs
  → scheduleTasks() → TaskScheduler.Schedule() 把 task 下发到 pod 内 task-executor
  → task-executor 执行 task.process（先 preStart 钩子，再主命令）
```

**关键机制**：
- task 的 process 命令（或 preStart 钩子）里可以 `cat > file <<'EOF' ... EOF` 写文件 + `sh file` 调用——**这就是"分配后执行注入脚本"**
- task-executor 收到 task 后立即执行，pod 是 Pool 已分配的（已运行），所以天然是"分配后"

**三个关键限制**：
1. **task 是一次性的**：task 执行完（Succeed/Failed）就结束，不会重复执行。所以"分配后执行一次注入脚本"符合，但"多次/定时执行"不行。
2. **动态参数必须创建时已知**：taskTemplate 是 server 创建 BatchSandbox 时生成的，命令里只能带"创建时已知"的参数（如 S3 前缀、sessionId）。**无法携带"分配后才知道"的信息**（如 pod IP、分配状态）。
3. **执行时机是"分配后"而非精确"Ready 后"**：controller 每 3s 轮询，检测到 pod 分配后即下发 task，可能在 pod 完全 Ready 前就执行。若注入脚本依赖 pod 完全就绪，需在脚本内自检或改用 k8s exec（server 等 Ready 后再注入）。

**对比**：
| 维度 | taskTemplate（分配后执行） | k8s exec（分配后注入） |
|---|---|---|
| 执行时机 | controller 3s 轮询，分配后 | server 等 Ready 后，精确 |
| 动态参数 | 仅创建时已知 | 含分配后信息 |
| 重复执行 | ❌ 一次性 | ✅ 可多次 |
| 需新增接口 | 否 | 是 |
| 注入+调用 | ✅ 命令内写+跑 | ✅ 命令内写+跑 |

---

## 5. 推荐方案

### 5.1 主方案：模板渲染 + exec 注入（用户方案）

server 侧用代码定义模板，接受动态参数，渲染后通过 exec 命令注入到容器文件并调用：

```
create(poolRef, metadata.user_id?)
  → 建 BatchSandbox（poolRef + 固定 postStop 的 taskTemplate）
  → 等 pod Ready
  → 内部 pods/exec → 容器 task-executor：
       a. 模板渲染：server 用动态参数（S3_USER_PREFIX、sessionId）渲染 .osb-sync-out.sh 模板
       b. 注入：exec 命令 cat > /shared-workspace/.osb-sync-out.sh <<'EOF' ... EOF && chmod +x
       c. 调用：exec 命令后台启动 inbound restore（sh 脚本）
  → 返回 create 成功
delete / expireTime
  → 删 CR → finalizer → 固定 postStop 跑注入脚本 + 清盘 → 回池
```

- **模板**：server 代码定义（如 `.osb-sync-out.sh` 模板），接受动态参数
- **渲染**：server 用动态参数渲染模板
- **注入**：exec 命令写文件（`cat > file <<'EOF' ... EOF`）
- **调用**：exec 命令执行脚本（`sh file`）
- **回写**：固定 postStop（静态、与用户无关）
- 详见 `wiki/opensandbox-pooled-session-s3-sync-middleware.md`

> **注意**：k8s exec 的"注入 + 调用"是**一次 exec 调用**完成的——`pods/exec` 本身就是执行命令，命令里既能 `cat > file` 写文件，也能 `sh file` 跑脚本。所以"注入脚本 + 调用脚本"不需要两个独立接口，一个 exec 通道即可。

### 5.1b 替代方案：taskTemplate 命令注入（动态参数创建时已知时，可替代 k8s exec）

**关键**：如果动态参数在**创建 BatchSandbox 时已知**（如 `S3_USER_PREFIX`、`sessionId`），则**无需 k8s exec**——server 在 `_build_task_template()` 里直接渲染模板成命令，命令内 `cat > file <<'EOF' ... EOF` 写文件 + `sh file` 调用，由 task-executor 执行。

```
create(poolRef, metadata.user_id?)
  → server _build_task_template()：
       a. 模板渲染：用动态参数渲染脚本内容
       b. 生成命令：cat > /shared-workspace/.osb-sync-out.sh <<'EOF' ... EOF && chmod +x && sh ...
       c. 打包进 taskTemplate.process.command
  → 建 BatchSandbox（poolRef + taskTemplate）
  → TaskScheduler 下发 → task-executor 执行命令（写文件 + 调用）
  → 返回 create 成功
```

**对比**：
| 方案 | 模板渲染 | 动态参数 | 调用脚本 | 需新增接口 | 注入时机 |
|---|---|---|---|---|---|
| **k8s exec** | ✅ | ✅（含分配后信息） | ✅ | 是 | pod 分配后 |
| **taskTemplate 命令** | ✅ | ✅（创建时已知） | ✅ | 否 | 创建时 |
| lifecycle preStart | ✅ | ✅（创建时已知） | ✅ | 否 | 任务启动时 |

**结论**：
- 若动态参数**创建时已知**（S3 前缀、sessionId）→ **优先 taskTemplate 命令注入（零新增）**，无需 k8s exec
- 若需要**分配后才知道**的信息（pod IP、分配状态、运行时探测）→ 才需要 **k8s exec**

### 5.1c 具体场景：用户申请 BatchSandbox 时带用户信息，注入进沙箱

**场景（最终确认）**：下游业务侧在 **create 时传参**（`user_id` + `user_auth_token`），**server 在分配时自动注入**（业务侧不直接调 exec），注入形式为**写文件 + 调用脚本**。**只要分配时注入一次**，不需要运行中任意时刻注入。

**关键判断**：用户信息在**创建 BatchSandbox 时已知**（来自请求的 `metadata` / `extensions` / 鉴权上下文），且**只要分配时注入**——所以**属于"创建时已知 + 分配时注入"场景，taskTemplate 命令注入即可，无需 k8s exec**。

**推荐落地（taskTemplate 命令注入，零新增）**：
```
下游业务 create(poolRef, metadata={user_id, user_auth_token})
  → server 解析用户信息
  → _build_task_template()：
       a. 模板渲染：用 user_id / user_auth_token 渲染脚本/配置内容
       b. 生成命令：cat > /shared-workspace/.osb-user-info.sh <<'EOF' ... EOF && chmod +x && sh ...
       c. 打包进 taskTemplate.process.command（同时可注入 env）
  → 建 BatchSandbox（poolRef + taskTemplate）
  → TaskScheduler 下发 → task-executor 执行命令（写文件 + 调用）
  → 返回 create 成功
```

**用户信息传递路径**（server 侧）：
- `metadata` / `extensions`：`create_workload()` 已接收 `extensions`，可扩展接收用户信息
- 鉴权上下文：从 API Key / JWT 推导（S3 同步文档 §9 提到）
- 当前 `_build_task_template()` 只注入 `env` + `OPENSANDBOX_ID`，**需扩展为"渲染用户信息到文件 + 调用"**

**两种注入方式对比**：
| 方式 | 说明 | 适用 |
|---|---|---|
| **env 注入** | 用户信息作为 env 传给 task 进程 | 业务进程直接读 env |
| **文件注入 + 调用** | 渲染用户信息到文件，再调用脚本 | 需要脚本/配置落盘，或供 postStop 回写用 |

**注意**：若用户信息需要**落盘成文件**（如 `.osb-sync-out.sh` 供 postStop 回写），则用"文件注入 + 调用"；若只是业务进程读，用 env 注入即可（更简单）。

**结论**：本场景**不需要新增 k8s exec 接口**。taskTemplate 命令注入（或 env 注入）在 create 时就能完成"写文件 + 调用脚本"，且天然在分配后执行。k8s exec 接口只有在需要"分配后才知道的信息"或"运行中任意时刻注入"时才必要——本场景两者都不需要。

### 5.1d 用户授权 token 的安全注入考量

`user_auth_token` 是**敏感凭证**，注入时需遵循 server 侧已有的安全模式（egress token / secure-access token / imagePullSecret 的处理）：

**可复用的安全模式**（server 侧已有）：
| 模式 | 现有实现 | 说明 |
|---|---|---|
| **env 注入 + annotation 传递** | egress token（`OPENSANDBOX_EGRESS_TOKEN` env + `opensandbox.io/egress-auth-token` annotation） | token 进容器 env，同时经 annotation 给 server 侧鉴权 |
| **K8s Secret** | imagePullSecret（`opensandbox-image-auth-{id}`） | 敏感凭证放 K8s Secret，容器通过 volume/envFrom 引用 |
| **execd 凭证黑名单** | `execdConfigEnvBlacklist`（`EXECD_ACCESS_TOKEN` 等） | execd 自身凭证不泄露给 workload |

**token 注入的安全要点**：
1. **不要打进 exec 命令行日志**：`pods/exec` / task-executor 的命令会记日志，token 若在命令里会泄露。应通过 env 或文件注入，避免出现在命令行参数。
2. **文件注入时注意权限**：写 token 的文件应 `chmod 600`，避免同 pod 其他进程可读。
3. **区分"用户 token"与"execd 凭证"**：用户 token 是业务凭证，与 execd 的 `EXECD_ACCESS_TOKEN`（沙箱 API 访问凭证）不同，不要混用。
4. **token 生命周期**：token 有有效期，注入后若过期需刷新机制（可参考 OSEP-0009 自动续约思路）。

**推荐**：`user_id` 用 env 或文件注入（非敏感）；`user_auth_token` 用 **env 注入**（避免进命令行日志），或经 K8s Secret 挂载（更安全，但 Pool 模式需预挂载，分配时无法新增——所以**分配时注入 token 只能用 env / 文件**，无法用 Secret 挂载）。

### 5.2 可选演进：task-executor Local 钩子继承 process.env

若让 task-executor 的 Local 钩子继承 `process.env`，则"创建时只设 env + 固定 sync 脚本读 `$S3_USER_PREFIX`"即可，**去掉 exec 注入**，退化为纯钩子方案。这是 S3 同步文档 §8 提到的可选演进。

### 5.3 各技术适用场景速查（复用已建 pod 约束下）

| 需求 | 推荐技术 |
|---|---|
| 分配时注入用户命令/脚本（复用 pod） | taskTemplate + task-executor |
| 分配时**模板渲染 + 动态参数**注入 + 调用脚本（参数创建时已知） | taskTemplate 命令 / lifecycle preStart（零新增） |
| 分配时**模板渲染 + 动态参数**注入 + 调用脚本（参数分配后才知道） | **k8s exec** |
| 任务启停时执行固定动作（复用 pod） | lifecycle hooks（preStart/postStop） |
| 注入静态配置文件（仅 pod 创建时） | ConfigMap 预挂载 + env 指向 |
| 注入静态可执行文件（仅 pod 创建时） | initContainer |
| 注入共享数据/工作区（仅 pod 创建时） | PVC 预挂载 |
| 注入环境变量（仅 pod 创建时） | env 透传 / EXECD_ENVS |

---

## 6. 参考代码位置

| 路径 | 说明 |
|---|---|
| `server/opensandbox_server/services/k8s/batchsandbox_provider.py` | 池化 create / `_build_task_template` |
| `kubernetes/internal/task-executor/runtime/process.go` | preStart/postStop；nsenter 执行 |
| `kubernetes/pkg/task-executor/types.go` | Process / Lifecycle / ExecAction 类型 |
| `kubernetes/internal/controller/strategy/task_scheduling_strategy_default.go` | taskTemplate → api.Task 转换 |
| `kubernetes/internal/scheduler/default_scheduler.go` | TaskScheduler 下发任务 |
| `kubernetes/internal/controller/recycle/restart/restart_default.go` | 已有 pods/exec 先例（SPDY） |
| `components/execd/bootstrap.sh` | EXECD_BOOTSTRAP_PRE_SCRIPT / EXECD_ENVS |
| `components/execd/pkg/runtime/env.go` | EXECD_ENVS env 文件注入 |
| `components/execd/pkg/isolation/config.go` | EXECD_ISOLATION_CONFIG TOML 注入 |
| `server/opensandbox_server/examples/e2e.batchsandbox-template.yaml` | ConfigMap 挂载样板 |
| `kubernetes/config/samples/sandbox_v1alpha1_pool.yaml` | Pool 模板 initContainer 注入 |
| `docs/examples/kubernetes-pvc-volume-mount.md` | Pool 模式 PVC 预挂载 |
