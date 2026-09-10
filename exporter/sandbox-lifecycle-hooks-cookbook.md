# 沙箱生命周期钩子 Cookbook（OSEP-0020：preStart / periodic）

在 create 请求中声明 **execd 级**生命周期钩子（OSEP-0020）。上游**正在分阶段实现**：当前仅 `preStart` + `periodic` 可用，且**池化模式暂不支持**。本篇讲清楚：哪套钩子是什么、池化现在怎么替代、直建怎么用、以及上游落地后的切换路径。

**前提**

| 项 | 约定 |
|---|---|
| 部署 | 池化主路径（Pool + BatchSandbox + taskTemplate）；直建 K8s 场景见 §4 |
| 访问 | 业务流量经 server proxy |
| 生命周期 | 申请 → 使用 → 释放；不使用 pause/resume |
| 上游版本 | server v0.2.3 / execd v1.1.0（upstream/main @ `f91f153c` 已核对） |
| 组件最小镜像（hook 能力基线，2026-09-01 实测） | controller `latest`（v0.2.0 及更早不支持）、task-executor `latest`（v0.2.0 及更早不支持）、execd `v1.1.0`；详见 §3.4 版本矩阵 |

## 目录

- [1. 先分清两套钩子（最易混淆）](#1-先分清两套钩子最易混淆)
- [2. OSEP-0020 钩子全集与实施状态](#2-osep-0020-钩子全集与实施状态)
- [3. 池化模式：现在能做什么](#3-池化模式现在能做什么)
- [4. 直建 K8s 沙箱：create 带 lifecycle（已可用）](#4-直建-k8s-沙箱create-带-lifecycle已可用)
- [5. 现在铺路：Pool 模板按 execd-as-init 建设](#5-现在铺路pool-模板按-execd-as-init-建设)
- [6. 上游阶段落地后的切换清单](#6-上游阶段落地后的切换清单)
- [参考](#参考)

---

## 1. 先分清两套钩子（最易混淆）

OpenSandbox 里有**两套互不替代的钩子机制**，写配置前先确认要哪一套：

| | task-executor 任务钩子 | OSEP-0020 沙箱级钩子（本篇） |
|---|---|---|
| 配置位置 | BatchSandbox `spec.taskTemplate.spec.lifecycle` | `POST /sandboxes` 请求体 `lifecycle` 字段 |
| 执行者 | task-executor（任务进程启动/停止前后） | execd（沙箱容器启动序列 / 运行期 cron） |
| 触发点 | 每次下发 Task 的 preStart / postStop | 沙箱生命周期事件：启动前、暂停前、恢复后、终止前、周期性 |
| 典型用途 | 任务级数据准备/清理 | 沙箱初始化、心跳、优雅收尾 |
| 现状 | 已实现（手写 CR / 待 API 暴露） | phase 1-2 已实现；PATCH 与池化未实现 |
| 文档 | `pod-lifecycle-hooks-cookbook.md` | 本篇 |

OSEP-0020 的 Non-goal 明确：task-level hooks 保持不变。**两者可共存**，选型标准是"挂在任务上"还是"挂在沙箱上"。

## 2. OSEP-0020 钩子全集与实施状态

### 2.1 钩子全集（spec 已定义五种，本版只放行两种）

| Hook | 执行通道 | 运行时 PATCH | 失败默认语义 | 触发时机 |
|---|---|---|---|---|
| `preStart` | execd 启动序列 | ❌（create 声明） | **Abort**（阻止 entrypoint 启动） | execd HTTP ready 后、entrypoint 前，每次容器启动 |
| `periodic[]` | execd 内置 cron | ✅（phase 3） | Continue（固定） | 运行期按 schedule 调度；同名钩子不重叠，上一轮未结束则跳过 |
| `prePause` | orchestrated（server 触发） | ✅（phase 3/4） | Abort | 暂停前（手动 / idle / TTL） |
| `postResume` | orchestrated | ✅（phase 3/4） | Abort | resume 后、公开 Running 前 |
| `preTerminate` | signal-driven（execd 捕 SIGTERM） | ✅（phase 3/4） | Continue（固定） | Running 态被真实终止（delete / TTL / 驱逐 / stop） |

> 业务不用 pause/resume（D-4），`prePause`/`postResume` 落地后也基本用不上；**对本业务真正有价值的是 `preStart`（初始化）、`periodic`（心跳/巡检）、`preTerminate`（释放回调/产物收尾）**。

### 2.2 分阶段实施状态（对照 upstream/main @ f91f153c）

| 阶段 | 内容 | 状态 | 对业务的影响 |
|---|---|---|---|
| 1 | execd：配置持久化 + `preStart`/`periodic` 执行 | ✅ execd v1.1.0（**2026-09-01 池模式实测通过**） | 具备执行能力 |
| 2 | spec `lifecycle` 字段 + SDK 模型 + server create 传输 | ✅ server v0.2.3 | **直建 K8s 可用；池化被 schema 校验 400 拦截** |
| 3 | `run`/`config`/`status` 端点、PATCH、其余 transition hooks | ❌ future | 运行时改钩子暂不可能 |
| 4 | Docker/K8s provider 编排（prePause/postResume/preTerminate）、grace 接线 | ❌ future | 终止前回调暂不可能 |
| 5 | **池化支持**：per-sandbox 经 `taskTemplate` 注入（R11，最后一期） | ❌ future；**R11 原型已实测可用** | server API 池化 create 带 lifecycle 暂不可能；**手写 BatchSandbox CR 直注已实测打通**（§3.4） |

池化被拦截的硬证据：`lifecycle` + `extensions.poolRef` 组合在 server schema 校验直接 400（`schema.py` `validate_source_and_entrypoint`）；官方文档 `docs/guides/lifecycle-hooks.md` 明文 "A request cannot combine `lifecycle` with `poolRef`"。

## 3. 池化模式：现在能做什么

在 phase 5 落地前，池化的"申请后初始化"用以下替代方案（详见 wiki 调研文档 §7）：

| 方案 | 时机 | 顺序保证 | 建议 |
|---|---|---|---|
| `env` 注入配置值 | 分配时经 taskTemplate | 随容器启动生效 | **推荐**，用户信息注入已在用（D-8） |
| 自定义 `entrypoint` 包装初始化命令 | 分配时经 taskTemplate（覆盖预热 entrypoint） | ✅ 初始化在 Ready 前完成，**失败即启动失败** | 需要跑命令时用；注意会走出"零修改认领"fast path |
| Ready 后业务层 exec | 申请成功后 | ❌ 业务层自保证顺序 | 无服务端保证，仅作兜底 |
| **手写 BatchSandbox CR 直注 `OPENSANDBOX_LIFECYCLE`** | 分配时经 taskTemplate env | ✅ execd 层保证（校验失败 startup abort） | R11 原型，**2026-09-01 实测打通**；server API 放开前的过渡形态，见 §3.4 |
| （将来）`preStart` hook | phase 5 放开后 | ✅ execd 层保证，失败 abort | 到时 create 请求直接加 `lifecycle` 字段 |

### 3.1 env 注入（配置值类初始化）

```bash
curl -X POST "$SERVER/sandboxes" -H 'Content-Type: application/json' -d '{
  "extensions": { "poolRef": "dept-a-pool" },
  "env": {
    "OSB_USER_ID": "u1001",
    "OSB_USER_TOKEN": "<token>",
    "OSB_S3_PREFIX": "users/u1001"
  },
  "timeout": 600
}'
```

### 3.2 entrypoint 包装（命令类初始化）

```bash
curl -X POST "$SERVER/sandboxes" -H 'Content-Type: application/json' -d '{
  "extensions": { "poolRef": "dept-a-pool" },
  "env": { "OSB_USER_ID": "u1001" },
  "entrypoint": ["/bin/sh", "-c",
    "mkdir -p /workspace && cp /shared/models/manifest.json /workspace/ || exit 1; exec python serve.py"],
  "timeout": 600
}'
```

要点：初始化失败要 `exit 非 0`，让沙箱**启动失败**而不是带着脏状态变 Ready；`exec` 保证业务进程接管 PID，信号能送达。

### 3.3 禁止走私 lifecycle 配置（经 server 的 create）

经 server create 时，env 里私带 `OPENSANDBOX_LIFECYCLE` 变量名会被保留名校验拒绝（`schema.py`）——这是 phase 5 之前的正常防线，不要绕。**手写 BatchSandbox CR 不经 server**，直注见 §3.4。

### 3.4 手写 CR 直注 execd 钩子（R11 原型，2026-09-01 实测打通）

不经 server、直接创建带 `taskTemplate` 的 BatchSandbox，把 execd 钩子 JSON 放进 `OPENSANDBOX_LIFECYCLE` env（保留名校验只在 server 层，controller 链路不受限）：

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: BatchSandbox
metadata:
  name: hook-demo
  namespace: opensandbox
spec:
  poolRef: my-pool
  replicas: 1
  taskTemplate:
    spec:
      process:
        command: ["/bin/sh", "-c", "exec /opt/opensandbox/bootstrap.sh sleep 3600"]
        env:
          - name: EXECD_INIT
            value: "1"
          - name: OPENSANDBOX_ID
            value: hook-demo
          - name: OPENSANDBOX_LIFECYCLE
            value: '{"version":1,"periodic":[{"name":"heartbeat","schedule":"@every 30s","command":["/bin/sh","-c","date +%FT%T%z >> /workspace/logs/heartbeat.log"],"timeoutSeconds":10}]}'
```

**组件最小镜像版本（池模式 hook 能力基线，2026-09-01 registry 逐一实测）**

| 组件 | 最小可用版本 | 实测依据 |
|---|---|---|
| controller | `opensandbox/controller:latest`（**v0.2.0 及更早不支持**） | v0.2.0 部署实测：reconcile 用旧 typed struct 重写 `spec.taskTemplate`，静默抹掉 `process.lifecycle` 与注入字段（特征：`metadata.generation` 无故 +1、`getTasks` 缺字段）；`latest` 锚定为上游 main ≥ `cf808310`（2026-08-25）的滚动构建（Go 1.25.12 + alpine 基座 = `1c94cc5b` 2026-07-13 之后），含 #420；正式 release 发布后以 release tag 为准 |
| task-executor | `opensandbox/task-executor:latest`（**v0.2.0 及更早不支持**） | 二进制特征串 grep：v0.2.0 无 `Executing postStop lifecycle hook`（Go 1.24.13 构建），latest 有（Go 1.25.12 构建） |
| execd | `opensandbox/execd:v1.1.0`（v1.0.x 无 OSEP-0020 hooks） | phase 1 能力随 v1.1.0 发布；池模板 initContainer 安装 `./execd + ./bootstrap.sh` |
| 沙箱底座镜像 | 无硬性要求（实测 code-interpreter:v1.1.0） | hook 命令需容器内有 `/bin/sh`；`curl` 需镜像自带或 initContainer 挂入 |

要点与实测结论（k3s 双节点）：

- controller 与 task-executor 必须**同代升级**（同为 ≥ #420 的构建），单边升级会停在"字段被抹 / 字段无人执行"的半生效状态。
- `EXECD_INIT=1` 时 bootstrap.sh `exec execd --init`，execd 校验后原子落盘 `~/.execd/lifecycle.toml`（HOME=/root）并 unset 传输 env；`periodic` 由 execd 内置 cron 调度，实测 `@every 30s` 五拍间隔精确、无漂移。
- task-executor 层 `postStop`（`process.lifecycle.postStop`）触发语义：entrypoint 终态**立即执行**（实测退出后 1s 内）；优雅删除**先 stop 进程再执行**（实测 delete 后 2s 内）；**pod 硬杀不执行**（收尾回调等 phase 4 `preTerminate`）。
- 验证范式：hook 命令"写文件到 emptyDir 卷 + `curl` 打点集群内 mock 服务"双通道取证，pod 回收后证据仍留在 mock 侧。

## 4. 直建 K8s 沙箱：create 带 lifecycle（已可用）

不经池、由 server 直接拉起 BatchSandbox 时，`lifecycle` 字段当前即可用（K8s provider）：

```bash
curl -X POST "$SERVER/sandboxes" -H 'Content-Type: application/json' -d '{
  "image": "registry.example.com/base/python-slim:3.10",
  "entrypoint": ["python", "serve.py"],
  "timeout": 600,
  "lifecycle": {
    "preStart": {
      "command": ["/bin/sh", "-c",
        "mkdir -p /workspace && echo $OSB_USER_ID > /workspace/.user"],
      "timeoutSeconds": 60
    },
    "periodic": [
      {
        "name": "heartbeat",
        "schedule": "@every 30s",
        "command": ["/bin/sh", "-c",
          "curl -sf -X POST http://biz-internal/sandbox-heartbeat -d @/workspace/.user"],
        "timeoutSeconds": 10
      }
    ]
  }
}'
```

**Schema 字段（specs/sandbox-lifecycle.yml）**

| 字段 | 约束 |
|---|---|
| `preStart.command` | `string[]`，minItems 1；需要 shell 时显式 `["sh", "-c", "..."]` |
| `preStart.timeoutSeconds` | 1~10800（最长 3h），缺省 60 |
| `periodic[].name` | 沙箱内唯一 |
| `periodic[].schedule` | 五段 cron 或 `@hourly` / `@every 30s`（`@every` 最小 1s） |
| `periodic[].command` | `string[]`，**无隐式 shell 展开** |
| `periodic[].timeoutSeconds` | 1~300，缺省 60 |

**行为要点**

- `preStart` 在 execd HTTP server ready 之后、entrypoint 之前执行；失败或超时 → entrypoint 不启动（Abort）。
- `periodic` 由 execd 在沙箱内调度；同名钩子上一轮未结束时本轮**跳过**（不排队）。
- 配置经 create env `OPENSANDBOX_LIFECYCLE`（JSON）传入，execd 校验后原子落盘 `~/.execd/lifecycle.toml`（HOME=/root；可被 `EXECD_LIFECYCLE_CONFIG` 覆盖），并 unset 该环境变量（仅传输不残留）。
- Docker 与 fleets 运行时会明确拒绝 lifecycle；仅 K8s provider 支持。

## 5. 现在铺路：Pool 模板按 execd-as-init 建设

R13 结论：将来 `preTerminate` **仅支持 execd-as-init 拓扑**（execd 为 PID 1，能可靠收到 SIGTERM）。legacy Pool task 形态里 task shim 把 bootstrap 放后台，SIGTERM 送达不了 execd。

**建议**：池模板现在就按 `EXECD_INIT=1` 建设（execd 作为 PID 1），phase 4/5 落地时停机钩子直接可用，迁移成本最低。模板改造操作见 `pool-pod-template-cookbook.md`。

## 6. 上游阶段落地后的切换清单

上游每合并一个阶段，做一次回访（🚧 wiki 调研文档同步更新）：

| 上游阶段 | 落地信号 | 业务动作 |
|---|---|---|
| phase 3（PATCH/端点） | spec 出现 `/sandboxes/{id}/lifecycle` 路由；execd 出现 lifecycle API | 运行期可动态增改 `periodic`；注意非 Running 态返回 409 |
| phase 4（provider 编排） | prePause/postResume/preTerminate 生效公告 | **D-4 业务不用 pause/resume**；只关注 `preTerminate`：TTL/删除/驱逐前的释放回调、产物收尾（与 S3 回写衔接） |
| phase 5（池化放开） | `lifecycle` + `poolRef` 组合校验解除 | 池化 create 直接带 `lifecycle.preStart`；§3.2 的 entrypoint 包装方案退役 |

跟踪入口：上游 issue **#1455**（Track OSEP-0020 implementation coordination）。

## 参考

- 调研底稿：`wiki/opensandbox-lifecycle-hooks-osep0020-status-and-injection.md`（🚧 上游功能，随阶段回访；2026-09-01 增补池模式注入实测与最小镜像版本矩阵）
- 提案：`oseps/0020-sandbox-lifecycle-hooks.md`
- 契约：`specs/sandbox-lifecycle.yml`（`SandboxLifecycle` / `LifecycleHook` / `PeriodicLifecycleHook`）
- 官方指南：`docs/guides/lifecycle-hooks.md`
- 姊妹篇：`pod-lifecycle-hooks-cookbook.md`（task-executor 任务钩子）、`pool-pod-template-cookbook.md`（模板与 EXECD_INIT）、`sandbox-management-cookbook.md`（create/注入/续约总览）
- 相关 wiki：`opensandbox-pool-allocation-time-injection.md`、`opensandbox-task-template-user-info-injection-example.md`
