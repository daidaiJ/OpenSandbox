# K8s 池模式（无 pause/resume）文档覆盖度回顾与优先级建议

> 日期：2026-09-03
> **状态更新（2026-09-03 当日）**：P0-1/2/3、P1-4/5 五项已落地成文——[故障排查 Runbook](opensandbox-pool-troubleshooting-runbook.md)、[监控告警 SOP](opensandbox-pool-monitoring-alerting-sop.md)、[升级兼容 SOP](opensandbox-upgrade-compat-sop.md)、[容量规划与压测 SOP](opensandbox-capacity-planning-and-loadtest-sop.md)、[日志与产物留存](opensandbox-pool-log-artifact-retention.md)（P1-5 方向已定：hostPath+日志易 / agent CLI→S3）。剩余 P1-6/7、P2 项仍按本文优先级排队。
> 盘点范围：`wiki/` 32 篇 + `exporter/` 8 篇 cookbook + `changes/`，以业务基线（内网 K8s、池化 use-and-burn、无 pause/resume、租户管控在业务层、S3 中间件 + NAS）为标尺。
> 结论：**"机制与参数"层已基本覆盖饱和；缺口集中在"运维动作"层——排障、告警、升级、容量实测、日志留存、安全与多部门接入。**

---

## 1. 已覆盖地图（无需重复建设）

| 领域 | 覆盖文档（wiki / exporter） | 成熟度 |
|---|---|---|
| 池化链路机制（CR 调谐、3s 轮询、分配/释放） | crd-controller-reconcile-analysis、batchsandbox-task-3s-polling、shardtaskpatches | ✅ 深 |
| 容量参数与扩缩容机理 | pool-capacity-params、pool-scaling-mechanism-ops、client-pool-warmup cookbook | ✅ 深（缺实测，见缺口 #4） |
| 网络隔离（netpol + egress sidecar + Vault） | egress 全系列 7 篇 + 2 cookbook | ✅ 深（已实测） |
| 注入（env/taskTemplate/hooks/用户信息） | pool-allocation-time-injection、task-template-user-info、lifecycle-hooks + cookbook | ✅ 深 |
| 生命周期与续约 | sandbox-lease-manual-cleanup、proxy-server-business-facts | ✅ |
| 用户数据持久 | S3 中间件（方案+实施） | ✅（池化路径闭环） |
| Pod 内组件、卷、部署配置、API 响应 | 边车组件指导、卷类型实践、三大部署核心配置、管理 API §2.3.1（2026-09-03 本批补齐） | ✅ 本批新增 |
| 上游跟踪 | exporter/README 跟踪表（OSEP-0020/0022、#1650/#1662 等） | ✅ 保持节奏即可 |

## 2. 缺口清单与优先级

### P0 —— 生产可用性刚需（建议先做）

| # | 缺口 | 内容大纲 | 依赖/输入 |
|---|---|---|---|
| 1 | **池化故障排查 Runbook** | 症状→根因→处置：create 400 系列（poolRef+volumes/networkPolicy 拒绝、taskTemplate 未触发走快路径）；create 卡 Pending（`POOL_CAPACITY_EXHAUSTED`→看 Pool available/扩池）；`Allocated` 不转 Running（探针/镜像/边车装配）；task 派发失败（5758 连通、taskTemplate 语法）；execd 44772 不就绪；Pod 卡 Terminating（finalizer/归还流程）；apiserver 429。每条附 kubectl 一键取证命令 | 管理 API §2.3.1 状态表、部署核心配置 §3.2、边车组件文档 |
| 2 | **监控告警与容量水位 SOP** | controller metrics 启用（helm `metrics.enabled`）；Pool status 指标采集（total/allocated/available/updated/revision）；沙箱 Pod 密度与节点资源水位；告警规则建议（available<bufferMin 持续 N 分钟、POOL_CAPACITY_EXHAUSTED 频次、Pod 启动 P95、CR 积压）；告警→扩池/扩容预案联动。**组件内 OTel 采集面 exporter cookbook 已写，本文档只做"监控体系+告警+值班动作"层** | node-agent-observability cookbook（采集面）|
| 3 | **升级与版本兼容 SOP** | 兼容矩阵固化（controller ≥ #420、execd ≥ v1.1.0、server v0.2.3、egress v1.1.7、chart 0.2.1）；升级顺序（CRD→controller→池模板 execd 镜像滚动→server）；灰度（测试池先行 + 手写 CR 冒烟）；回滚步骤与"静默抹字段"类版本坑的检测方法 | lifecycle-hooks §7 版本坑、部署核心配置 §1 |

### P1 —— 规模化与安全（业务硬约束驱动）

| # | 缺口 | 内容大纲 | 依赖/输入 |
|---|---|---|---|
| 4 | **容量规划与压测 SOP** | 单节点密度画像（沙箱 Pod 资源画像含 task-executor/execd 开销）；启动风暴（池补货 + 分配并发）压测方法与脚本；分配延迟实测分解（3s 轮询 + 认领 + ready）；bufferMax/poolMax 上限验证。**"节点资源有限、服务更多用户"决策需要这份数据支撑** | 扩缩容机理文档的延迟公式、client-pool-warmup cookbook |
| 5 | **池化沙箱日志与产物留存方案** | Delete 回收即焚 → 任务失败取证难、stdout/stderr 随 Pod 丢失。方案对比：OTel filelog sidecar（每 Pod 成本）/ 节点级 DaemonSet 采集 / postStop 钩子回传 / S3 中间件产物路径扩展；给推荐组合与灰度步骤 | lifecycle hooks（postStop 能力边界：硬杀覆盖不到）、卷类型文档（Restart 残留坑） |
| 6 | **安全加固手册** | RBAC 最小化（controller/server SA 权限面）；ResourceQuota/LimitRange（工作负载 ns）；api_key + 传输加密；私有 registry 供应链（镜像扫描/签名）；审计数据源梳理（server 访问日志、K8s audit、egress 审计事件、S3 中间件操作日志）→ 对接企业审计平台 | egress SOP（审计事件部分已有）、部署核心配置 §2.3 |
| 7 | **业务层多部门接入 SOP** | namespace/池规划模式对比（每部门独立池+server 实例 vs 共享池+metadata 隔离）；user→部门→namespace 映射落地；metadata 打标规范（可被 GET/LIST 回显与过滤，见 §2.3.1）；配额/审批流与业务层对接；配额超限的降级响应（POOL_CAPACITY_EXHAUSTED 语义复用） | D-3/D-4 决策、管理 API 参考 |

### P2 —— 预案与治理（可排后）

| # | 缺口 | 内容大纲 |
|---|---|---|
| 8 | 孤儿资源巡检 SOP | 孤儿 PVC（预存卷不随池删）、无主 BatchSandbox、expireTime 漏网资源、store 与集群状态一致性巡检周期表 |
| 9 | 灾备预案 | server 无状态重建演练（PostgreSQL 恢复）、store/Redis 故障降级行为、节点故障下池补充、单集群→多集群演进触发条件 |
| 10 | 上游演进跟踪 | 维持 exporter/README 跟踪表节奏：OSEP-0022 fleet、#1650 池容量指标（落地后可替代缺口 #2 部分自建采集）、#1662 池化任务失败状态语义 |

## 3. 落地节奏建议

1. **第一周**：#1 Runbook（纯整理已有事实即可成文，性价比最高）+ #3 兼容矩阵部分（从现有文档抽表）；
2. **随后两周**：#2 监控告警（先手动采集 Pool status + node_exporter 级指标，再接 Prometheus）；#4 压测（产出密度画像，反哺 capacitySpec 与节点规划）；
3. **一个月内**：#5 日志留存选型决策（影响镜像与模板，宜早不宜晚）；
4. **按需插入**：#6/#7 跟企业安全与多部门接入时间表走；#8/#9 排维保窗口。

> 维护提醒：#2/#4/#10 与 exporter/README 上游跟踪表存在数据依赖——上游落地（如 #1650 池容量指标）后应回访更新本文档优先级。
