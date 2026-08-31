# OpenSandbox 实操 Cookbook 索引（exporter）

本目录集中存放池化 K8s 部署下的实操 Cookbook（用户约定），与 `wiki/`（调研/方案文档）配套：wiki 讲"为什么"，本目录讲"怎么做"。

> **维护规则**：新增/删除/重命名 cookbook 时，必须同步更新本 README 索引，避免内容碎片化。

## 业务背景

本目录所有 Cookbook 服务于**企业内部智能体服务**（多部门/多团队 agent、内网 K8s、资源有限）。核心约束与架构决策：

- **资源有限**：节点 CPU/内存不充裕 → 池化主路径 + 用完即焚 + 短 TTL + 超卖，**更多用户 > 售出时长**
- **业务层租户控制**：租户/配额/审计在业务层，namespace 审批制（静态、受控）；server 退化为执行引擎
- **池化产物走 S3 中间层**：池化模式无法动态挂卷，产物按用户目录静默恢复/回写
- **去 egress sidecar**：用 K8s NetworkPolicy 省内存；共享只读数据静态预置 Pool 模板
- **任务型负载不走 pause/resume/快照**：重建优于快照

> 完整背景、决策理由与变更记录见仓库根 [MEMORY.md](../MEMORY.md)（权威业务记忆文档）；摘要见仓库根 `AGENTS.md` 的 Business Context。

## Cookbook 列表

| 文档 | 主题 | 关联 wiki |
|---|---|---|
| [沙箱创建与管理 API Cookbook](sandbox-management-cookbook.md) | 创建、注入、续约、查询、删除、池管理、流量路径（proxy vs lifecycle API） | `opensandbox-sandbox-management-api-reference.md` |
| [池化模式 Pod 模板定制 Cookbook](pool-pod-template-cookbook.md) | Pool 模板预设资源/卷/initContainer、分配时动态注入、更新池、参数边界 | `opensandbox-pool-template-update-and-allocation.md` |
| [Pod 生命周期钩子 Cookbook](pod-lifecycle-hooks-cookbook.md) | preStart / postStop 钩子机制与配置 | `opensandbox-pool-allocation-time-injection.md` |
| [池化模式统一出向管控 Cookbook](egress-network-policy-cookbook.md) | egress 预置、定向阻断/放行、平台组件隔离、Higress L7 分层、验证与故障排查 | `opensandbox-egress-pool-higress-architecture.md`（附录：`opensandbox-egress-internals-reference.md`） |
| [沙箱生命周期钩子 Cookbook（OSEP-0020）](sandbox-lifecycle-hooks-cookbook.md) | 🚧 上游实现中：两套钩子辨析、preStart/periodic 用法、池化替代方案、execd-as-init 铺路、阶段切换清单 | `opensandbox-lifecycle-hooks-osep0020-status-and-injection.md` |
| [客户端池预热与分配延迟 Cookbook（OSEP-0005/0021）](client-pool-warmup-cookbook.md) | client SandboxPool 语义、Python/Kotlin 参数与用法、bufferMin=0 组合策略、坑清单 | `opensandbox-pool-capacity-params.md`、`opensandbox-pool-scaling-mechanism-ops.md` |
| [凭据注入 Cookbook（OSEP-0012）](credential-vault-cookbook.md) | Vault/Proxy 原理、`/credential-vault` API、fail-closed 前提、fleet MITM 现状与迁移触发条件 | `opensandbox-egress-pool-higress-architecture.md` |
| [可观测与审计采集 Cookbook（OSEP-0010/0019）](node-agent-observability-cookbook.md) | 组件 OTel 指标/日志、egress 审计事件、nodeagent 归档 v1 范围（池化不适用）、落地建议 | `opensandbox-controller-multi-replica-tuning.md` |

## 上游功能跟踪速览（2026-08-31，upstream/main @ `f91f153c`）

| 上游项 | 状态 | 业务结论 | 详见 cookbook |
|---|---|---|---|
| OSEP-0020 沙箱生命周期钩子 | 🚧 implementing（phase 1-2 落地；PATCH、池化未实现） | 池化暂用 env + entrypoint 包装；模板按 execd-as-init 铺路 | sandbox-lifecycle-hooks |
| OSEP-0005 / 0021 client pool 与预热 | 0005 implemented；0021 draft（Kotlin 先行落地） | 可选叠加：小 maxIdle + DIRECT_CREATE 兜底；是否值得先量化分配延迟 | client-pool-warmup |
| OSEP-0012 Credential Vault | per-sandbox 已落地（README 表未刷新）；fleet 的 server 编排未落地 | 短期维持 D-8 env 注入；满足触发条件再迁 | credential-vault |
| OSEP-0022 fleet 共享 egress | 数据平面 A1 已合入；server 侧编排（phase 1a）未落地 | 每 Pod 一份形态与 D-7 收敛；敏感 Pool 灰度引入 | credential-vault §5 |
| OSEP-0010 OTel 指标/日志 | implemented | Pool 模板预置 `OTEL_*` env 即可用 | node-agent-observability |
| OSEP-0019 nodeagent 采集 | implementing | v1 只采非池化沙箱，池化主路径不适用 | node-agent-observability |
| OSEP-0003 Volume | implementing | 池化 create 仍拒绝 volumes（server 校验），D-5 S3 中间层维持 | — |
| 上游 issue | #1455（hooks 跟踪）、#1594（vault 持久化 RFC）、#1650（池容量指标）、#1662（池化任务失败仍 Running）、#1433（poolRef 修改杀在用 Pod） | 按需跟踪 | 各 cookbook issue 节 |

## 关联关系速览

```
sandbox-management-cookbook ──┬── pool-pod-template-cookbook ──┬── pod-lifecycle-hooks-cookbook（task 级）
                              │                                ├── sandbox-lifecycle-hooks-cookbook（OSEP-0020 沙箱级）
                              │                                └── egress-network-policy-cookbook
                              │                                     └── credential-vault-cookbook
                              └── wiki/opensandbox-egress-pool-higress-architecture
                                   └── wiki/opensandbox-egress-internals-reference（附录）
client-pool-warmup-cookbook ──┬── pool-pod-template-cookbook
                              └── wiki/opensandbox-pool-capacity-params / pool-scaling-mechanism-ops
node-agent-observability-cookbook ── credential-vault-cookbook（fleet egress 引入条件）
```