# OpenSandbox Kubernetes 算子缺陷与坑总结（性能 & 规模化）

- 日期：2026-08-07
- 范围：`kubernetes/`（controller-runtime v0.21.0 / client-go v0.33.0），配套 `server/` 消费侧与 Helm 部署
- 来源：4 路子智能体深度调研（CRD 状态机 / 调谐逻辑 / 调度器与注解流 / 性能审计），关键证据已人工复核（文件:行号）
- 规模假设：数百~数千 BatchSandbox / Pool、数千 Pod

---

## 一、性能缺陷（按优先级）

### P0-1 任务型 sandbox 每 3s 无条件轮询
- **症状**：稳态无任何业务变化时，控制器仍持续高频 reconcile；规模化后 CPU/API 压力线性上涨，reconcile 延迟失控
- **根因**：task 调度状态纯内存、无事件机制，代码强制周期性调度（注释原文："Because tasks are in-memory and there is no event mechanism, periodic reconciliation is required"）
- **证据**：`kubernetes/internal/controller/batchsandbox_controller.go:274-275`；requeue 消费在 :230-235
- **量化**：1000 个任务型 sandbox ≈ **333 reconcile/s 稳态**；且 `RequeueAfter` 走 `AddAfter` **绕过 workqueue 限流**（指数退避只保护返回 error 的路径）
- **触发条件**：`spec.taskTemplate != nil` 且未 Paused —— 对沙箱平台是主流路径
- **应对**：改事件驱动（task-executor 状态上报）+ 心跳降频/分桶错峰；短期可调大 `--concurrency=batchsandbox` 缓解排队

### P0-2 Pod 事件无过滤放大
- **症状**：任意 Pod 状态波动（kubelet 状态写、容器重启、注解变更）触发整池全量 reconcile
- **根因**：BatchSandbox 与 Pool 的 `Owns(Pod)` 均无 predicate；Pool 每事件执行 2 个 O(pool) List + 逐 sandbox 注解解析 + 调度算法
- **证据**：`batchsandbox_controller.go:642-643`；`pool_controller.go:365`（Owns 无谓词）、:148-170（两处 List）
- **量化**：5000 pod 池，每分钟 5% pod 变化 → 250 次 O(5000+2000) 全量 reconcile/分钟，且整段包在 `RetryOnConflict` 内（`pool_controller.go:189`）
- **应对**：为 `Owns(Pod)` 增加 predicate（仅 phase/ready 变化入队）

### P0-3 Helm 默认资源限额过小
- **症状**：数千 CR + 数千 Pod 场景下 OOMKill / CPU 节流
- **证据**：`charts/opensandbox-controller/values.yaml:28-33` —— limits 500m/128Mi、requests 10m/64Mi
- **叠加因素**：全集群 informer 缓存（数百 MB 量级）+ 每 sandbox 调度器状态 + HTTP 轮询
- **应对**：上调限额（或改 HPA）；评估 128Mi 下批量创建/回收潮的内存峰值

### P1-1 注解 churn 级联（分配/释放写放大）
- **症状**：批量分配/回收潮时 API 写放大 + reconcile 级联背压
- **根因**：每次分配把 pod 数组 JSON 整表覆盖式 MergePatch 写 `alloc-status`（`allocator.go:139-175`），并发 256（`pool_controller.go:71`）；`alloc-release` 一次写入同时触发 BatchSandbox + Pool 两个 controller（`pool_controller.go:277-280` 谓词专门放行）
- **证据**：`allocator.go:271-300, 357-403`；`batchsandbox_status.go:291-310`（endpoints 注解）
- **量化**：kube-client QPS 默认 100（`main.go:197-198`）封顶分配吞吐；每笔状态变更 ≈ 2 次 reconcile（status 自环，见 F-1）
- **应对**：注解写前比对去重、增量式合并批量写；复核 256 并发与 QPS 100 的匹配

### P1-2 全集群 informer + 无界内存结构
- **症状**：内存随集群 Pod 总数线性增长；事件潮下全局锁争用
- **根因**：Manager 未设 Cache 选项（全 namespace 全类型 watch，`main.go:398-413`）；allocator 内存 map（`allocator.go:28-33`）、taskSchedulers sync.Map（`batchsandbox_controller.go:74`）、ScaleExpectations **全局互斥锁**（`scale_expectations.go:44-52`）均无上限
- **应对**：Cache 加 namespace/selector 限定；期望缓存按对象分片

### P1-3 每 3s HTTP 轮询风暴 + 日志序列化
- **症状**：任务型 sandbox 稳态压向 pod 内 task-executor 与控制器 CPU；日志爆炸（默认轮转 100MB/份）
- **根因**：状态收集对每个有 IP 的 pod 发 HTTP GET，semaphore 容量 = len(ipList)（**无界全并发**，`status_collector.go:44-74`）；每轮把全部任务状态 DumpJSON 打 Info 日志（`status_collector.go:72`、`batchsandbox_controller.go:289`）
- **应对**：日志降级到 Debug；HTTP 轮询加并发上限与超时分级

### P2-1 Pool reconcile 每轮 O(pool sandboxes+pods)
- **症状**：大池下单事件成本高；冲突时整段重跑放大写
- **根因**：每轮对池内所有 sandbox 构建请求、每个做 2 次注解 JSON 解析（`allocator.go:456-580`），再跑 PackedSchedule；`updatePoolStatus` 整对象 `Status().Update`（非 patch）；revision 每次 sha256 模板 JSON
- **应对**：调度结果缓存/增量重算；status 改 Patch

### P2-2 启动与批量创建首轮风暴
- **症状**：控制器重启恢复慢；批量创建千级 sandbox 首轮并发 GET 风暴
- **根因**：`Recover` 全集群无选择器 List（`allocator.go:69-74`，失败 `os.Exit(1)`）；每个任务型 sandbox 首次 reconcile 对全部有 IP pod 无界并发 GET（`default_scheduler.go:196-202`，代码自注 TODO 建议新建 scheduler 跳过 recovery）
- **应对**：Recover 加选择器/分批；新 scheduler 跳过 recovery

### P2-3 池化模式 listPods 逐 Pod Get
- **症状**：replicas 大的 sandbox 每轮 R 次 Get（cache 读但逐对象深拷贝）
- **证据**：`batchsandbox_controller.go:338-346`，代码自注 `// TODO maybe performance is problem`
- **应对**：改为按 label 一次 List

### P2-4 并发不均衡
- **症状**：批量 snapshot/pause 串行阻塞；故障切换 15s 空窗
- **根因**：SandboxSnapshotReconciler 无 `WithOptions`（并发默认 1，`sandboxsnapshot_controller.go:196-202`）；leader election 单 leader 不可水平扩展（默认 15s/10s/2s，`main.go:403-409`）
- **应对**：snapshot 并发上调（注意 pause 内部快照幂等约束）；评估多 leader 分片

### P3 级
- 无 label index 的 label List（resume/snapshot 全 namespace 扫描）：`batchsandbox_pause_resume.go:152`、`sandboxsnapshot_lifecycle.go:222,553`
- 每 reconcile 常数成本（DeepCopy、排序、ObserveScale 全局锁）：`batchsandbox_status.go:139`、`batchsandbox_controller.go:178-184,528`

---

## 二、特性坑（行为陷阱）

### F-1 BatchSandbox status 更新自环
- **坑**：`For(BatchSandbox)` 无 predicate，**status 更新本身会触发新的 reconcile**；`StatusRVExpectation`（`batchsandbox_status.go:229-245`）只能抑制"写了又重算再写"，无法阻止事件排队 → 每笔状态变更实际 ≈ 2 次 reconcile
- **影响**：状态频繁变化（任务计数、phase 翻转）时放大事件量
- **踩坑提示**：不要依赖"改 status 不会触发 reconcile"的假设（对比 Pool 有 `GenerationChangedPredicate`）

### F-2 任务执行是 at-least-once 语义
- **坑**：控制器重启/调度器重建时 `recover()` 从 pod 内 `/getTasks` 反推任务归属，**已执行过的任务可能被再次下发执行**（`recovery.go:40-46` 注释明确）
- **影响**：非幂等任务（发消息、写外部系统、计费）可能重复执行
- **踩坑提示**：业务侧任务需自带幂等键；不能依赖平台保证 exactly-once

### F-3 pause 只支持单副本（replicas=1）
- **坑**：`supportedPauseReplicas = 1`（`batchsandbox_pause_resume.go:21`）；多副本 sandbox 请求 pause 会 ACK 回原 phase + `PauseFailed(UnsupportedReplicas)`
- **影响**：多副本场景无法 pause/resume，需先缩到 1（而缩容未实现，见 F-4）——**死锁组合**
- **踩坑提示**：`server` 侧 `pause_sandbox` 只允许 Succeed 状态（`batchsandbox_provider.py:626`），多副本 sandbox 直接拒绝

### F-4 BatchSandbox 缩容未实现
- **坑**：`scaleBatchSandbox` 只有扩没有缩（`batchsandbox_controller.go:557` `// TODO var needDeleteIndex []int`）；`spec.replicas` 调小不会删 Pod
- **影响**：非池模式 replicas 只增不减；与 F-3 组合导致多副本无法变单副本
- **踩坑提示**：缩容只能靠删除整个 sandbox 或走 Pool 模式

### F-5 pooled 模式删除阻塞在 finalizer
- **坑**：池化 BatchSandbox 删除依赖 `pool.sandbox.opensandbox.io/pool-allocation` finalizer，**必须等所有分配 Pod 完成 recycle 才移除**（`allocator.go:369-396`）；若 recycle/驱逐卡住，sandbox 永远删不掉（terminating 悬挂）
- **叠加**：Pool 控制器挂掉/重启恢复失败（F-8）时，所有池化 sandbox 删除全部阻塞
- **踩坑提示**：删除前确认 Pool 控制器健康；应急需人工摘 finalizer（破坏一致性，慎用）

### F-6 注解契约的语义陷阱
- **坑 1**：`alloc-status` 是**整表覆盖式**写入——并发分配时以最后一次写入为准，丢更新风险依赖"先内存后注解、失败回滚"（`allocator.go:351-372`）保障，绕过内存 store 直接改注解会丢状态
- **坑 2**：`alloc-release`（进行中的释放请求）与 `alloc-released`（已确认释放）语义分离，`Recover` **只过滤后者、故意不过滤前者**（`allocator.go:100-114` 注释）——重启后"正在释放"的 pod 会被当作已分配
- **坑 3**：Pool 对 BatchSandbox 的普通 `alloc-status` 变化**不**触发 reconcile（谓词只放行 release/replicas/删除）——改 alloc-status 注解不会让 Pool 立即重算
- **踩坑提示**：annotation 是内部契约，改键/改 JSON 形状必须同步所有读写方（AGENTS.md 明令）

### F-7 分配状态真相源是注解，内存 store 可重建
- **坑**：池级分配聚合只在内存（`InMemoryAllocationStore`），重启后从注解反推；**若注解被外部修改/删除，内存与集群实际分配脱节**，可能出现同一 pod 被重复分配或分配表孤儿
- **缓解**：孤儿 pod 有 GC 逻辑（`getAllRequest` 对"在分配表但 sandbox 已删"的 pod 生成 ToRelease，`allocator.go:255-265`）

### F-8 恢复失败直接退出进程
- **坑**：首次 `Schedule()` 时 `store.Recover` 失败 → `os.Exit(1)`（`allocator.go:477-485`）——控制器 CrashLoop，且每次重启重试全集群 List（P2-2）
- **影响**：RBAC 权限错误、API server 抖动、大规模 List 超时都会导致控制器整体不可用
- **踩坑提示**：恢复应降级为"空分配表 + 后台重建"而非退出

### F-9 任务→Pod 绑定裸 HTTP、无认证
- **坑**：任务下发走 `http://<podIP>:5758` 裸 HTTP（`default_scheduler.go:159-167`），无认证/鉴权，安全边界完全依赖 pod 网络策略
- **影响**：同网络可触达 pod 的实体可向 task-executor 注入任务/读状态
- **踩坑提示**：部署时须配 NetworkPolicy；任务内容按不可信输入处理

### F-10 驱逐是硬删，非 Eviction API
- **坑**：`handler.Evict` = 直接 `client.Delete`（`eviction_default.go:41-47`），绕过 PDB/优雅终止；已分配给 sandbox 的 pod 即使带 evict label 也会被跳过（`pool_controller.go:935-939`），但空闲 pod 被硬删无宽限期
- **影响**：配合 P0-2 的事件放大，驱逐一批 pod 会产生一波整池 reconcile

### F-11 任务与 pod 一一绑定、每 pod 串行执行
- **坑**：`maxConcurrentTasks = 1`（`task_manager.go:40`）——每 pod 同时只能跑一个任务，第二个任务直接报错
- **影响**：`spec.replicas` 决定并行度；任务排队只能靠扩容（而扩容量受 Pool 供给与 F-4 约束）
- **踩坑提示**：高并发任务需求要提前规划 replicas/Pool buffer

### F-12 pause/resume 期间依赖 1s 轮询推进
- **坑**：pause/resume 各中间阶段靠 1s `RequeueAfter` 轮询 + snapshot Owns 事件双通道推进（`batchsandbox_pause_resume.go` 多处）；控制器短暂过载（P0-1）时轮询延迟放大，pause/resume 状态机卡在中间态
- **叠加**：resume 依赖快照镜像可拉取，registry 慢/挂会导致 resume 长期 Resuming

### F-13 snapshot 的 commit Job 信任面大
- **坑**：commit Job 挂载 containerd socket + hostPath、privileged 节点访问（`sandboxsnapshot_lifecycle.go:456-530`）；`BackoffLimit=3`、超时 10min
- **影响**：恶意 snapshot 请求可构造 Job 打源节点；image-committer 镜像本身是信任边界（AGENTS.md 明令改动需评审）

### F-14 Pool 滚动更新只滚 idle pod
- **坑**：`recreateUpdateStrategy` 只处理未分配给 sandbox 的 pod（`pool_update.go:35-90`）；被占用的 pod 要等释放回池才被滚
- **影响**：模板升级后旧版本 pod 可能长期占用池容量，升级周期 = 最长 sandbox 占用时长；更新期间可用池变小触发 5s 补货轮询（P0-1 之外另一周期性来源）

---

## 二.5 控制器自身更新 / 重启 / 调谐风暴风险（2026-08-07 补充）

事实基础（已核验）：`replicaCount=1`（`values.yaml:26`）；deployment **无 updateStrategy → 默认 RollingUpdate**（MaxSurge 25%→1、MaxUnavailable 25%→0，更新时新旧并存）；leaderElection 默认开启（`values.yaml:80`，15s/10s/2s，`ReleaseOnCancel: true`）；`terminationGracePeriodSeconds=10`；allocator store / taskSchedulers / DurationStore 全为内存态。

### 更新（RollingUpdate）期间
- **新旧双实例并存窗口**（新 pod 拉镜像→Ready 期间）：新 leader `Recover` 全量 List 重建内存 store 与旧 leader 尾巴写入竞态；`alloc-status` 整表覆盖式 MergePatch（非增量）→ 可能互相覆盖丢更新
- **契约不兼容**：新版本改注解 JSON 形状/CRD schema 时，并存窗口内新旧代码对同一注解语义理解不同
- **资源叠加**：128Mi/500m 限额下双实例并存内存翻倍，OOM 概率上升
- **建议**：升级配 `maxUnavailable=0, maxSurge=0`；补 preStop 排空 hook（当前无）

### 重启（crash/OOM/手动）—— 启动调谐风暴
- **全对象同时入队**：informer 初始 List 对全部 CR 发 Add 事件 → 千级 sandbox 同时入队（无 jitter）→ 32 worker 队列打满（P0-1 的启动放大版）
- **首轮恢复风暴**：`Recover` 全集群 List + 每任务型 sandbox 首次 reconcile 对全部有 IP pod 无界并发 GET（`default_scheduler.go:196-202` TODO）→ 1000 sandbox × 3 pod ≈ 3000 并发 GET
- **任务重复执行**：taskSchedulers 内存态丢失 → `/getTasks` 反推 → at-least-once（F-2），重启即可能重复下发
- **服务空窗**：单 leader 双挂 ≈ 15s 租约 + 重启时间；期间池化删除阻塞（F-5）、pause/resume 卡中间态
- **CrashLoop 恶性循环**：`Recover` 失败 → `os.Exit(1)` → 重启重试全量 List（RBAC/API server 抖动时反复 CrashLoop，每次带一轮风暴）
- **建议**：3s 轮询首轮加启动 jitter（分散到 3~8s）；新建 scheduler 跳过 recovery（TODO 落地）；Recover 失败降级为空分配表 + 后台重试而非退出

### 运行时风暴入口（非重启）
批量创建/删除/暂停 sandbox（256 并发注解 Patch × 双 controller 级联）、池模板滚动/驱逐一批 pod（整池 O(N) 反复）、status 自环（F-1，每笔 ≈ 2 次 reconcile）。

## 三、已知结论性事实（设计边界，非缺陷）

- BatchSandbox 缩容、container executor（`runtime/container.go` 报 not implemented）、Pool 的持久化分配聚合（无 `PersistPoolAllocation`，AGENTS.md 描述与实际代码不符）均未实现
- 单 leader 架构：全集群缓存与轮询集中单进程，无法水平分摊（见 P2-4）
- `server` 侧 phase 映射为快照推导（Pending→CREATING 等），phase 为空时回退按 ready/allocated 推导（`batchsandbox_provider.py:779`）

---

## 四、建议的监控与应急

- **监控**：workqueue 深度/重试次数（controller-runtime metrics，Prometheus 默认关闭需开启）、`batchsandbox` reconcile 耗时 P99、任务型 sandbox 3s 轮询实际周期、`alloc-status`/`alloc-release` 注解写入 QPS、controller 内存/CPU（对照 128Mi/500m 限额）
- **应急**：`--concurrency=batchsandbox=N` 临时提升处理能力；`--kube-client-qps/burst` 上调（注意与 256 并发注解写的匹配）；日志级别降为 error；资源限额上调；避免在高峰期批量创建/删除 sandbox（注解 churn 级联）

---

## 五、关联文档

- 生命周期流转与性能风险完整分析：`wiki/opensandbox-crd-controller-reconcile-analysis.md`
- 官方设计文档：`kubernetes/docs/guides/pause-resume.md`、`kubernetes/docs/`（E2E 排障）、`docs/kubernetes/index.md`
