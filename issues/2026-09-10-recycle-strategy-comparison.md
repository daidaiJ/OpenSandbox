# recycleStrategy 策略对比：Restart / Delete / Noop 与隔离性结论

| 项 | 内容 |
|---|---|
| 背景 | Pool 模式压测销毁风暴排查中，评估切换回收策略（[主 issue](2026-09-10-pool-pending-scalein-churn.md)）作为解耦手段 |
| 日期 | 2026-09-10 |
| 状态 | 结论固化；切换 Restart 前须完成两个前置验证（见第四节） |
| 涉及代码 | `kubernetes/internal/controller/recycle/`（recycle_factory.go / delete.go / noop.go / restart.go / restart/restart_default.go）、`apis/sandbox/v1alpha1/pool_types.go` |

## 一、三种策略的实际机制

**Delete（默认）**：`recycle_factory.go` 中 `pool.Spec.RecycleStrategy == nil → DeleteRecycler`。释放回池 = 直接删除 pod，scale 逻辑按 buffer 目标新建。隔离是结构性的：新 pod = 全新可写层、全新 emptyDir、新网络 namespace 与 IP、init 容器重跑、调度器重新选节点。

**Restart**：`restart.go` + `restart/restart_default.go`，跨 reconcile 状态机：
1. 对 pod 内所有非黑名单的 Running 容器经 pod exec 执行 `kill 1`（SIGTERM 给 PID 1），要求 PID 1 优雅退出，kubelet 按 `restartPolicy: Always` 拉起新容器实例；
2. 以容器 ID 是否变化判定重启完成，状态机记录在 pod annotation；
3. 默认 30s 间隔重试、最多 3 次（`DefaultMaxRetries=3`），exec 单次超时 10s；**3 次耗尽 → `NeedDelete=true` 兜底删除**；
4. 可经 Pool annotation 配置：`blacklist`（跳过容器）、`retryInterval`、`maxRetries`、`restartCommand`（可替换为自定义命令，如清盘脚本 + kill）。
5. **init 容器不会重跑**（仅 pod 创建时执行一次）；默认 `kill 1` **不做任何文件清理**。

**Noop**：不做任何动作，pod 立即可再分配。只适合上层协议保证每次会话自初始化的场景。

## 二、逐维度对比

| 维度 | Delete（删了重建） | Restart（kill 1 重启容器） |
|---|---|---|
| 容器可写层 | 全新 ✅ | 新容器实例=全新 ✅ |
| 进程 / 内存 | 全灭 / 全新 ✅ | 全灭 / 全新 ✅ |
| **emptyDir 卷**（示例模板 `/var/lib/sandbox`、`/workspace/logs`） | 全新 ✅ | **跨重启保留 ❌** |
| pod IP / 网络命名空间 | 新 IP、新 netns ✅ | **复用 ❌**（残留连接内核态、IP 被下一租户沿用） |
| init 容器产物 | 重跑 | 保留（installer 类通常符合预期，但"重置"不会发生） |
| 节点级残留（page cache、镜像） | 概率性换节点缓解 | 永远原地，持续累积 |
| 回收延迟 | 全 pod 启动（实测 6-10s）+ 25%/轮补货限速 | 跳过调度/CNI/init 容器，容器重启约 1-3s；Recycling 期间不可分配 |
| apiserver/调度器 churn | 每 sandbox 周转一次 pod 删建 | 仅 annotation patch + exec，pod 总量恒定 |
| 隔离保证来源 | 结构性，无遗漏面 | 依赖"沙箱状态全在可写层"假设 |

**Restart 的两个隔离缺口**：① emptyDir 挂载（`/var/lib/sandbox`、`/workspace/logs`）跨重启保留——若沙箱会话状态写在卷上而非可写层，上一会话数据原样留给下一租户；② IP 复用。多租户/不可信负载若要用 Restart，必须用 `restartCommand` 换成"清目录 + kill 1"（注意 exec 单次 10s 超时、失败只记日志不阻断），或让 bootstrap 启动时清理。

## 三、成本与失败模式

**Restart 优势**：
- pod 数量恒定，sandbox 周转与池扩缩彻底解耦——对主 issue 的销毁风暴是决定性干预（回收删除、trim 连锁、Pending 连锁的源头被拆掉）；
- apiserver/etcd/调度器 churn 基本消失；回收延迟 1-3s 级。

**Restart 的代价/失败模式**：
- PID 1 必须优雅处理 SIGTERM（模板 `sh -c exec task-executor` 满足；裸 sleep 类会卡满 3 次重试走删除兜底，最坏回收延迟 90s+）；
- 回收吞吐受 `RECYCLE_POD_CONCURRENCY`（默认 64）与重试间隔约束；
- 依赖 controller→kubelet exec 可达 + `pods/exec` RBAC；
- 节点热点固化：pod 不迁移，emptyDir 占用单调增长（需 sizeLimit + kubelet 回收）；sidecar（如 egress 策略容器）需显式加 `blacklist`，否则被连带 `kill 1`；
- 理论上存在"清理不彻底但状态机判 Succeeded"的静默泄漏，Delete 无此风险。

**Delete 优势**：隔离无遗漏面，唯一适合不可信负载的默认项；失败模式简单（仅创建期配额/调度问题）。

## 四、选型结论与切换前置

| 负载信任模型 | 建议 |
|---|---|
| 多租户 / 不可信代码 | **Delete（默认）**，不为性能换隔离 |
| 可信 / 同租户高周转 | **Restart**，切换前完成两个验证 |
| 会话协议自初始化 | Noop 可用 |

**切换 Restart 前置验证**：
1. 确认沙箱会话状态落点：可写层（重启即清）还是 emptyDir 卷（跨重启泄漏）→ 后者必须补清盘路径；
2. 确认 PID 1 信号处理链路 + 不该重启的 sidecar 进 blacklist。

## 关联

- [2026-09-10-pool-pending-scalein-churn.md](2026-09-10-pool-pending-scalein-churn.md) —— 销毁风暴主根因（Pending → scale-in 自噬循环）。
