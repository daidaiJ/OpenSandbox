# Pool 池模式扩缩容运维手册

> 日期：2026-08-27
> 适用对象：运维 / 平台工程师
> 阅读路径：按章节顺序读，每章只推进一步认知；原理在附录，遇到"为什么"先跳过，读完正文再回来看。

## 1. 池子是什么

**一句话**：池子 = 提前创建好的一批沙箱 pod，请求来了直接分配，不用现建。

**一个图**（蓄水池）：

```
        ┌──────────────────────────────┐
        │           池子（≤ poolMax）    │
        │  ┌────────────────────────┐  │
        │  │ 缓冲：空闲 Ready pod     │← 请求来了直接拿（秒级）
        │  │ 水位 = status.available │  │
        │  └────────────────────────┘  │
        │  ┌────────────────────────┐  │
        │  │ 已分配：挂给沙箱的 pod    │  │
        │  └────────────────────────┘  │
        └──────────────────────────────┘
```

**快慢取决于一件事：请求来时池子里有没有货**（实际观测）：

| 请求来时池子的状态 | 一句话 | 拿到沙箱要多久 |
|---|---|---|
| 缓冲有货 | 池子里有未分配，直接拿 | **1~2 秒** |
| 没货，镜像已预热 | 重新创建 pod 再分配 | **5~10 秒**（首个 ~30s，全部按缺口分批） |
| 没货，还要拉镜像 | 重新建，还得先拉镜像 | **8 分钟** |

**先给答案**（推荐配置，poolMax=400）：

```yaml
spec:
  capacitySpec:
    poolMin: 10        # 闲时保底
    poolMax: 400       # 硬上限（含驱逐中 pod）
    bufferMin: 4       # 不强制保底缓冲
    bufferMax: 40      # 秒级分配吸收量；回落常驻 20
  #scaleStrategy:
  #  maxUnavailable: "25%"   # 默认；同时最多 25%×目标 个 pod 在创建中
```

> 为什么是这些数？第 3、4 章解释。先记住一句话：**缓冲决定秒级分配的量，poolMax 是硬上限**。

## 2. 跟着一个场景走一遍

场景：早上 10 点，100 个 agent 同时要沙箱。池子当前：缓冲 40，镜像已预热。

```
t=0s        t=2s        t=10s       t=20s
│───────────│───────────│───────────│
│ 100 请求    │ 40 个秒级   │ 首批 30 个  │ 第二批 30 个
│ 到达        │ 分配完成    │ 新 pod 就绪 │ 就绪，缺口补齐
│           │ 缺口 60     │ 可分配      │ 池子扩到 120
```

发生了什么：
1. 前 40 个请求：缓冲有货，2 秒内拿到沙箱；
2. 后 60 个：缓冲空了，控制器开始现建 pod；
3. 现建不是一次建 60 个，而是**分批**：每批最多 30 个，每批要等 pod 就绪（约 10s）；
4. 20 秒后 60 个全部就绪，池子扩到 120（100 分配 + 20 缓冲）。

**为什么是"每批 30 个"**：同时最多 30 个 pod 处于"创建中"（`maxUnavailable`，默认 25%×目标规模）。这是对集群的保护——不会一次性压垮集群。

> 记住两个数：**缓冲 = 秒级分配的量；每批 = maxUnavailable = 25%×目标规模**。第 3 章讲怎么调。

## 3. 四个参数各管什么

四个参数分两组：**池子规模**（poolMin / poolMax）和**缓冲区间**（bufferMin / bufferMax）。

**池子规模**：
- `poolMax`：池子总 pod 数上限（含删除中的）。**必须 ≥ 峰值并发**，否则请求排队。
- `poolMin`：闲时保底。没请求时池子至少留这么多。

**缓冲区间**：
- `bufferMin`：缓冲低于它 → 开始补货（补到区间中点）
- `bufferMax`：缓冲高于它 → 开始放水（缩到区间中点）

**滞回（防抖）**：缓冲在 `[bufferMin, bufferMax]` 区间内 → 什么都不做。越界才动作，动作目标是**区间中点** `(bufferMin+bufferMax)/2`。这是故意的：不会在边界附近反复扩缩容。

**范围表**（poolMax=400 为例）：

| 参数 | 合法 | 推荐 | 一句话 |
|---|---|---|---|
| poolMin | ≥ 0 | 0~40 | 闲时保底 |
| poolMax | ≥ 0 | ≥ 峰值并发 | 硬上限 |
| bufferMin | ≥ 0 | 0 或小值 | 低于它补货 |
| bufferMax | ≥ 0 | 40~100 | 高于它放水 |

约束：`poolMin ≤ poolMax`、`bufferMin ≤ bufferMax`、`bufferMax ≤ poolMax`。

## 4. 怎么调

**目标 → 动作**：

| 想要 | 调 | 代价 |
|---|---|---|
| 秒级分配更多 | ↑ bufferMax | 闲时占用更多 |
| 扩容更快 | ↑ maxUnavailable；预热镜像 | 集群压力更大 |
| 闲时更省 | ↓ poolMin、↓ bufferMin | 突发时冷启动 |
| 扛更大并发 | ↑ poolMax | 资源配额 |

**一个容易困惑的点**：经历负载后，池子会停在 `(bufferMin+bufferMax)/2`（bufferMin=0 时 = bufferMax/2），不会缩回闲时水平。这是故意的——避免反复冷启动。

**三条铁律**：
1. `poolMax` ≥ 峰值并发，否则必然排队；
2. 镜像必须预热（8 分钟 vs 5~10 秒）；
3. 盯 `status.available`：接近 0 = 缓冲耗尽，即将排队。

**别忘了 server 侧超时**：server 等沙箱就绪也有超时，**默认只有 60s**——池子冷拉镜像要 8 分钟时必然超时报错：

```toml
[kubernetes]
sandbox_create_timeout_seconds = 600        # 默认 60；建议 ≥ 最坏就绪时间（冷拉场景）
sandbox_create_poll_interval_seconds = 1.0  # 轮询间隔，默认 1s
```

报错特征（HTTP 504，code `K8S_POD_READY_TIMEOUT`）：

```
Timeout waiting for sandbox xxx to be Running with IP. Elapsed: 60.0s, Last state: Pending
```

池模式同样适用（BatchSandbox 分配完成即视为就绪，等待期间状态变化会打日志 `Sandbox xxx state: ...`）。调参原则：**server 超时 ≥ 池子最坏就绪时间**，否则池子还在扩容，server 先放弃了。

## 5. 怎么观测

**先跑起来**（拿数据）：

```bash
# 完整资源（capacitySpec + status 全量）
kubectl get pool -n p-cxmt-oa-agi <pool-name> -o yaml

# 关键状态一行输出（便于脚本与监控）
kubectl get pool -n p-cxmt-oa-agi <pool-name> \
  -o jsonpath='total={.status.total} allocated={.status.allocated} available={.status.available}{"\n"}'

# 确认当前容量参数
kubectl get pool -n p-cxmt-oa-agi <pool-name> \
  -o jsonpath='poolMin={.spec.capacitySpec.poolMin} poolMax={.spec.capacitySpec.poolMax} bufferMin={.spec.capacitySpec.bufferMin} bufferMax={.spec.capacitySpec.bufferMax}{"\n"}'

# 持续监控缓冲水位（每 2s 刷新）
watch -n 2 'kubectl get pool -n p-cxmt-oa-agi <pool-name> -o jsonpath="{.status.total} {.status.allocated} {.status.available}{\"\n\"}"'
```

> 提示：`kubectl get pool` 默认列已含 TOTAL / ALLOCATED / AVAILABLE / UPDATED（CRD printcolumn），直接 `kubectl get pool -n p-cxmt-oa-agi` 即可看概览，无需 jsonpath。

**三个字段**：
- `total`：池子多大
- `allocated`：多少被占
- `available`：**缓冲水位**（最该盯的）

**动作日志**（控制器）：
- 事件：`AllocationSucceeded` / `SuccessfulCreate` / `SuccessfulDelete`，用 `kubectl get events -n p-cxmt-oa-agi --field-selector involvedObject.name=<pool-name>` 看
- 日志：`Scale pool decision`（每轮扩缩容决策）、`Reconcile finished`（5s requeue = 有未满足分配），用 `kubectl logs -n <controller-ns> <controller-pod> | grep "Scale pool decision"` 看

## 6. 出问题怎么排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 分配排队、available=0 | 缓冲耗尽 | 预热镜像；↑ bufferMax |
| 扩容慢 | pod 就绪慢 | 预热镜像；↑ maxUnavailable |
| 池子不缩容 | 滞回区间内（回落常驻 = 中点） | 预期行为；要更低 ↓ bufferMax |
| 新建数 < 预期 | poolMax 含删除中 pod | 等缩容完成 |
| 突发压垮集群 | 同时建太多 | ↓ maxUnavailable；错峰 |
| 报 `Timeout waiting for sandbox xxx`（504） | server 等待超时（默认 60s）< 实际就绪时间 | 调大 `sandbox_create_timeout_seconds`；预热镜像 |

## 附录：全链路原理（支撑材料）

### A.1 事件驱动 reconcile 流程

Pool 控制器**无固定周期轮询**，由事件触发，每次 reconcile 按固定顺序执行：

```
事件触发 → 1. handleEviction（剔除待驱逐 pod）
        → 2. scheduleSandbox（分配：把 Ready 空闲 pod 挂给 BatchSandbox）
        → 3. updatePool（滚动更新：模板变更时删旧建新）
        → 4. scalePool（扩缩容：按 capacitySpec 计算目标并创建/删除 pod）
        → 5. updatePoolStatus（写 status.total/allocated/available）
```

**触发事件源**：Pool spec 变更；池内 Pod 任何变化；BatchSandbox 创建/删除/`replicas` 变化/`alloc-release` 注解变化/进入 terminating。

**关键节奏**：有未满足分配（`supplyCnt > 0`）时 **5s requeue** 直到补齐；无待办时纯事件驱动。

### A.2 扩缩容算法细节

**目标计算**（scalePool）：

```
bufferCnt = 当前可调度 pod 数 - 已分配数        // 当前空闲缓冲
desiredBufferCnt = bufferCnt 在 [bufferMin, bufferMax] 内 ? 保持 : (bufferMin+bufferMax)/2   // 滞回
desiredSchedulableCnt = max(已分配 + 待补充 + desiredBufferCnt, poolMin)
maxNewPods = max(poolMax - 总pod数(含驱逐中), 0)
```

**扩容限速**：每轮创建 `min(缺口, maxNewPods, maxUnavailable - 未就绪pod数)` 个——同时最多 `maxUnavailable` 个 pod 未就绪，这是对集群的保护。

**精确公式**：

```
扩容吞吐 ≈ maxUnavailable / T_ready          （个/秒）
全部就绪时间 ≈ ceil(N / maxUnavailable) × T_ready
```

- 同时最多造 `maxUnavailable`（未分配）个 pod，每个要 `T_ready` 秒 → 每秒造 `maxUnavailable / T_ready` 个；
- 缺口 N 个分 `ceil(N / maxUnavailable)` 批造完，每批 `T_ready` 秒。

**缩容**：`desiredSchedulableCnt < 当前` 时直接删差值个 idle pod，不限速；删除异步完成，`PoolMax` 计数含删除中 pod。

**分配前提**：只有 Ready pod 可分配（`getAvailablePodsFromAlloc` 过滤）。

### A.3 关键代码位置

| 逻辑 | 位置 |
|---|---|
| reconcile 主流程 | `kubernetes/internal/controller/pool_controller.go` `reconcilePool` |
| 扩缩容决策 | 同文件 `scalePool` |
| 分配（Ready 过滤） | `kubernetes/internal/controller/allocator.go` `getAvailablePodsFromAlloc` |
| 事件源注册 | 同文件 `SetupWithManager` |
| 参数类型定义 | `kubernetes/apis/sandbox/v1alpha1/pool_types.go` `CapacitySpec` |