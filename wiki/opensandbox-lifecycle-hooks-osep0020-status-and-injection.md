# OSEP-0020 沙箱生命周期钩子：实施状态与池模式注入路径

- 日期：2026-08-31（2026-09-01 增补 k3s 池模式注入实测）
- 状态：调研 + 池模式注入路径实测（基于 upstream/main @ `f91f153c`，dev 已合并至 `ebf776be`；server v0.2.3 / execd v1.1.0 / controller·task-executor latest ≥ #420）
- 关联：`wiki/opensandbox-pool-allocation-time-injection.md`（分配时注入技术对比）、`wiki/opensandbox-task-template-user-info-injection-example.md`（taskTemplate 注入实例）、`wiki/opensandbox-pool-capacity-params.md`（池容量参数）

---

## 1. 结论速览

| 问题 | 答案 |
|---|---|
| 沙箱生命周期钩子实现了吗 | **部分**。仅 phase 1-2 落地：create 时声明 `preStart` + `periodic`，由 execd 在沙箱内执行（server v0.2.3 / execd v1.1.0） |
| `PATCH /sandboxes/{id}/lifecycle` 实现了吗 | **没有**。spec 无该端点、server 无路由、execd 无 lifecycle API；属 phase 3 future |
| K8s 直建（非池）支持吗 | ✅ create 时 `lifecycle` 字段可用（K8s provider）；Docker 与 fleets 明确拒绝 |
| **K8s 池模式支持吗（server API）** | ❌ **不支持**。`lifecycle` + `poolRef` 组合在 API 校验层直接 400；池模式支持排在实施计划**最后一期**（phase 5） |
| **池模式手写 CR 直注实测** | ✅ **2026-09-01 k3s 双节点实测打通**：BatchSandbox `taskTemplate` env 注入 `OPENSANDBOX_LIFECYCLE` → execd v1.1.0 `periodic @every 30s` 五拍全中（文件 + HTTP 双证一致）；task-executor 层 `postStop` 自然退出/优雅删除两路径均触发（前提：controller·task-executor ≥ #420，见 §7 版本坑） |
| 池模式"申请后短时初始化"用什么 | `env` 注入（配置值）+ 自定义 `entrypoint` 包装初始化命令（Ready 前完成、失败即启动失败）；execd 钩子类初始化走手写 CR 直注（§7 R11 原型） |

## 2. OSEP-0020 概述

提案：`oseps/0020-sandbox-lifecycle-hooks.md`（status: implementing，2026-08-17 立项 / 08-26 更新）。

沙箱级生命周期钩子五种，声明在 `CreateSandboxRequest.lifecycle`：

| Hook | 执行通道 | 运行时 PATCH | 失败默认 | 触发时机 |
|---|---|---|---|---|
| `preStart` | execd 启动序列 | 否 | Abort | entrypoint 之前，每次启动（含 K8s resume） |
| `prePause` | orchestrated（server 触发 execd） | 是 | Abort | 暂停前（手动/idle/TTL） |
| `postResume` | orchestrated | 是 | Abort | resume 后、公开 Running 前 |
| `preTerminate` | signal-driven（execd 捕 SIGTERM） | 是 | Continue（固定） | Running 态被真实终止（delete/TTL/驱逐/docker stop） |
| `periodic[]` | execd 内置 cron | 是 | Continue（固定） | 运行期间按 cron 调度 |

**本版 API 只放行 `preStart` 和 `periodic`**（`specs/sandbox-lifecycle.yml` 明文），其余 hooks 属后续阶段。

## 3. 实施状态（分阶段核对）

OSEP-0020 "Phased rollout" 原文与代码核对结果：

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| 1 | execd：配置持久化 + `preStart`/`periodic` | ✅ 实测通过 | `components/execd/pkg/lifecycle/`（config/periodic/runner），execd v1.1.0（v1.0.x → v1.1.0 minor 跳版主因）；2026-09-01 池模式实测 periodic cron 间隔精确（`@every 30s` 五拍无漂移） |
| 2 | spec `CreateSandboxRequest.lifecycle` + SDK 再生成 + server create 传输 | ✅ | `specs/sandbox-lifecycle.yml`（LifecycleHook/PeriodicLifecycleHook schema）；server `create_helpers.py` env 注入；SDK models 已加 |
| 3 | `run`/`config`/`status` 端点、**PATCH**、其余 transition hooks | ❌ future | spec 无 `/sandboxes/{sandboxId}/lifecycle` 路径；`api/lifecycle.py` 仅 metadata PATCH；execd `pkg/web` 无 lifecycle API |
| 4 | Docker/K8s provider 编排（prePause/postResume/preTerminate）、grace 接线、E2E | ❌ future | — |
| 5 | **池模式支持**：经 `spec.taskTemplate` per-sandbox 注入（R11） | ❌ future（最后一期）；**R11 原型已实测可用** | `schema.py:572` 校验拒绝 lifecycle+poolRef（**仅 server API 层**）；手写 BatchSandbox CR 走 controller 链路不受此限，注入链路实测打通（§4/§7） |

## 4. 注入路径：复用现有 task/alloc 链路（R11 设计）

R11：**"Pool-mode: per-sandbox injection via the existing task/alloc path (`spec.taskTemplate`), never the shared Pool template"**——永不改共享 Pool 模板，per-sandbox 隔离。

链路（两端已实现并跑通，中间的 lifecycle 字段放开是将来时）：

```
create 请求 (poolRef + env/entrypoint)
   │
   ▼ server 侧
batchsandbox_provider._create_workload_from_pool()
   └─ 创建 BatchSandbox CR：
      spec.poolRef      → 池引用
      spec.taskTemplate = _build_task_template(entrypoint, env)
        ├─ process.command = shell-escaped bootstrap 命令（覆盖预热 entrypoint）
        ├─ process.env     = 请求 env + OPENSANDBOX_ID（将来 + OPENSANDBOX_LIFECYCLE）
        └─ EXECD_INIT=1    （execd_run_as_init 拓扑时）
   │
   ▼ controller 侧
BatchSandboxReconciler → poolassign 从 Pool 绑定预热 pod
TaskScheduler: NeedTaskScheduling = TaskTemplate != nil
   （strategy/task_scheduling_strategy_default.go；支持 ShardTaskPatches strategic-merge 叠加）
   │
   ▼ pod 内
scheduler 经 endpoints annotation 找到 task-executor（pod 内 HTTP server）
   └─ NewProcessExecutor 以注入 env 执行 bootstrap 命令（task shim 替代预热 entrypoint）
   │
   ▼ execd 消费（OSEP-0020 核心，2026-09-01 实测确认）
bootstrap.sh → execd 启动 → LoadConfig()
   → 注入 env 权威 → 校验 → 原子落盘 ~/.execd/lifecycle.toml（HOME=/root；可用 EXECD_LIFECYCLE_CONFIG 覆盖）→ unset 环境变量
   → 执行 preStart → 启动 entrypoint → Ready（periodic 由 execd 内置 cron 调度）
```

关键实现位置：

- server 端 taskTemplate 构建：`server/opensandbox_server/services/k8s/batchsandbox_provider.py` `_build_task_template()`（带 env/entrypoint/execd_run_as_init 任一即走 taskTemplate 路径；否则走"零修改认领"fast path，**fast path 无法注入任何 per-allocation env**）
- server 端 lifecycle env 传输：`services/k8s/create_helpers.py` `sandbox_env[OPENSANDBOX_LIFECYCLE] = request.lifecycle.model_dump_json(...)`（仅直建路径可用，池路径被 schema 校验拦截）
- execd 配置加载与持久化：`components/execd/pkg/lifecycle/config.go`（`ConfigEnv = "OPENSANDBOX_LIFECYCLE"`，落盘 `~/.execd/lifecycle.toml`，可被 `EXECD_LIFECYCLE_CONFIG` 覆盖；~~早期调研误记为 `/var/execd/lifecycle.toml`~~，`bootstrap.sh` 末尾 `unset` 该 env——transport-only，不残留进程环境）

## 5. 配置双层源与持久化语义（R8 / PATCH 设计）

| 层 | 载体 | 角色 |
|---|---|---|
| provider-held | Docker 文件存储 / K8s BatchSandbox `sandbox.opensandbox.io/lifecycle` **annotation**（controller 忽略，server-only 契约） | server 重启后的恢复源 |
| transport | create 时 env `OPENSANDBOX_LIFECYCLE`（JSON） | **仅传输**：execd 校验后原子落盘，失败则 lifecycle startup abort |
| effective | 沙箱内 `~/.execd/lifecycle.toml`（实测 `/root/.execd/lifecycle.toml`，HOME=/root） | 运行时生效配置，跨 execd 重启 / pause-resume 存活 |

PATCH（未实现）的设计约束（R9-R10）：仅影响未来 transition（启动时快照）；非 `Running` 态返回 409；execd 无 lifecycle API（capability gate）时拒绝；PATCH 同步更新 pod-creation source（taskTemplate env / podTemplate env）使 replacement pod 物化最新配置，且 env 更新不得触发运行中 pod 重建。

## 6. 与 task-executor task-level hooks 的区别（易混淆）

样例 `kubernetes/config/samples/sandbox_v1alpha1_batchsandbox-lifecycle.yaml` 里 `taskTemplate.spec.lifecycle.preStart/postStop` 是 **task-executor 层的任务钩子**（任务进程前后执行，`task_manager.go` 处理），**不是** OSEP-0020 的沙箱级 hooks（execd 域）。OSEP-0020 Non-goal 4 明确 task-level hooks 保持不变。两者互不替代。

**task-executor 层 `postStop` 触发语义（2026-09-01 代码核对 + 实测，`task_manager.go` `decideTaskStop`）**——它挂在 **task 进程生命周期**上，不是沙箱销毁钩子：

| 场景 | 行为 | 实测证据 |
|---|---|---|
| task 进程进入终态（entrypoint 自然退出/失败/超时） | 立即执行 postStop（reason `terminal task completed`） | entrypoint `sleep 150` 退出后 1s 内 hook 执行，executor 日志 `Executing postStop lifecycle hook → completed` |
| BatchSandbox 删除/到期（优雅删除） | controller `StopTask()` → task 打 DeletionTimestamp → **先 stop 进程 → 执行 postStop → 才 finalize 删除**（reason `deletion requested`） | delete 后 2s 内 hook 执行，随后 CR NotFound、pod 回收 |
| pod 被硬杀（驱逐/节点故障/容器 SIGKILL） | task-executor 自身消亡，**postStop 不执行** | 代码路径确认 |

即：entrypoint 转后台退出后**立即执行**；优雅删除时会**补跑**；硬杀路径覆盖不到——业务"释放回调/产物收尾"依赖优雅删除 + 足够的 grace period，硬杀兜底仍需等 OSEP-0020 phase 4 的 `preTerminate`（execd-as-init 拓扑收 SIGTERM，§8）。

## 7. 池模式现状与"申请后短时初始化"的可用方案

当前版本池模式：**不能 create 带 hooks，不能 PATCH hooks**。可用替代：

| 方案 | 时机 | 顺序保证 | 备注 |
|---|---|---|---|
| `env` 注入 | 分配时经 taskTemplate | 配置值随容器启动生效 | 正规路径，user info injection 已在用 |
| 自定义 `entrypoint` 包装初始化 | 分配时经 taskTemplate，容器以新启动命令重启 | **初始化在 Ready 前完成，失败即启动失败** | 唯一能跑初始化命令的池模式机制；不再走 fast path |
| Ready 后 exec 跑初始化 | 申请成功后业务层执行 | ❌ 业务层自保证"先初始化后使用" | 标准 API，无服务端顺序保证 |
| **手写 BatchSandbox CR 直注 `OPENSANDBOX_LIFECYCLE`**（R11 原型，2026-09-01 实测） | 分配时经 taskTemplate env | ✅ execd 层保证（校验失败 startup abort，同 create 语义） | 不经 server、不触发 400；需 controller·task-executor ≥ #420，见下方版本坑 |
| （未来）`preStart` hook | OSEP-0020 phase 5 放开后 | execd 层保证，超时 60s~3h，失败 abort | 到时 create 请求直接加 `lifecycle` 字段 |

绕过提醒（仅针对经 server 的 create）：env 里私带 `OPENSANDBOX_LIFECYCLE` 变量名会被保留名校验拒绝（`schema.py` `validate_source_and_entrypoint`）。该校验只在 server API 层；手写 BatchSandbox CR 不经 server，直注即上表 R11 原型路径（已实测），不算绕过防线。

**版本坑（2026-09-01 实测发现，易踩且难排查）**：CRD 对 `spec.taskTemplate` 设了 `x-kubernetes-preserve-unknown-fields`（API 层不 prune），但 **controller reconcile 时会用自身 typed struct 重写 `spec.taskTemplate`**——早于 #420（2026-07-20 `feat(k8s): Add lifecycle feat in task schedule`）的 controller 结构体没有 `process.lifecycle` 字段，重写时**静默抹掉**（实测特征：`metadata.generation` 无故 1→2、task-executor `getTasks` 返回缺 lifecycle）。**排查手段**：对比存储侧 CR 与 `getTasks` 返回、盯 generation 变化。

**组件最小镜像版本（池模式 hook 基线，2026-09-01 registry 逐一实测）**：

| 组件 | 最小可用版本 | 实测依据 |
|---|---|---|
| controller | `opensandbox/controller:latest`（**v0.2.0 及更早不支持**） | v0.2.0 部署实测：reconcile 抹掉 `process.lifecycle`；`latest` 经 Dockerfile 构建线索锚定为**上游 main ≥ `cf808310`（2026-08-25）的滚动构建**（Go 1.25.12 + alpine 瘦身基座对应 `1c94cc5b` 2026-07-13；含 #420；被 08-25 提交删除的错误串已不在二进制中），≈ 当前 main（f91f153c 时代）。含 #420 的正式 release 发布后以 release tag 为准 |
| task-executor | `opensandbox/task-executor:latest`（**v0.2.0 及更早不支持**） | 二进制特征串 grep 实测：v0.2.0 无 `Executing postStop lifecycle hook`（Go 1.24.13 构建），latest 有（Go 1.25.12 构建） |
| execd | `opensandbox/execd:v1.1.0`（v1.0.x 无 OSEP-0020 hooks） | phase 1 能力随 v1.1.0 发布（1.0.x → 1.1.0 跳版主因）；池模板 initContainer 安装 `./execd + ./bootstrap.sh` |
| 沙箱底座镜像 | 无硬性要求（实测 code-interpreter:v1.1.0） | hook 命令需容器内有 `/bin/sh`；`curl` 需镜像自带或 initContainer 挂入（code-interpreter 自带 curl 8.5.0） |

controller 与 task-executor 必须**同代升级**（同为 ≥ #420 的构建），单边升级会停在"字段被抹/字段无人执行"的半生效状态。

**实测范式（可复用）**：集群内布一个 mock HTTP 服务（ConfigMap + python http.server，POST 打点落盘），hook 命令"写文件到 emptyDir 卷 + `curl` 打点 mock"双通道取证；pod 回收后证据仍保留在 mock 侧，postStop 这类终局钩子尤其依赖该范式。

## 8. 拓扑建议（R13）

legacy Pool task 形态里 task shim 把 bootstrap 放后台，SIGTERM 送达不了 execd → **`preTerminate` 仅支持 `execd_run_as_init` 拓扑**。建议池模板现在就按 execd-as-init（`EXECD_INIT=1`，execd 为 PID 1）建设，将来 phase 4/5 落地时停机钩子直接可用，迁移成本最低。

## 9. 参考与证据索引

- OSEP：`oseps/0020-sandbox-lifecycle-hooks.md`（upstream/main）
- 关键提交：execd hooks `1b2f2f25`、server transport `f0ba38d9`、execd v1.1.0 bump `13448766`、egress v1.1.7 bump `afd412ec`、server v0.2.3 tag（指向 `c39b814f`）
- spec：`specs/sandbox-lifecycle.yml`（LifecycleHook `:1271`、PeriodicLifecycleHook `:1291`、"only preStart and periodic" `:1326`、allocation summary `AllocationSummary`）
- 官方文档：`docs/guides/lifecycle-hooks.md`（"A request cannot combine `lifecycle` with `poolRef`"）
- task-executor 层 lifecycle 引入提交：#420 `c6eecbfa`（2026-07-20，controller `convertLifecycle` + task-executor `postStopRequired`；**早于该提交的 controller/task-executor 镜像不支持，见 §7 版本坑**）
- 实测记录：2026-09-01，k3s v1.30.5 双节点（1 Ubuntu master + 1 CentOS Stream 9 worker），controller/task-executor latest（≥ #420）+ execd v1.1.0 + code-interpreter v1.1.0 池模板（execd-as-init 拓扑，EXECD_INIT=1）；结论：periodic `@every 30s` 五拍双证一致、`~/.execd/lifecycle.toml` 落盘正确、postStop 自然退出/优雅删除两路径均触发，详见 §1/§3/§6/§7
