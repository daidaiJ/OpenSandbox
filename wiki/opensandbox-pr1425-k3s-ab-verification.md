# PR #1425 前后 A/B 对照验证报告：k3s 双节点缩比复现

> 日期：2026-09-10
> 关联：[issues/2026-09-10-pool-pending-scalein-churn.md](../issues/2026-09-10-pool-pending-scalein-churn.md)、[opensandbox-pr1425-k3s-bisect-burst-plan.md](opensandbox-pr1425-k3s-bisect-burst-plan.md)、上游 [#1423](https://github.com/opensandbox-group/OpenSandbox/issues/1423) / [#1425](https://github.com/opensandbox-group/OpenSandbox/pull/1425)
> 结论先行：**前坏后好，本 fork 应合 #1425**；另确认一项残留（scale-in 仍会删在途 pod，但已封顶），与方案 §4 预判一致。

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
| 服务端参数 | `pool_acquisition_timeout=30s`（默认）、创建超时 240s（现网配置） |

指纹自检：A 侧 `bufferCnt := schedulableCnt - allocatedCnt`、无 `countReadyIdlePods`；B 侧 `countReadyIdlePods` / `desiredBufferCount` / `pool_scaling_stability_test.go` 均在。

## 2. A/B 结果（同需求、同池规格、同基座 alloc≈99）

| 指标 | 前（A） | 后（B） |
|---|---|---|
| `POD_READY_TIMEOUT` 失败 | ~350/400（波次请求 100% 在 30s 池阻塞线阵亡） | ~302/400（波次失败点从 30s 推迟到 ~75s） |
| scale-down 删除（SuccessfulDelete 事件） | **13+**（事件保留期截断；实测 TOTAL 143→124 单轮 -19） | **1** |
| 池控制器连续性 | **冻结 ≥14 分钟**：03:26Z 起零 Pool reconcile（两次直接探测证实），wave 2 完全无人处理 | 持续 reconcile：~27 决策/分钟（wave 期间实测），drain 期 44 决策/3 分钟，**无冻结** |
| buffer 口径 trace | `bufferCnt` 含 Pending/在途：B=49 / Available=0；B=10 / A=0 同时出现 | buffer 只计 Ready idle |
| 删除目标 | 最老优先（含未 Ready 在途 pod） | 未 Ready 先删 + `maxUnavailable` 封顶 |
| 终态 | alloc 99 + 25 Pending 冻结 | alloc 98，池持续收敛 |

## 3. 判定与机制归因

**判定表逐项核对（wiki 方案 §4）**：`supplyCnt>0` 与 `Scaling down` 并存（前有后无）✓；Pending 不随 trim 正反馈堆积（后）✓；`podsToDelete` 批次上限（后）✓。**前坏后好 → 本 fork 合 #1425。**

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
4. 池模板 + ramp4 脚本见集群 `/tmp/bisect/`（pool-bisect-churn.yaml / ramp4.sh / sample.sh / monitor.sh）。关键标定：**readiness 延迟 70s > pool_acquisition_timeout 30s**，保证等新 pod 的沙箱必然失败 → supply 塌缩 → 在途搁浅。
5. 监控用 `kubectl logs -f` 流式落盘 + 15s 采样双通道（控制器日志 10MB 轮转极快，事后取不回）。

## 6. 环境复原清单

- controller 已滚回现网 `latest`，CRD 已恢复 fork chart 版，`bisect-churn` 池已删，lite-test-pool 2/2 健康
- 镜像 tar（两节点 /tmp）已删；containerd 内 `bisect-pre1425`/`bisect-1425` 镜像保留备复跑（各 ~97.5MiB）
- `/tmp/osb-1425-bisect` worktree 与 `/home/extvdiadmin/OpenSandbox-bisect` clone 保留
- 实验数据：`/tmp/bisect-pre-v4/`（前）、`/tmp/bisect-post/`（后）
