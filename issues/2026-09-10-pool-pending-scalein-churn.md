# Pool 压测销毁风暴：Pending → scale-in 自噬循环（根因定位与修复提案）

| 项 | 内容 |
|---|---|
| 现象 | Pool 模式压测中销毁的池 pod 持续多于 running，伴随 20-30 个 pod 长期 Pending |
| 环境 | poolMin=20 / poolMax=400 / bufferMin=4 / bufferMax=40；池模板 2c4G；namespace 配额余量 900c；13 个候选节点（nodeAffinity + 污点容忍）；压测 30min、负载按 40 一档递增至 ~100 并发 |
| 日期 | 2026-09-10 |
| 状态 | 删除侧因果链已闭环（代码级定位）；调度侧 Pending 根因待一条 jsonpath 输出收口 |
| 涉及代码 | `kubernetes/internal/controller/pool_controller.go`（scalePool / pickPodsToDelete）、`allocator.go`（getAvailablePodsFromAlloc）、`internal/utils/pod.go`（ComparePodsForDeletion） |

## 一、现象清单

1. **销毁的池 pod 比 running 多**，约 1.5:1；水位刚到 1/3（~40 并发）时就开始反超，持续累积到 150+。
2. **20-30 个 pod 长期 Pending**，与销毁同时出现。
3. running pod 集中在 13 个候选节点中的 6 个；强行给池模板加 pod 反亲和打散到 13 台后，就绪速度不变（6-10s）。
4. 控制器日志快照（~100 并发时采样）：`maxNewPods=272`、`desiredSchedulableCnt=121`、`totalPodCnt=128`。

## 二、快照反推（关键证据）

`totalPodCnt = PoolMax - maxNewPods = 400 - 272 = 128`，且 `schedulableCnt` 与 `totalPodCnt` 在 reconcilePool → scaleArgs 里取的是**同一个列表**（全部非 terminating 池 pod）。代入 `desired = allocated + supply + desiredBuffer`：

- 若 buffer ∈ [4,40]：`desiredBuffer = buffer`，则 `desired = allocated + supply + buffer = schedulable + supply ≥ 128`，不可能等于 121；
- 唯一自洽解是 **buffer > 40（越上限）**：`desiredBuffer=22` → `allocated≈80、supply≈19、buffer≈48`。

即采样那一刻：**128 个 pod 只有 ~80 个被分配，~48 个躺在 idle，19 个 sandbox 在等 pod，而池子在执行 scaleIn≈7 的删除**。pod 就绪仅 6-10s、分配在下一个 reconcile 周期（~5s）就该发生——48 个卡在 idle 说明有一批 pod 卡住远超 10s（真 Pending），同时池子把它们当"过剩 buffer"在删。

## 三、根因链：三个代码缺陷叠加成自噬循环

位置：`pool_controller.go` 的 `scalePool`（~L725-790）与 `pickPodsToDelete`（~L840）。

1. **buffer 统计口径包含未 Ready 的 pod。**
   `schedulableCnt = len(pods)`（所有非 terminating 池 pod，含 Pending/ContainerCreating），`bufferCnt = schedulableCnt - allocatedCnt`。而分配器只把 Ready pod 分给 sandbox（`allocator.go` `getAvailablePodsFromAlloc` 中 `!IsPodReady → continue`）。于是调度卡住的 pod 长期停留在 idle 集合，在扩缩容公式里被计成"富余缓冲"。

2. **scale-in 无就绪过滤，且按创建时间最老优先。**
   `pickPodsToDelete` 对 idle pod 只按 `CreationTimestamp` 升序、仅跳过已在删除中的 pod。`internal/utils/pod.go:223` 有考虑 Pending/Ready 状态的 `ComparePodsForDeletion`，但只用于滚动更新路径（pool_update.go），scale-in 未使用。最老的 idle pod 恰是卡得最久、马上就绪的那批——trim 定向淘汰最接近可用的 pod。

3. **门控不对称 + 删除正反馈。**
   scale-up 有 `maxUnavailable`（默认 25%）预算门（`notReadyCnt ≥ 25%×desired` 即停建），scale-in 完全没有对应门；且每删一个未 Ready pod → `notReadyCnt-1` → 创建预算+1，**删除动作直接放大下一轮创建**。

**循环全貌**：创建 → 调度不上（Pending）→ 计入 buffer → buffer>40 触发 trim → 最老优先删掉 → 预算回血 → 再创建 → 再 Pending。稳态运转下销毁累计自然远超 running。

**20-30 Pending = 25% 预算平衡点**：desired≈120 → 预算≈30，控制器创建到 notReady 顶线即停，与观测精确吻合。卡死 pod 还永久吃掉预算（budget = 25%×desired − notReady ≈ 5），池子连正常补货都做不动，只在 trim 后瞬间回血——这就是 supply>0 与删除并存、池子"冻住"的原因。

## 四、已排除项

| 假设 | 排除依据 |
|---|---|
| ResourceQuota 准入 | Pending pod **存在** = create 已过准入（quota 拒绝发生在创建时，表现为 FailedCreate，不会产生 pod 对象）。卡点在 kube-scheduler 调度层 |
| 镜像冷节点/节点性能差异 | 反亲和打散到 13 台后就绪速度一致（6-10s） |
| Sandbox TTL/周转率 | 水位 1/3 即出现销毁>running，周转率解释不了早期反超（周转删除由默认 recycleStrategy 承担，见关联文档） |
| maxNewPods=272 / desired=121 本身异常 | 前者是创建上限（PoolMax−total），后者是期望公式输出；单看正常。真信号是 **desired < schedulable（scaleIn>0）** |

节点集中 6/13 的修正解释：kube-scheduler LeastAllocated 在共享节点上跟随真实空闲度的自然结果（那 6 台实际更空，先被填满再外溢）；它是"6 台先满 → 13 台全满 → Pending"过程的放大器，不是删除的原因。

## 五、待收口：Pending 的调度原因（一条命令）

对任意 Pending pod（get 权限即可）：

```bash
kubectl get pod <pending-pod> -o jsonpath='{.status.conditions[*].message}'
```

| message 关键词 | 结论 | 动作 |
|---|---|---|
| `Insufficient cpu` | 13 节点真实空闲不足（共享节点；900c 是 namespace 准入配额 ≠ 节点余量；~128 pod = 256c/512G 请求） | 证据交平台管理员；poolMax 对齐真实容量 |
| `didn't match ... affinity` / `untolerated taint` | 部分节点 label/taint 实际不匹配，有效节点 <13 | 修池模板或节点 label |

## 六、修复提案（代码级，按优先级）

1. **P0**：`pickPodsToDelete`（scale-in 路径）跳过未 Ready 的 pod；或改用 `utils.ComparePodsForDeletion` 并对 trim 增加 pod 最小存活时间（避免杀掉在途 pod）。
2. **P0**：scale-in 增加与 scale-up 对称的 `maxUnavailable` 门控：notReady 已达预算时不 trim。
3. **P1**：`bufferCnt` 口径改为只统计 Ready 的 idle pod；Pending/在途 pod 单独作为"在途容量"参与 `desiredSchedulableCnt` 计算，不触发 scale-in。
4. **P2**：回归测试覆盖"创建突增 + pod 启动延迟"场景下 trim 不应删除未 Ready pod；文档补充 PoolMax 需对齐候选节点真实容量的告警。

## 七、运维侧缓解（仅动 Pool spec，可逆，可先行）

```yaml
spec:
  capacitySpec:
    bufferMin: 20      # 调钝 trim：只在 buffer>60 时触发、目标回到 40
    bufferMax: 60
  scaleStrategy:
    maxUnavailable: 10%   # 压低在途创建峰值，Pending 不再堆积到 25% 平衡点
  # 若调度瓶颈证实为容量：poolMax 临时压到 节点真实空闲 ÷ 单 pod 请求
```

调度瓶颈解决前，快补只会快产垃圾；先止血再扩容。

## 八、验证判据

1. 重跑同一 ramp：`Scale pool decision` 日志中 `scaleIn` 归零或大幅下降、销毁量塌缩；
2. 病理标志消失：不再出现 `supply>0` 且 scaleIn>0 并存（一边等 pod 一边删 pod）；
3. `SuccessfulDelete` 计数 vs `Allocate action ... toRelease` 计数分离，确认删除构成；
4. Pending pod 的 conditions message 按第五节判读归档。

## 关联

- [2026-09-10-recycle-strategy-comparison.md](2026-09-10-recycle-strategy-comparison.md) —— 默认 `recycleStrategy: Delete` 的周转删除流与 Restart/Delete/Noop 对比、隔离性结论。
