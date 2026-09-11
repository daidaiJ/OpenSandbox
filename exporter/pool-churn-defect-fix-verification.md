# Pool 销毁风暴：缺陷定位与修复验证（上游 #1423 / PR #1425）

> 日期：2026-09-11（问题定位与 A/B 验证：2026-09-10）
> 性质：**一文具全的整合文档**——生产/压测问题诊断（现象、证据链、根因、修复、验证、对策）完整收录，不依赖外部内部文档；上游 issue/PR 通过 GitHub 链接直达。
> 结论：**前坏后好成立，本 fork 应合 PR #1425（CRD 必须随行）**。残留一项（scale-in 仍删在途 pod，已封顶单轮收敛），另开小 issue，不重开 #1423。
> 上游：[#1423](https://github.com/opensandbox-group/OpenSandbox/issues/1423)（halleystar，2026-07-30，CLOSED）· [#1425](https://github.com/opensandbox-group/OpenSandbox/pull/1425)（GodBlf，2026-09-07 合入 main，MERGED，Closes #1423）

---

## 一、一句话结论

Pool 控制器在「慢启动 runtime + 突发负载」下会进入自持的创建/删除风暴：**buffer 口径把未 Ready 的在途/Pending pod 误计为富余缓冲（燃料）+ scale-in 无门控且最老优先（放大器）+ 错误路径冻结（失联）**。与容量墙、请求失败潮均无关（均已证伪）。上游 #1425 修掉了燃料与放大器，k3s 缩比 A/B 重测实证前坏后好，本 fork 应随 CRD 一体合入。

## 二、生产现象与关键证据（13 节点压测）

环境：13 候选节点（nodeAffinity + 污点容忍）、namespace 配额余量 900c、池模板 2c4G、poolMin=20 / poolMax=400 / bufferMin=4 / bufferMax=40、压测 30min 负载按 40 一档递增至 ~100 并发。

现象四件套：

1. **销毁量塌缩式畸高**：终态峰值销毁累计 **293**、Running 阶段 pod 峰值 **193**（293:193 ≈ 1.52）；水位刚到 1/3（~40 并发）时销毁就开始反超 running。全程创建 ≈ 293 销毁 + 期末存活 ~130 ≈ 420 个 pod，实际需要 ~100-130 个——**约 70% 的创建是垃圾 churn**。
2. **自噬标志**：`supplyCnt>0` 与 `scaleIn>0` 并存（一边等 pod 一边删 pod）；20-30 个 pod 长期 Pending，与销毁同时出现。
3. **池冻结**：churn 期间 Pool 零 reconcile ≥14 分钟（两次直接探测证实），controller 重启无效（上游 #1423 同样报告 restart 后 ~15 分钟重入风暴）。
4. **水位反直觉**：alloc 不到 poolMax 的 1/3 就触发——排除「打满才出事」的直觉。

控制器日志快照（~100 并发采样）：`maxNewPods=272`、`desiredSchedulableCnt=121`、`totalPodCnt=128`。

**快照反推**：`totalPodCnt = PoolMax − maxNewPods = 400 − 272 = 128`，且 `schedulableCnt` 与 `totalPodCnt` 取的是同一个列表。代入 `desired = allocated + supply + desiredBuffer`：若 buffer ∈ [4,40] 则 `desired = schedulable + supply ≥ 128`，不可能等于 121——唯一自洽解是 **buffer > 40（越上限）**：`desiredBuffer=22 → allocated≈80、supply≈19、buffer≈48`。即采样那一刻：128 个 pod 只有 ~80 被分配，~48 躺在 idle，19 个 sandbox 在等 pod，而池子在执行 scaleIn≈7 的删除。

**时间序列四段振荡**（实测：100 running 前一切正常 → 忽然大量销毁 → 然后 Pending → running 冻结）：

1. **爬坡期**：`scaleIn>0 ⟺ buffer > supply + desiredBuffer`，每波 supply≈40 而 buffer≤40，不等式恒不成立——「100 之前好好的」是不等式的必然结果；
2. **顶点坍缩**：最后一波被吸收瞬间 supply→0，desired 从峰值坍缩到 allocated+22；total≈190 / allocated≈100 时 buffer≈90>40 → **一次性 scaleIn≈68**（全程最大单波删除恰好发生在爬坡顶点）；
3. **重建 burst 撞墙**：trim 清空 notReady → 25% 预算满血 → 单轮 burst ~25-30 创建，撞上容量/调度墙（「然后 Pending」）；
4. **冻结低烧**：卡死 Pending 永久占用 25% 预算（budget≈30−25≈5）→ 创建近乎停摆；残余低烈度 churn（偶发 trim 最老卡死 pod → 预算回血 → 再建 → 再卡）以 ~10 pod/分钟累积 293 长尾。

## 三、缺陷定位

### 3.1 本地三缺陷链（`0d82d87b^` 前侧代码）

位置：`kubernetes/internal/controller/pool_controller.go`（scalePool / pickPodsToDelete）、`allocator.go`（getAvailablePodsFromAlloc）、`internal/utils/pod.go`（ComparePodsForDeletion）。

| # | 缺陷 | 代码位置（前侧） | 机制 |
|---|---|---|---|
| L1 | **buffer 统计口径包含未 Ready pod** | `bufferCnt := schedulableCnt - allocatedCnt`（pool_controller.go:1106） | 分配器只把 Ready pod 分给 sandbox（`getAvailablePodsFromAlloc` 中 `!IsPodReady → continue`），Pending/ContainerCreating 卡在 idle 集合，在扩缩公式里被计成「富余缓冲」——实测 trace：bufferCnt=49 / Available=0 同时出现 |
| L2 | **scale-in 无门控且最老优先** | `scaleIn := schedulableCnt - desiredSchedulableCnt`（:1147-1149，无上限）；`pickPodsToDelete` 按 CreationTimestamp 升序、仅跳过已在删除中的 pod | 最老的 idle pod 恰是卡最久、马上就绪的那批——trim 定向淘汰最接近可用的 pod；`utils.ComparePodsForDeletion`（考虑 Pending/Ready 状态，utils/pod.go:223）只用于滚动更新路径（pool_update.go），scale-in 未使用 |
| L3 | **门控不对称 + 错误路径冻结** | scale-up 有 `maxUnavailable`(默认 25%) 预算门（:1128-1132、:1242-1253 `getScaleMaxUnavailable`）；scale-in 无对应门；`scalePool` 出错 `return fmt.Errorf("pool scale is not ready")` | 每删一个未 Ready pod → `notReadyCnt-1` → 创建预算+1（删除正反馈）；错误返回触发 controller-runtime workqueue 指数退避（上限 1000s）+ 删除期望永不 `ObserveScale` → 池脱离管控（实测冻结 ≥14 分钟） |

**自噬循环全貌**：创建 → 调度不上（Pending）→ 计入 buffer → buffer>bufferMax 触发 trim → 最老优先删掉 → 预算回血 → 再创建 → 再 Pending。**20-30 Pending = 25% 预算平衡点**：desired≈120 → 预算≈30，控制器创建到 notReady 顶线即停，与观测精确吻合；卡死 pod 还永久吃掉预算，池子连正常补货都做不动——这就是 supply>0 与删除并存、池子「冻住」的原因。

### 3.2 上游 #1423 六缺陷（同一代码路径的更完整盘点）

上游环境：controller v0.2.0 + chart 0.2.0、server v0.2.2、kata-qemu（60s+ 慢启动）、poolMin 20 / poolMax 1000 / bufferMin 20 / bufferMax 100、单副本 controller（8h 验证排除 split-brain）。症状：**~2250 创建 + ~2290 删除每分钟、~1300 Pending 永久滞留、status.Available 恒 0、约一半创建请求 504 `POD_READY_TIMEOUT`**，重启 controller 无效。

单 reconcile 实锤（同一 reconcileID 同一秒）：`bufferCnt=89 / idlePods=89` vs `Available=0`，随后 status 写入被 API server 拒绝 `unknown field "status.updated"`。

| # | 上游缺陷 | 与本地对应 | 说明 |
|---|---|---|---|
| U1 | **Helm chart CRD 缺 `status.updated`** → oldStatus.Updated 恒 0、DeepEqual 永不相等 → 每 reconcile 写 status → status 写又 re-enqueue → 热循环 ~1005 reconciles/min（实测一分钟 Pool reconcile 1005 / Update pool status 1004 / unknown field 1004，一一对应） | 本地未单列（fork chart 同病，A/B 时以 CRD 随行解决） | [#1337](https://github.com/opensandbox-group/OpenSandbox/pull/1337)（2026-07-20 合入）曾把该项作为 "cosmetic follow-up" 推迟——实际不是 cosmetic：被 prune 的字段使短路永不生效。同源：#1336 报告 chart CRD 还缺 `spec.scaleStrategy` 等三个 spec 字段（Helm 用户想调 maxUnavailable 也调不了） |
| U2 | **带内 `desiredBufferCnt = bufferCnt` 无滞回**：带内时 `desired = schedulableCnt + supplyCnt`（supply>0 就永远加建，无视已有 buffer）；出带瞬间 snap 到 midpoint（越过 100 直接到 60），无任何阻尼 → 建删交替 | 本地触发几何分析的一部分 | 实测同一秒内 16 个 reconcile 互相 undo（Scaling up createCnt=16 → Scaling down scaleIn=16 → …） |
| U3 | **bufferCnt 计入未 Ready pod**（scalePool :685 无 readiness 过滤；updatePoolStatus :747-755 有过滤）——与 status.Available 口径结构性分叉 | = **L1** | 单 reconcile 实锤：bufferCnt=89 / idlePods=89 vs Available=0 |
| U4 | **scale-up 双限流（PoolMax−totalPodCnt 与 maxUnavailable−notReadyCnt），scale-down 零限流**——`pickPodsToDelete` 返回多少删多少 | = **L2/L3 的门控半边** | [#584](https://github.com/opensandbox-group/OpenSandbox/pull/584) 曾提 `--scale-up/down-per-minute` token bucket 限速 PR，作者 7 分钟后自行关闭未合入（且即使合入也无效：默认 0=不限、chart 无 extraArgs、RateLimitError 中断路径会抑制 Available 上报） |
| U5 | **terminating pod 不计入 totalPodCnt/schedulableCnt**（Reconcile :151-158 过滤 DeletionTimestamp）→ PoolMax 不约束真实占用；大规模删除立刻被读成缺货，从底部闭合循环 | 上游特有（本地判定为症状非根因） | 直接观测：poolMax=1000、pool 显示 TOTAL 437，namespace 实有 **1355 Pending** pool pod（kata-qemu 销毁要几十秒，窗口内仍占资源但控制器不可见） |
| U6 | **最老优先删除 = 定向收割刚 Ready 的 pod**（idlePods 按 CreationTimestamp 升序从头删） | = **L2** | 慢启动 runtime 上「oldest idle」与「刚完成启动」是同一集合——恰好是 status.Available 计数的 pod → AVAILABLE 被钉死在 0 而非 merely low |

上游 #1423 的「容量超限（1355 Pending）」是 U5 的症状而非根因；触发机制与本地同构（慢启动 / buffer 误计 / 缩容无门控 / 池冻结 / 容量超限五要素对照全部吻合）。

### 3.3 触发条件（定量推导）

前侧代码关键五处（`0d82d87b^` pool_controller.go）：

| 行为 | 代码位置 | 语义 |
|---|---|---|
| `bufferCnt := schedulableCnt - allocatedCnt` | :1106 | Pending/在途全部计入 buffer |
| band 外 `desiredBufferCnt = (bufferMin+bufferMax)/2` | :1109-1112 | midpoint 与池规模无关的**绝对**锚点 |
| `desiredSchedulableCnt := max(alloc+supply+desiredBuffer, poolMin)` | :1115 | 期望水位 |
| `scaleIn := schedulableCnt - desiredSchedulableCnt`（无上限） | :1147-1149 | 删除侧无任何门控 |
| `createCnt ≤ limitedCreateCnt = 25%×desired - notReadyCnt` | :1128-1132、:1242-1253 | 创建侧是百分比预算 |

三步推导：

1. **带内恒不剪**：buffer 在 `[bufferMin, bufferMax]` 内时 `desiredBufferCnt = bufferCnt`，代入得 `desired = schedulableCnt`，故 `scaleIn ≡ 0`——无论 alloc 多大，带内数学上不可能 trim。
2. **带外触发是双门槛**：出带本身要求 `bufferCnt > bufferMax`；band 外还要 `scaleIn = bufferCnt − supplyCnt − midpoint > 0`，即 `M > max(bufferMax, supply + midpoint)`（双门槛取大）。
3. **在途质量受百分比预算封顶**：`M_max ≈ 25%×desired ≈ (alloc+supply)/3`。

**联立**：`alloc ≳ 3×bufferMax − supply` 且 **`alloc ≳ 2×supply + 3×midpoint`**。

三个推论：

1. **为何必须体量大才能触发**：绝对带 midpoint 不随池规模缩小，可搁浅量随 alloc 线性放大——MVP 小池（poolMin 4 / poolMax 24，alloc~十几）数学上不可能触发（复现失败的全部原因，不是操作问题）。
2. **为何不到 1/3 水位就触发**：alloc≈100（poolMax=400 的 25%）时 `100 > 2×10+75` 已满足——门槛是**绝对数**不是占比，扩容反而更容易触发。
3. **创建超时参数不在风暴环路上**（生产 240s 无失败潮仍中招为最终证词）：循环燃料是误计的假 buffer，自给自足——**没有任何一环需要请求先失败**。超时只决定请求多晚死、报什么码；测试环境 60s 失败潮只是把假 buffer 顶得更猛的加速器。

**催化剂链**：readiness 70s > 创建总超时 60s（测试环境）→ 突发请求批量 `POD_READY_TIMEOUT` 阵亡（加速器非燃料）→ 在途搁浅堆积、假 buffer 顶过绝对带 → 带外 trim 启动 → 删最老在途（≈最接近 Ready）→ 需求仍在继续创建 → 循环；错误路径 `return fmt.Errorf` 触发 workqueue 指数退避 → 池冻结。

**风暴必要条件（两阶段 N1-N7）**：

- 阶段一（触发单次误剪，全部满足）：**N1** 误计缺陷在场（假 buffer）；**N2** 未 Ready 未分配质量 M 越过双门槛 `M > max(bufferMax, supply+midpoint)`；**N3** 池体量供得起 M（`alloc ≳ 3×bufferMax − supply` 且 `alloc ≳ 2×supply + 3×midpoint`）；**N4** 就绪时长 ≫ 调谐节奏（M 以未 Ready 形态停留多个 reconcile 周期）。
- 阶段二（升级为自持风暴）：**N5** 需求持续存在（长超时或持续到达）；**N6** 无门控 + 最老优先在场——最老优先删掉≈最接近 Ready 的 pod → 分配永远追不上 → 需求永不满足 → 循环不断粮（**此缺陷是把「浪费」变成「正反馈」的关键**）；**N7**（放大器，非必要）错误路径冻结。
- **非条件**：资源限制/容量墙（§四证伪）、请求失败潮（生产 240s 无失败潮仍中招）、特定 runtime（kata 只是 N4 的极端来源）。
- 合入 #1425 后：N1 被 `countReadyIdlePods` 消除（断燃料）；N6 被 maxUnavailable 封顶 + 未 Ready 先删缓解（限幅）；N5 需求仍在但单轮收敛不再正反馈（重测实证波次后 ~60s 收敛）。

### 3.4 已排除项

| 假设 | 排除依据 |
|---|---|
| ResourceQuota 准入 | Pending pod **存在** = create 已过准入（quota 拒绝发生在创建时，表现为 FailedCreate，不会产生 pod 对象）。卡点在 kube-scheduler 调度层 |
| 镜像冷节点/节点性能差异 | 反亲和打散到 13 台后就绪速度一致（6-10s） |
| Sandbox TTL/周转率 | 水位 1/3 即出现销毁>running，周转率解释不了早期反超 |
| 容量墙/资源限制 | ① 无容量墙条件下照样复现（50m/32Mi × poolMax 400 ≈ 20c，远低于节点余量）；② 风暴中 pod 终结均为控制器 scale-down 决策（`Deleting pool pod`），零 Evicted/OOMKilled；③ 1355 Pending 是 terminating 计数缺陷（U5）的症状。**资源限制既不必要也不充分** |
| maxNewPods=272 / desired=121 本身异常 | 前者是创建上限、后者是期望公式输出，单看正常；真信号是 `desired < schedulable`（scaleIn>0） |

节点集中 6/13 的修正解释：kube-scheduler LeastAllocated 在共享节点上跟随真实空闲度的自然结果（那 6 台实际更空，先被填满再外溢）；它是放大器，不是删除的原因。

## 四、PR #1425 修复内容（上游，2026-09-07 合入 main）

PR：`[codex] stabilize pool scaling`，Closes #1423。改动文件：`pool_controller.go`、chart CRD `pools.yaml`、新增 `pool_scaling_stability_test.go` / `pool_allocation_backfill_test.go`、e2e 与 docs。**无新增 CRD 字段 / CLI flag / Helm values，存量 manifest 完全兼容。**

| 修复 | 对应缺陷 | 内容 |
|---|---|---|
| 同步 Helm Pool CRD 补 `status.updated`（含 UPDATED printer column） | U1 | DeepEqual 短路恢复生效，热循环消除 |
| buffer 计算改 `countReadyIdlePods`（只计 Ready 且未分配），Pending 保留为在途容量 | U3/L1 | 假 buffer 燃料断 |
| scale-down 批次以 `scaleStrategy.maxUnavailable` 封顶并等待删除完成 | U4/L2/L3 | 单轮删除 ≤25%×desired，默认仍 25%，双向对称 |
| 删除排序改「least-useful-first」：未 Ready 先删、同就绪度新的先删，保护稳定 Ready 容量 | U6/L2 | 不再定向收割刚就绪的 pod |
| terminating pod 计入 PoolMax 占用 | U5 | PoolMax 约束真实占用 |
| 期望未满足期间保持 status 更新（scale-up 出错 `return true, nil` 软 requeue + `observeDeletedPods`/`ExpectScale(Delete)`） | L3/冻结 | 池不再脱离管控 |

上游验证：envtest 36 specs、pool scaling stability 单测、expectations 单测、`go vet`、helm lint、渲染 CRD 含 updated 字段与 UPDATED printer column、`pnpm docs:build`。

## 五、修复验证：k3s 双节点缩比 A/B（2026-09-10）

### 5.1 实验环境

| 项 | 值 |
|---|---|
| 集群 | ubuntu 10.254.254.105（master）+ k3s-103 10.254.254.103（worker），k3s v1.30.5 |
| controller 镜像 A（前） | `docker.io/library/controller:bisect-pre1425` = `0d82d87b^`（2dc3e955） |
| controller 镜像 B（后） | `docker.io/library/controller:bisect-1425` = `0d82d87b`（PR #1425） |
| CRD A / B | 前 = fork chart 渲染版（**无** `status.updated`，热循环缺陷在）；后 = `0d82d87b` 版（**有**，热循环修复） |
| 测试池 | `bisect-churn` 锁 worker 103（nodeAffinity，不碰 master 现网服务）；50m/32Mi、poolMin 20、poolMax 400、buffer 10-40、`recycleStrategy: Delete` |
| 慢启动模拟 | 主容器 `sleep 70 && touch /tmp/ready` + readinessProbe，pod 70s 才 Ready（对应上游 kata-qemu 60s+） |
| 负载（ramp4） | 基座 10 批 × 30 沙箱（30s 间隔）+ 突发 2 波 × 50，沙箱 timeout 3600，共 400 创建请求 |
| 服务端参数 | `sandbox_create_timeout_seconds`=60s（默认）、`pool_acquisition_timeout_seconds`=60s（CM 实配）；readiness 70s 超出两者 → 波次请求 60s 总闸 `POD_READY_TIMEOUT` 阵亡 |

指纹自检：A 侧 `bufferCnt := schedulableCnt - allocatedCnt`、无 `countReadyIdlePods`；B 侧 `countReadyIdlePods` / `desiredBufferCount` / `pool_scaling_stability_test.go` 均在。

### 5.2 A/B 结果（同需求、同池规格、同基座 alloc≈99/98）

| 指标 | 前（A，有效） | 后重测（B′，有效） |
|---|---|---|
| `POD_READY_TIMEOUT` 失败 | 301/400 | ~303/400（**持平**——由 60s 创建总超时 vs 70s 就绪决定，与修复无关） |
| 决策连续性 | **冻结 ≥14 分钟**（03:26Z 起零 Pool reconcile，两次直接探测证实） | **全程连续**：869 次决策，每分钟均有记录，最大空窗 ≤1 分钟 |
| TOTAL 轨迹 | 锯齿自噬 143→124→145→132→143→124，冻死 124 | 平滑爬升 42→137；每波**一次性收缩** 137→108、138→108，**单轮收敛** |
| 删除 | 16 事件（窗口截断口径）、单轮 TOTAL -19（无界） | 96 次执行（控制器日志 `Deleting pool pod` 对账），**每轮 ≤25% 封顶**：基座期 36 次小步 buffer 超限修剪 + 每波 30×2 |
| buffer 口径 | 含 Pending/在途：B=49 / Available=0 | Ready-only：**bufferCnt=0 实时 trace** |
| 删除目标 | 最老优先（含未 Ready 在途 pod） | 未 Ready 先删（在途超额）+ 每轮 maxUnavailable 封顶 |
| Pending | 25 堆积冻结（正反馈） | 3（103 节点 pod 上限墙 `Too many pods`，调度器行为，非控制器病理） |
| 终态 | alloc 99 + 25 Pending 冻结 | alloc 98 / total 108 = alloc+bufferMin **精确收敛** |
| 病理标志 | supply>0 ∧ scaleIn>0 持续并存且正反馈 | 波次瞬间并存（supply=33→trim 30）但**单轮收敛、不复发** |

**判定表逐项核对通过：前坏后好成立，本 fork 应合 #1425。**

四个缺陷的实测归因：

1. **池冻结**：前侧 `scalePool` 出错路径 → workqueue 指数退避 + 删除期望永不 observe → 池脱离管控；#1425 改软 requeue + `ExpectScale(Delete)`（前侧冻结 ≥14min vs 后侧最大空窗 ≤1 分钟）。
2. **trim 无门控**：前侧单轮 TOTAL -19 无界；#1425 `maxDeleteCnt = maxUnavailable(25%×desired)` 封顶（单轮 ≤25%、7+23 分轮）。
3. **buffer 口径**：前侧 B=49 全是 Pending 仍被当富余；#1425 `countReadyIdlePods`（bufferCnt=0 实时 trace）。
4. **最老优先删除**：前侧删即将就绪的 pod；#1425 删刚创建的 pod（浪费最小）。

### 5.3 复盘取证：原「后侧」运行判定无效（方法论教训）

原始后侧运行因**部署失误无效**——当时 #1425 pod 从未接管。取证链：

1. 重读日志发现决策行 caller 为 `pool_controller.go:1119`——前侧源码行号（#1425 版本因新增 `countReadyIdlePods` 漂移到 **:1132**）；
2. RS 时间线：bisect-1425 RS 创建 02:56:02Z，但两轮压测窗口内日志全部 :1119；
3. worker 103 节点 `crictl ps -a` / `ctr images ls` 无任何 bisect 容器/镜像——镜像未进 103 containerd → 新 pod 未 Ready → `kubectl logs deploy/` 一直打到旧 pre pod（静默，不报错到操作者眼前）;
4. docker 侧镜像验尸：`bisect-1425` 二进制 md5 与符号（countReadyIdlePods×3）确认镜像本身没错——错在部署环节未验证接管。

原「后侧」数据（仅 1 次删除、无冻结）是同一前侧二进制的第二轮运行间波动（触发不等式未被越过），而非修复效果。

**方法论（A/B 必做）**：切镜像后必须验证「新 pod 接管」再开压——三件套：① `kubectl rollout status` 成功；② RS `readyReplicas=1`；③ 决策日志 caller 行号指纹（前 ：1119 / 后 ：1132）。`kubectl logs deploy/` 会静默打到旧 Ready pod。

**事件通道教训**：重测期间 namespace 事件存储被海量 Scheduled 事件淹没，SuccessfulDelete 事件查不到——**删除对账两侧统一用控制器日志 `Deleting pool pod` 执行计数口径**；监控用 `kubectl logs -f` 流式落盘 + 15s 采样双通道（控制器日志 10MB 轮转极快，事后取不回）。

### 5.4 复现配方（供他人复跑）

1. 双点对照镜像：`0d82d87b^` / `0d82d87b` 各构建 `COMPONENT=controller`（buildx 需 `--build-arg GOPROXY=https://goproxy.cn,direct`，内网 proxy.golang.org 不通）。
2. `docker save` → `k3s ctr images import` **两个节点**；deployment 引用 `docker.io/library/controller:<tag>`（pullPolicy IfNotPresent）。
3. CRD 必须随侧切换：前 = fork chart 渲染版（无 `status.updated`，chart 模板文件需先剥 `{{ }}`）；后 = `config/crd/bases/sandbox.opensandbox.io_pools.yaml`（原生 YAML）。
4. 池模板关键标定：**readiness 延迟 70s > server 创建总超时 60s（默认值）**，保证等新 pod 的沙箱必然 `POD_READY_TIMEOUT` 失败 → supply 塌缩 → 在途搁浅。
5. 重测部署链：镜像重新导入 105+103 → `set image` → rollout 成功 → RS readyReplicas=1 → **caller :1132 指纹实测确认接管** → 重建同规格池 → 同配方 ramp4。

### 5.5 环境复原清单

- controller 已滚回现网 `latest`，CRD 已恢复 fork chart 版，`bisect-churn` 池已删，lite-test-pool 2/2 健康；
- 镜像 tar（两节点 /tmp）已删；containerd 内 `bisect-pre1425`/`bisect-1425` 镜像保留备复跑（各 ~97.5MiB）；
- `/tmp/osb-1425-bisect` worktree 与 `/home/extvdiadmin/OpenSandbox-bisect` clone 保留；实验数据：`/tmp/bisect-pre-v4/`（前）、`/tmp/bisect-post/`（后）。

## 六、残留与后续行动

| 项 | 状态 | 行动 |
|---|---|---|
| 合入 PR #1425 | **待办（本 fork 主行动）** | chart 一体升级，**CRD 必须随行**（缺 `status.updated` 回热循环）；灰度单池用 caller :1132 指纹验收；回滚预案就绪 |
| scale-in 仍删在途 pod | 已封顶、单轮收敛、无正反馈（重测实锤：波次响应期创建的 30 个在途超额 pod 被单轮收缩删除，05:13:58Z） | 另开「scale-in 跳过 in-flight」小 issue，不重开 #1423；代码层建议 `pickPodsToDelete` 对未 Ready idle pod 直接跳过或单列低优先级 |
| 生产 Pending 调度原因 | 待收口 | 对任意 Pending pod：`kubectl get pod <p> -o jsonpath='{.status.conditions[*].message}'`——`Insufficient cpu` = 共享节点真实空闲不足（900c 是 namespace 准入配额 ≠ 节点余量，poolMax 需对齐真实容量）；`didn't match ... affinity` / `untolerated taint` = 有效节点 <13，修池模板或节点 label |
| churn 削减（建 30 删 30 抖动） | PR 未覆盖 | scale-in 滞回/cooldown（buffer 越带需持续 N 个 reconcile 才删，删除后一窗口抑制再创建）、需求驱动扩容（把 server 等待请求数注入 desired）、decision-rate 等 metrics（呼应上游 #1650/#1651） |

**四个承压边界（PR 不解决、需另行处理）**：① 请求成功率不因 PR 改善（慢启动业务打突发仍会大面积 `POD_READY_TIMEOUT`，只是池不再陪葬）；② 高频突发下「建 30 删 30」成为常态抖动；③ 在途删除残留极端情况下拖慢追赶；④ 两堵墙——CRD 必须随 controller 同步升级、worker 节点 max-pods 上限是独立于池参数的调度墙。

## 七、对策清单（代码 / 配置 / 业务运维）

### 7.1 代码（controller，建议提上游或随本 fork 合入）

1. **scale-in 跳过 in-flight**（清残留，最高优先）：`pickPodsToDelete` 对未 Ready 的 idle pod 直接跳过（或单列低优先级 + 独立限速），只回收真正富余的 Ready idle；
2. **scale-in 滞回**：buffer 越带需持续 N 个 reconcile（或 cooldown，如 60s）才执行删除；删除后一个窗口内抑制再创建；
3. **需求驱动扩容**：把 server 侧等待中请求数注入 desired 计算（替代 25% 预算式盲目追赶）；
4. **可观测性**：暴露 decision-rate、scaleIn/delete 执行速率、expectations 未满足时长指标（呼应上游 #1650/#1651）。

### 7.2 配置基线（参数 → 建议值 → 依据）

| 参数 | 建议值 | 依据 |
|---|---|---|
| `sandbox_create_timeout_seconds` | ≥ 业务 readiness P95 + 30% 余量（如 P95 70s → 120s；现值 240s 若 P95≤180s 可保持） | 决定突发中「拿到 pod 的请求」能否活到就绪；纯成功率参数，与风暴无关 |
| `pool_acquisition_timeout_seconds` | 30-60s，≤ 总超时 | 池打满时的 429+Retry-After 快速失败通道；给业务明确重试语义 |
| `sandbox_create_poll_interval_seconds` | 1s 默认；批量创建压力大时 2s | 只影响状态感知延迟与 server→API 压力 |
| `bufferMin` | 5-10%×poolMax | 保底吸收零星请求，避免冷启动 |
| `bufferMax` | **≥ 一个典型突发波次规模**（如常见波 50 → 60-80） | post-fix 下只决定「何时收缩」——太小两波之间反复建删（churn），太大是 idle 成本 |
| `maxUnavailable` | 25% 默认；对 churn 敏感降 15% | 双重身份：创建预算（越大追赶越快）+ 删除封顶（越大单轮抖动越大） |
| `poolMin / poolMax` | poolMin=低谷水位；poolMax=峰值 alloc + 一个波次 | 同时核对节点 max-pods 与 namespace 配额总账（含 system pod） |
| `recycleStrategy` | Delete（默认） | 重测口径下已无风暴放大问题；选型详见 §八 |
| 池模板 `terminationGracePeriodSeconds` | 5-10s | scale-down 删的是 idle 无会话 pod，30s 默认只占资源/pod 槽位；BatchSandbox 回收路径的 postStop（S3 回写等）需按业务评估分开 |
| `--concurrency` | 多池 >8 或 BS 量大时调高（默认 Pool=16 / BatchSandbox=32，`cmd/controller/main.go:60-62`） | chart 未暴露该 flag，需自行加 args；同一 Pool 的 reconcile 天然串行 |
| `--kube-client-qps/burst` | 大池（poolMax 400+）观察 client 限流指标，必要时 200/400 | create/delete 是串行 for 循环，QPS 直接决定单轮收敛速度；期望值超时默认 5min（`--expectation-timeout`） |

**治风暴的正确组合** = 合 #1425（断假 buffer 燃料，N1）+ 削峰（减小瞬时在途质量，压 N2）+ 加速就绪（缩短在途假 buffer 停留时间，压 N4）。**不要用资源参数治这个病**：触发门槛是绝对数而非占比，扩容后 alloc 上限更高反而更容易触发，并放大爆炸半径。

### 7.3 业务运维

1. **削峰**：业务层令牌桶/排队把瞬时突发拉平成 ramp；SDK 侧 `SandboxPool` warmup 预热（warmupConcurrency ≤ 200）。post-fix 下削峰不再是「防风暴」，而是减少波间建删 churn 与 429。
2. **分池**：突发型与慢启动业务隔离池；慢启动池预留基座安全边际，避免在大 alloc 基座上突然打慢启动突发。
3. **监控告警四件套**：decision-rate 掉零（冻结前兆）；scale-down 删除速率 vs 沙箱释放速率分离（自噬标志）；bufferCnt 与 Available 口径长期偏差（误计信号）；Pending message 分类（`Too many pods` → max-pods 扩容；quota → 配额扩容）。另加 **pod readiness P95**（成功率第一决定因素）。
4. **压 N4（就绪时长）**：节点预拉业务镜像；startupProbe + 分层 readiness 让「进程起」与「服务就绪」分离上报；突发型池避免 kata 类 60s+ 启动的重 runtime。
5. **容量台账**：每池记录 alloc 峰值、典型突发规模、readiness P95、节点 max-pods/配额余量；变更池参数前复核。
6. **升级 SOP**：#1425 以 chart 一体升级（CRD 随行）；灰度单池用「决策日志 caller 行号指纹」验收新二进制接管（前 ：1119 / 后 ：1132）；上线前按 §5.4 复现配方缩比压测、判定表逐项核对；保留回滚预案。

### 7.4 生产风暴后遗症「资源滞留 + 新建不起来」：机理与止血

四个叠加机制（A/B 终态「alloc 99 + 25 Pending 冻结」是其缩比版）：

1. **控制器冻结期零清理**——风暴中 scalePool 反复出错 → workqueue 指数退避 + 删除期望（默认 5min）永不满足 → Pool 脱离管控：不补货、不分配、不清理，新请求全部堵死。**「建不起来」的直接原因。**
2. **删除潮 × 30s 默认 grace × terminating 不可见缺陷**——Terminating pod 占资源/pod 槽位最长 30s+，前侧不计入 totalPodCnt → 控制器当作容量已空继续创建 → Running+Terminating 双份占用，节点资源、max-pods、namespace 配额三墙齐打满。
3. **Pending 滞留反向堵塞**——Pending 占配额与 pod 计数不提供服务，前侧还误计入 bufferCnt；新请求排在僵尸后面。
4. **alloc 高位钉死（长尾）**——风暴期间分配出去的沙箱带 1800/3600s 超时，业务放弃也要等超时回收 → AVAILABLE 长期为 0。

取证五步：① `logs --since=15m | grep -c "Scale pool decision"` ≈0 即冻结；② `grep -c Terminating`；③ Pending pod conditions message 分类；④ `describe resourcequota`（used vs hard）；⑤ BatchSandbox 总数 vs 业务活跃数 + 池 TOTAL/ALLOCATED/AVAILABLE。

止血（按序）：① `rollout restart` controller（冻结唯一解法，重启即清卡死期望）；② 按业务确认批量 DELETE 僵尸沙箱让 alloc 回落；③ idle 池 pod 卡 Terminating 用 `--grace-period=0 --force`（勿用于有会话 pod）；④ 低谷期删池重建（alloc 归零，代价是容量短暂清零）；⑤ 治本 = 合 #1425 + §7.2 配置对齐。

## 八、附：recycleStrategy 选型结论（Restart / Delete / Noop）

排查风暴时评估过的解耦手段，结论固化：

| 策略 | 机制 | 隔离性 | 适用 |
|---|---|---|---|
| **Delete（默认）** | 释放 = 删 pod 重建；隔离是结构性的（全新可写层/emptyDir/网络 namespace/IP，init 重跑，重选节点） | 无遗漏面，唯一适合不可信负载 | 多租户 / 不可信代码 |
| **Restart** | pod exec `kill 1`（SIGTERM）→ kubelet 按 `restartPolicy: Always` 拉起新容器实例；容器 ID 变化判完成；默认 30s 间隔重试 3 次，耗尽走删除兜底；可经 Pool annotation 配 blacklist / retryInterval / maxRetries / restartCommand | **两个缺口**：① emptyDir 卷跨重启保留（会话状态写在卷上会泄漏给下一租户）；② pod IP/netns 复用；且 init 容器不重跑、默认不做文件清理、节点热点固化 | 可信 / 同租户高周转——切换前必须：① 确认会话状态落点（可写层 or emptyDir，后者必须补清盘路径）；② 确认 PID 1 信号链（模板 `sh -c exec task-executor` 满足；裸 sleep 类卡满 3 次重试最坏 90s+ 走删除）+ sidecar（如 egress）加 blacklist |
| **Noop** | 不做任何动作，pod 立即可再分配 | 依赖上层协议保证自初始化 | 会话协议自初始化场景 |

Restart 优势：pod 总量恒定，sandbox 周转与池扩缩彻底解耦（对销毁风暴是决定性干预）；apiserver/etcd/调度器 churn 基本消失；回收 1-3s 级。受 `RECYCLE_POD_CONCURRENCY`（默认 64）与 controller→kubelet exec 可达（`pods/exec` RBAC）约束。

## 关联（上游）

- [#1423 Pool controller: hot reconcile loop + unthrottled scale-down oscillation](https://github.com/opensandbox-group/OpenSandbox/issues/1423) · [#1425 stabilize pool scaling](https://github.com/opensandbox-group/OpenSandbox/pull/1425)
- 相关上游：#1336（chart CRD 缺 spec 字段）、#1337（修复三个字段、推迟 status.updated）、#584（未合入的 scale 限速 PR）、#906（pool scale expectation stuck）、#1650/#1651（池指标）
