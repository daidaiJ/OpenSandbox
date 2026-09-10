# Pool 压测销毁风暴：Pending → scale-in 自噬循环（根因定位与修复提案）

| 项 | 内容 |
|---|---|
| 现象 | Pool 模式压测中销毁的池 pod 持续多于 running，伴随 20-30 个 pod 长期 Pending |
| 环境 | poolMin=20 / poolMax=400 / bufferMin=4 / bufferMax=40；池模板 2c4G；namespace 配额余量 900c；13 个候选节点（nodeAffinity + 污点容忍）；压测 30min、负载按 40 一档递增至 ~100 并发 |
| 日期 | 2026-09-10 |
| 状态 | **已闭环并 A/B 验证（2026-09-10）**：删除侧因果链 + 触发条件确认；前（pre1425）坏后（#1425）好，本 fork 应合 #1425；残留一项（scale-in 未 Ready 先删而非跳过）另开小 issue。见第九节与 wiki A/B 报告 |
| 涉及代码 | `kubernetes/internal/controller/pool_controller.go`（scalePool / pickPodsToDelete）、`allocator.go`（getAvailablePodsFromAlloc）、`internal/utils/pod.go`（ComparePodsForDeletion） |

## 一、现象清单

1. **销毁的池 pod 比 Running 的多**：终态峰值销毁累计 **293**、Running 阶段 pod 峰值 **193**（293:193 = 1.52，与初测"约 1:1.5"吻合）；水位刚到 1/3（~40 并发）时就开始反超。
2. **20-30 个 pod 长期 Pending**，与销毁同时出现。
3. running pod 集中在 13 个候选节点中的 6 个；强行给池模板加 pod 反亲和打散到 13 台后，就绪速度不变（6-10s）。
4. 控制器日志快照（~100 并发时采样）：`maxNewPods=272`、`desiredSchedulableCnt=121`、`totalPodCnt=128`。
5. 负载 sandbox 并发 ~100，Running 阶段 pod 却达 193——**峰值池内约 90 个多余 pod**；全程创建 ≈ 293 销毁 + 期末存活 ~130 ≈ **420 个 pod**，实际需要 ~100-130 个，**约 70% 的创建是垃圾 churn**。

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

**终态数据量纲核对**：波幅与累计销毁均可由本模型复现——每波 40 的突增使 supply 尖峰 → desired 被抬高 → 按 25% 预算超建 → pod 就绪时 supply 已回落 → desired 坍缩 → 单次 scaleIn 50-90 的集中删除；3-4 波累计 ≈ 293 销毁。trim 单独即可解释全部销毁，无需引入 sandbox 周转（与"非 TTL"观测一致）；自噬机器全程平均吞吐 ~10 pod/分钟。Running 峰值 193 ≈ 1.9× sandbox 负载（~100），峰值的 ~90 个多余 pod 即 trim 的主要目标。

**时间序列互证（实测：100 running 前一切正常 → 忽然大量销毁 → 然后 Pending → running 冻结）**：四段观测与公式逐段吻合——
1. **爬坡期（supply>0）trim 在数学上不可能发生**：`scaleIn>0 ⟺ buffer > supply + desiredBuffer`，爬坡期每波 supply≈40 而 buffer≤40，不等式恒不成立——"100 之前好好的"是不等式的必然结果；
2. **最后一波被吸收的瞬间（supply→0）**：desired 从峰值坍缩到 allocated+22；total≈190 / allocated≈100 时 buffer≈90>40 → **一次性 scaleIn≈68**，全程最大单波删除恰好发生在爬坡顶点（"忽然大量销毁"）；
3. **trim 清空 notReady → 预算满血 → 单轮 burst ~25-30 创建**，撞上容量/调度墙（"然后 Pending"）。补充假设：被删 68 pod 释放的 ~136c 在重建间隙被共享节点的邻居租户占用，池子无法回到 193；
4. **卡死 Pending 永久占用 25% 预算**（budget≈30−25≈5）→ 创建近乎停摆（"running 停在那里"）；残余低烈度 churn（偶发 trim 最老卡死 pod → 预算回血 → 再建 → 再卡）以 ~10 pod/分钟 累积 293 长尾。

由此形态定性为**四段振荡**：爬坡超建 → 顶点单波坍缩 → 重建 burst 撞墙 → 冻结低烧。修复映射：P0 trim 门控消掉第 2 段大波，P1 buffer 口径修正消掉第 4 段低烧。

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

## 九、验证结果（2026-09-10 k3s 双节点 A/B；当日复盘修正 + 后侧重测，已闭环）

在 ubuntu 双节点 k3s 上以 `0d82d87b^`（前）vs `0d82d87b`（PR #1425，后）controller 镜像做同需求对照（400 创建请求、同池规格、基座 alloc≈99/98）。完整报告见 [wiki/opensandbox-pr1425-k3s-ab-verification.md](../wiki/opensandbox-pr1425-k3s-ab-verification.md)。

**最终判定：前坏后好成立，本 fork 应合 #1425（CRD 随行）。** 过程有波折：原后侧运行因部署失误被判无效（当时 #1425 pod 从未接管——镜像未入 worker 节点 containerd，`kubectl logs deploy/` 静默打到旧前侧 pod，日志 caller :1119 指纹可证，见报告 §7 取证与镜像/行为对照表）；重新部署并以 **caller :1132 指纹 + RS READY=1 验证接管**后重测，后侧结论成立（报告 §8）。

- **前侧（有效）**：锯齿自噬（TOTAL 143→124→145→132→143→124）、冻结 ≥14 分钟、删除 16 事件（单轮 -19）、buffer 含在途（B=49/A=0）、终态 alloc 99 + 25 Pending 冻结。
- **后侧重测（有效）**：决策全程连续（869 次，最大空窗 ≤1 分钟）；每波一次性收缩（137→108）单轮收敛无循环；删除 96 次执行、每轮 ≤25% 封顶；bufferCnt=0（Ready-only 口径实时 trace）；终态 alloc 98 / total 108 = alloc+bufferMin 精确收敛；Pending 仅 3 个（worker 节点 pod 上限墙，非控制器病理）。
- **请求成功率两轮持平（99 vs ~97 /400）**：成功率由 30s `pool_acquisition_timeout` vs 70s 就绪决定，与控制器修复无关——修复的效果在病理消失，不在成功率。
- **触发条件修正**：病理与「容量墙」无关——在无容量墙（50m 超轻模板、远低于节点余量）条件下同样复现；充分条件是「慢启动（readiness 70s > server 创建总超时 60s，测试集群默认值）+ 突发负载」使在途+Pending 堆积越界、supply 经失败潮塌缩。定量门槛 `alloc > 2×supply + 3×midpoint`（推导见 [触发条件证据链](../wiki/opensandbox-pool-scalein-trigger-evidence-chain.md)，同时解释小池不可触发与 <1/3 水位触发）。上游 #1423 的 1355 Pending 超限是 terminating 计数缺陷的症状而非根因。
- **残留（有效运行实锤）**：后侧 supply 塌缩后仍会删在途 pod（未 Ready 先删而非跳过；波次响应期创建的 30 个在途超额 pod 被单轮收缩删除），已封顶、单轮收敛、无正反馈；建议另开「scale-in 跳过 in-flight」小 issue，不重开 #1423。
- **方法论教训（A/B 必做）**：切镜像后必须验证新 pod 接管再开压——rollout status 成功 + RS readyReplicas=1 + 决策日志 caller 行号指纹（前 ：1119 / 后 ：1132）；`kubectl logs deploy/` 会静默打到旧 Ready pod。删除对账两侧统一用控制器日志 `Deleting pool pod` 口径（事件通道在 churn 期间会被淹没）。

## 关联

- [2026-09-10-recycle-strategy-comparison.md](2026-09-10-recycle-strategy-comparison.md) —— 默认 `recycleStrategy: Delete` 的周转删除流与 Restart/Delete/Noop 对比、隔离性结论。
