# OpenSandbox 池模式沙箱 Pod 边车组件介绍与实践指导

> 日期：2026-09-03
> 依据：代码调研（`components/execd`、`components/egress`、`kubernetes/internal/task-executor`、`kubernetes/pkg/task-executor`、`server/opensandbox_server/services/k8s/batchsandbox_provider.py`、`kubernetes/internal/task-executor/server/router.go`）+ 2026-09-01/09-03 ubuntu k3s 双节点实测记录（见文末关联文档）。
> 定位：池化沙箱 Pod 内组件的**总览 + 实践指导**（入口文档）；配置参数全集见[沙箱配置参数与环境变量参考](opensandbox-sandbox-config-and-env-reference.md)，各专项深入见关联文档。

---

## 1. 总览：池化沙箱 Pod 里有什么

池化模式下（Pool 预热 + BatchSandbox 认领），沙箱 Pod **不是**由 server 现场拼装的，而是来自 Pool 模板（`spec.template`，Schemaless 可直接写 Pod spec）。一个典型池化沙箱 Pod 的构成（2026-09-03 实测）：

```
┌─────────────────────────── 池化沙箱 Pod ───────────────────────────┐
│ initContainers（两个安装器，产物进共享 emptyDir opensandbox-bin）      │
│   ├─ task-executor-installer   镜像 task-executor:latest            │
│   │                            二进制 → /opt/opensandbox/           │
│   └─ execd-installer           镜像 execd:v1.1.0                    │
│                                ./execd + ./bootstrap.sh → 同上       │
│                                                                     │
│ containers                                                          │
│   ├─ sandbox（主容器，业务镜像如 code-interpreter:v1.1.0）            │
│   │    PID1 = task-executor（默认拓扑）或 execd --init（init 拓扑）    │
│   │    进程：task-executor(:5758) → 派发任务 → bootstrap.sh → execd(:44772)│
│   │    可选：Jupyter(:44771，code-interpreter 镜像内)、业务进程        │
│   └─ egress（可选 sidecar，池化默认不装，共享 netns；NET_ADMIN）        │
│        API :18080 / DNS :15353 / mitmproxy :18081                    │
│                                                                     │
│ 共享卷：opensandbox-bin emptyDir → 各容器 /opt/opensandbox            │
└─────────────────────────────────────────────────────────────────────┘
```

| 组件 | 角色 | 是否必需 | 监听端口 | 源码位置 |
|---|---|---|---|---|
| task-executor | Pod 内任务代理：接收 controller 派发的任务并执行 | **必需**（池化链路核心） | 5758 | `kubernetes/internal/task-executor`、`kubernetes/pkg/task-executor` |
| execd | 沙箱执行守护进程：命令执行/文件操作/生命周期钩子，SDK 流量终点 | **必需**（无它 SDK 无法操作沙箱） | 44772 | `components/execd` |
| bootstrap.sh | 启动粘合脚本：先起 execd 再执行业务命令 | 必需（随 execd 镜像分发） | — | `components/execd/bootstrap.sh` |
| Jupyter | 代码解释器内核（execd 联动） | 可选（解释器场景） | 44771 | `sandboxes/code-interpreter` |
| egress | 出口网络管控 sidecar + Credential Vault | 可选（池化默认不装） | 18080/15353/18081 | `components/egress` |

**易混淆的非 Pod 内组件**（不在沙箱 Pod 里，排查时别找错地方）：

| 组件 | 层级 | 作用 | 源码 |
|---|---|---|---|
| ingress | 集群级网关 | 把外部/业务流量路由进沙箱（endpoint 路由） | `components/ingress` |
| nodeagent | 节点级 DaemonSet（每节点一个） | 收集沙箱容器 stdout/stderr（container-logs Source）写文件/OSS；**实验性**（OSEP-0019），`/healthz` `:8080` | `components/nodeagent` |
| controller | 集群级管理面 | Pool/BatchSandbox 调谐、调度、3s 轮询 task-executor | `kubernetes/internal/controller` |

---

## 2. 组件介绍

### 2.1 task-executor——Pod 内"任务代理"（必需）

**是什么**：一个轻量 HTTP server，跑在沙箱容器里，是 controller 与沙箱之间的执行代理。池化模式的"用完即焚"任务派发全靠它。

**运行形态（池化实测）**：作为主容器 PID1 启动：

```bash
/opt/opensandbox/task-executor -listen-addr=0.0.0.0:5758 -log-dir=/tmp
```

**HTTP API**（`kubernetes/internal/task-executor/server/router.go:24-29`）：

| 端点 | 用途 |
|---|---|
| `POST /setTasks` | controller 批量下发/同步任务（SyncTasks） |
| `GET /getTasks` | controller 轮询任务实际状态 |
| `POST /tasks` / `GET /tasks/{id}` / `DELETE /tasks/{id}` | 单任务 CRUD（调试用） |
| `GET /health` | 健康检查 |

**派发链路**：controller scheduler 把 `taskTemplate`/任务 patch 组装后 `POST :5758/setTasks` 写入；每 3s 轮询 `getTasks` 对账；任务终态写 BatchSandbox `status.task*` 注解/字段，Release 时写 `alloc-release` 归还 Pod 回池。详见[BatchSandbox 3s 轮询 Task 执行机制调研](batchsandbox-task-3s-polling-exploration.md)。

**关键配置**（flag 覆盖同名 env）：

| flag / env | 默认 | 说明 |
|---|---|---|
| `--listen-addr` / `LISTEN_ADDR` | `0.0.0.0:5758` | HTTP 监听 |
| `--data-dir` / `DATA_DIR` | `/var/lib/sandbox/tasks` | 任务状态与日志目录 |
| `--enable-sidecar-mode` | false | 任务经 `nsenter` 进主容器 PID namespace 执行（需权限） |
| `--main-container-name` | `main` | sidecar-mode 的目标容器名 |
| `--enable-container-mode` | false | CRI 容器模式（当前占位，勿依赖） |
| `--reconcile-interval` | 500ms | 内部任务状态协调间隔 |

注意区分两层"钩子"：`taskTemplate.spec.lifecycle.preStart/postStop` 是 **task-executor 层的任务进程钩子**（`task_manager.go`，任务前后执行），**不是** OSEP-0020 沙箱级 hooks（execd 域）——两者互不替代。

### 2.2 execd——沙箱执行守护进程（必需）

**是什么**：SDK/业务所有沙箱内操作的终点：`/command` 命令执行（含 PTY）、文件读写、目录列表、生命周期钩子（v1.1.0 起 `preStart`/`periodic`）。业务流量经 server proxy 转发到 `execd:44772`（当前集成方案全部流量走 server proxy）。

**启动方式**：不是独立容器，而是**任务派发后**由 task-executor 执行 bootstrap 命令拉起：

- 默认拓扑（task-shim 后台）：`/opt/opensandbox/bootstrap.sh <entrypoint> &`——bootstrap 先后台起 execd，再执行业务进程；
- init 拓扑（推荐，见 §3.2）：`exec /opt/opensandbox/bootstrap.sh <entrypoint>` + env `EXECD_INIT=1`——bootstrap exec `execd --init`，**execd 成为 PID1**，业务进程为子进程。

**关键 env**（完整清单见[配置参考](opensandbox-sandbox-config-and-env-reference.md)）：

| env | 说明 |
|---|---|
| `EXECD=/opt/opensandbox/execd` | server 侧唯一固定注入的 env（K8s 运行时）；bootstrap 据此选二进制 |
| `EXECD_INIT=1` | init 拓扑开关（server `runtime.execd_run_as_init=true` 或池模板自带） |
| `EXECD_ENVS=/opt/opensandbox/.env` | task-executor 在语言切换后追加 PATH/JAVA_HOME/GOROOT 供 execd 子进程继承 |
| `JUPYTER_HOST`/`JUPYTER_TOKEN` | Jupyter 联动（不由 server 注入，调用方经 taskTemplate env 传入） |
| `OPENSANDBOX_LIFECYCLE` | OSEP-0020 hooks 传输 env（JSON），execd 校验后原子落盘 `~/.execd/lifecycle.toml`（`HOME=/root`） |

**认证**：请求头 `X-EXECD-ACCESS-TOKEN`（server 侧持有对应 token）。

**可选文件系统隔离**：`bootstrap.execd.isolation=enable` → 主容器需 `CAP_SYS_ADMIN` + seccomp/AppArmor Unconfined，挂 `isolation-upper` emptyDir 到 `/var/lib/execd/isolation`（upper rootfs 限额：upper 8GiB / diff 4GiB，`allowed_writable` 白名单替换式生效）。

**坑**：镜像里的 `execd-ebpf` 观测变体**未接线**（server 不注入 `EXECD` 选择、分发路径只装 `/execd`），生产勿依赖（`components/execd/README.md` 已声明）。

### 2.3 Jupyter（可选，解释器场景）

随 code-interpreter 镜像运行（`:44771`），execd 通过 `JUPYTER_HOST`/`JUPYTER_TOKEN` 联动（代码解释器 API 把代码发给 Jupyter 执行）。池化瘦身方案见[共享存储挂载解释器镜像最小化](opensandbox-shared-storage-interpreter-minimal-image.md)——解释器可放共享 PVC 卷，主容器用 mini 镜像。

### 2.4 egress sidecar（可选——池化默认不装）

**是什么**：与主容器共享 netns 的出口管控边车：DNS 拦截（:15353）+ iptables/nft REDIRECT 到透明 mitmproxy（:18081）+ 策略 API（:18080），提供**域名级**出口白名单与 Credential Vault（凭据代理注入，沙箱只见假凭据）。

**装配要求**（实测验证 2026-09-03，V0–V9 全过）：

- egress 容器 `capabilities.add: [NET_ADMIN]`；主容器必须 `capabilities.drop: [NET_ADMIN]`（与 server `build_security_context_for_sandbox_container()` 对齐，实测 CapEff 位 12=0，沙箱内无法改网络栈绕过）；
- server `[egress]` 配置驱动 `egress_helper.apply_egress_to_spec()` 拼装（直接创建路径）；池化路径需手工组装（见 SOP）；
- env 白名单：仅 `OPENSANDBOX_EGRESS_` 前缀 key 会进 sidecar（`split_egress_env`），`MITMPROXY_TRANSPARENT` 同时进主容器；token 经 annotation `opensandbox.io/egress-auth-token` 传给 server 做鉴权（请求头 `OPENSANDBOX-EGRESS-AUTH`）。

**池化为什么不默认装**：业务决策 D-7——每个 sidecar 约 20–50MB 内存，池化沙箱量大，内存省下来服务更多用户；IP/端口/label 级隔离由 **K8s NetworkPolicy** 承担。**域名级白名单 / Vault** 是 netpol 表达不了的能力，仅对敏感沙箱单独启用 sidecar。详见[NetworkPolicy vs Egress 边车对比](opensandbox-k8s-networkpolicy-vs-egress-sidecar.md)、[落地 SOP](opensandbox-egress-netpol-vault-sop.md)。

**互斥约束**：与 Istio/Envoy 同 Pod 二选一；与 gVisor 不兼容（gVisor 走 CNI 级策略）。

**上游演进**：fleet 共享 MITM（OSEP-0022 A1）数据面已落地、server 编排未落地——"共享 sidecar 省内存"形态暂不可端到端，持续跟踪。

---

## 3. 实践指导

### 3.1 Pool 模板装配清单

池化沙箱模板的骨架（可运行的完整示例见[用完即焚编排模式](opensandbox-ephemeral-sandbox-orchestration-pattern.md) §5）：

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: Pool
metadata:
  name: ephemeral-pool
spec:
  capacitySpec: { bufferMin: 5, bufferMax: 20, poolMin: 5, poolMax: 200 }
  template:
    spec:
      initContainers:                      # ① 两个安装器：二进制进共享卷
      - name: task-executor-installer
        image: <registry>/opensandbox/task-executor:latest
        command: ["sh","-c","cp /task-executor /opt/opensandbox/"]
        volumeMounts: [{ name: opensandbox-bin, mountPath: /opt/opensandbox }]
      - name: execd-installer
        image: <registry>/opensandbox/execd:v1.1.0
        command: ["sh","-c","cp /execd /bootstrap.sh /opt/opensandbox/"]
        volumeMounts: [{ name: opensandbox-bin, mountPath: /opt/opensandbox }]
      containers:
      - name: sandbox                      # ② 主容器：业务镜像
        image: <registry>/opensandbox/code-interpreter:v1.1.0
        command: ["/bin/sh","-c","/opt/opensandbox/task-executor -listen-addr=0.0.0.0:5758 -log-dir=/tmp"]
        securityContext:
          capabilities: { drop: ["NET_ADMIN"] }   # ③ 与 server 逻辑对齐，防沙箱改网络栈
        volumeMounts: [{ name: opensandbox-bin, mountPath: /opt/opensandbox }]
      volumes:
      - name: opensandbox-bin
        emptyDir: {}
```

要点：
- initContainer 命名与安装动作照抄官方样例（`kubernetes/examples/`、`kubernetes/config/samples/`）；
- server `[kubernetes].execd_init_resources` 只作用于**直接创建**路径的 execd-installer 资源限额；池模板里资源写在自己模板里；
- 主容器镜像需含 shell（bootstrap.sh 是 sh 脚本）；最小镜像矩阵见[lifecycle hooks 文档 §组件最小镜像矩阵](opensandbox-lifecycle-hooks-osep0020-status-and-injection.md)。

### 3.2 拓扑选择：建议 execd-as-init（EXECD_INIT=1）

| 拓扑 | task 命令形态 | PID1 | SIGTERM 送达 execd |
|---|---|---|---|
| legacy task-shim（默认） | `bootstrap.sh <cmd> &`（放后台） | task-executor → shell | **收不到**（shim 在前） |
| execd-as-init（推荐） | `exec /opt/opensandbox/bootstrap.sh <cmd>` + `EXECD_INIT=1` | **execd --init** | ✅（收到后转发子进程） |

建议池模板现在就按 execd-as-init 建设（server 侧 `runtime.execd_run_as_init=true`，或池模板/手写 CR 自带 `EXECD_INIT=1`）：OSEP-0020 phase 4 的 `preTerminate` 仅支持该拓扑，提前采用迁移成本最低（实测文档 §7 R11 结论）。

### 3.3 版本矩阵（2026-09-01/03 实测基线）

| 组件 | 版本 | 版本红线 |
|---|---|---|
| controller + task-executor | `latest` | **≥ PR #420** 才支持 taskTemplate lifecycle 字段；≤ v0.2.0 会**静默抹字段** |
| execd | `v1.1.0` | ≥ v1.1.0 才有 OSEP-0020 phase1 hooks（v1.0.x 无） |
| egress | `latest`（≥ v1.1.7） | — |
| 主容器 | 按业务（如 code-interpreter v1.1.0） | 需含 shell |

### 3.4 端口 / 认证 / 权限速查

| 项 | 值 |
|---|---|
| 端口 | task-executor `5758`、execd `44772`、Jupyter `44771`、egress API/DNS/mitm `18080`/`15353`/`18081` |
| 认证头 | execd `X-EXECD-ACCESS-TOKEN`；egress `OPENSANDBOX-EGRESS-AUTH` |
| token 传递 | egress token 走 annotation `opensandbox.io/egress-auth-token`；sandbox_id 走 label `opensandbox.io/id` |
| 权限 | 主容器 drop `NET_ADMIN`；egress sidecar add `NET_ADMIN`；execd isolation 另需 `CAP_SYS_ADMIN` + seccomp/AppArmor Unconfined |
| 共享卷 | `opensandbox-bin` emptyDir → `/opt/opensandbox`（二进制 + mitm CA `/opt/opensandbox/mitmproxy-ca-cert.pem`） |

### 3.5 注入与初始化路径

- **分配时注入**：BatchSandbox `taskTemplate` 带 `env` / `entrypoint` / `execd_run_as_init` 任一即走 taskTemplate 注入路径；三者全无则走"零修改认领" fast path——**fast path 无法注入任何 per-allocation env**（需要注入用户信息的场景必须带 taskTemplate）。详见[池化分配时间点动态注入调研](opensandbox-pool-allocation-time-injection.md)与[用户信息注入示例](opensandbox-task-template-user-info-injection-example.md)。
- **生命周期钩子（OSEP-0020 phase1-2）**：create/手写 CR 传 `OPENSANDOox_LIFECYCLE` env（JSON）→ execd 校验落盘 `~/.execd/lifecycle.toml` → 执行 `preStart`/`periodic`；池模式手写 CR 直注已实测打通。详见[lifecycle hooks 状态与注入路径](opensandbox-lifecycle-hooks-osep0020-status-and-injection.md)。
- **收尾回调**：task-executor 层 `postStop` 在优雅删除时触发（含补跑）；**硬杀（OOM/节点故障/强杀）覆盖不到**——业务产物收尾需保证优雅删除路径 + 足够 grace period，硬杀兜底等 phase 4 `preTerminate`。

### 3.6 网络隔离分层（结合业务决策）

1. **基线（所有池化沙箱）**：K8s NetworkPolicy——同 ns 沙箱互隔、白名单 IP/端口/label；无域名级能力；
2. **敏感沙箱**：单独加 egress sidecar（域名白名单 + Credential Vault 假凭据注入），按 [SOP](opensandbox-egress-netpol-vault-sop.md) 操作；
3. **未来**：fleet 共享 MITM（OSEP-0022 A1）跟踪上游，暂不可端到端。

同 ns 互隔实测：netpol 开启后沙箱 A→B 的 5758/44772 均 blocked，池化链路（controller→task-executor 管理面）不受影响。

### 3.7 避坑清单

| # | 坑 | 应对 |
|---|---|---|
| 1 | controller/task-executor ≤ v0.2.0 静默抹 taskTemplate lifecycle 字段 | 升级 ≥ #420（helm `controller.image.tag=latest`） |
| 2 | fast path（零修改认领）无法注入 env | 需注入的场景必须带 taskTemplate（env/entrypoint/execd_run_as_init 任一） |
| 3 | legacy task-shim 拓扑 SIGTERM 送达不了 execd | 按 execd-as-init 建设池模板 |
| 4 | `execd-ebpf` 未接线 | 生产勿用 |
| 5 | netpol 无域名白名单 | 域名级走 egress sidecar 或 CNI 扩展（Cilium toFQDNs） |
| 6 | egress sidecar 与 Istio/Envoy 互斥、gVisor 不兼容 | 同 Pod 二选一 |
| 7 | task-executor 层 hooks ≠ OSEP-0020 沙箱级 hooks | 分清 task 前后钩子与 execd 域钩子 |
| 8 | OPENSANDBOX_LIFECYCLE 是 transport-only | execd 落盘 `~/.execd/lifecycle.toml` 后 unset；排查以落盘文件为准 |
| 9 | task-executor 轮询端口 5758 在沙箱网络内可达 | netpol 白名单必须放行**管理面→沙箱 5758**，否则任务派发全挂 |
| 10 | sidecar/container 执行模式 | `--enable-container-mode` 为占位实现，勿依赖；`sidecar-mode` 需 nsenter 权限 |

---

## 4. 关联文档

- [沙箱配置参数与环境变量参考（全链路）](opensandbox-sandbox-config-and-env-reference.md) —— env/端口/配置优先级全集
- [BatchSandbox 3s 轮询 Task 执行机制调研](batchsandbox-task-3s-polling-exploration.md) —— controller↔task-executor 派发机制
- [用完即焚沙箱编排最佳模式](opensandbox-ephemeral-sandbox-orchestration-pattern.md) —— Pool/BatchSandbox 完整模板与避坑
- [Egress 出口管控与 Credential Vault 最佳实践 SOP](opensandbox-egress-netpol-vault-sop.md) —— sidecar 装配与操作步骤
- [Egress 出口管控验证报告](opensandbox-egress-netpol-vault-verification.md) —— netpol/Vault 实测记录（含 Pod 构成实测）
- [K8s NetworkPolicy vs Egress 边车对比](opensandbox-k8s-networkpolicy-vs-egress-sidecar.md) —— 隔离选型依据
- [OSEP-0020 生命周期钩子：实施状态与池模式注入路径](opensandbox-lifecycle-hooks-osep0020-status-and-injection.md) —— hooks 拓扑与最小镜像矩阵
- [池化分配时间点动态注入技术调研](opensandbox-pool-allocation-time-injection.md) —— env/entrypoint/taskTemplate 注入对比
