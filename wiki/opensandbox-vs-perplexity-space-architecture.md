---
name: opensandbox-vs-perplexity-space-architecture
description: Perplexity SPACE 沙箱架构拆解、与 OpenSandbox 的能力对照，以及面向池化主路径的吸收优先级
type: project
---

# Perplexity SPACE 沙箱架构拆解与 OpenSandbox 可吸收项

> 调研日期：2026-10-23
> 调研对象：GitHub `perplexityai/SPACE`（Sandboxed Platform for Agentic Code Execution，Apache 2.0，2026-10 开源）及其官方架构文档、Perplexity 博客。
> 对照基线：本仓当前 `main` 的 K8s 池化路径（Pool + BatchSandbox + task-executor）、容器 pause/resume、Fast Sandbox 微虚机路径、egress/Credential Vault。
> 结论口径：本文把"可吸收"限定为**能落到 OpenSandbox 现有分层、且不与内网 K8s、节点资源受限、池化短任务为主、业务层管租户这些约束冲突**的机制。SPACE 的性能数字均为其官方自述，未独立复测。

## 一、结论先行

SPACE 的差异化不在"每沙箱一个 Firecracker microVM"这一条。OpenSandbox 已经有 Kata/Firecracker RuntimeClass 和 Fast Sandbox 微虚机路径，缺的不是隔离原语，而是四个工程化闭环：

1. **温池以不可变模板 release 为单位组织**：池按键 `(template release, vCPU, memory, encryptable)` 绑定，slot 有 `warming → ready → claimed → bound → cleanup_pending` 状态机，claim 与 bind 分离，失败可 release，冷启动是显式回退路径。
2. **生命周期显式区分 pause 与 suspend**：pause 保留 VM 内存驻留、不落盘；suspend 生成完整快照并上传对象存储、释放计算资源；另有周期性磁盘快照与回滚，构成"时间机器"。
3. **凭据在沙箱外集中管理**：凭据库在沙箱边界之外，按服务授权、限流、审计，必要时在网络层注入；TLS 拦截可按目的地豁免，且要求实时 DNS 绑定。
4. **管理面与数据面凭据分离**：生命周期 token 与命令会话 attachment token 不通用；命令流可断线续传（`Last-Event-ID`），数据面 SIGTERM 有明确的 drain 语义。

对当前 OpenSandbox 的**池化短任务主路径**，最值得吸收的是 1 和 2 里的可观测/状态机部分；3、4 更适合长会话池和敏感池，宜作为可选的加固档，而不是改变主路径。每沙箱 microVM 作为默认形态不建议吸收，理由见第五节。

## 二、SPACE 架构事实

### 2.1 三层结构

| 层 | 组成 | 职责 |
|---|---|---|
| Control plane | 无状态 API、PostgreSQL、controllers、direct/Kubernetes adapters | 认证授权、把请求写成期望状态、持续调谐；所有持久信息在共享数据库，API 崩溃可恢复 |
| Node-local services | sandbox manager、node manager、volume manager、credential manager、network gateway | 管理 VM、存储、网络、模板物化、快照上传下载；sandbox manager 无特权，特权操作交给唯一的 root 进程 node manager |
| Sandbox | Firecracker microVM +  guest 内 `space` daemon | 每个沙箱独立 guest 内核；daemon 只经私有通道与宿主通信，负责文件系统、进程、就绪与活动上报 |

`space` daemon 不直接面向客户端；客户端命令走独立 data plane，沙箱自身网络只承载业务出向流量。这一点与 OpenSandbox 的 execd 直连模型不同。

### 2.2 核心对象与生命周期

| 对象 | 含义 |
|---|---|
| Template | 起始文件系统与运行时配置；以 content hash 标识不可变 release |
| Sandbox | 一个 microVM，带独立可写文件系统和生命周期 |
| Process / Command session | 进程与一次命令的连接信息、授权；创建 session 分配进程 ID，attach 才启动进程 |
| Operation | 异步 create/pause/suspend/wake/delete 的记录，客户端轮询 |

生命周期状态：

| 状态 | 进程执行 | 保留内容 | 下一步 |
|---|---|---|---|
| Running | 可执行 | 活内存 + 可写文件系统 | 继续执行、pause、suspend、delete |
| Paused | 暂停 | VM 内存驻留 + 文件系统留在 worker；**不是持久快照** | wake |
| Suspended | 不执行 | VM 内存、运行时状态、rootfs 的完整快照；释放活跃 VM 资源 | wake，可在任意节点恢复 |
| Deleted | 不执行 | 不可再访问 | 重新创建 |

默认 6 小时无访问/无命令活动后自动 suspend；这是空闲上限，不是最大生存期。

### 2.3 快照分层

- **磁盘快照**：频繁采集，不暂停沙箱；用于文件系统回滚。
- **完整 checkpoint**：频率较低，捕获暂停 VM 的内存、vCPU、设备状态与 rootfs；用于崩溃恢复和 suspend。
- **保留策略按层衰减**；快照先留在节点本地。
- **suspend** 把完整快照上传对象存储，数据库行只有在所有 artifact 落盘后才标记可恢复，避免半上传快照被恢复到损坏状态；恢复不依赖原节点。
- **fork**：从会话快照分叉出多个沙箱，保留原会话的策略选择；fork 是独立沙箱，不是原沙箱的继续。

### 2.4 温池

SPACE 的温池不是简单的"多留几个 pod"，而是四层对象：

| 对象 | 作用 |
|---|---|
| `warm_pool_policies` | 哪个模板、什么规格要保持预热；ready 上下界；保留几个 release |
| `kubernetes_pool_configs` | 一个**不可变模板 release + 一种 VM 规格**的目标 ready 数、补池速度、最大 warming 数 |
| `kubernetes_pool_slots` + pod | 一个可认领的、已启动并暂停的沙箱；pod 上带 pool-config-id、slot-id、template、content-hash、**预留 sandbox-id** |
| Demand calculation | 按近期需求在 policy 边界内调整 config 的目标值 |

关键机制：

- **claim 用 `FOR UPDATE SKIP LOCKED`**，并发 create 不会拿到同一个 slot；claim 与 bind 是两个事务，bind 前失败可 release 回 `ready`，bind 后启动失败进入 `cleanup_pending`，不会回到库存。
- **create 准入时判断 hit / miss / ineligible / disabled**；不满足条件就冷启动，冷启动是正确性路径，温池只是优化。
- 请求同时指定 vCPU 和 memory 时只匹配同规格；都不指定时可匹配该 release 的任意规格。
- **admission-time claiming** 让原生 create 在记录请求的同一事务里认领 slot，并直接采用 slot 的预留 sandbox ID；否则原生 create 默认冷启动。
- 滚动策略保留最近 N 个 release 的预热，按需求在 `min_ready_slots` 与 `max_ready_slots` 之间伸缩；发布新 release 后旧池逐步排空。
- 补池有 `refill_per_tick`、`max_warming_slots` 节奏控制；warming 超时（默认 10 分钟）删除。

### 2.5 安全与数据面

- 节点级 network gateway 强制所有出向流量；在其 Kind 本地拓扑中，沙箱 pod 位于独立 `sandboxes` namespace，NetworkPolicy 只放行 API/controller 以及必要的 DNS/公网出口。
- 凭据库在沙箱外；凭据按层级作用域解析，支持注入方式、过期、限流、审计；BYOK 密钥不进入沙箱。
- TLS 拦截可按目的地豁免（域名或 IP）；域名豁免要求存在**实时观测到的 DNS 绑定**，防止 domain fronting；显式 deny 和平台 guardrail 优先。
- 管理 token 与 attachment token 不通用；data plane 副本收到 SIGTERM 时先停止监听、保留已 attach 的流、按 drain deadline 收尾；SSE 客户端可用 `Last-Event-ID` 续传（但不能补回已错过的输出）。
- 官方自述：create 中位延迟 185ms → 60ms（3.1x），p90 447ms → 89ms（5.0x）；上线首周数百万次创建、数千万次重连。均为厂商数据。

## 三、与 OpenSandbox 的能力对照

| 维度 | SPACE | OpenSandbox 现状 | 判断 |
|---|---|---|---|
| 隔离单元 | 每沙箱 Firecracker microVM，独立 guest 内核 | 默认 runc；gVisor/Kata-QEMU/Kata-Firecracker 经 `secure_runtime` 或 RuntimeClass；Fast Sandbox 直接 Firecracker | **不是能力缺口**，是默认取舍；主路径继续容器，敏感/长会话按需 Fast Sandbox |
| 控制面 | 无状态 API + PostgreSQL 期望状态 + controller；direct/K8s 两种 adapter | FastAPI server + K8s CRD/controller；Docker/K8s/FastSandbox 三种 runtime | 等价；SPACE 的 operation 记录与 create 幂等更显式 |
| 生命周期 | Running / Paused（内存驻留）/ Suspended（持久快照）/ Deleted | Running / Pausing / Paused / Resuming；容器 pause 把 rootfs 提交 OCI 并释放 pod；Fast Sandbox pause 为完整 checkpoint；QEMU vmstate 可选但受 node class 约束 | 容器路径缺"驻留暂停"与"持久 suspend"的显式区分 |
| 周期快照/回滚 | 磁盘快照频繁、完整 checkpoint 较低频、按层保留、可回滚 | 只有显式 snapshot；未见周期磁盘快照与 rollback API；镜像/快照保留由外部 registry 策略负责 | **明确缺口**（长会话价值高） |
| Fork/分支 | 会话可 fork 成多个沙箱，保留策略 | 可从 snapshot 新建沙箱（Fast Sandbox 含内存+rootfs；容器通常只有 rootfs；QEMU vmstate 公开 clone 尚不支持） | 部分覆盖；容器路径的"带内存 fork"缺失 |
| 温池组织 | 按 `(release, shape, encryptable)` 建池；slot 状态机；claim/bind；预留 sandbox ID；准入时认领；滚动保留 N 个 release；冷启动显式回退 | Pool 有 `bufferMin/Max`、`poolMin/Max`、`revision`、`updateStrategy`、`recycleStrategy`；分配按 `poolRef`/labels；模板更新只重建 idle pod，**分配不区分 revision** | **最大缺口，且正好落在池化主路径** |
| 模板标识 | content hash 固定 release；create 返回解析后的 digest；模板存储桶可加白名单 | 容器路径以镜像 tag/字符串为主；Fast Sandbox 使用 content-addressed artifact；Pool 有 revision hash 但不用于分配 | 容器路径缺 digest 固定与校验 |
| 存储 | btrfs CoW/reflink、NoCoW、节点本地快照、suspend 上传对象存储、单飞模板物化 | 容器 overlayfs；Fast Sandbox XFS reflink + DART + S3 内容寻址；容器 pause 走 OCI image commit | Fast Sandbox 已接近；容器路径的轻量快照/单飞物化缺失 |
| 网络 | 节点级 gateway + 每沙箱 NetworkPolicy；TLS 拦截按目的地豁免 + DNS 绑定；operator egress profiles | egress sidecar（或池模板预置）/ NetworkPolicy；DNS+nft；透明 TLS 拦截（实验性）；平台 overlay；未见按目的地 TLS 豁免 | 主路径用 netpol 已够；敏感池可吸收 TLS 豁免与 profile 组合 |
| 凭据 | 沙箱外凭据库；按服务授权；网络层注入；限流/审计；BYOK | Credential Vault 在 egress sidecar 内存；TLS 拦截时注入；真实密钥不进 workload；pause 后丢失需 re-inject | 注入机制已有；缺集中生命周期、审计与跨暂停持久性 |
| 数据面 | 管理/attachment token 分离；命令会话独立于沙箱和连接；SSE `Last-Event-ID`；SIGTERM drain | execd HTTP API + 沙箱级 access token；SSE 流；后台命令与日志；PTY | 未见会话级 token、流续传与明确的 drain 契约 |
| 空闲/唤醒 | 默认 6h 空闲 suspend；ingress 访问可唤醒；响应完成后再做生命周期转换 | OSEP-0024 的 idle auto-pause + ingress wake-on-access 目前面向 **Fast Sandbox**；容器池无空闲自动暂停 | 容器长会话池可吸收 |
| 兼容层 | ECW（E2B 兼容 API） | 原生 API/SDK；未见 E2B 兼容层 | 生态选项，不是架构刚需 |

## 四、适合吸收的项（按优先级）

### P0-1：温池按不可变 release + 规格绑定，引入 claim/bind 状态机

**解决的问题**：当前池模板更新只重建 idle pod，分配不区分 revision；突发创建时可能拿到旧 revision 的 pod，或者 pool 容量在途、删除中、换 revision 之间出现"看起来有 buffer、实际不可用"的窗口。多部门拆池后，`bufferMin` 底座碎片化也会放大。

**SPACE 做法**：一个 pool config 只服务一个 `template_releases.id` + 一种 shape；slot 有明确状态与所有权；claim 与 bind 分离；预留 sandbox ID；冷启动是显式回退。

**落到 OpenSandbox 的改法**：

1. 把 `Pool.status.revision` 提升为 create 可选择的 release 标识（content hash 或 digest），并在 `Pool.spec` 增加 shape 约束；`Pool.status` 增加 `readySlots`、`warmingSlots`、`claimedSlots`。
2. Pod label 已有 `sandbox.opensandbox.io/pool-revision`；让 allocator 的 predicate 增加 `release` 匹配，create 可传 `templateDigest`，不匹配就不进入该池。
3. 分配账本增加 claim 阶段：先写 claim（带 generation/lease），再绑定 sandbox；claim 超时或 pod 被删时 release；绑定后启动失败进入 cleanup，不回到 ready。
4. 预留 sandbox ID：pool pod 创建时写入 `sandbox.opensandbox.io/reserved-sandbox-id`，server 在 pool 模式下优先采用，减少 bind 往返。
5. 补池节奏显式化：`refillPerTick`、`maxWarming` 或复用 `scaleStrategy.maxUnavailable`，但要把"warming 中"与"ready"分开统计。
6. 滚动策略：保留最近 N 个 release 的预热，旧 release 的 idle pod 按 `updateStrategy` 排空；create 指定旧 digest 时，要么路由到对应旧池，要么明确失败并提示 digest 不再可用。

**适用边界**：池化主路径，收益最大；不引入 per-sandbox 常驻内存。

**改动面与风险**：`Pool` CRD 是公开契约，字段新增属 additive，但分配语义变化会影响现有业务；需要 CRD/controller/server/SDK 同步，按仓库 guardrail 先评审。claim 状态机要处理 controller 重启、pod 删除、revision 切换三种竞态。

**验证**：双 release 灰度 + 突发创建压测；检查是否出现跨 revision 分配、claim 泄漏、cleanup 回收；对比 p50/p99 create 延迟与 pool hit rate。

### P0-2：create 路径的 boot mode 可观测 + 单飞模板物化

**解决的问题**：冷启动回退目前是静默的；业务和运维无法从 API/指标判断一次突发到底命中了温池还是打到了冷启动。相同模板的并发首次拉取还可能放大 I/O。

**SPACE 做法**：准入结果为 `hit / miss / ineligible / disabled`；create 暴露实际 boot mode；模板/快照按 content hash 单飞物化，并发相同请求合并成一次下载。

**落到 OpenSandbox 的改法**：

1. 增加指标 `pool_create_path_total{mode="hit|miss|ineligible|disabled"}`、`pool_create_path_duration_seconds`、`pool_ready_slots`、`pool_warming_slots`。
2. create 响应 metadata 或响应头返回 `bootMode`（池命中/冷启动/不适用），至少写入 server 日志与 K8s event。
3. 对 Pool 模板的镜像/artifact 拉取做 per-node single-flight；容器路径可依赖 kubelet 镜像去重，但 S3 中间件、Fast Sandbox 模板物化需要显式合并。

**适用边界**：所有池化部署；改动小，先做这个再动 CRD。

**验证**：同一模板 50/100 并发创建，观察 `hit` 比例、冷启动数量、节点镜像拉取次数、p99 延迟。

### P1-1：两级暂停（驻留 pause / 持久 suspend）+ 空闲自动 suspend

**解决的问题**：容器 pause 目前要把 rootfs 提交成 OCI 镜像并释放 pod，恢复要重建；对长会话来说，恢复成本和镜像 registry 压力都偏高。Fast Sandbox 已有完整 checkpoint，但容器路径没有"先冻结、快速恢复"的轻量档。

**SPACE 做法**：Paused 保留内存驻留、不落盘；Suspended 才做完整快照并释放资源；默认 6 小时空闲自动 suspend。

**落到 OpenSandbox 的改法**：

1. 容器路径增加 `pauseMode=resident|durable`（或 `idleAction=freeze|snapshot`）：resident 用 cgroup freezer 冻结容器、保留 pod；durable 走现有 `SandboxSnapshot` OCI commit。
2. resident 暂停要有配额：节点上最多驻留多少个、最长驻留多久；节点压力、驱逐、TTL 到期时自动转 durable 或删除。
3. 把 OSEP-0024 的 idle auto-pause 从 Fast Sandbox 扩展到长会话容器池，活动探针复用 `idlePolicy.activeProbe`；短任务池不开启。
4. 恢复语义写清楚：resident 恢复只 unfreeze；durable 恢复重建 pod 并 re-inject 凭据。

**适用边界**：长会话池、需要人类在环暂停的场景；**不适用于用完即焚的短任务池**。

**风险**：驻留内存仍然占节点容量，和"密度优先"直接冲突；必须有每节点/每池的驻留预算，否则会把池化主路径的 headroom 吃掉。cgroup freeze 与 K8s 驱逐、健康检查、日志采集的交互需要实测。

### P1-2：周期性磁盘快照 + 回滚

**解决的问题**：Agent 执行破坏性命令（`rm -rf`、错误迁移、覆盖文件）后，当前只能从最后一次显式 snapshot 恢复；没有"回到 5 分钟前"的能力。

**SPACE 做法**：磁盘快照频繁、不暂停沙箱；完整 checkpoint 较低频；保留按层衰减；磁盘快照用于文件系统回滚。

**落到 OpenSandbox 的改法**：

1. 在长会话池的 node-agent 侧，对容器可写层做周期快照；优先用底层文件系统的 reflink/原子快照（XFS reflink、btrfs snapshot），overlayfs 场景需要短暂 freeze 或 fsync 后复制 upperdir。
2. 快照元数据记录 sandbox ID、时间、父快照、大小、校验和；保留策略按"最近 N 个 + 每小时/每天各若干"分层。
3. 增加 rollback API：停止容器、替换可写层、重启；rollback 后必须重新注入凭据、重建 endpoint。
4. 与现有 `SandboxSnapshot` 区分：周期快照是节点本地、轻量、短保留；显式 snapshot 是持久、可跨节点、可发布。

**适用边界**：长会话池、有 hostPath 的池；短任务池不做，避免 I/O 干扰和存储放大。

**风险**：overlayfs 没有 btrfs 那样的原子快照；freeze 时间、快照一致性、快照期间的写放大都要实测。建议先做 spike，不直接改公共 API。

### P1-3：外部凭据代理与短时凭证（与业务层集成）

**解决的问题**：当前 Credential Vault 在 egress sidecar 内存里，pause 后丢失、需要 re-inject；缺少集中签发、按服务授权、审计和限流。对敏感部门，凭据生命周期应该由业务层/独立服务掌握。

**SPACE 做法**：凭据库在沙箱外，按层级作用域解析，支持过期、限流、审计；网络层注入；BYOK 密钥不进入沙箱。

**落到 OpenSandbox 的改法**：

1. 业务层作为 credential authority，按 sandbox/tenant/service 签发短 TTL、最小 scope 的凭据；egress sidecar 只持有 TTL 内的注入材料，不持久化。
2. sidecar 通过 mTLS/服务 token 向 authority 换取凭据；每次签发/拒绝写审计事件（actor、subject、resource、scope、outcome），不记录明文。
3. pause/resume 后重新换取；不住留跨暂停的 secret。
4. 与 OSEP-0023 的 credential-bound TLS 衔接：authority 只负责签发，注入仍由 sidecar 完成。

**适用边界**：敏感部门、需要审计的租户；主路径可继续用现有 Vault。

**风险**：跨业务层边界，需要契约和故障降级；authority 不可用时必须 fail-closed，不能回退到无凭据直连。

### P2-1：数据面会话级 token、SSE 续传、SIGTERM drain

**解决的问题**：execd 目前是沙箱级 access token；一个 token 泄露可操作整个沙箱。命令流断线后没有 `Last-Event-ID` 续传；data plane 重启/滚动升级时缺少明确的 drain 契约。

**SPACE 做法**：管理 token 与 attachment token 分离；命令 session 有独立授权；SSE 可续传；SIGTERM 先停止监听、保留已 attach 流、按 deadline 收尾。

**落到 OpenSandbox 的改法**：

1. execd 增加命令/PTY session 级 token，scope 到 session ID + TTL；生命周期 token 不能用于数据面，数据面 token 不能管理生命周期。
2. SSE 增加 event ID 与有界 replay buffer；客户端带 `Last-Event-ID` 重连时补发可用片段，明确"错过的输出不保证补回"。
3. 定义 drain：停止接受新连接、保留已 attach 流、deadline 后取消；网关/代理配合 preStop 摘流量。

**适用边界**：长会话、多租户审计；短任务收益有限。

### P2-2：TLS 拦截按目的地豁免 + DNS 绑定

**解决的问题**：当前 egress 对 80/443 默认拦截；遇到证书固定、mTLS、特殊 SDK 时只能整体关闭拦截或加端口，缺少"按目的地放行明文透传"的细粒度开关。

**SPACE 做法**：`tls_interception_exemptions` 使用与 egress 规则相同的 destination selector；域名豁免要求实时 DNS 绑定；显式 deny 与平台 guardrail 优先；豁免本身不授予 egress 权限。

**落到 OpenSandbox 的改法**：

1. egress policy 增加 `tlsInterceptionExemptions`（domain/IP/CIDR），只影响是否终止 TLS，不改变 allow/deny。
2. 域名豁免必须匹配当前 DNS 解析绑定；没有绑定则回到正常拦截，防止 domain fronting。
3. 显式 deny、平台 overlay 优先于豁免；豁免不绕过 HTTP 检查与凭据注入，只是不终止 TLS。

**适用边界**：启用透明 TLS 拦截的敏感池；纯 netpol 路径不需要。

### P2-3：fork 作为一等操作（容器路径的带内存分支）

**现状**：Fast Sandbox 的 snapshot 已经可以"从运行中沙箱发布 artifact，再创建新沙箱"，语义上接近 fork；容器路径的 snapshot 通常只有 rootfs，QEMU vmstate 的公开 clone 还不支持。

**可吸收点**：如果要做"同一会话探索多个分支"，需要把 fork 明确成独立操作：新 sandbox ID、继承源 sandbox 的 egress policy/profile 选择、可选继承内存状态（仅 provider 支持时）、源沙箱不被修改。对短任务池没有价值。

### P2-4：operation 记录与 create 幂等

**现状**：pause/resume/snapshot 已经是 202 + 异步；create 仍以同步等待为主。突发场景下客户端重试可能产生重复沙箱。

**可吸收点**：create 接受 `Idempotency-Key`，返回 `operationId`；operation 记录期望状态与终态，重试返回同一结果；controller/server 崩溃后按 operation 继续收敛。对池化突发和业务侧重试有价值，但改动面较大，放在 P2。

### 可选（产品/生态，不是架构）

- **ECW 式 E2B 兼容层**：SPACE 用 edge wrapper 兼容 E2B API。OpenSandbox 目前是原生 SDK；如果目标客户大量使用 E2B 生态，做一个只翻译生命周期/命令/文件子集的兼容层，比改内核更划算。需要单独评估契约覆盖与长期维护成本。

## 五、不建议吸收的项

| 项 | 原因 |
|---|---|
| 每沙箱 Firecracker 作为默认运行时 | 与"节点资源受限、服务更多用户优先"冲突；guest 内核、页缓存、预热实例都按租户线性叠加。OpenSandbox 已有 Fast Sandbox/Kata-FC，按敏感度选择性使用即可 |
| btrfs NoCoW 作为通用优化 | 与 Firecracker rootfs 镜像和 btrfs 缓存强绑定；容器 overlayfs 路径不适用。只有在 Fast Sandbox 存储层做专项时才考虑 |
| 用 PostgreSQL 重写控制面 | OpenSandbox 的 K8s CRD 已经是期望状态模型；重写会破坏现有 runtime 抽象和运维方式，收益低 |
| BYOK / 完全离线 | 内网部署已经满足离线；BYOK 是商业合规特性，当前业务层没有这个需求 |
| 对短任务池做周期快照/时间机器 | 快照 I/O 和存储会直接吃掉密度预算；短任务"重建优于快照"的既定立场不变 |
| 把 `space` daemon 的私有通道照搬到所有沙箱 | execd 直连是 OpenSandbox 数据面的性能与简单性来源；只在敏感池做可选加固，不作为默认 |

## 六、落地路线建议

| 阶段 | 内容 | 产出/验收 | 预估 |
|---|---|---|---|
| 0 | P0-2：boot mode 指标与日志；梳理现有 Pool revision/alloc 注解的竞态 | 一张突发创建 dashboard；能区分 hit/miss/cold | 3–5 天 |
| 1 | P0-1：Pool release 绑定 + claim/bind 状态机 + 预留 sandbox ID | 双 release 灰度不串版；claim 泄漏为 0；突发 p99 不退化 | 2–3 周 |
| 2 | P1-1/P1-2 spike：长会话池的 resident freeze + 周期快照 | 单部门试点；给出内存/存储/I/O 账本与回滚 RTO | 3–4 周 |
| 3 | P1-3/P2-1：业务层凭据代理 + 会话级 token | 审计事件闭环；暂停恢复后凭据可重取；token 越权测试通过 | 3–4 周 |
| 4 | P2-2/P2-3：TLS 豁免、fork 语义 | 仅在启用 MITM 的敏感池；fork 作为独立 API | 按需 |

**顺序理由**：P0 不改变隔离形态和资源模型，直接改善池化主路径的确定性与可观测性；P1 需要额外的内存/存储预算，必须先有账本再上线；P2 是安全与生态增强，可以在前两阶段稳定后推进。

## 七、待验证与风险

1. **SPACE 文档仍在快速演进**：仓库 2026-10 才开源，部分文档（如 execution environments、native-api hardening）描述的是内部实现契约；本文只取与 OpenSandbox 可类比的部分，落地前应以代码为准复核。
2. **厂商性能数据未复测**：60ms/89ms create 延迟来自 Perplexity 博客，测试条件（模板、节点、并发、是否命中温池）未公开；不能直接作为 OpenSandbox 的目标值。
3. **claim/bind 在 K8s 上的实现方式与 SPACE 的 PostgreSQL 行锁不同**：需要用 resourceVersion/lease/annotation 做乐观并发，重点验证 controller 重启、pod 删除、revision 切换三种竞态。
4. **resident pause 与密度约束冲突**：必须有每节点驻留预算和自动降级策略，否则会重现"池化 headroom 被吃掉"的问题。
5. **overlayfs 周期快照的一致性**：没有 btrfs 原子快照；freeze 窗口、fsync、写放大的实测结果决定是否值得做。
6. **CRD/公开 API 变更**：`Pool` 字段、create 的 `templateDigest`、pause mode 都属于公开契约，需按仓库 guardrail 先评审，并保证旧客户端兼容。
7. **凭据代理跨业务层**：authority 不可用时必须 fail-closed；审计事件不能包含明文；轮转与暂停恢复要有幂等语义。

## 八、参考

### SPACE

- 仓库：<https://github.com/perplexityai/SPACE>
- 架构：<https://github.com/perplexityai/SPACE/blob/main/docs/architecture.md>
- 温池（使用）：<https://github.com/perplexityai/SPACE/blob/main/docs/warm-pools.md>
- 温池（设计）：<https://github.com/perplexityai/SPACE/blob/main/docs/space/design/warm-pools.md>
- base snapshot：<https://github.com/perplexityai/SPACE/blob/main/docs/base-snapshots.md>
- rootfs backing：<https://github.com/perplexityai/SPACE/blob/main/docs/space/design/rootfs-backing.md>
- egress profiles：<https://github.com/perplexityai/SPACE/blob/main/docs/egress-profiles.md>
- 凭据 token exchange：<https://github.com/perplexityai/SPACE/blob/main/docs/space/design/credential-token-exchange.md>
- 博客（架构）：<https://www.perplexity.ai/hub/blog/making-space-secure-and-efficient-runtimes-for-long-running-agents>
- 博客（安全分层）：<https://www.perplexity.ai/hub/blog/secure-sandboxes-for-agents>

### OpenSandbox

- 架构总览：`docs/architecture/index.md`
- Pause/Resume：`docs/guides/pause-resume.md`
- QEMU VMState：`docs/guides/qemu-vmstate-snapshots.md`
- Fast Sandbox checkpoint：`docs/architecture/fast-sandbox/checkpoints.md`
- Fast Sandbox 模板：`docs/architecture/fast-sandbox/templates.md`
- Pool 设计：`docs/architecture/control-plane/operator.md`
- 池化分配与调优：`wiki/opensandbox-pool-tuning-and-assign-guide.md`
- Egress：`docs/architecture/network/egress.md`
- Credential Vault：`docs/guides/credential-vault.md`
- Execd：`docs/architecture/data-plane/execd.md`
- 安全运行时：`docs/guides/secure-container.md`
