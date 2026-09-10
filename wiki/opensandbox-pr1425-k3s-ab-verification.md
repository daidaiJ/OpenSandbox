# PR #1425 前后 A/B 对照验证报告：k3s 双节点缩比复现

> 日期：2026-09-10（**当日傍晚复盘修正 §7 + 后侧重测 §8**）
> 关联：[issues/2026-09-10-pool-pending-scalein-churn.md](../issues/2026-09-10-pool-pending-scalein-churn.md)、[opensandbox-pr1425-k3s-bisect-burst-plan.md](opensandbox-pr1425-k3s-bisect-burst-plan.md)、上游 [#1423](https://github.com/opensandbox-group/OpenSandbox/issues/1423) / [#1425](https://github.com/opensandbox-group/OpenSandbox/pull/1425)
> 结论：**前坏后好成立，本 fork 应合 #1425（CRD 随行）**。注意：原始后侧运行因部署失误无效（§7，当时 #1425 pod 从未接管）；后侧结论以**接管验证通过后的重测**（§8）为准。残留一项（scale-in 仍删在途 pod，已封顶单轮收敛），建议另开小 issue。

---

## 1. 实验环境

| 项 | 值 |
|---|---|
| 集群 | ubuntu 10.254.254.105（master）+ k3s-103 10.254.254.103（worker），k3s v1.30.5 |
| controller 镜像 A（前） | `docker.io/library/controller:bisect-pre1425` = `0d82d87b^`（2dc3e955） |
| controller 镜像 B（后） | `docker.io/library/controller:bisect-1425` = `0d82d87b`（PR #1425） |
| CRD A（前） | fork chart 渲染版，**无** `status.updated`（热循环缺陷在，等同现网） |
| CRD B（后） | `0d82d87b` 版，**有** `status.updated`（热循环修复） |
| 测试池 | `bisect-churn` 锁 worker 103（nodeAffinity，不碰 master 现网服务）；50m/32Mi、poolMin 20、poolMax 400、buffer 10-40、`recycleStrategy: Delete` |
| 慢启动模拟 | 主容器 `sleep 70 && touch /tmp/ready` + readinessProbe，pod 70s 才 Ready（对应上游 kata-qemu 60s+） |
| 负载（ramp4） | 基座 10 批 × 30 沙箱（30s 间隔）+ 突发 2 波 × 50，沙箱 timeout 3600，共 400 创建请求 |
| 服务端参数 | `sandbox_create_timeout_seconds`=60s（默认，未配 240s）、`pool_acquisition_timeout_seconds`=60s（CM 实配）；readiness 70s 超出两者 → 波次请求 60s 总闸 `POD_READY_TIMEOUT` 阵亡 |

指纹自检：A 侧 `bufferCnt := schedulableCnt - allocatedCnt`、无 `countReadyIdlePods`；B 侧 `countReadyIdlePods` / `desiredBufferCount` / `pool_scaling_stability_test.go` 均在。

## 2. A/B 结果（同需求、同池规格、同基座 alloc≈99）

> ⚠️ 本表中「后（B）」列数据后被 §7 复盘判定无效（当时 #1425 pod 从未接管，实为前侧二进制第二轮）；有效后侧数据见 §8 重测（B′）。

| 指标 | 前（A） | 后（B，~~无效~~） | 后重测（B′，§8 有效） |
|---|---|---|---|
| `POD_READY_TIMEOUT` 失败 | 301/400（波次请求 100% 在 60s 创建总超时阵亡：readiness 70s > 60s） | — | ~303/400（与 A 持平，成功率与修复无关） |
| scale-down 删除（SuccessfulDelete 事件） | **13+**（事件保留期截断；实测 TOTAL 143→124 单轮 -19） | **1** | 96 次日志执行（事件通道被淹没，见 §8 备注），每轮 ≤25% 封顶 |
| 池控制器连续性 | **冻结 ≥14 分钟**：03:26Z 起零 Pool reconcile（两次直接探测证实），wave 2 完全无人处理 | 持续 reconcile：~27 决策/分钟（wave 期间实测），drain 期 44 决策/3 分钟，**无冻结** | **全程连续**：869 决策，最大空窗 ≤1 分钟，无冻结 |
| buffer 口径 trace | `bufferCnt` 含 Pending/在途：B=49 / Available=0；B=10 / A=0 同时出现 | buffer 只计 Ready idle | buffer 只计 Ready idle：bufferCnt=0 实时 trace |
| 删除目标 | 最老优先（含未 Ready 在途 pod） | 未 Ready 先删 + `maxUnavailable` 封顶 | 未 Ready 先删（在途超额）+ 每轮 `maxUnavailable` 封顶，单轮收敛 |
| 终态 | alloc 99 + 25 Pending 冻结 | alloc 98，池持续收敛 | alloc 98 / total 108 = alloc+bufferMin 精确收敛 |

## 3. 判定与机制归因

> ⚠️ 本节四项实测归因中，第 2-4 条的后侧对照数据出自无效运行（§7）；归因本身（代码差异 + 前侧实测）仍然成立，重测后侧确认见 §8。

**判定表逐项核对（wiki 方案 §4）**：核对结论以 §8 重测为准：**前坏后好成立 → 本 fork 合 #1425。**

四个缺陷的实测归因：

1. **池冻结（前侧最重信号）**：`scalePool` 出错路径 `return fmt.Errorf("pool scale is not ready")` → controller-runtime workqueue 对该 Pool key 指数退避（上限 1000s）+ pre 侧删除期望值永不 `ObserveScale` → churn 期间池整体脱离管控。这正是本地 issue「池子冻住/冻结低烧」与上游「restarting the controller doesn't help」的机制。#1425 改为 `return true, nil`（软 requeue）+ `observeDeletedPods`/`ExpectScale(Delete)`。
2. **trim 无门控**：pre 侧 scale-in 无任何上限；#1425 加 `maxDeleteCnt = maxUnavailable(25%×desired)` 封顶。
3. **buffer 口径**：pre `bufferCnt = schedulableCnt - allocatedCnt` 把 Pending/在途计入缓冲（实测 B=49 全是 Pending 时仍被当富余）；#1425 改 `countReadyIdlePods`。
4. **最老优先删除**：pre 定向淘汰存活最久（≈最接近 Ready）的在途 pod；#1425 排序改为未 Ready 先删、同就绪度新的先删。

**触发数学**（前侧代码推导，实测吻合；完整推导与三推论见 [触发条件证据链](opensandbox-pool-scalein-trigger-evidence-chain.md)）：`scaleIn>0 ⟺ bufferCnt > supplyCnt + desiredBufferCnt`，band 内 `desiredBufferCnt = bufferCnt` 时该条件恒假——因此只有「buffer 越界（慢启动/失败潮使在途+Pending 堆积）+ supply 塌缩（30s 池阻塞失败）」同时发生才触发。上游 #1423 的「容量超限」是缺陷 5（terminating 不计入 totalPodCnt）的症状而非根因；**触发条件是慢启动 + 突发，与容量墙无关**——本次 MVP 已在无容量墙（50m×400=20c ≪ 节点余量）条件下复现。

## 4. 残留确认（方案 §4 预判成立）

后侧在 supply 塌缩后仍会删除在途 pod（03:51Z 1 次事件）——排序是「未 Ready 先删」而非提案的「跳过未 Ready」。由于已被 maxUnavailable 封顶且不再引发正反馈，影响可控；建议另开「scale-in 跳过 in-flight pod」小 issue，不重开 #1423。

## 5. 复现配方（供他人复跑）

1. 双点对照镜像：`0d82d87b^` / `0d82d87b` 各构建 `COMPONENT=controller`（buildx 需 `--build-arg GOPROXY=https://goproxy.cn,direct`，内网 proxy.golang.org 不通）。
2. `docker save` → `k3s ctr images import` 两个节点；deployment 引用 `docker.io/library/controller:<tag>`（pullPolicy IfNotPresent）。
3. CRD 必须随侧切换：前 = fork chart 渲染版（无 `status.updated`，chart 模板文件需先剥 `{{ }}`）；后 = `config/crd/bases/sandbox.opensandbox.io_pools.yaml`（原生 YAML）。
4. 池模板 + ramp4 脚本见集群 `/tmp/bisect/`（pool-bisect-churn.yaml / ramp4.sh / sample.sh / monitor.sh）。关键标定：**readiness 延迟 70s > server 创建总超时 60s（默认值）**，保证等新 pod 的沙箱必然 `POD_READY_TIMEOUT` 失败 → supply 塌缩 → 在途搁浅。
5. 监控用 `kubectl logs -f` 流式落盘 + 15s 采样双通道（控制器日志 10MB 轮转极快，事后取不回）。

## 6. 环境复原清单

- controller 已滚回现网 `latest`，CRD 已恢复 fork chart 版，`bisect-churn` 池已删，lite-test-pool 2/2 健康
- 镜像 tar（两节点 /tmp）已删；containerd 内 `bisect-pre1425`/`bisect-1425` 镜像保留备复跑（各 ~97.5MiB）
- `/tmp/osb-1425-bisect` worktree 与 `/home/extvdiadmin/OpenSandbox-bisect` clone 保留
- 实验数据：`/tmp/bisect-pre-v4/`（前）、`/tmp/bisect-post/`（后）

## 7. 复盘取证：原「后侧」验证判定无效（2026-09-10 傍晚）

### 7.1 矛盾点与取证链

重读原后侧日志发现决策行 caller 为 `pool_controller.go:1119`——这是**前侧源码**的行号（`0d82d87b^` 的决策日志在 :1119；`0d82d87b`/#1425 版本因新增 `countReadyIdlePods` 等改动漂移到 **:1132**，且字段/函数签名均变）。随后逐项取证：

| # | 证据 | 结果 | 含义 |
|---|---|---|---|
| 1 | RS 时间线（`kubectl get rs`） | `bisect-pre1425` RS 创建 01:45:45Z；`bisect-1425` RS 创建 **02:56:02Z**；回滚 latest 后的 pod 启动 **04:01:41Z** | 原「后侧」压测窗口（03:42–04:00Z）名义上在 bisect-1425 RS 期间 |
| 2 | 原「前侧」数据文件 mtime | `/tmp/bisect-pre-v4/*` = **03:20–03:34Z** | 前 v4 轮竟然也落在 bisect-1425 RS 窗口内——两轮都未发生真正的 RS 接管 |
| 3 | 两窗口内决策日志 caller | pre-v4 与「post」日志**全部 :1119** | 两轮日志都出自**前侧二进制**进程 |
| 4 | 103 节点 `crictl ps -a` / `ctr images ls` | 仅有 current(latest) 容器；无任何 bisect 容器/镜像记录 | bisect-1425 pod 在 103 上**没有运行痕迹**（当时 103 containerd 无该镜像 → 新 pod 未 Ready，`kubectl logs deploy/` 一直打到旧 pre pod） |
| 5 | docker 侧两镜像验尸 | `controller:bisect-1425`（fa8b7697ca96）二进制 md5 `899d4e03…`，含 `countReadyIdlePods`×3 / `desiredBufferCount`×1；`controller:bisect-pre1425`（a72711d3e153）两者皆无 | **镜像本身没错**（build 产物确为 #1425 代码）；错在部署环节镜像没进 103 containerd、切换后又未验证接管 |

**结论：原 §2 表中「后（B）」一列的数据全部无效**——那是同一前侧二进制的第二轮运行，其"仅 1 次删除、无冻结"属于运行间波动（触发不等式 `bufferCnt > supplyCnt + midpoint` 在该轮未被越过），而非修复效果。

### 7.2 镜像与行为对照表（取证终版）

| 项 | 前（有效） | 原「后」（无效） | 重测后侧（§8） |
|---|---|---|---|
| 镜像 digest | sha256:a72711d3e153…（pre 二进制，无 #1425 符号） | sha256:fa8b7697ca96…（#1425 二进制，但**未部署到 103**） | sha256:fa8b7697ca96…（105+103 containerd 均在位） |
| 实际服务的二进制 | pre（:1119） | **pre**（:1119，旧 pod 未被替换） | #1425（**:1132 实测指纹**，RS READY=1 后才开压） |
| 行为 | 16 次 SuccessfulDelete、单轮 TOTAL 143→124、冻结 ≥14min | 1 次删除、无冻结（波动，非修复） | 见 §8 |

### 7.3 修复程度评估（截至重测前）

- **代码层面：已确证**。#1425 已合入 upstream/main（含 `pool_scaling_stability_test.go` 单测）；本地构建的 `bisect-1425` 镜像经二进制符号验尸确认包含修复代码。
- **集群实证层面：原验证无效**。修复在真实 k3s 集群、同配方负载下的效果待 §8 重测。
- **方法论教训（已写入复现配方）**：A/B 切换镜像后必须先验证「新 pod 接管」再开压——验证手段：① `kubectl rollout status` 成功；② RS `readyReplicas=1`；③ 决策日志 caller 行号指纹（前 ：1119 / 后 ：1132）。`kubectl logs deploy/` 会静默打到旧 Ready pod，rollout 卡住时不会报错到操作者眼前。

## 8. 后侧重测（2026-09-10 傍晚，接管验证通过后）

**部署链（与 §7.3 教训对应）**：`controller:bisect-1425`（sha256:fa8b7697ca96…，二进制符号验尸通过）重新导入 105+103 containerd → `set image` → rollout 成功 → RS `readyReplicas=1` → **决策日志 caller=`:1132` 指纹实测确认 #1425 接管** → 重建 bisect-churn 池（与前侧完全同规格）→ ramp4 同配方（基座 10×30 + 2 波×50）。重测数据在 `/tmp/bisect-post/` 13:06 之后段（ctl-live.log 全程流 / sample.log / ramp.log）。

| 指标 | 前（A，有效） | 后重测（B′） |
|---|---|---|
| 决策连续性 | **冻结 ≥14 分钟** | **全程连续**：869 次决策，每分钟均有记录，最大空窗 ≤1 分钟 |
| TOTAL 轨迹 | 锯齿自噬 143→124→145→132→143→124，冻结在 124 | 平滑爬升 42→137；每波后**一次性收缩** 137→108、138→108 并收敛 |
| 删除执行 | 16 事件（窗口截断口径）+ 单轮 TOTAL -19 | 96 次执行、**每轮 ≤25% 封顶**：基座期 36 次小步 buffer 超限修剪 + 每波 30×2 |
| buffer 口径 | 含 Pending/在途（B=49 / Available=0） | Ready-only：**bufferCnt=0 实时 trace**，在途不再计入 buffer |
| 请求成功率 | 99/400 | ~97/400（**持平**——成功率由 60s 创建总超时 vs 70s 就绪决定，与修复无关） |
| Pending | 25 堆积冻结 | 3（103 节点 pod 上限墙 `Too many pods`，调度器行为，非控制器病理） |
| 终态 | alloc 99 + 25 Pending 冻结 | alloc 98 / total 108 = alloc + bufferMin **精确收敛** |
| 病理标志 | supply>0 ∧ scaleIn>0 并存且正反馈循环 | 波次瞬间并存（supply=33→trim 30）但**单轮收敛、不复发** |

判定表（方案 §4）重测逐项核对：`supplyCnt>0` 与 `Scaling down` 并存——前侧持续并存，后侧仅波次瞬间、一轮收敛 ✓；Pending 不随 trim 正反馈 ✓；删除批次封顶 ✓；buffer 只计 Ready ✓。**最终判定：前坏后好成立，本 fork 应合 #1425。**

**残留确认（有效运行实锤，方案 §4 预判成立）**：#1425 的 scale-in 仍会删除在途超额 pod——05:13:58Z 收缩删除的 30 个即刚创建未就绪的波次响应 pod（排序「未 Ready 先删」而非「跳过」）；因封顶 + 单轮收敛 + 无正反馈，属可控行为。维持另开「scale-in 跳过 in-flight」小 issue 的建议，不重开 #1423。

**事件通道备注**：重测期间 namespace 事件存储被基座期海量 Scheduled 事件淹没，SuccessfulDelete 事件查不到（pre 侧可查到 16 条）；删除对账统一以控制器日志 `Deleting pool pod` 执行计数为准，复现时两侧都用日志口径。

**复原**：controller 已回滚 latest（pod Running）、bisect-churn 池已删、无残留 BatchSandbox；`bisect-1425`/`bisect-pre1425` 镜像保留在 105 docker 与两节点 containerd 备复跑；tar 已删。
