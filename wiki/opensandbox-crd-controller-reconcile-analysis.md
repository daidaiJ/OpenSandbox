# OpenSandbox CRD 控制器调谐逻辑调研与规模化性能风险分析

- 日期：2026-08-07
- 范围：`kubernetes/`（controller-runtime v0.21.0 / client-go v0.33.0，module `github.com/alibaba/OpenSandbox/sandbox-k8s`）
- 方法：4 路并行子智能体调研（CRD 状态机 / 调谐逻辑 / 调度器与注解流 / 性能审计），关键证据已人工复核

---

## 1. 总览

算子定义 3 个 CRD（API 组 `sandbox.opensandbox.io/v1alpha1`），3 个控制器：

| CRD | 控制器 | phase | 并发默认 | 说明 |
|---|---|---|---|---|
| BatchSandbox (`bsbx`) | BatchSandboxReconciler | 6 种 | **32** | 沙箱生命周期 + 任务调度 |
| Pool | PoolReconciler | 无 | **16** | 预热 Pod 池，分配/回收/滚动/驱逐 |
| SandboxSnapshot (`sbxsnap`) | SandboxSnapshotReconciler | 4 种 | **1**（无 WithOptions） | pause/resume 的 rootfs 提交 |

两条相互咬合的回路：

```
任务回路：BatchSandbox reconcile → TaskScheduler → HTTP 推任务到 pod 内 task-executor(:5758) → 轮询状态 → 写 status
分配回路：Pool reconcile → Allocator.Schedule → 写 alloc-status 注解 + 内存 store → 注解变化经 watch 触发对方 reconcile → 闭环
```

---

## 2. CRD 生命周期状态机

### 2.1 BatchSandbox（`apis/sandbox/v1alpha1/batchsandbox_types.go`）

phase 枚举（:27-33）：`Pending / Succeed / Pausing / Paused / Resuming / Failed`。稳定态 3 个，暂停中间态 3 个。

**稳态（`batchsandbox_status.go` `buildRuntimeView` :165）**：

```
Pod 出现 CrashLoopBackOff/ImagePullBackOff/ErrImagePull/CreateContainerConfigError → Failed (+PodFailed=True)
ready > 0 → Succeed
ready == 0 → Pending
```

**Pause/Resume 状态机**（`batchsandbox_pause_resume.go` `dispatchPauseResume` :176，5 分支分发表；幂等闸门 = `status.pauseObservedGeneration >= spec.generation` :206-222）：

```
[稳态 Pending/Succeed]
 │ spec.pause=true 且 generation 前进
 ▼
Pausing ── handlePause: ACK(gen+Pausing) → 停任务 → 创建内部 SandboxSnapshot "<bs>-pause"（仅 replicas=1 支持，否则 PauseFailed）
 │ syncPauseOrClear 轮询 snapshot:
 │   Succeed → completePause: 删 Pod（非池）/ 固化 template+清 poolRef（池）+ 去 finalizer → phase=Paused
 │   Failed  → 回 Succeed（Pod 尚存）或 Failed（Pod 丢失）+ PauseFailed=True
 ▼
Paused （稳定态；scale 停止、task scheduler 删除）
 │ spec.pause=false 且 generation 前进
 ▼
Resuming ── handleResume: ACK(gen+Resuming)
 │ continueResume: 读 snapshot → 用镜像 URI 重写 template + 注入 resume pull secret
 │ 快照丢失：有 ready Pod 直接 Succeed；否则回滚 Paused + ResumeFailed
 ▼
applyResumingRuntimePhase → Succeed（或 Failed）
```

**Conditions**（6 种）：`Ready / Progressing / Paused / PauseFailed / ResumeFailed / PodFailed`。`Failed` 为终态；`PauseFailed`/`ResumeFailed` 由 `mergeLifecycleConditions` 保护不被运行时状态覆盖。

**Server 侧消费**（`server/opensandbox_server/services/k8s/batchsandbox_provider.py`）：`pause_sandbox` 仅允许 `Succeed`；`resume_sandbox` 仅允许 `Paused`；phase 映射：Pending→CREATING、Succeed→RUNNING、Pausing→PAUSING、Paused→PAUSED、Resuming→RESUMING、Failed→FAILED。

### 2.2 SandboxSnapshot（`sandboxsnapshot_types.go` :25-29）

```
"" ──ackGeneration──► Pending ──handlePending──► Committing（创建 commit Job）──► Succeed（Job.Succeeded>0，写 digest）
                                                    └─► Failed（RegistryNotConfigured/BatchSandboxLookupFailed/SourcePodNotFound/NoContainers/BuildCommitJobFailed）
Succeed / Failed = 终态（updateSnapshotStatus 带终态保护，不允许翻转）
```

### 2.3 Pool

无 phase/conditions，状态 = `status.total/allocated/available/updated/revision`（`updatePoolStatus`，`pool_controller.go:793`）。可用节点 = 未分配且 Ready 的 Pod；updated = 带当前 revision label 的 Pod 数。

### 2.4 Finalizer（3 个）

| Finalizer | 添加位置 | 清理逻辑 | 用途 |
|---|---|---|---|
| `batch-sandbox.../task-cleanup` | `batchsandbox_controller.go:170-176`（有 taskTemplate 时） | `reconcileTasks` :295-310（停全部任务、等 task 资源 release 后移除） | 防删除时残留执行中任务 |
| `pool.sandbox.opensandbox.io/pool-allocation` | `allocator.go:283-295`（分配时与 alloc-status 注解同写） | `allocator.go:369-396`（删除中且全部 Pod 已 release）+ pause/resume 处 | 保证 pooled sandbox 删除前 Pod 全部归还池 |
| `sandboxsnapshot.../cleanup` | `sandboxsnapshot_controller.go:124-127` | `handleDeletion`（删 `<name>-commit`/`-unpause` Job） | 清理 commit Job |

Pool 本身无 finalizer。

---

## 3. 调谐逻辑与资源流转

### 3.1 触发源（SetupWithManager）

**BatchSandboxReconciler**（`batchsandbox_controller.go:640-647`）：
- `For(BatchSandbox)` **无 predicate**——包括 status 更新在内的所有事件都触发 reconcile（`StatusRVExpectation` 只能抑制重复写，无法阻止事件本身）
- `Owns(Pod)` 无 predicate；`Owns(SandboxSnapshot)` 无 predicate

**PoolReconciler**（`pool_controller.go:351-366`）：
- `For(Pool)` + `GenerationChangedPredicate`——Pool 自身 status 更新**不**触发 reconcile（与 BatchSandbox 的关键差异）
- `Owns(Pod)` 无 predicate——每个 pool pod 的任何事件 → 完整 pool reconcile
- `Watches(BatchSandbox)` 两路：① `findPoolForBatchSandbox`（:284）谓词 `filterBatchSandbox`（:262-292）只放行 **PoolRef 非空 且（alloc-release 注解变化 / spec.replicas 变化 / DeletionTimestamp 置位）**；② detach 专用（:338-349），PoolRef 从非空→空时入队旧 Pool 重新平衡

**SandboxSnapshotReconciler**（`sandboxsnapshot_controller.go:163-168`）：`For(SandboxSnapshot)` + `Owns(Job)`，均无 predicate。

### 3.2 主流程

**BatchSandbox.Reconcile**（:95-231）：Get → ExpireTime 处理 → 策略解析 → Pool 自动分配（`poolRef="*"` 时 List 全 ns Pool 选 profile 并 patch spec）→ finalizer → pause/resume 分发 → listPods → calPodIndex+排序 → 扩容（`scaleBatchSandbox`，仅扩不缩，`// TODO var needDeleteIndex []int` :557）→ buildRuntimeView（phase 计算）→ Paused 时清理 task scheduler → reconcileTasks（3s requeue）→ persistRuntimeView（endpoints 注解 + status patch）→ 返回 `RequeueAfter = DurationStore.Pop()`（多来源取最短）。

**Pool.Reconcile**（:117-246，整体包在 `retry.RetryOnConflict(retry.DefaultBackoff)` 内）：Get Pool → List Pods（ownerRefUID 索引）→ List BatchSandboxes（poolRef 索引，跳过 template 非空者）→ `reconcilePool`：重新 Get → handleEviction（驱逐带 evict label 的空闲 pod，硬删 `client.Delete`）→ scheduleSandbox（Allocator.Schedule → doAllocate 并行写注解 → doRelease 回收；`SupplyCnt>0` 时 requeue 5s）→ updatePool（revision + 滚动更新）→ scalePool（PoolMax 限制 + maxUnavailable 25% 步长）→ updatePoolStatus。

**SandboxSnapshot.Reconcile**（:104-160）：Get → 删除处理（handleDeletion）→ 加 finalizer（requeue 100ms）→ ACK generation → 按 phase 分发：Pending→建 commit Job；Committing→查 Job 状态推进；Succeed/Failed→等 BatchSandbox 消费。

### 3.3 资源创建/删除与幂等

- **BatchSandbox 建 Pod**：`scaleBatchSandbox` :523-618，命名 `<bs>-<idx>` 确定性 + ownerRef + `ScaleExpectations`（创建前 Expect，下一轮 `SatisfiedExpectations` 不满足则跳过扩容防重复建）
- **Pool 建 Pod**：`createPoolPod` :898-923，GenerateName `<pool>-` 随机名 + PoolScaleExpectations
- **Pool 删 Pod**：`scalePool` :712-791（`r.Delete` :770），待删 pod 由 `pickPodsToDelete` :830 选择（先 toDeletePods 再按旧到新凑 scaleIn）
- **驱逐**：`eviction_default.go` `handler.Evict` = 直接 `client.Delete`（非 Eviction API），错误非致命
- **滚动更新**：`recreateUpdateStrategy`（`pool_update.go`），revision = sha256(template)前8位，maxUnavailable 默认 25%，**只滚 idle（未分配）pod**，旧 revision 且 budget 允许则删+补
- **池化模式 listPods**：逐 Pod `r.Client.Get`（`batchsandbox_controller.go:338-346`，代码自注 `// TODO maybe performance is problem`）

### 3.4 Requeue 模式汇总

| 场景 | 间隔 | 位置 |
|---|---|---|
| **任务调度轮询（无条件，对象数直接相乘）** | **3s** | `batchsandbox_controller.go:274-275`（注释：tasks 纯内存无事件机制，必须周期调度） |
| Pool 缺 pod（SupplyCnt>0） | 5s | `pool_controller.go:209` |
| Pause/Resume 各阶段推进 | 1s | `batchsandbox_pause_resume.go` 多处 |
| Snapshot 轮询 | 100ms / 1s / 5s | `sandboxsnapshot_controller.go:129`、`sandboxsnapshot_lifecycle.go` |
| ScaleExpectations 未满足 | 5min 超时内按剩余时间 | `batchsandbox_controller.go:552` |
| ExpireTime 兜底 | 剩余时间 | `batchsandbox_controller.go:127` |
| 错误重试（未自定义 RateLimiter） | 默认指数退避 5ms→1000s + 10qps/100 burst | controller-runtime 默认 |
| 冲突重试 | `retry.DefaultBackoff`：Steps 4、10ms、×5、jitter 0.1 | `pool_controller.go:189` |

---

## 4. 调度器与注解契约流

### 4.1 任务回路（TaskScheduler）

- **入口**：仅 `spec.taskTemplate`（`NeedTaskScheduling()` = taskTemplate != nil）。`GenerateTaskSpecs()` 按 replicas 生成 N 个任务，命名 `<sandboxName>-<idx>`，支持按 index 打 patch。
- **选 pod**：`Schedule()`（`default_scheduler.go:212`）三步：`refreshFreePods`（剔除已占用 + 要求 PodIP 非空）→ `collectTaskStatus`（对已分配 pod 并发 GET /getTasks）→ 按序取 `freePods[0]` 分配。
- **下发**：`POST http://<podIP>:5758/setTasks`（`pkg/task-executor/client.go`）；释放 = POST 空数组；状态查询 = GET /getTasks。
- **执行**：每 pod 一个 task-executor（主容器内或 sidecar 模式），`maxConcurrentTasks = 1`（**串行**），manager 内 500ms ticker Inspect 进程推进状态机，任务持久化 `/var/lib/sandbox/tasks/<name>/task.json`（原子写 tmp→rename）。
- **FSM**（default_scheduler.go:121-135）：`pending →assigned →releasing →released`；BatchSandbox 删除时直接 released。setTask 网络失败只记日志不阻塞，靠 3s requeue 下一轮重试。
- **恢复**：`recover()` 对 allPods 中所有有 IP 的 pod 无界并发 GET /getTasks 反推归属，**at-least-once 语义（可能重复执行任务）**（recovery.go 注释）。代码自注 TODO：新 scheduler 无需 recovery。

### 4.2 分配回路（Allocator）

- **触发**：Pool reconcile → `Allocator.Schedule`（`allocator.go:196`）：首次 Schedule 触发 `store.Recover`（sync.Once，失败 `os.Exit(1)`）→ 读内存 store + 三注解生成 `SandboxRequest`（含孤儿 pod GC）→ `PackedSchedule`（顺序打包，吃饱再下一个，不够记 PodSupplement 供扩容）。
- **持久化（两阶段，失败回滚）**：
  - `SyncSandboxAllocation`（allocate）：先乐观更新内存 store → `SetAllocation` 写 `alloc-status` 注解（整表覆盖式 MergePatch）+ 首次加 finalizer；注解失败则内存回滚。
  - `SyncSandboxReleased`（deallocate）：**先写 `alloc-released` 注解**，成功后**才**释放内存（防 pod 在落盘前被重新分配）。
- **并发**：`syncSandboxConcurrently` 每 sandbox 一个 goroutine，信号量默认 **256**（env `SYNC_SANDBOX_ALLOC_CONCURRENCY`）。
- **注**：AGENTS.md 提及的 `PersistPoolAllocation` 函数**不存在**——池级聚合分配纯内存，持久化真相源是每个 sandbox 的 `alloc-status` 注解。

### 4.3 注解契约（内部但稳定性敏感）

| 注解 | 写入方 | 时机 | 读取方 | 触发下游 |
|---|---|---|---|---|
| `alloc-status` | Pool（`SetAllocation`） | 每次有新分配时批量写（并发 256，整表覆盖） | Recover、getSandboxRequest、BatchSandbox listPods | → BatchSandbox watch → reconcile（更新 endpoints/status） |
| `alloc-release` | BatchSandbox（`releasePods`） | 任务完成且 policy=Release、或删除回收 | **Pool watch 谓词**（变化即触发）、getSandboxRelease | → Pool reconcile → recycle → 写 alloc-released |
| `alloc-released` | Pool（`SetReleased`） | recycle 成功后批量写；全部释放且删除中则移 finalizer | Recover（过滤已释放）、getSandboxRequest、listPods 差集 | 无直接谓词 |
| `endpoints` | BatchSandbox（`patchBatchSandboxEndpoints`） | 每次 reconcile persistRuntimeView 阶段，值变化才写 | ingress gateway（取 endpoints[0]） | 无 controller watch |

**关键语义**：`alloc-release` 是"进行中"的释放请求；`alloc-released` 是"已确认"释放。Recover 只过滤后者、故意不过滤前者（allocator.go:100-114 注释）。Pool 对 BatchSandbox 的普通 `alloc-status` 变化**不**触发 reconcile（谓词只放行 release/replicas/删除）。

---

## 5. 规模化性能风险（核心章节）

规模假设：数百~数千 BatchSandbox / Pool、数千 Pod。证据均含文件:行号，关键项已人工复核。

### 风险因果链

**任务型 sandbox 的 3s 无条件轮询 × 每轮 HTTP 轮询与日志序列化 × Pod 事件无过滤放大 × 注解写入跨 controller 级联 × 128Mi 内存限额** —— 规模化后即便稳态无业务变化，控制器也会被自身的设计性轮询与事件反馈压垮。

### 5.1 风险清单

| 优先级 | 风险 | 证据位置 | 规模化后果 |
|---|---|---|---|
| **P0** | **任务型 sandbox 每 3s 无条件轮询**（无变化也 reconcile，`RequeueAfter` 走 AddAfter **绕过限流**） | `batchsandbox_controller.go:274-275, 230-235` | 1000 任务 sandbox ≈ **333 reconcile/s 稳态**；32 worker 下单次耗时 >96ms 队列即不可持续 |
| **P0** | **Pod 事件无过滤放大**：两控制器 `Owns(Pod)` 均无 predicate + Pool 每事件 O(pool) 全量（2 个 list + 逐 sandbox 注解解析 + 调度） | `batchsandbox_controller.go:642-643`；`pool_controller.go:365`；`pool_controller.go:148-170` | 数千 pod 池：任意 pod 状态波动触发整池全量调度，事件→O(N) 成本链 |
| **P0** | **Helm 默认资源限额 128Mi/500m** | `charts/opensandbox-controller/values.yaml:28-33` | 数千 CR + 数千 Pod + 全集群 cache 下几乎必然 OOMKill / CPU 节流 |
| P1 | **注解 churn 级联**：分配/释放写 BatchSandbox 注解（并发 256 Patch），触发双 controller + status 自环（每笔状态变更≈2 次 reconcile） | `allocator.go:271-300, 357-403`；`pool_controller.go:71, 443` | 分配/回收潮时 API 写放大；kube-client QPS 100（`main.go:197-198`）封顶分配吞吐 |
| P1 | **全集群 informer + 内存结构**：Manager 无 cache 选项（全 ns 全类型 watch）；allocator map / taskSchedulers sync.Map / 全局期望锁 | `main.go:398-413`；`allocator.go:28-33`；`batchsandbox_controller.go:74`；`scale_expectations.go:44-52` | 内存随集群 Pod 总数线性增长；全局锁在事件潮下争用 |
| P1 | **每 3s HTTP 轮询风暴 + DumpJSON 日志**：状态收集无界并发 GET（semaphore=len(ipList)）+ 每轮把全部任务状态 JSON 打日志 | `status_collector.go:44-74`；`default_scheduler.go:379-404, 462`；`batchsandbox_controller.go:289` | 压向 pod 内 execd 与 controller CPU；日志爆炸 |
| P2 | **Pool reconcile 每轮 O(pool sandboxes+pods)**：注解 JSON 解析 + PackedSchedule + RetryOnConflict 冲突整段重跑 | `allocator.go:456-580`；`pool_controller.go:189` | 大池下每事件成本高；冲突重试放大写 |
| P2 | **启动/首轮全量恢复**：Recover 全集群 List（无选择器）+ 新建 scheduler 全量 recover（代码自注 TODO 优化） | `allocator.go:69-74`；`default_scheduler.go:196-202` | 启动与批量创建首轮并发风暴 |
| P2 | **池化模式 listPods 逐 Pod Get**（代码自注 TODO） | `batchsandbox_controller.go:338-346` | replicas 大的 sandbox 每轮 R 次 Get |
| P2 | **并发不均衡**：snapshot 控制器串行（1）；leader election 单 leader 不可水平扩展（默认 15s/10s/2s） | `sandboxsnapshot_controller.go:196-202`；`main.go:403-409` | 批量 snapshot/pause 串行阻塞；故障切换 15s 空窗 |
| P3 | 无 label index 的 label List（resume/snapshot 全 namespace 扫描） | `batchsandbox_pause_resume.go:152`；`sandboxsnapshot_lifecycle.go:222, 553` | 低频路径，仅大 namespace 偶发慢 |
| P3 | 每 reconcile 常数成本：DeepCopy、排序、ObserveScale 全局锁 | `batchsandbox_status.go:139`；`batchsandbox_controller.go:178-184, 528` | 线性叠加，非独立爆点 |

### 5.2 量化放大链（以 1000 任务型 sandbox 为例）

- 3s 轮询 → 333 reconcile/s 稳态，全部 `AddAfter` 绕过 rate limiter（默认退避只保护返回 error 的路径）
- 每轮 reconcile 含：listPods（单 sandbox 有 index，好）+ Schedule()（每任务 pod 1 次 HTTP GET + 可能 setTask POST）+ 状态比对 + DumpJSON 日志
- BatchSandbox status patch 自环：`For()` 无 predicate，每笔状态变更 ≈ 2 次 reconcile（StatusRVExpectation 只抑制重复写）
- Pool 侧：一次 pool pod 事件 → 一次 `O(poolPods + poolSandboxes)` reconcile；分配潮时 256 并发注解 Patch × 每笔触发 1~2 次级联 reconcile

### 5.3 已有缓解机制（值得保留）

- Pool 的 `GenerationChangedPredicate` + 精确的 BatchSandbox watch 谓词（普通 alloc-status 变化不触发 Pool）
- `StatusRVExpectation`（10s 缓存滞后阀门 + 强制刷新）
- `ScaleExpectations` 防重复创建
- `DurationStore` requeue 合并（多来源取最短）
- status 写前 DeepEqual 相同跳过；endpoints 值不变不写

---

## 6. 优化建议（按优先级）

1. **P0 治理 3s 轮询**（最大收益）：改为事件驱动为主（task-executor 状态变化回调/status 上报触发）+ 心跳降频/分桶错峰（如按 sandbox hash 分桶 5~10s 轮询），避免全局同步 3s 风暴。
2. **P0 为 `Owns(Pod)` 加 predicate**：过滤掉非状态相关事件（如 `ResourceVersionChangedPredicate` 或仅 phase/ready 变化才入队），切断"任意 pod 波动 → 整池全量"的 O(N) 链。
3. **P0 上调 Helm 资源限额**并补充 HPA/垂直扩展；复核 256 并发注解写入与 `--kube-client-qps=100` 的匹配关系（写放大下 QPS 可能成为吞吐瓶颈）。
4. **P1 收敛 informer 范围**：Manager Cache 增加 namespace 或 label selector 限定；为 Pod label List 补 field index（`batch-sandbox.../name`）。
5. **P1 减少注解 churn**：alloc-status 由"整表覆盖式"改为增量/合并批量写，或引入 annotation 变更去重（写前比对）。
6. **P1 降日志序列化开销**：`DumpJSON` 从 Info 级降为 Debug 级（`status_collector.go:72`、`batchsandbox_controller.go:289`）。
7. **P2 调度器恢复优化**：新 scheduler 跳过 recover（代码已留 TODO）；Recover 全量 List 增加选择器。
8. **P2 snapshot 并发提升**：`WithOptions(MaxConcurrentReconciles)` 从默认 1 上调（注意 pause 内部快照的幂等约束）。

---

## 7. 附：关键文件索引

| 主题 | 文件:行号 |
|---|---|
| CRD 类型 | `apis/sandbox/v1alpha1/batchsandbox_types.go`、`pool_types.go`、`sandboxsnapshot_types.go` |
| 注解/finalizer/label 常量 | `internal/controller/apis.go:27-44` |
| BatchSandbox 触发源 | `batchsandbox_controller.go:640-647` |
| BatchSandbox 主流程 / 任务 | `batchsandbox_controller.go:95-231` / `262-355` |
| Pool 触发源（含谓词） | `pool_controller.go:260-366` |
| Pool 主流程 / 分配 | `pool_controller.go:117-246` / `534-593` |
| 滚动更新 | `pool_update.go:35-90` |
| 驱逐 | `pool_controller.go:925-962`、`eviction/eviction_default.go` |
| 分配器 / 注解同步 | `internal/controller/allocator.go`（Schedule :196、SyncSandboxAllocation :351、SyncSandboxReleased :374、Recover :63） |
| 任务调度器 | `internal/scheduler/default_scheduler.go`、`recovery.go`、`status_collector.go` |
| task-executor | `internal/task-executor/manager/task_manager.go`、`runtime/process.go`、`storage/file_store.go` |
| Pause/Resume 状态机 | `batchsandbox_pause_resume.go:176-223`（dispatch） |
| Snapshot 生命周期 | `sandboxsnapshot_lifecycle.go` |
| 入口 / 并发配置 | `cmd/controller/main.go:58-59, 398-468` |
| 资源限额 | `charts/opensandbox-controller/values.yaml:28-33` |
