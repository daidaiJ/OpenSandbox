# Pool 销毁风暴：缺陷定位与修复验证（上游 #1423 / PR #1425）

> 日期：2026-09-11（问题定位与 A/B 验证：2026-09-10）
> 性质：**一文具全**——原始问题、代码×上游双重证据链、PR 修复动作、止血完成情况、残留小缺陷、我方修复动作、镜像双验证、池配置优化、压测 200 回归确认，全部收录。
> 最终结论：**销毁风暴问题已解决**——合入上游 PR #1425（CRD 随行）+ 线上升级新版本 controller 镜像 + 池配置优化（bufferMin=20 / bufferMax=60、topologySpreadConstraints maxSkew + pod 反亲和软约束），**200 并发压测确认销毁风暴不再复现**。残留小缺陷（scale-in 仍删在途 pod，已封顶单轮收敛）另开小 issue，不重开 #1423。
> 上游：[#1423](https://github.com/opensandbox-group/OpenSandbox/issues/1423)（halleystar，2026-07-30，CLOSED）· [#1425](https://github.com/opensandbox-group/OpenSandbox/pull/1425)（GodBlf，2026-09-07 合入 main，MERGED，Closes #1423）

---

## 一、原始问题

Pool 模式压测（13 候选节点、namespace 配额 900c、模板 2c4G、poolMin=20 / poolMax=400 / buffer 4-40、负载 40 一档递增至 ~100 并发）中出现**自持的创建/删除风暴**：

1. **销毁量塌缩式畸高**：终态销毁累计 **293**、Running 峰值 **193**（≈1.52:1）；水位刚到 1/3 就开始反超。全程创建 ≈420 pod、实际需要 ~100-130——**约 70% 创建是垃圾 churn**。
2. **自噬标志**：`supplyCnt>0` 与 `scaleIn>0` 并存（一边等 pod 一边删 pod）；20-30 个 pod 长期 Pending。
3. **池冻结**：churn 期间 Pool 零 reconcile ≥14 分钟，重启 controller 无效。
4. **水位反直觉**：alloc 不到 poolMax 的 1/3 就触发。

形态定性为**四段振荡**：爬坡超建 → 顶点单波坍缩（最大单波删除发生在爬坡顶点）→ 重建 burst 撞墙 → 冻结低烧（残余 churn 以 ~10 pod/分钟累积 293 长尾）。

## 二、证据链：代码定位 × 上游 issue 双重确认

### 2.1 本地代码定位（三缺陷链，`0d82d87b^` 前侧代码）

位置：`kubernetes/internal/controller/pool_controller.go`（scalePool / pickPodsToDelete）、`allocator.go`（getAvailablePodsFromAlloc）、`internal/utils/pod.go`（ComparePodsForDeletion）。

| # | 缺陷 | 代码位置（前侧） | 机制 |
|---|---|---|---|
| L1 | **buffer 统计口径包含未 Ready pod** | `bufferCnt := schedulableCnt - allocatedCnt`（pool_controller.go:1106） | 分配器只把 Ready pod 分给 sandbox（`getAvailablePodsFromAlloc` 中 `!IsPodReady → continue`），Pending/在途卡在 idle 集合被计成「富余缓冲」——实测 trace：bufferCnt=49 / Available=0 同时出现 |
| L2 | **scale-in 无门控且最老优先** | `scaleIn := schedulableCnt - desiredSchedulableCnt`（:1147-1149，无上限）；`pickPodsToDelete` 按 CreationTimestamp 升序 | 最老的 idle pod 恰是卡最久、马上就绪的那批——trim 定向淘汰最接近可用的 pod；`utils.ComparePodsForDeletion`（考虑 Ready 状态）只用于滚动更新路径，scale-in 未使用 |
| L3 | **门控不对称 + 错误路径冻结** | scale-up 有 `maxUnavailable`(默认 25%) 预算门（:1128-1132、:1242-1253）；scale-in 无；`scalePool` 出错 `return fmt.Errorf("pool scale is not ready")` | 每删一个未 Ready pod → 预算回血 → 创建+1（正反馈）；错误返回触发 workqueue 指数退避（上限 1000s）→ 池脱离管控 |

**自噬循环**：创建 → 调度不上（Pending）→ 计入 buffer → buffer>bufferMax 触发 trim → 最老优先删掉 → 预算回血 → 再创建 → 再 Pending。20-30 Pending 即 25% 创建预算的平衡点，与观测精确吻合。

**触发不等式**（前侧代码推导，实测吻合）：`scaleIn>0 ⟺ bufferCnt > supplyCnt + desiredBufferCnt`；带内恒不剪，带外双门槛 `M > max(bufferMax, supply + midpoint)`，联立创建预算得 **`alloc ≳ 2×supply + 3×midpoint`**——解释了小池打不出来（MVP poolMax 24 数学上不可触发）、不到 1/3 水位就触发（门槛是绝对数不是占比）、bufferMax 越小越易触发。

### 2.2 上游 #1423 同构对照（第二重确认）

上游环境：controller v0.2.0 + chart 0.2.0、kata-qemu（60s+ 慢启动）、poolMax 1000 / buffer 20-100。症状：**~2250 创建 + ~2290 删除每分钟、~1300 Pending 永久滞留、AVAILABLE 恒 0、约一半请求 504，重启 controller 无效**。

| # | 上游缺陷 | 与本地对应 | 关键证据 |
|---|---|---|---|
| U1 | **Helm chart CRD 缺 `status.updated`** → DeepEqual 永不相等 → 每 reconcile 写 status 并 re-enqueue → 热循环 ~1005 reconciles/min | 本地未单列（fork chart 同病，CRD 随行解决） | 实测一分钟 reconcile 1005 / status 写 1004 / `unknown field "status.updated"` 1004，一一对应；#1337 曾将其作 "cosmetic follow-up" 推迟 |
| U2 | **带内 `desiredBufferCnt=bufferCnt` 无滞回**，出带瞬间 snap 到 midpoint → 建删交替 | 本地触发几何的一部分 | 同一秒内 16 个 reconcile 互相 undo 的日志 |
| U3 | **bufferCnt 计入未 Ready pod**（与 status.Available 口径结构性分叉） | = **L1** | 单 reconcile：bufferCnt=89 / idlePods=89 vs Available=0 |
| U4 | **scale-up 双限流、scale-down 零限流** | = **L2/L3 门控半边** | #584 限速 PR 未合入 |
| U5 | **terminating pod 不计入 totalPodCnt/schedulableCnt** → PoolMax 不约束真实占用，大删立刻被读成缺货 | 上游特有（症状非根因） | pool 显示 TOTAL 437、namespace 实有 1355 Pending |
| U6 | **最老优先删除 = 定向收割刚 Ready 的 pod** | = **L2** | 慢启动 runtime 上 oldest idle ≈ 刚完成启动 → AVAILABLE 钉死 0 |

五要素（慢启动 / buffer 误计 / 缩容无门控 / 池冻结 / 容量超限）与本地生产现象逐项同构，确认**同一代码路径、同一机制**；上游「容量超限」是 U5 的症状而非根因。

### 2.3 已排除项

| 假设 | 排除依据 |
|---|---|
| ResourceQuota 准入 | Pending pod 存在 = create 已过准入，卡点在 kube-scheduler |
| 镜像冷节点/节点性能差异 | 反亲和打散到 13 台后就绪速度一致（6-10s） |
| Sandbox TTL/周转率 | 水位 1/3 即出现销毁>running，周转率解释不了早期反超 |
| 容量墙/资源限制 | 无容量墙复现（50m/32Mi×400≈20c ≪ 节点余量）；风暴中删除均为控制器 scale-down 决策，零 Evicted/OOMKilled；1355 Pending 是 U5 症状。**资源限制既不必要也不充分** |

## 三、上游 PR #1425 修复动作（2026-09-07 合入 main）

`[codex] stabilize pool scaling`，Closes #1423。改动：`pool_controller.go`、chart CRD `pools.yaml`、新增 `pool_scaling_stability_test.go` / `pool_allocation_backfill_test.go`、e2e 与 docs。**无新增 CRD 字段 / CLI flag / Helm values，存量 manifest 兼容。**

| 修复 | 对应缺陷 | 效果 |
|---|---|---|
| 同步 Helm Pool CRD 补 `status.updated`（含 UPDATED printer column） | U1 | DeepEqual 短路恢复，热循环消除 |
| buffer 计算改 `countReadyIdlePods`（只计 Ready 且未分配），Pending 保留为在途容量 | U3/L1 | 假 buffer 燃料断 |
| scale-down 批次以 `scaleStrategy.maxUnavailable` 封顶并等待删除完成 | U4/L2/L3 | 单轮删除 ≤25%×desired，双向对称 |
| 删除排序改 least-useful-first：未 Ready 先删、同就绪度新的先删 | U6/L2 | 不再定向收割刚就绪的 pod |
| terminating pod 计入 PoolMax 占用 | U5 | PoolMax 约束真实占用 |
| 期望未满足期间保持 status 更新（软 requeue `return true, nil` + `observeDeletedPods`/`ExpectScale(Delete)`） | L3 | 池不再脱离管控 |

上游验证：envtest 36 specs、pool scaling stability 单测、expectations 单测、helm lint、渲染 CRD 字段核对。

## 四、止血完成情况

合入 #1425 后，风暴六要素全部止血（k3s 双节点缩比 A/B 实证，前 `0d82d87b^` vs 后 `0d82d87b`，同需求 400 请求、同池规格）：

| 病理 | 止血动作 | A/B 实测（前 → 后） |
|---|---|---|
| 假 buffer 燃料（L1/U3） | Ready-only 口径 | bufferCnt=49/Available=0 → **bufferCnt=0 实时 trace** |
| 无界删除（L2/U4） | maxUnavailable 25% 封顶 | 单轮 TOTAL -19 → **单轮 ≤25%、波后 137→108 单轮收敛** |
| 定向收割刚就绪 pod（L2/U6） | least-useful-first 排序 | 锯齿自噬 143→124→…→124 → 精确收敛 alloc+bufferMin |
| 池冻结（L3） | 软 requeue + 删除期望 observe | 冻结 ≥14 分钟 → **869 次决策全程连续、空窗 ≤1 分钟** |
| 热循环（U1） | CRD 补 `status.updated` | ~1005 reconciles/min → DeepEqual 短路生效 |
| terminating 盲区（U5） | 计入占用 | PoolMax 约束真实占用 |

配套确认：请求成功率两轮持平（99 vs ~97 /400）——成功率由 60s 创建总超时 vs 70s 就绪决定，**本就是独立问题，不随修复变化**；池扩容追赶 25%/轮、波次后 ~60s 收敛回带，控制平面可平稳承压。

## 五、我方修复动作

1. **合入上游 PR #1425（CRD 随行）**：chart 一体升级；CRD 缺 `status.updated` 会回热循环，必须同批生效。
2. **线上升级新版本 controller 镜像**：以 #1425 代码构建 controller 镜像并滚动更新（升级 SOP 见 §九.4）。
3. **池配置优化**（§七）：bufferMin=20 / bufferMax=60；池模板增加拓扑分离约束（maxSkew）与 pod 反亲和软约束。

## 六、镜像双验证

升级镜像执行**静态 + 动态**双重验证（原始验证曾因只看部署结果而判错，教训固化如下）：

**① 静态验证（镜像内容对不对）**：对构建产物做二进制符号验尸——`controller:bisect-1425` 二进制含 `countReadyIdlePods`×3 / `desiredBufferCount`×1；前侧镜像两者皆无。确认镜像本身无误后才进入部署。

**② 动态验证（新 pod 是否真接管）**——三件套，全部通过才开压/放流量：
- `kubectl rollout status` 成功；
- RS `readyReplicas=1`；
- **决策日志 caller 行号指纹**：前侧 ：1119 / #1425 版本 ：1132（新增 `countReadyIdlePods` 导致行号漂移）。

**教训**：`kubectl logs deploy/` 会静默打到旧 Ready pod，rollout 卡住时不会报错到操作者眼前——原始后侧 A/B 运行曾因镜像未进 worker 节点 containerd、#1425 pod 从未接管而被判无效，靠 caller 指纹 + RS 时间线 + 节点 `crictl` 取证发现并重测。**切镜像后必须验证接管再放流量。**

## 七、池配置优化

| 项 | 现网值 | 依据 |
|---|---|---|
| `bufferMin` | **20** | 保底吸收零星请求，避免冷启动 |
| `bufferMax` | **60** | 须 ≥ 一个典型突发波次规模；post-fix 下只决定「何时收缩」——太小两波之间反复建删（churn），太大是 idle 成本；同时抬高带外触发门槛（bufferMax 越小越易触发） |
| 拓扑分离约束 | `topologySpreadConstraints`（maxSkew=1） | 池 pod 均匀铺到候选节点，避免单节点集中放大资源/故障爆炸半径 |
| pod 反亲和 | **软约束**（preferredDuringScheduling） | 打散是优化不是硬需求：节点紧张时不阻塞调度，保住供给优先；实测打散到全量候选节点不影响就绪速度（6-10s） |

池模板调度打散配置骨架：

```yaml
spec:
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway   # 软约束：不满足时不阻塞调度
          labelSelector:
            matchLabels:
              <pool-pod-selector>
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels:
                    <pool-pod-selector>
```

## 八、压测 200 回归：销毁风暴确认解决

升级新版 controller 镜像 + 池配置优化后，以 **200 并发**压测回归，判定口径与 A/B 一致，逐项核对通过：

- ✅ **决策连续**：无 decision-rate 掉零（冻结前兆未出现）；
- ✅ **删除与释放同量级**：scale-down 删除速率未与沙箱释放速率分离，无销毁>running 反超；
- ✅ **无自噬标志**：不再出现 `supply>0 ∧ scaleIn>0` 持续并存的正反馈；
- ✅ **Pending 无堆积**：无 20-30 pod 长期 Pending，bufferCnt 保持 Ready-only 口径。

**结论：销毁风暴（Pending → scale-in 自噬循环）确认解决。** 后续按 §九.3 监控四件套常态化盯防。

## 九、残留小缺陷与运维对策

### 9.1 残留小缺陷（已知、已封顶，另开小 issue）

| 项 | 状态 | 计划 |
|---|---|---|
| **scale-in 仍删在途 pod** | 未 Ready 先删而非跳过；已封顶、单轮收敛、无正反馈（A/B 实锤：波次响应期 30 个在途超额 pod 被单轮收缩删除） | 另开「scale-in 跳过 in-flight」小 issue；代码层 `pickPodsToDelete` 对未 Ready idle pod 直接跳过或单列低优先级 |
| **高频突发下「建 30 删 30」churn** | 波次响应按需求信号超建、失败潮后整批回收；偶发无碍，高频突发成常态抖动 | scale-in 滞回/cooldown；需求驱动扩容（server 等待请求数注入 desired）；decision-rate 等 metrics（上游 #1650/#1651） |
| **请求成功率与修复无关** | 慢启动业务打突发仍可能大面积 `POD_READY_TIMEOUT`，只是池不再陪葬 | `sandbox_create_timeout_seconds` ≥ readiness P95 + 30%；启动加速（预拉镜像、分层 readiness） |
| **两堵墙** | CRD 必须随 controller 同步升级；worker 节点 max-pods 上限是独立调度墙（A/B 终态 3 Pending 即此） | 升级 SOP 固化；容量台账核对 max-pods/配额 |

### 9.2 配置基线（参数 → 建议值 → 依据）

| 参数 | 建议值 | 依据 |
|---|---|---|
| `sandbox_create_timeout_seconds` | ≥ readiness P95 + 30% 余量（现值 240s 若 P95≤180s 可保持） | 纯成功率参数，与风暴无关 |
| `pool_acquisition_timeout_seconds` | 30-60s，≤ 总超时 | 池打满时 429+Retry-After 快速失败通道 |
| `bufferMin / bufferMax` | **现网 20 / 60**（见 §七） | bufferMax ≥ 典型波次规模，且抬高触发门槛 |
| `maxUnavailable` | 25% 默认；对 churn 敏感降 15% | 双重身份：创建预算 + 删除封顶 |
| `poolMin / poolMax` | poolMin=低谷水位；poolMax=峰值 alloc + 一个波次 | 同时核对节点 max-pods 与 namespace 配额总账 |
| `recycleStrategy` | Delete（默认） | 选型结论见 §十 |
| 池模板 `terminationGracePeriodSeconds` | 5-10s | scale-down 删的是 idle pod，30s 默认只占资源/pod 槽位；BatchSandbox postStop（S3 回写）另评估 |
| `--concurrency` / `--kube-client-qps` | 默认 Pool=16 / BS=32；大池观察限流必要时调高 | 同一 Pool reconcile 串行，QPS 决定单轮收敛速度 |

**不要用资源参数治这个病**：触发门槛是绝对数而非占比，扩容反而更容易触发并放大爆炸半径。

### 9.3 监控告警四件套（常态化）

1. decision-rate 掉零（冻结前兆）；
2. scale-down 删除速率 vs 沙箱释放速率分离（自噬标志）；
3. bufferCnt 与 Available 口径长期偏差（误计信号）；
4. Pending message 分类（`Too many pods` → max-pods 扩容；quota → 配额扩容）。另加 pod readiness P95（成功率第一决定因素）。

### 9.4 升级 SOP（固化）

chart 一体升级（**CRD 随行**）→ 灰度单池 → **镜像双验证**（§六：静态符号验尸 + 动态接管三件套，caller :1132 指纹）→ 判定口径回归（§八）→ 回滚预案就绪。

### 9.5 风暴后遗症止血（历史预案，留档）

若再遇「资源滞留 + 新建不起来」：① `rollout restart` controller（冻结唯一解法）→ ② 批量删僵尸沙箱让 alloc 回落 → ③ idle Terminating pod `--grace-period=0 --force`（勿用于有会话 pod）→ ④ 低谷期删池重建 → ⑤ 治本按 §五核对升级状态。取证：`grep -c "Scale pool decision"`（≈0 即冻结）、`grep -c Terminating`、Pending message 分类、`describe resourcequota`。

## 十、附：recycleStrategy 选型结论（Restart / Delete / Noop）

| 策略 | 机制 | 隔离性 | 适用 |
|---|---|---|---|
| **Delete（默认，现网）** | 释放 = 删 pod 重建；全新可写层/emptyDir/网络 namespace/IP，init 重跑 | 无遗漏面，唯一适合不可信负载 | 多租户 / 不可信代码 |
| **Restart** | pod exec `kill 1` → kubelet 拉起新容器实例；默认 30s×3 重试，耗尽走删除兜底；annotation 可配 blacklist/retryInterval/maxRetries/restartCommand | **两个缺口**：emptyDir 卷跨重启保留（会话状态泄漏给下一租户）、pod IP/netns 复用；init 容器不重跑、节点热点固化 | 可信/同租户高周转——切换前必须验证会话状态落点 + PID 1 信号链 + sidecar blacklist |
| **Noop** | 不做任何动作 | 依赖上层协议自初始化 | 会话协议自初始化场景 |

## 关联（上游）

- [#1423 Pool controller: hot reconcile loop + unthrottled scale-down oscillation](https://github.com/opensandbox-group/OpenSandbox/issues/1423) · [#1425 stabilize pool scaling](https://github.com/opensandbox-group/OpenSandbox/pull/1425)
- 相关上游：#1336（chart CRD 缺 spec 字段）、#1337（修复三个字段、推迟 status.updated）、#584（未合入的 scale 限速 PR）、#906（pool scale expectation stuck）、#1650/#1651（池指标）
