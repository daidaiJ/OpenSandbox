# Pool 容量四参数（poolMin / poolMax / bufferMin / bufferMax）调研

> 调研日期：2026-08-27
> 代码位置：`kubernetes/apis/sandbox/v1alpha1/pool_types.go`（类型定义）、`kubernetes/internal/controller/pool_controller.go`（伸缩逻辑）
> 官方文档示例：`docs/kubernetes/index.md`、`docs/guides/secure-container.md`

## 1. 参数定义（CRD `capacitySpec`）

Pool 的 `spec.capacitySpec` 有四个必填参数，全部为 `int32`，最小值 0：

| 参数 | CRD 注释原文 | 含义 |
|---|---|---|
| `poolMin` | minimum total size of the pool | **池子总规模下限**：无论有没有请求，池中 pod 总数（可调度数）不得低于此值 |
| `poolMax` | maximum total number of nodes allowed in the entire pool | **池子总规模硬上限**：池中所有 pod（**含正在驱逐/删除中的**）不得超过此值 |
| `bufferMin` | minimum number of nodes that must remain in the buffer | **缓冲（空闲）pod 下限**：未分配给任何 sandbox 的空闲温 pod 不得低于此值 |
| `bufferMax` | maximum number of nodes kept in the warm buffer | **缓冲（空闲）pod 上限**：空闲温 pod 不得超过此值 |

**关键概念**：buffer（缓冲）指池中**已创建但未分配给任何 BatchSandbox** 的温 pod，用于快速响应新沙箱请求（分配是秒级的，创建 pod 是慢的）。pool 指整个池子的总规模 = 已分配 + 缓冲。

## 2. 伸缩算法（`scalePool`，pool_controller.go:713）

每次 reconcile 时控制器计算以下中间量：

```
schedulableCnt = 当前可调度 pod 数（非驱逐中）
totalPodCnt    = 所有 pod 数（含驱逐中，仅用于 PoolMax 强制）
allocatedCnt   = 已分配给 sandbox 的 pod 数
supplyCnt      = allocator 需要的补充数（Σ(sandbox.replicas - 已分配)）+ 滚动更新补充数
bufferCnt      = schedulableCnt - allocatedCnt   // 当前空闲缓冲数
```

### 2.1 目标缓冲数（滞回控制）

```go
desiredBufferCnt := bufferCnt
if bufferCnt < BufferMin || bufferCnt > BufferMax {
    desiredBufferCnt = (BufferMin + BufferMax) / 2
}
```

- 当前缓冲在 `[bufferMin, bufferMax]` 区间内 → **不动**，保持现状；
- 越界（低于下限或高于上限）→ 目标收敛到**区间中点** `(bufferMin+bufferMax)/2`。

这是典型的**滞回（hysteresis）设计**：避免缓冲数在边界附近抖动导致频繁扩缩容。注意目标不是回到边界，而是回到中点，留出余量。

### 2.2 目标池规模

```go
desiredSchedulableCnt = max(allocatedCnt + supplyCnt + desiredBufferCnt, PoolMin)
```

即：**已分配 + 待补充 + 目标缓冲**，且**至少 poolMin**。

- `poolMin` 是总规模下限：即使没有任何 sandbox 请求（allocated=0、supply=0），池子也会保持 `max(desiredBufferCnt, poolMin)` 个 pod；
- 当 allocated 很大时，池子自然超过 poolMin，此时 poolMin 不生效。

### 2.3 PoolMax 硬上限

```go
maxNewPods = max(PoolMax - totalPodCnt, 0)
```

- 新建 pod 数受 `PoolMax - totalPodCnt` 限制，**totalPodCnt 包含驱逐中的 pod**，防止驱逐未完成时超限创建；
- 若 `desiredSchedulableCnt > schedulableCnt` 且 `maxNewPods > 0`，创建 `min(差值, maxNewPods)` 个，并受 `scaleStrategy.maxUnavailable`（默认 25%）限速；
- 若 `desiredSchedulableCnt < schedulableCnt`，缩容删除差值个 pod，**优先删空闲（idle）pod**，已分配的 pod 不会被删。

### 2.4 初始创建

池子刚创建时 `schedulableCnt=0`、`bufferCnt=0`，若 `0 < bufferMin` 则 `desiredBufferCnt=(bufferMin+bufferMax)/2`，首轮会创建 `min(max((bufferMin+bufferMax)/2, poolMin), poolMax)` 个 pod（测试中常见 `min(PoolMax, BufferMin)` 的初始形态）。

## 3. 参数间关系与调参要点

```
约束：0 ≤ bufferMin ≤ bufferMax ≤ poolMax（建议）
     0 ≤ poolMin ≤ poolMax
```

| 场景 | 建议 |
|---|---|
| 追求低延迟分配（秒级拿到沙箱） | 提高 `bufferMin`，让空闲温 pod 常备；代价是常驻资源成本 |
| 控制资源成本/配额 | 收紧 `poolMax`（硬上限，含驱逐中 pod）；`bufferMax` 防止缓冲过度膨胀 |
| 突发流量（大量 sandbox 同时创建） | `poolMax` 需 ≥ 峰值并发数，否则分配会排队等 pod 创建（`supplyCnt>0` 时控制器 requeue 等待） |
| 池子常驻保底 | `poolMin` 保证无请求时也有最小规模；注意它和 `bufferMin` 是**两个维度**：poolMin 管总规模，bufferMin 管空闲数 |
| 避免抖动 | 区间 `[bufferMin, bufferMax]` 越宽，扩缩容越少；越窄越敏感 |

**典型示例**（docs 默认）：`bufferMax: 10, bufferMin: 2, poolMax: 20, poolMin: 5` —— 空闲缓冲目标区间 [2,10]，越界时收敛到 6；池子总规模 5~20。

## 4. 相关状态字段（`pool.status`）

- `total`：池中 pod 总数
- `allocated`：已分配给 sandbox 的 pod 数
- `available`：空闲且 Ready 的 pod 数（≈ 实际可立即分配的缓冲）
- `updated`：已更新到最新 revision 的 pod 数

## 5. 边界与坑

1. **PoolMax 含驱逐中 pod**：驱逐/删除慢时，实际可新建数会暂时小于 `PoolMax - 已分配`，属预期行为（E2E-TROUBLESHOOTING 也提示 replica 超 PoolMax 时检查此值）。
2. **bufferMin 与 poolMin 不冲突但会叠加**：`desiredSchedulableCnt` 取两者较大语义（allocated+supply+desiredBuffer 与 poolMin 取 max），不会出现"总规模达标但缓冲不足"的死锁——缓冲不足时 desiredBufferCnt 会拉高总规模。
3. **`(bufferMin+bufferMax)/2` 取整**：奇数区间中点向下取整（Go 整数除法）。
4. **分配不区分 revision**：缓冲 pod 的模板版本不影响分配（详见 wiki《Pool Pod 模板更新与 Pod 分配行为排查》）。

## 6. 调参方案（以 poolMax=400 为例）

### 6.1 关键行为推演（先理解再调参）

设 `poolMin=10, bufferMin=0, bufferMax=40, poolMax=400`，`maxUnavailable` 默认 25%：

| 阶段 | 计算过程 | 结果 |
|---|---|---|
| 闲时（无负载历史） | bufferCnt=10 ∈ [0,40] → 不动 | 池子保持 **10** 个 pod |
| 突发 100 请求 | bufferCnt=10-100=-90 < 0 → 补到中点 20 → desired=100+0+20=120 | 扩到 120，**每轮最多 25%×120=30 个**（且受未就绪 pod 数限速），5s requeue 一轮 |
| 持续高压 300 | desired=300+0+20=320 | 继续扩到 320，缓冲 20 吸收后续秒级分配 |
| 打满 400 | desired=400+0+20=420 > poolMax → maxNewPods=0 | 池子封顶 400，**缓冲归零，新请求排队等释放** |
| 回落到 0 | bufferCnt=120 > 40 → 缩到中点 20 | 池子缩到 **20** 常驻（滞回：20 ∈ [0,40] 不再动） |

**三个关键结论**：
1. **扩容速度 = min(maxUnavailable, 未就绪 pod 数)**：同时最多 `maxUnavailable` 个 pod 处于创建/启动中，pod 就绪慢则扩容更慢——这是对集群的保护，也是突发时分配延迟的来源。
2. **缓冲吸收量 = bufferMax**：≤ bufferMax 的突发全部秒级分配；超出部分按需现建（延迟 = pod 创建+就绪时间）。
3. **回落常驻量 = (bufferMin+bufferMax)/2**（bufferMin=0 时即 bufferMax/2）：经历负载后池子不会缩回闲时水平，滞回避免反复冷启动。

### 6.2 推荐配置（均衡型）

```yaml
spec:
  capacitySpec:
    poolMin: 10        # 闲时保底 10 个（400 的 2.5%），几乎不占资源
    poolMax: 400       # 硬上限（含驱逐中 pod）
    bufferMin: 0       # 不强制保底缓冲，闲时允许池子缩到 poolMin
    bufferMax: 40      # 缓冲吸收 ≤40 的突发；回落常驻 20
  scaleStrategy:
    maxUnavailable: "25%"   # 默认即可；同时最多 100 个 pod 在创建中
```

行为特征：闲时 10 个 pod；≤40 并发秒级分配；大突发按需扩容（25% 限速保护集群）；回落后常驻 20 个。

### 6.3 按并发峰值调整

| 峰值并发 | poolMin | bufferMin | bufferMax | 回落常驻 | 说明 |
|---|---|---|---|---|---|
| ≤ 50 | 5 | 0 | 20 | 10 | 极致省资源 |
| 50~150 | 10 | 0 | 40 | 20 | **推荐**，均衡 |
| 150~300 | 20 | 10 | 80 | 45 | 平稳优先，闲时占用略高 |
| 300~400 | 30 | 20 | 100 | 60 | 大缓冲吸收，闲时占用最高 |

通用规则：
- `poolMax` ≥ 峰值并发（硬约束，否则分配排队）；
- `bufferMax` ≈ 峰值并发的 10~25%（秒级分配吸收量）；
- `poolMin` = 可接受的闲时常驻（保底）；
- `bufferMin` 通常 0 或与 poolMin 同量级；`bufferMin=0` 时回落常驻 = bufferMax/2；
- 扩容节奏用 `scaleStrategy.maxUnavailable` 调：pod 就绪快（镜像已预热）可调大加速扩容；集群紧张调小（如 10%）。

### 6.4 配套建议（避免集群压力）

1. **镜像预热**：池模板镜像提前拉取到节点（或节点缓存），否则突发时现拉镜像既慢又压集群——缓冲的意义就是避免这个。
2. **监控**：盯 `pool.status.total / allocated / available` 三个字段；`available` 接近 0 说明缓冲耗尽，即将进入排队模式。
3. **缩容无限速**：回落时控制器一次性删除多余 idle pod（不受 maxUnavailable 限制），删除是异步的，对集群压力小；注意 `recycleStrategy` 默认 Delete。
4. **BatchSandbox 总量约束**：所有 BatchSandbox 的 replicas 之和 ≤ poolMax，否则必然排队。