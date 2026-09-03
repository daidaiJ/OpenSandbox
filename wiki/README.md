# OpenSandbox 调研 / 方案文档索引（wiki）

本目录集中存放针对 OpenSandbox 的调研报告、技术方案与优化方案文档（用户约定）。

已落地 / 拟合入上游的二次开发改动说明见 [`changes/`](../changes/README.md)（勿与本 wiki 混放）。

> **维护规则**：新增 wiki 文档时，提交前必须同步更新本 README 索引；删除/重命名文档时同样需要同步。详见根目录 `AGENTS.md`。

## 调研与分析

> 🚧 标记 = 该文档追踪的**上游功能仍在逐步实现**（OSEP status: implementing），上游每合并一个新阶段后需回访同步本文档。

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
| [沙箱管理高阶 API 与参数参考（快速检索）](opensandbox-sandbox-management-api-reference.md) | 按业务能力查 API/参数：创建/注入/续约/查询/池管理；**2026-09-03 补 GET/LIST 响应字段详解与池化状态表（§2.3.1）** | 2026-08-19 |
| [示例：动态传递用户信息给 task 模板](opensandbox-task-template-user-info-injection-example.md) | user_id + user_auth_token 经 taskTemplate 注入沙箱（env / 文件两种方式） | 2026-08-19 |
| [池化模式出向管控与 Higress 分层架构](opensandbox-egress-pool-higress-architecture.md) | 定向阻断、特定服务（内外）放行、平台组件/业务运行时隔离、Higress L7 分层、NodePort 场景 | 2026-08-21 |
| [shardTaskPatches 机制详解与示例](opensandbox-shardtaskpatches-mechanism-and-examples.md) | 异构任务分发机制（strategic merge patch、下标对齐）、适用场景、完整示例与坑 | 2026-08-22 |
| [沙箱控制器多副本部署与调优参数调研](opensandbox-controller-multi-replica-tuning.md) | leader election 多副本 HA、concurrency/qps/burst 等调优参数清单 | 2026-08-27 |
| [Pool 容量四参数（poolMin/poolMax/bufferMin/bufferMax）调研](opensandbox-pool-capacity-params.md) | 池模式容量参数定义、滞回伸缩算法、调参要点与边界 | 2026-08-27 |
| [Pool 池模式扩缩容机理与延迟计算（运维手册）](opensandbox-pool-scaling-mechanism-ops.md) | 事件驱动机理、分配/扩容/缩容延迟公式与示例、参数范围表、观测与排查 | 2026-08-27 |
| [OSEP-0020 生命周期钩子：实施状态与池模式注入路径](opensandbox-lifecycle-hooks-osep0020-status-and-injection.md) | 🚧 **正在逐步实现的上游功能**：hooks 集与执行通道、分阶段实施状态（PATCH 未实现）、task/alloc 注入链路、池模式限制与替代方案；**2026-09-01 池模式手写 CR 直注实测打通**（periodic/postStop 双路径 + 组件最小镜像矩阵） | 2026-09-01 |
| [execd 命令执行 vs K8s exec，以及 egress 同 ns 隔离与路由前缀](opensandbox-execd-command-vs-k8s-exec-and-egress-isolation.md) | execd `/command` 与业务侧 `pods/exec` 设计/功能差异；egress 同 namespace 沙箱互隔离；FQDN 之外到不了 HTTP 路由前缀（Higress/Cilium L7） | 2026-09-03 |
| [Egress 出口管控验证报告：NetworkPolicy 池化隔离 + Credential Vault](opensandbox-egress-netpol-vault-verification.md) | ubuntu k3s 实测：netpol 池化隔离 13/13 用例、Vault 注入 V0–V9 场景（含 Host 形式不一致根因排查）、环境/镜像/权限/sidecar 全记录 | 2026-09-03 |
| [池模式沙箱 Pod 边车组件介绍与实践指导](opensandbox-pool-sandbox-sidecar-components-guide.md) | task-executor/execd/bootstrap/Jupyter/egress 五组件职责、Pod 装配骨架、execd-as-init 拓扑、端口/认证/权限速查、避坑清单 | 2026-09-03 |
| [K8s 池模式卷类型、配置限制与副作用实践](opensandbox-pool-mode-volumes-and-storage-practice.md) | spec 三后端（host/pvc/ossfs）支持矩阵、池化拒绝请求卷、回收策略×数据残留（Restart/Noop 泄漏坑）、RWX/RWO 副作用、S3+NAS 落地决策树 | 2026-09-03 |
| [K8s 池模式三大部署核心配置：controller / server / Pool CR](opensandbox-pool-deploy-core-config-guide.md) | helm values→flag 映射与版本红线、server K8s 运行时配置节、Pool CR spec/status 全字段、从零到可用 checklist | 2026-09-03 |

## 方案设计

| 文档 | 主题 | 状态 |
|---|---|---|
| [用完即焚沙箱编排最佳模式](opensandbox-ephemeral-sandbox-orchestration-pattern.md) | 无状态/任务型沙箱全流程资源生命周期流转 | 方案设计（未实施） |
| [共享存储挂载解释器镜像最小化与快速启动](opensandbox-shared-storage-interpreter-minimal-image.md) | 解释器镜像瘦身与共享存储加速启动可行性 | 可行性评估（未实施） |
| [OpenClaw Tool Plugin 设计方案](opensandbox-openclaw-tool-plugin-design.md) | 方式 B：官方 Tool Plugin 封装 JS SDK | 方案设计 |
| [OpenClaw 插件对接自部署 Server 配置指南](opensandbox-openclaw-plugin-selfdeployed-server.md) | 代理模式下插件对接自部署 OpenSandbox Server | 配置指南 |
| [池化沙箱业务会话 S3 用户目录静默同步](opensandbox-pooled-session-s3-sync-middleware.md) | 中间层静默恢复/回写；不向业务暴露 exec；固定 postStop + 内部注入脚本 | 部分实施（server） |
| [Egress 出口管控与 Credential Vault 最佳实践 SOP](opensandbox-egress-netpol-vault-sop.md) | 企业内部署三层管控分层（netpol 基线/敏感沙箱 sidecar/未来 fleet）、SOP-A/B/C 操作步骤与陷阱清单 | 落地 SOP（已实测） |
| [池化模式故障排查 Runbook](opensandbox-pool-troubleshooting-runbook.md) | 取证命令包 + 症状对号入座（创建 4xx/429/504、不就绪、派发失败、删不掉、数据残留、限流） | 落地 Runbook |
| [池化模式监控告警与容量水位 SOP](opensandbox-pool-monitoring-alerting-sop.md) | 池水位采集脚本（Pushgateway）、controller metrics 开启、9 条告警规则与处置联动、验收清单 | 落地 SOP |
| [OpenSandbox 升级与版本兼容 SOP](opensandbox-upgrade-compat-sop.md) | 兼容矩阵与版本红线、五步升级顺序、灰度三件事、静默抹字段检测、回滚对照表 | 落地 SOP |
| [池化模式容量规划与压测 SOP](opensandbox-capacity-planning-and-loadtest-sop.md) | 密度画像方法、create 延迟账、三场景压测（含脚本骨架）、capacitySpec 反推配法 | 方法论（数值待实测） |
| [池化沙箱日志与产物留存方案](opensandbox-pool-log-artifact-retention.md) | 既定路线：hostPath+日志易采日志、agent CLI 直推 S3 产物；目录规范、凭据注入、清理与验收 | 落地方案 |
| [K8s 池模式（无 pause/resume）文档覆盖度回顾与优先级建议](opensandbox-pool-mode-wiki-gap-analysis-and-roadmap.md) | 盘点 wiki 32 篇 + exporter 8 cookbook 已覆盖面；缺口清单 P0（Runbook/监控告警/升级 SOP）/P1（容量压测/日志留存/安全加固/多部门接入）/P2 与落地节奏 | 规划建议 |

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
openclaw-integration-analysis ──┬── openclaw-tool-plugin-design ──┬── openclaw-plugin-selfdeployed-server
                                └── open-issues-risk-review-no-pause-resume
openclaw-tool-plugin-design ──┴── execd-directory-listing-limits
egress-network-policy ──┬── k8s-networkpolicy-vs-egress-sidecar
                        └── egress-pool-higress-architecture ──┬── egress-internals-reference（附录）
                                                                └── exporter/egress-network-policy-cookbook（落地）
execd-command-vs-k8s-exec-and-egress-isolation ──┬── pool-allocation-time-injection（k8s exec vs taskTemplate）
                                               └── egress-pool-higress-architecture（L7 路由前缀）
egress-netpol-vault-verification ──┬── egress-netpol-vault-sop（落地 SOP）
                                   ├── k8s-networkpolicy-vs-egress-sidecar（选型依据）
                                   └── exporter/credential-vault-cookbook（Vault 机制）
pool-sandbox-sidecar-components-guide ──┬── pool-deploy-core-config-guide（Pool 模板装配 + 部署配置）
                                        ├── pool-mode-volumes-and-storage-practice（模板卷选型与残留坑）
                                        └── sandbox-config-and-env-reference（env 全集）
pool-mode-wiki-gap-analysis-and-roadmap ──（盘点全量 wiki + exporter cookbook，运维层缺口规划）
```
