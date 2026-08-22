# 业务背景与决策记忆（Business Context & Decision Log）

> 本文档是 OpenSandbox 下游业务的**权威背景记忆**，供 agent 与开发者快速恢复业务上下文。
> 维护规则：业务背景/约束/架构决策变化时，先更新本文档，再同步 `AGENTS.md` 的 Business Context 与 `exporter/README.md` 背景描述。
> 关联：`AGENTS.md`（Business Context 摘要）、`wiki/README.md`（调研/方案索引）、`changes/README.md`（已实施改动）

---

## 1. 业务场景

大型企业**内部智能体服务**：多部门/多团队 agent 协作，运行在**企业内网 K8s 集群**上。

- 负载特征：**短任务为主**（知识库问答、代码片段、流程查询，~80%），长会话交互为辅（业务辅助、多轮调试，<20%）
- 数据敏感：企业敏感数据（业务数据、内部资料、IP）需强隔离 + 审计，数据不出内网

## 2. 硬约束（按优先级）

| # | 约束 | 含义 |
|---|------|------|
| 1 | **资源有限** | 节点 CPU/内存不充裕，无无限云端资源 |
| 2 | **更多用户 > 售出时长** | 单位资源服务更多用户比单用户会话时长更重要 |
| 3 | **服务质量与稳定性** | 资源回收不能导致体验崩溃；故障域要小 |
| 4 | **业务层租户控制** | 租户/配额/审计由上层业务系统管理，不依赖沙箱平台多租户功能 |
| 5 | **namespace 审批制** | 部门 namespace 是审批制资源：静态、受控、数量有限 |
| 6 | **内网/离线** | 私有镜像仓库、无公网依赖 |
| 7 | **数据安全** | 强隔离 + 审计，敏感数据分级管控 |

## 3. 架构决策（含决策理由）

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| D-1 | **租户控制上移业务层**，不用 server `[tenants]` | 业务层已有 IAM/审批流程；namespace 审批制天然静态受控；server 退化为执行引擎 | 2026-08-22 |
| D-2 | **每部门一个 server 实例**（部门多时改单实例 + tenants 映射） | 配额/密钥/审计随 namespace 走；隔离彻底；故障域小 | 2026-08-22 |
| D-3 | **池化主路径**（Pool + BatchSandbox + taskTemplate），用完即焚 + 短 TTL | 资源有限下密度优先；任务完成即归还 Pod（`policy=Release`）；批量 O(1) 交付 | 2026-08-22 |
| D-4 | **任务型负载不走 pause/resume/快照**（重建优于快照） | commit Job 10min 超时 + registry push/pull 全是净开销；无状态任务重建成本低 | 2026-08-22 |
| D-5 | **产物走 S3 中间层**（静默恢复/回写，按用户目录） | 池化模式 API 拒绝 volumes（预热 Pod 无法动态加卷）；卷级细粒度权限做不到；S3 权限由中间层控制 | 2026-08-22 |
| D-6 | **共享只读数据静态预置 Pool 模板**（模型/数据集） | 所有沙箱可见的静态数据不需要动态卷；只读挂载防误写 | 2026-08-22 |
| D-7 | **去 egress sidecar，用 K8s NetworkPolicy** | 省 20~50MB/沙箱；内网出站目标可控（IP/CIDR 够用），域名级白名单需求低 | 2026-08-22 |
| D-8 | **用户信息经 taskTemplate env 注入**（分配时） | 业务层 create 传参、server 分配时注入；token 不进命令行日志 | 2026-08-22 |
| D-9 | **Pool bufferMin=0**（不常驻预热） | 预热 Pod 是纯开销；按需扩容 + poolMax 上限 | 2026-08-22 |
| D-10 | **超卖**（requests 小 / limits 大，2~3 倍） | 内部可信负载；K8s 按 requests 调度 | 2026-08-22 |

## 4. 平台选型结论（OpenSandbox vs CubeSandbox）

- **主选 OpenSandbox**：租户配额 + K8s 稳定性（故障域小、暂停态跨节点存活）+ 暂停零节点占用 + 协议开放可二次开发 + 无部署前提
- **CubeSandbox 不选**（当前）：需裸金属 KVM（不支持嵌套虚拟化）、无租户配额、暂停快照在节点本地盘（节点故障连暂停态一起丢）、跨节点恢复在 roadmap
- 详细对比：`agent-teams-docs` 仓库 `opensandbox-vs-cubesandbox-selection.md`（企业内网智能体服务场景）

## 5. 关键机制参考

| 主题 | 文档 |
|---|---|
| 用完即焚编排 | `wiki/opensandbox-ephemeral-sandbox-orchestration-pattern.md` |
| S3 产物中间层 | `wiki/opensandbox-pooled-session-s3-sync-middleware.md` + `changes/pooled-session-s3-sync.md`（已实施） |
| 异构任务分发 | `wiki/opensandbox-shardtaskpatches-mechanism-and-examples.md` |
| 用户信息注入 | `wiki/opensandbox-task-template-user-info-injection-example.md` |
| 网络隔离选型 | `wiki/opensandbox-k8s-networkpolicy-vs-egress-sidecar.md` |
| 镜像瘦身 | `wiki/opensandbox-shared-storage-interpreter-minimal-image.md` |
| 静默重建感知 | `changes/954-runtime-perception-proxy.md`（已实施） |
| 实操 Cookbook | `exporter/README.md` |

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-22 | 初版：业务场景、硬约束、架构决策 D-1~D-10、平台选型结论 |