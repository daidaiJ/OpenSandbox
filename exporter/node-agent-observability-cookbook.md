# 可观测与审计采集 Cookbook（OSEP-0010 OTel / OSEP-0019 Node Agent）

业务硬约束"强隔离 + 审计"需要两层观测：**组件指标/日志**（execd/egress/ingress，OSEP-0010 已实现）与**沙箱日志归档**（nodeagent 采集，OSEP-0019 实现中，v1 范围有池化限制）。本篇讲清各自能拿到什么、怎么开、池化主路径的缺口在哪。

**前提**

| 项 | 约定 |
|---|---|
| 部署 | 池化主路径（无 per-sandbox egress sidecar，D-7）；业务流量走 server proxy |
| 审计分界 | 沙箱内审计由业务层（D-1）+ 平台组件日志共同承担；nodeagent 是平台侧补充 |
| 注意 | `docs/guides/sdk-telemetry.md` / `sdk-tracing.md` 是 **SDK 客户端侧**遥测，与本文组件侧 OTel 不是一回事 |

## 目录

- [1. 观测面全景](#1-观测面全景)
- [2. 组件 OTel：指标与日志（OSEP-0010）](#2-组件-otel指标与日志osep-0010)
- [3. 出向访问审计日志（egress）](#3-出向访问审计日志egress)
- [4. Node Agent 容器日志归档（OSEP-0019）](#4-node-agent-容器日志归档osep-0019)
- [5. 池化业务落地建议](#5-池化业务落地建议)
- [6. 相关上游 issue](#6-相关上游-issue)
- [参考](#参考)

---

## 1. 观测面全景

| 层 | 载体 | 内容 | 状态 |
|---|---|---|---|
| 组件指标 | execd / egress / ingress | HTTP 时延、执行/文件操作、策略命中、路由、系统资源 | ✅ OSEP-0010 |
| 组件日志 | egress（zap JSON stdout）+ 未来 in-sandbox audit trail | 出站访问、策略变更审计 | ✅（audit trail 本体是独立未来 OSEP） |
| 沙箱容器日志 | nodeagent DaemonSet | 采非池化沙箱主容器 stdout/stderr → OSS/file | ⚠️ v1 明确**不含池化任务文件** |
| server/池容量指标 | server | 沙箱/池容量低基数指标 | ❌ 上游 issue **#1650** 待实现 |
| tracing | — | OSEP-0010 明确 Non-goal（无 trace_id，靠 sandbox_id+时间戳关联） | 不做 |

## 2. 组件 OTel：指标与日志（OSEP-0010）

**开启方式**：纯 `OTEL_*` 环境变量（标准命名），推模式直达 OTLP endpoint（Collector 可选）；不配置则 noop 零影响。身份维度自动注入：execd 用 `OPENSANDBOX_ID`，egress 用 `OPENSANDBOX_EGRESS_SANDBOX_ID`（进 Resource/指标/日志）；可经 `OPENSANDBOX_EXECD_METRICS_EXTRA_ATTRS` / `OPENSANDBOX_EGRESS_METRICS_EXTRA_ATTRS` 追加低基数维度。

**池化落地**：OTel env 通过 **Pool 模板 env 预置**（`pool-pod-template-cookbook.md`），模板改完只重建 idle Pod。核心指标：

| 组件 | 关键指标 |
|---|---|
| execd | `execd.http.request.duration`（路由模板维度）、`execd.execution.duration`（run_code/run_in_session/run_command）、`execd.filesystem.operations.duration`、`execd.system.cpu/memory/process` |
| egress | `egress.dns.query.duration`（仅 allow 路径）、`egress.policy.denied_total`、`egress.nftables.rules/updates.count`、系统资源 |
| ingress | `ingress.http.request.count/.duration`、`ingress.routing.resolutions.*`、`ingress.proxy.http.requests_total`、`ingress.proxy.websocket.connections_total` |

**注意事项**：

- 范围仅 Metrics + Logs；egress 的 OTLP log 导出 in-tree 未实现（日志走 zap JSON stdout，需节点侧收集器接走）。
- **禁高基数**：HTTP 指标只用路由模板非原始 path；主机名/IP 进日志不进指标标签。
- 高 QPS 下组件日志量大，唯一调节手段是调低组件日志级别（无独立开关，无采样/过滤 SPI）。

## 3. 出向访问审计日志（egress）

egress 组件默认 info 级输出两条审计事件（结构化 JSON）：

| 事件 | 内容 |
|---|---|
| `opensandbox.event=egress.outbound` | 每条出站 DNS 尝试：`sandbox_id` / `target.host` / `target.ips` / `peer`（IP 直连）/ `error` —— "沙箱试图访问了什么" |
| `egress.loaded` / `egress.updated` / `egress.update_failed` | 策略加载与增删改审计（含 rules 摘要与 default 动作） |

⚠️ **适用性**：这两条挂在 egress sidecar/fleet 组件上。池化主路径按 D-7 **没有** egress sidecar → 出向审计当前由 K8s NetworkPolicy（只有拒绝计数，无访问明细）+ 网络侧设施承担。引入 fleet 共享 egress（OSEP-0022）后此审计即生效，见 `credential-vault-cookbook.md` §5。

## 4. Node Agent 容器日志归档（OSEP-0019）

**是什么**：每节点一个 DaemonSet（`components/nodeagent`），持续采集沙箱容器 stdout/stderr 并持久化到对象存储，提供完整性声明。与业务审计的契合点：把 egress/execd 的结构化审计日志随容器日志一起归档，为未来 in-sandbox audit trail 提供复用的发现/富化/传输层。**但原始 stdout ≠ 审计记录**（上游原话口径）。

**架构**：K8s watch（nodeName→podUID→sandbox_id 富化）→ inotify 读 kubelet `/var/log/pods/` → pipeline（批处理、全局字节预算 + per-sandbox 队列背压）→ 单一 Sink；bbolt 本地 checkpoint（`NODEAGENT_STATE_DIR`），durable 至少一次，产物带 `finalized` 标记与 `complete / complete-with-drops / incomplete` 状态。

**v1 范围与限制（重点）**：

| 项 | 现状 |
|---|---|
| Source | 仅 `container-logs` 一个（"多 record sources"框架已合入，stock 二进制 v1 仍只此一个）；syscall/文件/网络审计均为未来 Source |
| **池化范围** | **只采非池化沙箱 Pod**（带 `opensandbox.io/id` 且**无** pool-name 标签）——池化任务走 task-executor 文件，不在主容器标准流里，**v1 明确不覆盖池化主路径** |
| Sink | 内置 `oss`（AppendObject，对象族按 cluster/ns/sandbox_id/pod 分层）与 `file`（hostPath）；S3/GCS/Loki/ClickHouse 需自写 Sink |
| 溢出策略 | `NODEAGENT_DROP_POLICY=block`（默认，背压）/`drop`；kubelet 日志保留期即缓冲上限，无独立磁盘 spool |
| 处理器 | v1 无过滤/脱敏/采样 |
| 运维 | fail-closed（无有效 Sink 不启动 Source）；换 Sink 目标须 drain 并清空 state 目录 |

**部署**：Helm chart `kubernetes/charts/opensandbox-node-agent/`（`values.yaml` 配 Sink/预算/DROP_POLICY；RBAC 仅 pod list/watch + 只读挂载，非特权）。

## 5. 池化业务落地建议

| 动作 | 现在/将来 | 说明 |
|---|---|---|
| Pool 模板预置 `OTEL_*` env（execd 指标） | ✅ 现在就能做 | 执行时延/文件操作/资源指标直达 OTLP；proxy 入口的业务 QPS 由业务层埋点补齐 |
| 审计主体 | ✅ 业务层（D-1） | 沙箱内命令/文件审计由业务层工具链承担；平台侧审计等上游 audit trail OSEP |
| nodeagent 归档 | ⚠️ 池化不适用 | 仅对**直建**长会话沙箱有价值（会话日志合规归档）；池化任务的产物/日志走 S3 中间层（D-5），别指望 nodeagent |
| server/池容量指标 | 跟踪 **#1650** | 池水位/分配延迟观测当前靠 server 日志 + K8s 指标自建；#1650 落地后可直接用 |
| egress 出向审计 | 将来 | 随 fleet egress 灰度引入（§3） |

## 6. 相关上游 issue

- **#1650** controller: expose low-cardinality sandbox and pool capacity metrics——池水位/容量观测的最大缺口。
- **#1662** Pool-mode sandbox reports Running even when its task failed——观测盲区：池化状态不能替代业务任务结果校验（另见 `client-pool-warmup-cookbook.md` §6.6）。
- **#1665** server structured error code for backend-connection failures on proxied routes（502 报文前缀）——proxy 链路错误可观测性待改善。
- **#1450** 优化 BatchSandbox 状态维护机制——状态机语义持续演进的跟踪入口。

## 参考

- 提案：`oseps/0010-opentelemetry-instrumentation.md`（implemented）、`oseps/0019-node-agent-sandbox-collection.md`（implementing）
- 实现：`components/internal/telemetry`、`components/egress/pkg/telemetry`、`components/nodeagent/pkg/`（source/containerlogs、pipeline、sink）
- 部署：`kubernetes/charts/opensandbox-node-agent/`
- 姊妹篇：`credential-vault-cookbook.md`（fleet egress 引入条件）、`pool-pod-template-cookbook.md`（模板 env 预置）、`sandbox-management-cookbook.md`（proxy 流量路径）
- 相关 wiki：`opensandbox-controller-multi-replica-tuning.md`（controller 侧观测参数）
