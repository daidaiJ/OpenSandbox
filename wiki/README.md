# OpenSandbox 调研 / 方案文档索引（wiki）

本目录集中存放针对 OpenSandbox 的调研报告、技术方案与优化方案文档（用户约定）。

已落地 / 拟合入上游的二次开发改动说明见 [`changes/`](../changes/README.md)（勿与本 wiki 混放）。

> **维护规则**：新增 wiki 文档时，提交前必须同步更新本 README 索引；删除/重命名文档时同样需要同步。详见根目录 `AGENTS.md`。

## 调研与分析

| 文档 | 主题 | 日期 |
|---|---|---|
| [CRD 控制器调谐逻辑与规模化性能风险分析](opensandbox-crd-controller-reconcile-analysis.md) | BatchSandbox/Pool 调谐逻辑、调度器与注解流、规模化性能风险 | 2026-08-07 |
| [Kubernetes 算子缺陷与坑总结（性能 & 规模化）](opensandbox-controller-defects-and-pitfalls.md) | 控制器缺陷、性能瓶颈、规模化陷阱（数百~数千 BatchSandbox/Pool） | 2026-08-07 |
| [BatchSandbox 3s 轮询 Task 执行机制调研](batchsandbox-task-3s-polling-exploration.md) | controller/scheduler/task-executor/CRD 轮询执行机制 | 2026-08-07 |
| [接入 OpenClaw 方式分析](opensandbox-openclaw-integration-analysis.md) | OpenSandbox 与 OpenClaw 集成方式对比与推荐方案 | 2026-08-12 |
| [上游 Open Issues 风险调研（禁止暂停/恢复场景）](opensandbox-open-issues-risk-review-no-pause-resume.md) | 无状态沙箱下未修复缺陷与规模化风险（gh 拉取上游 open issues） | 2026-08-13 |
| [Pool Pod 模板更新与 Pod 分配行为排查](opensandbox-pool-template-update-and-allocation.md) | 模板更新只重建 idle pod、分配不区分 revision、pod→sandbox 无所有权注解、换新 pod 操作指南 | 2026-08-18 |
| [execd 目录读取工具与 Server Proxy 限制](opensandbox-execd-directory-listing-limits.md) | `/directories/list` 与 `/files/search` 限制、proxy 的 secure-access/runtime-id 门禁 | 2026-08-18 |
| [沙箱续约机制与伪永久（manual cleanup）调研](opensandbox-sandbox-lease-and-manual-cleanup.md) | TTL 过期、renew-expiration 手动续约、OSEP-0009 自动续约、不传 timeout 伪永久 | 2026-08-18 |
| [业务流量走 Server Proxy 代理的业务事实梳理](opensandbox-proxy-server-business-facts.md) | 连接拓扑、proxy 行为、自动续约生效条件、生命周期选择与边界 | 2026-08-18 |
| [Egress 网络策略调研](opensandbox-egress-network-policy.md) | egress 组件定位、sandbox_id 归因、域名/IP 配置、K8s 池模式预置、CAP_NET_ADMIN | 2026-08-19 |
| [K8s NetworkPolicy vs Egress 边车隔离方案对比](opensandbox-k8s-networkpolicy-vs-egress-sidecar.md) | 两种网络隔离方案的优缺点对比、OpenSandbox 取舍与落地组合 | 2026-08-19 |
| [池化分配时间点动态注入技术调研](opensandbox-pool-allocation-time-injection.md) | 分配时注入配置/脚本的技术对比（taskTemplate/lifecycle/bootstrap/ConfigMap/exec） | 2026-08-19 |
| [创建沙箱参数说明书（池化模式）](opensandbox-create-sandbox-params-reference.md) | 池化模式参数（生效/忽略/拒绝）、extensions 编解码、OSEP-0009 续约 | 2026-08-19 |
| [沙箱管理高阶 API 与参数参考（快速检索）](opensandbox-sandbox-management-api-reference.md) | 按业务能力查 API/参数：创建/注入/续约/查询/池管理 | 2026-08-19 |
| [示例：动态传递用户信息给 task 模板](opensandbox-task-template-user-info-injection-example.md) | user_id + user_auth_token 经 taskTemplate 注入沙箱（env / 文件两种方式） | 2026-08-19 |
| [池化模式出向管控与 Higress 分层架构](opensandbox-egress-pool-higress-architecture.md) | 定向阻断、特定服务（内外）放行、平台组件/业务运行时隔离、Higress L7 分层、NodePort 场景 | 2026-08-21 |
| [shardTaskPatches 机制详解与示例](opensandbox-shardtaskpatches-mechanism-and-examples.md) | 异构任务分发机制（strategic merge patch、下标对齐）、适用场景、完整示例与坑 | 2026-08-22 |
| [业务背景与决策记忆](opensandbox-business-context.md) | 业务场景、硬约束、架构决策 D-1~D-10、平台选型结论、变更记录（权威背景文档） | 2026-08-22 |

## 方案设计

| 文档 | 主题 | 状态 |
|---|---|---|
| [用完即焚沙箱编排最佳模式](opensandbox-ephemeral-sandbox-orchestration-pattern.md) | 无状态/任务型沙箱全流程资源生命周期流转 | 方案设计（未实施） |
| [共享存储挂载解释器镜像最小化与快速启动](opensandbox-shared-storage-interpreter-minimal-image.md) | 解释器镜像瘦身与共享存储加速启动可行性 | 可行性评估（未实施） |
| [OpenClaw Tool Plugin 设计方案](opensandbox-openclaw-tool-plugin-design.md) | 方式 B：官方 Tool Plugin 封装 JS SDK | 方案设计 |
| [OpenClaw 插件对接自部署 Server 配置指南](opensandbox-openclaw-plugin-selfdeployed-server.md) | 代理模式下插件对接自部署 OpenSandbox Server | 配置指南 |
| [池化沙箱业务会话 S3 用户目录静默同步](opensandbox-pooled-session-s3-sync-middleware.md) | 中间层静默恢复/回写；不向业务暴露 exec；固定 postStop + 内部注入脚本 | 部分实施（server） |

## 参考

| 文档 | 主题 |
|---|---|
| [沙箱配置参数与环境变量参考（全链路）](opensandbox-sandbox-config-and-env-reference.md) | server 配置 → pod/容器 env 注入 → execd / task-executor / egress / Jupyter |
| [Egress 实现细节进阶参考（附录）](opensandbox-egress-internals-reference.md) | egress 内部机制：TTL、iptables/nft、HTTP API 细节、环境变量全集（主文档引用，非业务必读） |

## 关联关系速览

```
crd-controller-reconcile-analysis ──┬── controller-defects-and-pitfalls ──┬── ephemeral-sandbox-orchestration-pattern
                                   │                                      │         └── pooled-session-s3-sync-middleware
                                   │                                      └── shared-storage-interpreter-minimal-image
                                   └── sandbox-config-and-env-reference
                                        └── pool-template-update-and-allocation
batchsandbox-task-3s-polling-exploration ──┬── shardtaskpatches-mechanism-and-examples
                                           └── task-template-user-info-injection-example
business-context（权威背景）──┬── 全部调研/方案文档（约束与决策的出处）
                             └── ../exporter/README.md（背景摘要）
openclaw-integration-analysis ──┬── openclaw-tool-plugin-design ──┬── openclaw-plugin-selfdeployed-server
                                └── open-issues-risk-review-no-pause-resume
openclaw-tool-plugin-design ──┴── execd-directory-listing-limits
egress-network-policy ──┬── k8s-networkpolicy-vs-egress-sidecar
                        └── egress-pool-higress-architecture ──┬── egress-internals-reference（附录）
                                                                └── exporter/egress-network-policy-cookbook（落地）
```
