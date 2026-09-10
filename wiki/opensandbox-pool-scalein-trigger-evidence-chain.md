# Pool scale-in 自噬：触发条件完整证据链

> 日期：2026-09-10
> 目的：把「Pool 压测销毁风暴（Pending → scale-in 自噬）」从生产现象到修复判定全链路整合成一份可独立阅读的证据链——每条主张都有对应证据落点（代码 file:line、集群实测数据、上游 issue）。
> 关联：[issues/2026-09-10-pool-pending-scalein-churn.md](../issues/2026-09-10-pool-pending-scalein-churn.md)（缺陷记录+验证判据）、[opensandbox-pr1425-k3s-ab-verification.md](opensandbox-pr1425-k3s-ab-verification.md)（A/B 实测报告）、[opensandbox-pr1425-k3s-bisect-burst-plan.md](opensandbox-pr1425-k3s-bisect-burst-plan.md)（验证方案）、上游 [#1423](https://github.com/opensandbox-group/OpenSandbox/issues/1423) / [#1425](https://github.com/opensandbox-group/OpenSandbox/pull/1425)。

---

## 0. 结论先行

**触发充分条件：慢启动（readiness > pool_acquisition_timeout）+ 突发负载 + 足够大的 alloc 基座（`alloc > 2×supply + 3×midpoint`）。与容量墙/资源限制无关——销毁风暴是调谐设计缺陷（§7）。** 修复判定：**前坏后好，本 fork 应合 PR #1425**（重测有效，§5）；合入后控制平面可平稳扩容承压，但请求成功率、波次 churn、在途删除三个边界需按 §10-§11 的配置/代码/运维措施补齐。残留一项（scale-in 仍删在途 pod，已封顶单轮收敛），另开小 issue，不重开 #1423。

---

## 1. 证据链总览

| # | 环节 | 回答的问题 | 关键证据 | 落点 |
|---|---|---|---|---|
| 1 | 生产现象 | 发生了什么 | 13 节点压测销毁风暴四段形态 | issues 文档 §二/§三 |
| 2 | 上游对照 | 是不是同一个缺陷 | #1423 五要素机制同构 | 本文 §3 |
| 3 | MVP 复现失败解释 | 为什么小池打不出来 | 触发不等式在小池不可满足 | 本文 §4 推论 1 |
| 4 | 触发数学 | 什么条件**必然**触发 | 前侧代码两公式 → `alloc > 2×supply + 3×midpoint` | 本文 §4（核心） |
| 5 | A/B 实证 | 修复是否有效；根因是否容量 | 前坏后好 + 无容量墙复现 | 本文 §5 / A/B 报告 |
| 6 | 判定与残留 | 行动项与边界 | 合 #1425；残留已封顶 | 本文 §6 |

---

## 2. 环节一：生产现象（13 节点压测）

环境：13 候选节点、namespace 配额 ~900c、模板 2c4G、poolMax=400、突发创建。症状四件套（详见 issues 文档时间序列互证）：

1. **销毁量塌缩式畸高**：终态 293 SuccessfulDelete / 193 Running 峰值，删除量远大于沙箱主动释放；
2. **自噬标志**：`supplyCnt>0` 与 `scaleIn>0` 并存（一边等 pod 一边删 pod）；
3. **池冻结**：churn 期间 Pool 零 reconcile，controller 重启无效（「冻结低烧」）；
4. **水位反直觉**：alloc 不到 poolMax 的 1/3 就触发——排除「打满才出事」的直觉。

## 3. 环节二：上游 #1423 机制同构对照

| 要素 | 上游 #1423 | 我们的生产现象 | 同构？ |
|---|---|---|---|
| 慢启动 | kata-qemu 60s+ | 业务容器就绪慢 | ✓ |
| buffer 误计 | bufferCnt=89 / Available=0 | B=49 / Available=0 实测 trace | ✓ |
| 缩容无门控 | 删除无上限 | 293 销毁 | ✓ |
| 池冻结 | 重启 controller 无效 | 冻结低烧 | ✓ |
| 容量超限 | 1355 Pending | — | **症状非根因**（terminating 不计入 totalPodCnt 所致） |

结论：同一代码路径（`scalePool`/`pickPodsToDelete`），触发机制同构；上游的「容量超限」是第五缺陷（terminating 不可见）的症状，不是根因。

## 4. 环节三：触发数学（核心推导）

前侧代码（`0d82d87b^` 的 `kubernetes/internal/controller/pool_controller.go`）关键五处：

| 行为 | 代码位置 | 语义 |
|---|---|---|
| `bufferCnt := schedulableCnt - allocatedCnt` | :1106 | **Pending/在途全部计入 buffer** |
| band 外 `desiredBufferCnt = (bufferMin+bufferMax)/2` | :1109-1112 | midpoint 与池规模无关的**绝对**锚点 |
| `desiredSchedulableCnt := max(alloc+supply+desiredBuffer, poolMin)` | :1115 | 期望水位 |
| `scaleIn := schedulableCnt - desiredSchedulableCnt`（无上限） | :1147-1149 | **删除侧无任何门控** |
| `createCnt ≤ limitedCreateCnt = 25%×desired - notReadyCnt` | :1128-1132（25% 见 :1242-1253 `getScaleMaxUnavailable` 默认 `25%`） | **创建侧是百分比预算** |

三步推导：

**(1) 带内恒不剪。** buffer 在 `[bufferMin, bufferMax]` 内时 `desiredBufferCnt = bufferCnt`，代入 :1115 得 `desired = alloc+supply+buffer = schedulableCnt`，故 `scaleIn ≡ 0`——**无论 alloc 多大，带内数学上不可能 trim**。trim 只能发生在带外（buffer > bufferMax）。

**(2) 带外触发条件是绝对带。** band 外 `desiredBufferCnt = midpoint`，此时：

```
scaleIn = schedulableCnt - (alloc + supply + midpoint) = bufferCnt - supplyCnt - midpoint
scaleIn > 0  ⟺  bufferCnt > supplyCnt + midpoint        （绝对阈值）
```

**(3) 波次规模受百分比预算封顶。** 突发波把 C 个 pod 送入在途/搁浅，而这些在途本身计入 desired 分母，故单轮创建预算满足 `C ≤ 25%×(alloc+supply+C)`，解出：

```
C ≤ (alloc + supply) / 3                                  （百分比预算）
```

**联立（2)(3)**——要剪，需搁浅量（至多 C）越过绝对带：

```
(alloc + supply)/3 > supply + midpoint
⟹  alloc > 2×supply + 3×midpoint
```

测试池 buffer 10-40 → midpoint = 25 → **alloc > 2×supply + 75**。

### 三个推论（逐条回收此前疑问）

1. **为何必须体量大才能触发**：绝对带 `midpoint`（本池 25）不随池规模缩小，而可搁浅量 C 随 alloc 线性放大。`alloc ≤ 2×supply + 75` 的池（如 MVP：poolMin 4 / poolMax 24，alloc~十几）**在数学上不可能触发**——这正是 MVP 复现失败的全部原因，不是操作问题。
2. **为何不到 1/3 水位就触发**：alloc≈100（poolMax=400 的 25%）时 `100 > 2×10+75` 已满足。门槛是**绝对数**不是占比——「水位线」直觉在此失效，也再次排除容量墙根因。
3. **为何调创建超时避不开**：业务侧创建超时（240s）只影响业务等待；决定搁浅的是 server `pool_acquisition_timeout=30s`（等池新 pod 30s 阵亡 → 请求失败但 pod 已创建 → 搁浅入 buffer）。且即便调参避过一次，控制器四个缺陷（误计/无门控/最老优先/冻结）原样存在——超时只移动阈值，不动根因。上游专门出 #1425 正因如此。

**催化剂链**：readiness 70s > pool_acquisition_timeout 30s → 突发请求在池阻塞线批量阵亡 → 失败潮后 supply 塌缩、在途搁浅堆积 → `bufferCnt ≫ supply+midpoint` → 带外 trim 启动 → 删最老在途（≈最接近 Ready）→ 水位缺口回血再创建 → 循环；并发错误路径 `return fmt.Errorf` 触发 workqueue 指数退避 → 池冻结。

## 5. 环节四：A/B 实证（证伪容量 + 证实修复）

> **2026-09-10 傍晚复盘 + 重测（终版）**：原「后侧」运行期间 #1425 pod 从未接管（镜像未入 worker 节点 containerd，`kubectl logs deploy/` 静默打到旧 pre pod，日志 caller 指纹 ：1119 可证），原后侧数据无效。镜像取证与行为对照见 [A/B 验证报告 §7](opensandbox-pr1425-k3s-ab-verification.md)。随后重测：接管验证通过（caller `:1132` 指纹 + RS READY=1）后同配方重压，**前坏后好成立**——前侧锯齿自噬 + 冻结 ≥14min + Pending 堆积；后侧全程连续决策（869 次）、每波一次性收缩（137→108）单轮收敛、每轮删除 ≤25% 封顶、bufferCnt=0（Ready-only 口径实时可见）。详见验证报告 §8。

同需求（400 创建请求）、同池规格、同基座 alloc（99/98），唯一变量是 controller 代码：

- **无容量墙条件下复现**：50m/32Mi × poolMax 400 ≈ 20c，远低于节点余量——容量根因被直接证伪（前侧实证，有效）；
- **前侧四症状全部复现**：16 销毁事件（单轮 TOTAL 143→124）、冻结 ≥14 分钟、buffer 含 Pending/在途、Pending 正反馈堆积（alloc 99 + 25 Pending 冻结终态）；
- ~~后侧全部消失~~ → 待重测确认；
- ~~判定表逐项核对通过~~ → 待重测后重新逐项核对。

→ 与 §4 推导的印证关系：**前侧行为就是不等式的物理实现**（实测吻合）；修复是否如预期拆掉不等式成立前提（buffer 只计 Ready → 搁浅不再入 buffer；封顶 → 单轮删除 ≤ 25%；软 requeue → 冻结消失），以重测结果为准。

## 6. 环节五：判定、残留与边界

| 项 | 结论 |
|---|---|
| 修复有效性 | **前坏后好，本 fork 应合 #1425**（CRD 必须随行，见方案 §0.4） |
| 残留 | 后侧 supply 塌缩后仍删在途 pod（「未 Ready 先删」而非「跳过」），已封顶、无正反馈 → 另开「scale-in 跳过 in-flight」小 issue |
| 边界 | `pool_acquisition_timeout` 与 readiness 的差值决定**易触发性**（催化剂强度），不是根因；`maxUnavailable` 同时是创建预算与删除封顶，调小可抬高触发门槛但不修缺陷 |
| 观察项 | PR #1618（schedule 失败仍继续 scale/status）合入前需评估是否加重 trim（方案 §5.1） |

## 7. 排除资源限制：销毁是调谐设计缺陷，不是资源压力

三条独立证据：

1. **无容量墙条件下照样复现**：A/B 池模板 requests 仅 50m/32Mi（limit 128Mi），poolMax=400 全开 ≈ 20c / 12.8GiB，远低于 worker 节点可分配资源（62Gi 内存、CPU 富余）——前侧照样打出完整风暴。若存在资源阈值参与触发，这个量纲不可能成立。
2. **删除动作的全部来源是控制器 scale-down 决策**：风暴中 pod 终结均为 `SuccessfulDelete … (scale-down)` / `Deleting pool pod`（reconcile 循环内 `r.Delete`），没有一例 Evicted / OOMKilled / 调度失败清理；且删除后控制器立刻重建——资源压力不会产生「边删边建」的正反馈，只有控制逻辑错误会。
3. **生产环境的「容量超限」是症状不是根因**：上游 #1423 的 1355 Pending 超限由 terminating pod 不计入 totalPodCnt 的计数缺陷放大（§3）；重测后侧唯一与资源沾边的现象是终态 3 个 Pending（worker 节点 max-pods 上限墙 `Too many pods`），那是调度器容量边界，与销毁无关且量级差一个数量级（3 vs 25）。

**结论：销毁风暴 = 调谐（reconcile）设计缺陷；资源限制既不必要也不充分。**

## 8. PR 修复前后调谐反应对照

| 调谐维度 | 前 `0d82d87b^` | 后 #1425 | 实测差异（前 vs 重测） |
|---|---|---|---|
| buffer 口径 | `schedulable-allocated`，Pending/在途全算富余（:1106） | `countReadyIdlePods`，只计 Ready idle（:1122） | B=49/A=0 误计 vs **bufferCnt=0 实时 trace** |
| 触发几何 | 带内恒不剪；带外绝对带 `buffer > supply + midpoint` | 同一几何，但误计消失后搁浅在途不再推高 buffer | 前侧被一次失败潮推越带；后侧未越带，收缩由真实超额驱动 |
| scale-in 上限 | **无门控**，一轮删任意多（:1147-1153） | 每轮 `maxUnavailable(25%×desired)` 封顶 | 单轮 -19 无界 vs 单轮 ≤25%、7+23 分轮 |
| 删除排序 | 最老优先 → 删最接近 Ready 的在途（浪费最大） | 未 Ready 先删、同就绪度新的先删（浪费最小） | 删掉即将就绪的 pod vs 删刚创建的 pod |
| 期望值管理 | 删除期望永不 observe → 卡死 | `observeDeletedPods`/`ExpectScale(Delete)` | 期望卡死加剧冻结 vs 可满足 |
| 错误路径 | `return fmt.Errorf` → workqueue 指数退避（上限 1000s） | `return true, nil` 软 requeue | **冻结 ≥14 分钟** vs 最大空窗 ≤1 分钟 |
| 状态热循环 | CRD 无 `status.updated`，每轮写 status | CRD 补 `status.updated`，DeepEqual 可判等 | 上游 #1423 的 ~1005 reconciles/min 热循环消除 |
| 实测轨迹 | 锯齿 143→124→145→132→143→124，冻死 124 | 每波一次性收缩 137→108、138→108，收敛 | alloc 99+25Pending 冻死 vs alloc98/total108=alloc+bufferMin 精确收敛 |

## 9. 销毁风暴的必要条件（缺一不可）

| # | 条件 | 作用 | 反证 |
|---|---|---|---|
| C1 | **慢启动**：pod readiness P95 > server `pool_acquisition_timeout`(30s) | 突发请求在池阻塞线批量失败 → supply 搁浅堆积 | 快启动 MVP 复现不出（请求即时分配，带内恒不剪） |
| C2 | **突发负载**：波次规模相对池预算足够大（每轮创建 ≤25%×desired） | 在途/失败潮能堆出「越带」的 buffer | 平稳 ramp（30s 间隔小批）爬坡全程无 trim |
| C3 | **足够大的 alloc 基座**：`alloc > 2×supply + 3×midpoint` | 百分比预算与绝对带的错配——小池数学上不可触发 | 小池 MVP（alloc~十几 < 75+）复现不出；生产 <1/3 水位即触发（绝对数门槛） |
| C4 | **四缺陷在场**：buffer 误计 + scale-in 无门控 + 最老优先 + 冻结路径 | 把一次越界 trim 放大成「删→建→删」正反馈 + 池失联 | 后侧同触发条件仅单轮收敛、不复发 |

**非条件**：资源限制/容量墙（§7 证伪）、kata 等 特定 runtime（只是 C1 的一种来源）、特定 server 版本。

## 10. 合入 PR 后能否平稳扩容承压

**结论：控制平面可以平稳承压（有重测证据）；业务感受需要配置措施补齐（§11）。**

已证（重测，同配方 400 请求/15min、双波×50）：调谐连续不冻结（869 决策，峰值 187/分钟）；扩容追赶速率 25%/轮；波次后单轮收缩收敛（~60s 内回带）；终态精确收敛 alloc+bufferMin；删除限幅 ≤25%。

四个承压边界（PR 不解决、需另行处理）：

1. **请求成功率不因 PR 改善**：30s 池阻塞线 vs 70s 就绪，两轮失败率均 ~75%——慢启动业务打突发仍会大面积 `POD_READY_TIMEOUT`，只是池不再陪葬；
2. **波次 churn 成本**：响应突发会按需求信号超建（~30/波），失败潮后整批回收——偶发突发没问题，**高频突发**下「建 30 删 30」成为常态抖动；
3. **在途删除残留**：scale-in 仍删未 Ready 的超额 pod（封顶、单轮收敛），极端情况下拖慢对真实迟到需求的追赶；
4. **两堵墙**：CRD 必须随 controller 同步升级（否则回热循环）；worker 节点 max-pods 上限是独立于池参数的调度墙（重测终态 3 Pending 即此）。

## 11. 对策清单（代码 / 配置 / 业务运维）

### 11.1 代码（controller，建议提上游或随本 fork 合入）

1. **scale-in 跳过 in-flight**（清残留，最高优先）：`pickPodsToDelete` 对未 Ready 的 idle pod 直接跳过（或单列低优先级 + 独立限速），只回收真正富余的 Ready idle；
2. **scale-in 滞回**：buffer 越带需持续 N 个 reconcile（或 cooldown，如 60s）才执行删除；删除后一个窗口内抑制再创建——消除「建 30 删 30」churn；
3. **需求驱动扩容**：把 server 侧等待中请求数注入 desired 计算（替代 25% 预算式盲目追赶），突发时一次到位、不靠多轮爬坡；
4. **可观测性**：暴露 decision-rate、scaleIn/delete 执行速率、expectations 未满足时长指标（呼应 open 的 #1650/#1651）。

### 11.2 配置（现版本即可落地，性价比最高）

1. **拆掉 C1**：`pool_acquisition_timeout_seconds` 30s → ≥ 业务容器就绪 P95（建议 120s，且 ≤ 业务创建超时 240s）——失败潮消失，supply 不搁浅，触发不等式左端堆不起来；
2. **Pool spec 余量**：`bufferMax` 覆盖慢启动下一个波次的规模；`bufferMin` 保持小；`maxUnavailable` 可调小（如 10%）降低双向抖动幅度（代价：创建预算同步变小、追赶变慢，按业务取舍）；
3. **治 C1 根因**：节点预拉业务镜像；启动期用 startupProbe + 分层 readiness 让「进程起」与「服务就绪」分离上报；突发型池避免 kata 类 60s+ 启动的重 runtime；
4. **并发与 grace 调优**（2026-09-10 晚核对默认值）：控制器并发**不是单线程**——`MaxConcurrentReconciles` 默认 Pool=16、BatchSandbox=32（`cmd/controller/main.go:60-62`），可用 `--concurrency` flag 调整但 **helm chart 未暴露**该参数（多池场景可自行加 args）；但同一 Pool 的 reconcile 天然串行，且一轮内 create/delete 是串行 for 循环（受 `--kube-client-qps=100/burst=200` 限速）。Pod 删除的 grace 控制器不干预、模板也未设 → 落 K8s 默认 **30s `terminationGracePeriodSeconds`**：scale-down 删的是 idle 无会话 pod，30s 只是占着资源与 pod 槽位（加剧 max-pods 墙），**Pool 模板可设 5-10s 加速收敛**；注意若走 BatchSandbox 回收路径且业务有 S3 产物回写等 postStop 逻辑，需按业务评估再缩短；期望值超时默认 5min（`--expectation-timeout`，前侧冻结的放大器，#1425 后删除期望可 observe 一般不会触顶）。

### 11.2 补充：不要用资源参数治这个病

调大 requests/limits、加节点只会推迟 C3 的绝对门槛（门槛是绝对数 alloc > 2×supply+75，扩容后 alloc 上限更高反而**更容易**触发），并放大爆炸半径。

### 11.3 业务运维

1. **削峰**：业务层令牌桶/排队把瞬时突发拉平成 ramp（重测中「基座爬坡」就是健康形态）；SDK 侧用 `SandboxPool` warmup 预热（warmupConcurrency ≤ 200）；
2. **分池**：突发型与慢启动业务隔离池；慢启动池预留基座安全边际，避免在大 alloc 基座上突然打慢启动突发；
3. **监控告警四件套**：decision-rate 掉零（冻结前兆，前侧核心信号）；scale-down 删除速率 vs 沙箱释放速率分离（自噬标志）；bufferCnt 与 Available 口径长期偏差（误计信号）；Pending 堆积且 message 含 `Too many pods`（max-pods 扩容信号）；
4. **升级 SOP**：#1425 以 chart 一体升级（CRD 随行）；灰度单池用「决策日志 caller 行号指纹」验收新二进制接管（前 ：1119 / 后 ：1132）；上线前按 §5 复现配方缩比压测、判定表逐项核对；保留回滚预案。

## 12. 证据索引

| 主张 | 证据 |
|---|---|
| buffer 误计实测 | A/B 报告 §2 trace：B=49 / Available=0 |
| 池冻结实测 | A/B 报告 §2/§3.1：两次直接探测，03:26Z 起零 reconcile ≥14min |
| 删除封顶 | 后侧同场景 1 次事件 vs 前侧 13+ |
| 创建百分比预算 | `0d82d87b^` pool_controller.go:1128-1132、:1242-1253 |
| 删除绝对带无门控 | 同上 :1106-1115、:1147-1153 |
| 销毁非资源所致 | 重测全程零 Evicted/OOMKilled，删除均为 scale-down 决策（`Deleting pool pod` 96 次对账）；无容量墙复现（50m/32Mi×400 ≈ 20c） |
| 合入后承压能力 | 重测 869 决策连续、波后 ~60s 收敛、单轮 ≤25% 限幅（A/B 报告 §8） |
| max-pods 调度墙 | 重测终态 3 Pending，message=`Too many pods`（worker 节点上限，与控制器无关） |
| 无容量墙复现 | A/B 报告 §1（50m/32Mi 模板）+ §3 触发条件修正段 |
| 上游机制 | #1423 描述 + 方案文档 §5.1 分层盘点 |
| 复现配方 | A/B 报告 §5 + 集群 `/tmp/bisect/`（pool-bisect-churn.yaml / ramp4.sh / sample.sh / monitor.sh） |
