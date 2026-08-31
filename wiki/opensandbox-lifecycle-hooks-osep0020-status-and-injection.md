# OSEP-0020 沙箱生命周期钩子：实施状态与池模式注入路径

- 日期：2026-08-31
- 状态：调研（基于 upstream/main @ `f91f153c`，dev 已合并至 `ebf776be`；server v0.2.3 / execd v1.1.0）
- 关联：`wiki/opensandbox-pool-allocation-time-injection.md`（分配时注入技术对比）、`wiki/opensandbox-task-template-user-info-injection-example.md`（taskTemplate 注入实例）、`wiki/opensandbox-pool-capacity-params.md`（池容量参数）

---

## 1. 结论速览

| 问题 | 答案 |
|---|---|
| 沙箱生命周期钩子实现了吗 | **部分**。仅 phase 1-2 落地：create 时声明 `preStart` + `periodic`，由 execd 在沙箱内执行（server v0.2.3 / execd v1.1.0） |
| `PATCH /sandboxes/{id}/lifecycle` 实现了吗 | **没有**。spec 无该端点、server 无路由、execd 无 lifecycle API；属 phase 3 future |
| K8s 直建（非池）支持吗 | ✅ create 时 `lifecycle` 字段可用（K8s provider）；Docker 与 fleets 明确拒绝 |
| **K8s 池模式支持吗** | ❌ **不支持**。`lifecycle` + `poolRef` 组合在 API 校验层直接 400；池模式支持排在实施计划**最后一期**（phase 5） |
| 池模式"申请后短时初始化"用什么 | `env` 注入（配置值）+ 自定义 `entrypoint` 包装初始化命令（Ready 前完成、失败即启动失败） |

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
| 1 | execd：配置持久化 + `preStart`/`periodic` | ✅ | `components/execd/pkg/lifecycle/`（config/periodic/runner），execd v1.1.0（v1.0.x → v1.1.0 minor 跳版主因） |
| 2 | spec `CreateSandboxRequest.lifecycle` + SDK 再生成 + server create 传输 | ✅ | `specs/sandbox-lifecycle.yml`（LifecycleHook/PeriodicLifecycleHook schema）；server `create_helpers.py` env 注入；SDK models 已加 |
| 3 | `run`/`config`/`status` 端点、**PATCH**、其余 transition hooks | ❌ future | spec 无 `/sandboxes/{sandboxId}/lifecycle` 路径；`api/lifecycle.py` 仅 metadata PATCH；execd `pkg/web` 无 lifecycle API |
| 4 | Docker/K8s provider 编排（prePause/postResume/preTerminate）、grace 接线、E2E | ❌ future | — |
| 5 | **池模式支持**：经 `spec.taskTemplate` per-sandbox 注入（R11） | ❌ future（最后一期） | `schema.py:572` 校验拒绝 lifecycle+poolRef |

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
   ▼ execd 消费（OSEP-0020 核心）
bootstrap.sh → execd 启动 → LoadConfig()
   → 注入 env 权威 → 校验 → 原子落盘 /var/execd/lifecycle.toml → unset 环境变量
   → 执行 preStart → 启动 entrypoint → Ready
```

关键实现位置：

- server 端 taskTemplate 构建：`server/opensandbox_server/services/k8s/batchsandbox_provider.py` `_build_task_template()`（带 env/entrypoint/execd_run_as_init 任一即走 taskTemplate 路径；否则走"零修改认领"fast path，**fast path 无法注入任何 per-allocation env**）
- server 端 lifecycle env 传输：`services/k8s/create_helpers.py` `sandbox_env[OPENSANDBOX_LIFECYCLE] = request.lifecycle.model_dump_json(...)`（仅直建路径可用，池路径被 schema 校验拦截）
- execd 配置加载与持久化：`components/execd/pkg/lifecycle/config.go`（`ConfigEnv = "OPENSANDBOX_LIFECYCLE"`，落盘 `/var/execd/lifecycle.toml`，`bootstrap.sh` 末尾 `unset` 该 env——transport-only，不残留进程环境）

## 5. 配置双层源与持久化语义（R8 / PATCH 设计）

| 层 | 载体 | 角色 |
|---|---|---|
| provider-held | Docker 文件存储 / K8s BatchSandbox `sandbox.opensandbox.io/lifecycle` **annotation**（controller 忽略，server-only 契约） | server 重启后的恢复源 |
| transport | create 时 env `OPENSANDBOX_LIFECYCLE`（JSON） | **仅传输**：execd 校验后原子落盘，失败则 lifecycle startup abort |
| effective | 沙箱内 `/var/execd/lifecycle.toml` | 运行时生效配置，跨 execd 重启 / pause-resume 存活 |

PATCH（未实现）的设计约束（R9-R10）：仅影响未来 transition（启动时快照）；非 `Running` 态返回 409；execd 无 lifecycle API（capability gate）时拒绝；PATCH 同步更新 pod-creation source（taskTemplate env / podTemplate env）使 replacement pod 物化最新配置，且 env 更新不得触发运行中 pod 重建。

## 6. 与 task-executor task-level hooks 的区别（易混淆）

样例 `kubernetes/config/samples/sandbox_v1alpha1_batchsandbox-lifecycle.yaml` 里 `taskTemplate.spec.lifecycle.preStart/postStop` 是 **task-executor 层的任务钩子**（任务进程前后执行，`task_manager.go` 处理），**不是** OSEP-0020 的沙箱级 hooks（execd 域）。OSEP-0020 Non-goal 4 明确 task-level hooks 保持不变。两者互不替代。

## 7. 池模式现状与"申请后短时初始化"的可用方案

当前版本池模式：**不能 create 带 hooks，不能 PATCH hooks**。可用替代：

| 方案 | 时机 | 顺序保证 | 备注 |
|---|---|---|---|
| `env` 注入 | 分配时经 taskTemplate | 配置值随容器启动生效 | 正规路径，user info injection 已在用 |
| 自定义 `entrypoint` 包装初始化 | 分配时经 taskTemplate，容器以新启动命令重启 | **初始化在 Ready 前完成，失败即启动失败** | 唯一能跑初始化命令的池模式机制；不再走 fast path |
| Ready 后 exec 跑初始化 | 申请成功后业务层执行 | ❌ 业务层自保证"先初始化后使用" | 标准 API，无服务端顺序保证 |
| （未来）`preStart` hook | OSEP-0020 phase 5 放开后 | execd 层保证，超时 60s~3h，失败 abort | 到时 create 请求直接加 `lifecycle` 字段 |

绕过提醒：env 里私带 `OPENSANDBOX_LIFECYCLE` 变量名会被保留名校验拒绝（`schema.py` `validate_source_and_entrypoint`），无法走私 lifecycle 配置。

## 8. 拓扑建议（R13）

legacy Pool task 形态里 task shim 把 bootstrap 放后台，SIGTERM 送达不了 execd → **`preTerminate` 仅支持 `execd_run_as_init` 拓扑**。建议池模板现在就按 execd-as-init（`EXECD_INIT=1`，execd 为 PID 1）建设，将来 phase 4/5 落地时停机钩子直接可用，迁移成本最低。

## 9. 参考与证据索引

- OSEP：`oseps/0020-sandbox-lifecycle-hooks.md`（upstream/main）
- 关键提交：execd hooks `1b2f2f25`、server transport `f0ba38d9`、execd v1.1.0 bump `13448766`、egress v1.1.7 bump `afd412ec`、server v0.2.3 tag（指向 `c39b814f`）
- spec：`specs/sandbox-lifecycle.yml`（LifecycleHook `:1271`、PeriodicLifecycleHook `:1291`、"only preStart and periodic" `:1326`、allocation summary `AllocationSummary`）
- 官方文档：`docs/guides/lifecycle-hooks.md`（"A request cannot combine `lifecycle` with `poolRef`"）
