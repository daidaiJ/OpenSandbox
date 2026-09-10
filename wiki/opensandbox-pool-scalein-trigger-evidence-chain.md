# Pool scale-in 自噬：触发条件完整证据链

> 日期：2026-09-10
> 目的：把「Pool 压测销毁风暴（Pending → scale-in 自噬）」从生产现象到修复判定全链路整合成一份可独立阅读的证据链——每条主张都有对应证据落点（代码 file:line、集群实测数据、上游 issue）。
> 关联：[issues/2026-09-10-pool-pending-scalein-churn.md](../issues/2026-09-10-pool-pending-scalein-churn.md)（缺陷记录+验证判据）、[opensandbox-pr1425-k3s-ab-verification.md](opensandbox-pr1425-k3s-ab-verification.md)（A/B 实测报告）、[opensandbox-pr1425-k3s-bisect-burst-plan.md](opensandbox-pr1425-k3s-bisect-burst-plan.md)（验证方案）、上游 [#1423](https://github.com/opensandbox-group/OpenSandbox/issues/1423) / [#1425](https://github.com/opensandbox-group/OpenSandbox/pull/1425)。

---

## 0. 结论先行

**触发充分条件：慢启动（readiness > pool_acquisition_timeout）+ 突发负载 + 足够大的 alloc 基座（`alloc > 2×supply + 3×midpoint`）。与容量墙无关。** 修复判定：**前坏后好，本 fork 应合 PR #1425**；残留一项（scale-in 仍删在途 pod，已封顶），另开小 issue，不重开 #1423。

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

同需求（400 创建请求）、同池规格、同基座 alloc（99/98），唯一变量是 controller 代码：

- **无容量墙条件下复现**：50m/32Mi × poolMax 400 ≈ 20c，远低于节点余量——容量根因被直接证伪；
- **前侧四症状全部复现**：13+ 销毁（单轮 TOTAL 143→124）、冻结 ≥14 分钟、buffer 含 Pending（B=49/A=0）、Pending 正反馈堆积（alloc 99 + 25 Pending 冻结终态）；
- **后侧全部消失**：1 次删除（maxUnavailable 封顶）、~27 决策/分钟无冻结、buffer 只计 Ready idle、池持续收敛；
- 判定表（方案 §4）逐项核对通过。

→ 与 §4 推导互为印证：**前侧的行为就是不等式的物理实现，后侧的修复恰好逐条拆掉不等式的成立前提**（buffer 只计 Ready → 搁浅不再入 buffer；封顶 → 单轮删除 ≤ 25%；软 requeue → 冻结消失）。

## 6. 环节五：判定、残留与边界

| 项 | 结论 |
|---|---|
| 修复有效性 | **前坏后好，本 fork 应合 #1425**（CRD 必须随行，见方案 §0.4） |
| 残留 | 后侧 supply 塌缩后仍删在途 pod（「未 Ready 先删」而非「跳过」），已封顶、无正反馈 → 另开「scale-in 跳过 in-flight」小 issue |
| 边界 | `pool_acquisition_timeout` 与 readiness 的差值决定**易触发性**（催化剂强度），不是根因；`maxUnavailable` 同时是创建预算与删除封顶，调小可抬高触发门槛但不修缺陷 |
| 观察项 | PR #1618（schedule 失败仍继续 scale/status）合入前需评估是否加重 trim（方案 §5.1） |

## 7. 证据索引

| 主张 | 证据 |
|---|---|
| buffer 误计实测 | A/B 报告 §2 trace：B=49 / Available=0 |
| 池冻结实测 | A/B 报告 §2/§3.1：两次直接探测，03:26Z 起零 reconcile ≥14min |
| 删除封顶 | 后侧同场景 1 次事件 vs 前侧 13+ |
| 创建百分比预算 | `0d82d87b^` pool_controller.go:1128-1132、:1242-1253 |
| 删除绝对带无门控 | 同上 :1106-1115、:1147-1153 |
| 无容量墙复现 | A/B 报告 §1（50m/32Mi 模板）+ §3 触发条件修正段 |
| 上游机制 | #1423 描述 + 方案文档 §5.1 分层盘点 |
| 复现配方 | A/B 报告 §5 + 集群 `/tmp/bisect/`（pool-bisect-churn.yaml / ramp4.sh / sample.sh / monitor.sh） |
