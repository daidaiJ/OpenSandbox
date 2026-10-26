---
name: opensandbox-cross-node-state-persistence-and-recovery
description: 从状态分层与跨节点判据出发，拆解 OpenKruise Agents 的 pause/resume、Checkpoint、Commit 与 ACS 休眠策略，对照 OpenSandbox 容器 OCI 快照、QEMU vmstate、Fast Sandbox checkpoint、池化 + S3，以及 CubeSandbox、CRIU、gVisor、Firecracker、E2B、Modal、Daytona、agent-sandbox、LiteBoxd 的机制、约束与选型边界
type: project
---

# 沙箱状态跨节点持久化与恢复：OpenKruise Agents 实践、OpenSandbox 现状与同类方案

> 调研日期：2026-10-26
> 对照基线：本仓 `dev` 分支的 K8s 池化路径（Pool + BatchSandbox + task-executor）、容器 pause/resume、QEMU vmstate、Fast Sandbox checkpoint、S3 用户目录中间层。
> 口径：外部平台的性能数字和限制来自其公开文档或第三方实践文章，未在本仓环境复测；标“实测”的内容仅代表对应文章的测试条件。OpenKruise Agents 的内存态能力依赖底层运行时平台，社区文档与阿里云 ACS 文档的口径并不完全一致，文中分别标注。

## 一、结论先行

1. **跨节点恢复的本质是“把状态变成共享存储上的不可变 artifact，再在兼容节点上重建”**，不是把运行中的 Pod 或 VM 搬到另一台机器。三件事缺一不可：目标节点能读到 artifact、运行环境兼容、调度器能把实例放上去。
2. **`sandboxId` 不变不等于状态还在**。OpenKruise Agents 的 `Stop` 休眠策略保留沙箱 ID，但会换 Pod UID 并丢掉 rootfs；OpenSandbox 的 pause/resume 也保持 `sandboxId`，恢复的是 rootfs 镜像，进程和内存不会回来。产品契约要分别写清“身份、文件系统、内存、连接”四类状态。
3. **文件系统级是默认档，内存级显式开启**。E2B、Modal、Daytona、OpenKruise Agents、CubeSandbox 都提供内存态，但都带机型、内核、CPU、连接断开、TTL 或成本约束。对短任务，重建加外部数据通常比快照便宜。
4. **节点本地状态只能当缓存或单节点故障域，不能当持久化副本**。CubeSandbox 默认 `xfs` 后端的暂停包、规划中的节点本地 COW 快照都属于这一类，节点丢失后一起丢；LiteBoxd 的 RWO PVC 在节点故障时要等卷 detach/attach，恢复时间取决于存储；Fast Sandbox 的 node state root 只是缓存，权威副本在 S3。
5. **一致性、生命周期和容量是同一等问题**。快照前 quiesce、artifact 完整落盘后再标记 Ready、digest-first、TTL/GC、恢复时的容量预留，缺一项就会在生产里变成“快照存在但不可用”或“恢复成功但数据半写”。
6. **对 OpenSandbox 的落地判断**：短任务继续走池化重建 + S3 工作区；长会话用 rootfs OCI 快照；需要秒级或内存态时用 Fast Sandbox 全量 checkpoint；容器路径的内存快照只作为受约束的后续能力。不要把 paused Pod 当持久化存储。

## 二、状态分层与“跨节点”判据

### 2.1 四层状态

| 层 | 内容 | 典型保存方式 | 跨节点难度 | OpenSandbox 对应 |
|---|---|---|---|---|
| L0 运行态 | 进程、内存、vCPU/寄存器、设备状态、未落盘缓冲 | QEMU vmstate、Firecracker memory、gVisor/CRIU checkpoint、CubeSandbox 暂停包、OpenKruise Checkpoint(memory)、E2B/Modal 内存快照 | 高：依赖同构内核/CPU/机型，连接会断 | QEMU-in-runc vmstate、Fast Sandbox memory |
| L1 执行环境 | rootfs、安装包、系统配置、可写层 | OCI commit、PVC overlay、QCOW2、节点 COW 快照 | 中：需要镜像仓库/共享卷和兼容运行时 | 容器 OCI 快照、Fast Sandbox rootfs、LiteBoxd PVC overlay |
| L2 业务数据 | 工作区文件、文档、数据库、产物 | 对象存储、PVC、业务数据库 | 低：本来就是共享存储 | 池化 + S3 用户目录同步 |
| L3 控制面 | `sandboxId`、快照记录、manifest、状态机、路由 | CRD + 关系库/PostgreSQL、对象存储索引 | 低，但必须共享且可恢复 | `SandboxSnapshot` CR、server snapshot store、FastPath CRD |

跨节点恢复通常只解决 L0/L1；L2 的权威副本应留在业务层；L3 决定恢复请求能不能被正确受理和收敛。

### 2.2 跨节点恢复的三个必要条件

1. **artifact 可达**：快照/暂停包已经写入目标节点能访问的共享存储（OCI registry、S3、RWX 卷、可重新 attach 的云盘）。只写本地盘、本地 overlay upper 或节点缓存，不满足。
2. **运行环境兼容**：CPU 特性、内核版本、QEMU/Firecracker 版本、machine type、runtime class、guest 内核都要匹配。内存态对这一条最敏感；rootfs 快照宽松得多。
3. **调度可落地**：目标节点有容量、满足 node affinity/污点、能 attach 所需卷，并且控制面允许把实例放到那里。暂停态释放了计算资源，恢复时仍要重新抢容量。

### 2.3 持久化边界

“pause 请求被接受”“快照进入 Pending/Committing”都不等于持久化完成。至少要满足：

- artifact 已完整写入共享存储，并通过 digest/校验和验证；
- 快照记录进入 `Succeed`/`Ready`；
- 源实例在 artifact 完成前不能被清理；
- 恢复端只信任 digest，不信任可变 tag；
- 删除快照记录与删除 artifact 分开建模，保留策略可审计。

OpenSandbox 的 pause 文档明确写了这一点：rootfs 只有在快照 `Succeed` 且 OCI 镜像已推送到 registry 后才算持久；进程退出、OOM、Pod Failed、节点不可用都不会自动触发快照。[pause-resume](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/pause-resume.md)

## 三、OpenKruise Agents 的做法与经验

> 说明：OpenKruise Agents 的公开材料以 user manual 和 release blog 为主，没有把“大规模治理”写成单篇长文；本节按 pause/resume、Checkpoint、Commit、ACS 休眠策略和一篇单节点实战复盘归纳。规模数字和性能只引用原文条件，不外推成本集群基线。

### 3.1 资源模型

OpenKruise Agents 把沙箱生命周期收进一组 CRD：

| 资源 | 作用 |
|---|---|
| `Sandbox` | 单个沙箱实例，管理 Pause、Resume、Checkpoint、Clone、原地升级 |
| `SandboxSet` | 预热池，按副本数维护未领取的沙箱，领取后补池 |
| `SandboxClaim` | 从 `SandboxSet` 申请一个未使用沙箱，触发原地更新和动态存储挂载 |
| `Checkpoint` | 捕获运行中 Pod 的内存和/或文件系统，可用于克隆/分叉 |
| `Commit` | 把运行中容器的可写层保存为普通 OCI 镜像，Alpha 特性 |

这套模型把“快速交付”（预热池）、“闲置降本”（pause）、“状态复用”（checkpoint/commit）拆成独立资源；状态持久化不是 create 路径的一部分，而是显式的生命周期动作。[核心概念](https://openkruise.io/zh/kruiseagents/core-concept)

### 3.2 Pause / Resume：保留身份，计算资源可回收

公开文档的口径是：默认休眠路径下，pause 冻结沙箱 Pod，resume 恢复为运行态，整个过程中 `sandboxID` 和 Pod 保持不变；休眠时所有活动的 WebSocket、PTY、命令流都会断开，客户端需要重连。[休眠与唤醒](https://openkruise.io/zh/kruiseagents/user-manuals/pause-resume) 这里的“同一个 Pod”是逻辑身份；ACS 会回收底层计算资源，唤醒时重新获取容量。

几个容易被忽略的边界：

- **内存态是否保留取决于运行时平台**。社区文档说“是否保留内存状态依赖集群环境，内存态保留目前仅在阿里云 ACS 支持”；ACS 文档则把休眠策略拆成三档：[ACS 休眠和唤醒](https://help.aliyun.com/zh/cs/user-guide/hibernate-and-wake-up-the-agent-sandbox)
- **休眠保留时间独立于运行态 timeout**。`reserve-paused-sandbox-duration` 在 pause 转换后重算 `shutdownTime`，默认 `forever`（内部是 100 年，不是无限）；`Stop` 策略只保留 PVC，rootfs 和内存都丢。
- **唤醒可能失败**。休眠会回收 vCPU/内存，恢复时要重新获取容量；库存不足或账号欠费会导致唤醒失败，长连接也不会自动恢复。
- **自动休眠/唤醒是策略层**。探针驱动空闲识别、定时唤醒、入站流量唤醒都建立在 `spec.paused` 之上；流量唤醒只对经过 Sandbox Gateway 的请求生效，网关等待超时返回 `503 sandbox wake failed`。[自动休眠与唤醒](https://openkruise.io/zh/kruiseagents/user-manuals/auto-pause-resume)

ACS 的三种休眠策略可以直接对应三种持久化档位：

| 策略 | 配置 | 保留内容 | 跨节点含义 |
|---|---|---|---|
| 默认（存储卷/云盘） | 不配置 `pauseStrategy` | 休眠前把 rootfs 保存到沙箱挂载的存储卷；ACS 文档称默认策略为云盘休眠 | 依赖卷的跨节点可访问性；卷在，rootfs 在 |
| `Stop` | `pauseStrategy.type: Stop` | 不保存 rootfs/内存，仅保留 PVC 数据 | 只有 PVC 数据可跨节点；容器内未持久化内容丢失 |
| 快照 | `pauseStrategy.type: Hibernate` + `hibernateStrategy.type: Snapshot` | 把 rootfs 保存为快照 | 快照后端支持时可跨节点恢复 |

这里的关键经验是**把“暂停”拆成多个成本/状态档位**，而不是一个“pause 一定保留所有状态”的承诺。Stop 最便宜但丢环境；卷休眠保留文件系统但依赖卷；快照休眠增加一次快照写入，换可移植性。

### 3.3 Checkpoint：内存 + 文件系统的可复用状态

`Checkpoint` 是独立 CRD，捕获运行中 Pod 某一时刻的状态，之后可以用它 Fork 出多个新沙箱：

- `spec.persistentContents` 可选 `memory`、`filesystem`，为空时默认两者都启用（从源模板继承）；
- `spec.keepRunning` 控制捕获后源 Pod 是否继续运行；
- `spec.ttlAfterFinished` 控制 Checkpoint CR 的自动回收；
- 同一个 Pod 同时只能有一个运行中的 Checkpoint；
- 删除 Checkpoint 会清理 CR 和配对的 `SandboxTemplate`，已经克隆出的沙箱不受影响。

[快照管理](https://openkruise.io/zh/kruiseagents/user-manuals/checkpoint)

**跨节点语义取决于 Checkpoint 驱动**。社区文档明确“保留什么内容、速度、体积取决于集群中配置的 Checkpoint 驱动”；ACS 文档在调研时只支持 `filesystem`，指定其他内容会创建失败。[ACS Checkpoint](https://help.aliyun.com/zh/cs/user-guide/clone-agent-sandbox-using-checkpoint) 因而不能把“OpenKruise 支持内存 Checkpoint”当成所有部署的默认能力，只能当成接口预留和平台相关实现。官方介绍还提到 GPU 内存快照，但公开文档没有给出驱动和跨节点兼容性细节，本文不展开。

### 3.4 Commit：最朴素的跨节点载体

`Commit` 把运行中容器的可写文件系统层保存为新的容器镜像并推送到镜像仓库。它和 Checkpoint 的区别是：

- 产出的是普通 OCI 镜像，任何兼容容器运行时都能拉取，也能被后续 `SandboxTemplate` 引用；
- 不包含内存和进程状态；
- 受 `Commit` 特性门控控制，当前是 Alpha。

[提交沙箱镜像](https://openkruise.io/zh/kruiseagents/user-manuals/commit)

对跨节点恢复来说，Commit 是最容易落地的一档：镜像仓库天然跨节点，恢复就是按新镜像起 Pod。代价是恢复后进程重启、启动时要拉镜像。

### 3.5 实战复盘里的三个教训

一篇单节点小规模实践文章记录了几个有代表性的现象：[OpenKruise Agents 实战](https://aik8s.run/ai-k8s/rag-agent/openkruise-agents-kubernetes-practice/)

1. **Stop 恢复后 `sandboxId` 相同，但 Pod UID 变了，写在 `/home/user` 的标记文件消失**。这直接证明“固定逻辑身份”和“状态恢复”是两件事；Stop 只保留单独持久化的数据（如 PVC）。
2. **恢复路径可能卡在镜像一致性判断上**。该文在 containerd 1.7.14 + 带摘要的镜像引用下，v0.6.0 的 `isContainersConsistent` 只做镜像名标准化，无法把完整引用和配置摘要关联，导致恢复一直等待；换专用 tag 后恢复才走通。这是“恢复正确性校验”与“镜像引用形式”耦合的典型坑。
3. **小样本里 pause 约 8.64s、resume 约 3.14s**。这不是容量或性能结论，只说明 pause/resume 不是零成本；文章也明确没有覆盖多租户压力、控制面高可用、故障迁移和内存快照。

### 3.6 对“大规模治理”的启示

OpenKruise Agents 把状态治理拆成四层动作，而不是一个 pause API：

| 目标 | 动作 | 代价 | 适用 |
|---|---|---|---|
| 快速交付 | `SandboxSet` 预热 + `SandboxClaim` | 预热库存常驻资源 | 高频、短任务 |
| 闲置降本 | Pause（按策略保留状态） | 暂停态占存储；唤醒抢容量 | 长会话、交互式 |
| 环境复用/分叉 | Checkpoint | 捕获时间和存储；内存态兼容性约束 | RL rollout、调试复现 |
| 跨节点/跨集群复用 | Commit 到 OCI 镜像 | 恢复冷启动、拉镜像 | 模板化环境、离线交付 |

规模化之后，还有几笔账要单独算：

- **容量账**：预热库存、活跃沙箱、正在退出/恢复的 Pod 要一起计入容量；只按池大小算会低估资源。
- **转换限流**：pause/resume/checkpoint 都是状态转换，需要并发上限和队列；同时唤醒大量沙箱会把节点容量和镜像/artifact 带宽打满。
- **存储账**：Checkpoint 有 TTL 也会在到期前占存储；快照包可能和 sandbox 数量同阶，必须有配额、孤儿扫描和租户隔离。
- **调度碎片**：内存态恢复要求同构节点；集群里 CPU/内核/机型不一致时，可恢复节点会变成小池子，需要单独规划 node pool。
- **租户边界**：快照包含用户数据，E2B 的 Snapshot API 按 API-key 用户隔离，CRD 路径只受 Kubernetes RBAC 约束；平台要把这两套权限模型对齐。

真正的工程决策不是“要不要 pause”，而是“这一类负载的哪一层状态值得付费保留”。

## 四、OpenSandbox 的现状

### 4.1 五条路径的总览

| 路径 | 捕获内容 | 存放 | 跨节点恢复 | 主要边界 |
|---|---|---|---|---|
| K8s 容器 pause/resume | rootfs 可写层 | OCI registry | 可以：重写模板后重建 Pod，调度到任意节点 | 单副本；不含内存；只在快照 `Succeed` 后持久；卷不包含 |
| QEMU-in-runc vmstate | rootfs + QEMU vmstate（guest RAM/vCPU/设备） | OCI registry | 可以：按兼容性字段和 node class 恢复 | 实验特性；要求镜像内 QEMU 契约；公开 snapshot clone 暂不支持 |
| Fast Sandbox checkpoint | rootfs + vmstate + guest memory + SHA256SUMS | S3 兼容 artifact store | 可以：恢复不绑定原 Fastlet | 依赖 fast-sandbox 平台；artifact 保留由运维策略负责 |
| 池化 + S3 工作区 | 用户目录/工作区文件 | S3 前缀 | 可以：create 恢复、delete 回写 | 目录同步，不是时间点快照；不是 rootfs/内存 |
| Docker runtime | 容器可写层 | 本地 Docker + registry | 单机语义；跨节点靠镜像仓库 | `docker pause` 不跨节点；snapshot 走 `docker commit` |

### 4.2 K8s 容器路径：registry 为中心的 rootfs 快照

pause 的链路是：

```text
POST /v1/sandboxes/{id}/pause
  -> server PATCH BatchSandbox.spec.pause=true
  -> BatchSandbox controller 创建 SandboxSnapshot
  -> SandboxSnapshot controller 在源 Pod 所在节点创建 commit Job
  -> image-committer 通过 containerd API commit 容器 rootfs
  -> 推送到 OCI registry
  -> SandboxSnapshot.status.phase = Succeed
  -> 删除 Pod / 释放池化分配
```

resume 则重写 `BatchSandbox` 模板镜像、清空 `poolRef`，重新创建运行时 Pod；调度器可以把新 Pod 放到任意满足条件的节点，`sandboxId` 保持不变。[pause-resume](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/pause-resume.md)

这条路径的工程优点和限制都很明确：

**优点**

- registry 是天然的跨节点、跨集群载体；恢复不依赖源节点存活。
- 和现有 `BatchSandbox`/Pool 模型兼容，pause 后释放计算资源。
- 支持池化分配释放和 `poolRef` 清理（控制器有对应分支），但业务基线 D-4 明确任务型负载不启用 pause/resume。

**限制**

- 单副本：`BatchSandbox.spec.replicas` 必须为 1，快照只记录一个源 Pod。
- 默认不含内存；QEMU 契约是例外，且属于实验能力。
- `commit Job` 必须跑在源节点，依赖 containerd socket；commit Job 默认超时 10 分钟。
- rootfs 快照不包含 PVC、hostPath、云盘、网络对端状态；这些要单独持久化。
- 只有快照 `Succeed` 且镜像推送完成才算持久；进程崩溃、OOM、Pod Failed、节点丢失都不会自动快照。
- 带 egress sidecar 的沙箱在 2026-08 的调研中无法快照（#1382）；同一轮调研中，删除 `SandboxSnapshot` 不会清理 registry 镜像（#1179）。这两项都需要在落地前确认当前版本行为。
- 恢复后连接、内存、未落盘缓冲都丢失；客户端要重连并重放业务状态。

### 4.3 QEMU vmstate：容器路径上的进程级恢复

QEMU-in-runc 模式把 QEMU 跑在普通 runc 容器里，通过 QMP 和 launch manifest 定义兼容性契约：

- rootfs 可写层和 QEMU vmstate 都推送到 registry；
- vmstate 是 zstd 压缩的 QEMU migration stream；
- manifest 记录 architecture、QEMU 版本、machine type、CPU model、vCPU、内存、`qemuConfigDigest` 和磁盘 capture 策略；
- 恢复时校验 manifest 和 node class，要求 workload 识别 `OPENSANDBOX_RESTORE_MODE=qemu-v1` 并带 `-incoming` 启动；
- 公开 snapshot clone API 暂不支持 QEMU vmstate，因为快照记录没有持久化完整 Pod 模板和启动计划。

[qemu-vmstate-snapshots](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/qemu-vmstate-snapshots.md)

这条路径说明：**内存态不是“多存一个文件”**，而是 workload、运行时和调度三者之间的契约。没有 manifest 和兼容性校验，跨节点恢复只能靠“碰巧同构”。

### 4.4 Fast Sandbox：S3 artifact store + 任意 Fastlet 恢复

Fast Sandbox 把 pause 建模为一次完整 checkpoint：

| 部分 | 内容 |
|---|---|
| `rootfs` | 沙箱可写 rootfs |
| `vmstate` | Firecracker 设备/vCPU 状态 |
| `memory` | guest memory，捕获时经节点 `/dev/shm` 暂存 |
| `SHA256SUMS` | 整个 artifact set 的 digest 清单 |

checkpoint 以 digest-first 方式写入 S3 兼容 artifact store；只有 artifact set 完整落盘后才报告 Paused。pause 后释放 Fastlet 计算资源，resume 由 admission 选择任意 Fastlet，不要求原节点。[Fast Sandbox checkpoints](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/fast-sandbox/checkpoints.md)

节点侧用私有 XFS state root 做 reflink CoW 缓存，DART 做块级 P2P 分发；跨节点共享的是 S3 上的 artifact，节点缓存不共享，避免把每个节点变成彼此的故障域。[storage](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/fast-sandbox/storage.md)

这是目前本仓最接近“跨节点内存态恢复”的实现，但它是独立于 Kubernetes operator 的另一套控制面（`sandbox.fast.io`），和容器 OCI 快照共享生命周期 API、不共享 artifact 格式。

### 4.5 池化 + S3：短任务的默认答案

池化模式的主路径是“用完即焚”：

- create 时按用户/会话从 S3 前缀恢复工作区；
- delete/TTL 到期时通过固定 postStop 钩子把工作区回写 S3，再清理本地；
- 不依赖 pause/resume，不保存 rootfs 和内存；
- 业务文档权威副本在 L2，沙箱里的 `/workspace` 只是编辑现场。

[池化 S3 同步](opensandbox-pooled-session-s3-sync-middleware.md)

这条路径的“跨节点恢复”是**重建 + 数据回放**：新 Pod 可以在任意节点起来，环境由镜像重建，数据从 S3 恢复。它不是时间点快照，无法恢复进程内状态，但对短任务密度最高、运维最轻。

### 4.6 控制面：快照记录本身也要跨节点

- Kubernetes 侧的执行状态在 `SandboxSnapshot` CR 和 `BatchSandbox` 状态里，由控制器收敛。
- 公开快照目录默认存 SQLite；server 多副本或跨节点部署时应使用 PostgreSQL（或共享存储上的同一 SQLite），否则每个 server 可能只看到自己的记录。[snapshot-store-migration](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/reference/snapshot-store-migration.md)
- Fast Sandbox 的意图和观测在 `sandbox.fast.io` CRD，FastPath 崩溃后靠 CR 重放；快照创建是“提交意图 + 观察终态”，不是内存状态。
- 恢复请求要用 sandbox UID / snapshot digest 做 fencing；同名快照、并发 restore、源实例已删除都要有明确语义。

### 4.7 现有缺口

结合本仓文档和已有调研，容器路径的缺口集中在：

1. **quiesce 契约**：只有 cgroup freeze，没有显式 `sync`/`fsfreeze`，也没有在快照状态里记录“文件系统一致”还是“崩溃一致”。
2. **统一 manifest**：容器是 `containers[]`，QEMU 是 `virtualMachine`，Fast Sandbox 是 `manifestRef + SHA256SUMS`，缺少统一的 artifact 清单和兼容性摘要。
3. **生命周期**：快照没有 TTL/配额，删除记录不删 artifact；registry 和对象存储的保留策略在外部。
4. **节点本地加速层**：没有“本地 COW 快照 + durable 回退”的分层；每次 resume 都要拉镜像。
5. **跨环境归档**：没有 export/import 格式，离线集群迁移只能靠 registry 复制。
6. **池化会话的时间点语义**：S3 同步是目录级最终一致，不是可回滚的快照。
7. **内存态统一 API**：容器路径没有 `mode=memory`，QEMU/Fast Sandbox 各自有兼容性字段。

这些缺口和吸收建议在 [BoxLite 及同类平台状态快照设计参考](opensandbox-boxlite-state-snapshot-design-references.md) 里已有更细的落点，本文不重复展开。

## 五、其他容器类沙箱的做法

### 5.1 进程级 checkpoint：CRIU / runc 与 Kubernetes

Kubernetes 的 `ContainerCheckpoint`（KEP-2008）在 v1.25 进入 alpha、v1.30 进入 beta，通过 kubelet checkpoint API 调用 CRIU，把运行中容器的状态写成节点上的 checkpoint archive。它的定位主要是取证和调试：Kubernetes 没有原生的“从 checkpoint 恢复”API，跨节点恢复通常要把 archive 转成 OCI 镜像，再在目标节点用 CRIU 恢复。[KEP-2008](https://kep.k8s.io/2008)、[CRIU Kubernetes](https://criu.org/index.php?title=Kubernetes)

限制：

- 依赖 CRIU 和目标内核/运行时版本；不是所有进程、设备、socket 都能 checkpoint；
- checkpoint archive 默认在节点本地，跨节点要自己搬；
- 恢复后的网络连接、外部副作用不会自动回滚；
- 与 Kubernetes 的 Pod 生命周期、探针、Service 端点没有原生集成。

**适用**：短时冻结、取证、迁移实验；不适合作为平台默认的跨节点状态方案。

### 5.2 gVisor：用户态内核的 checkpoint/restore

gVisor 通过 `runsc checkpoint` 把进程状态写入 state file，再 `runsc restore` 到新容器：

- state file 包含内存和文件系统状态；
- `--leave-running` 让源容器继续运行，但实现方式是“立即 restore”，容器 ID 不变、进程 ID 可能变；
- `--background` 可以先恢复内核状态、异步加载应用内存；
- 跨机器恢复要求目标主机具备快照时启用的 CPU 特性；可以用 `dev.gvisor.internal.cpufeatures` 固定暴露的特性集合，从而在不同 CPU 的机器间恢复；
- GPU checkpoint 依赖 `cuda-checkpoint`，arm64 不支持。

[gVisor checkpoint/restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/)

gVisor 的 checkpoint 是“进程级 + 文件系统级”的完整状态，但它是 runtime 级能力，不是 Kubernetes 原生 API；平台要自己解决 artifact 搬运、调度、卷挂载和恢复后的路由。

### 5.3 microVM：Firecracker / QEMU / Kata

Firecracker snapshot 保存 guest memory、VM state 和磁盘：

- 恢复要求**软件和硬件配置与生成快照时一致**；官方只列出有限的“同机型、较新宿主内核”兼容案例；
- 内存通过 `UFFD` 按需加载，恢复快，但 memory 文件要一直保留；
- diff snapshot 仍是 developer preview，且通常要和 base 合并后才能恢复；
- snapshot 文件需要调用方自己做认证、加密和完整性校验；
- VMGenID、GIC 版本、cgroups v2 等都有额外限制。

[Firecracker snapshotting](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)

QEMU 的 vmstate 同理：machine type、CPU model、QEMU 版本、设备配置都要匹配；OpenSandbox 的 QEMU 契约就是把这些兼容性字段显式化。

Kata Containers 用 VM 做 Pod 隔离，但没有像 Firecracker 那样统一的“整机快照 + 任意节点恢复”标准能力；常见做法是 VM templating 加速克隆，状态持久化仍靠镜像/卷。把 Kata 当作“天然支持跨节点暂停恢复”是常见误解。

### 5.4 CubeSandbox：本地盘到 S3 的两级演进

CubeSandbox 的跨机快照文档把工程约束写得很完整，适合作为“容器类沙箱跨节点状态”的参考实现：[cross-node-snapshot](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/zh/guide/cross-node-snapshot.md)

| 维度 | `xfs` 后端（默认） | `s3` 后端（v0.7.0 preview） |
|---|---|---|
| 暂停包/快照存放 | 创建它的节点本地盘 | 共享 S3（CubeS3lvol 管理） |
| 恢复位置 | 必须回到源节点（node affinity） | 任意兼容节点 |
| 节点故障 | 暂停态和快照一起丢 | 可从 S3 恢复 |
| 调度 | 源节点不可调度就失败 | 优先源节点，不可调度才跨机 |
| 兼容性 | 本机 | `cpuid_hash` + `host_kernel_release` 相等匹配 |
| 本地盘 | 需要 | 仍需要 WAL 镜像盘和 chunk cache；写入先落本地再异步刷 S3 |
| 切换 | 模板创建时锁定，事后不能从 `xfs` 改 `s3` | 派生链继承 `s3` |

几个值得抄的工程点：

- **两级存储**：S3 是持久副本，本地盘是写缓冲/缓存；没有本地 WAL 的节点既不能做快照也不能恢复。
- **显式兼容性门禁**：`CanCrossNode(backend, remote_status)` 只有在 `backend=s3` 且 `remote_status=ready` 时才为真；否则只允许回源节点。
- **源节点优先**：即使满足跨机条件，调度器也优先放回源节点，减少快照传输和冷启动。
- **host-mount 钉死**：带 hostPath 的沙箱固定源节点，因为 host path 没有集群级稳定身份。
- **后端不可中途切换**：模板创建时锁定 `xfs`/`s3`，避免“快照在本地、恢复却以为在 S3”的语义混乱。

它的代价也直接：运行 s3lvol 的节点每台约 2 核 + 19 GiB 内存开销（含默认 1 GiB 对象缓存），本地 WAL 和 chunk cache 需要预留磁盘；跨机恢复仍受 CPU/内核同构约束。这说明“跨节点”不是免费的开关，而是存储、网络、调度、兼容性四笔账。

### 5.5 托管沙箱：E2B / Modal / Daytona

| 平台 | 文件系统持久化 | 内存持久化 | 跨节点约束 | 生命周期 |
|---|---|---|---|---|
| **E2B** | pause 保留文件系统 | 可选 full memory；pause 约 4s/GiB，resume 约 1s | 内存态依赖 Firecracker 快照和宿主兼容性 | 暂停态保留到显式删除；Pro 连续运行 24h 后 pause/resume 重置 |
| **Modal** | Filesystem Snapshot（相对 base 差分）、Directory Snapshot（可挂载到运行中沙箱） | Memory Snapshot（实验） | 内存快照只能恢复到相同 instance type；TCP 连接关闭；源沙箱会终止；不支持 GPU；后台进程不保证恢复；不能 pin region | fs/dir 默认 30 天 TTL；memory 7 天且不可延长 |
| **Daytona** | 容器 stop 保留在 runner 并计配额；archive 移到对象存储；VM stop 卸载到近端存储 | 仅 VM 支持 pause/resume；容器 stop 清内存 | 容器 pause 不支持；VM 内存态绑定 VM 机型 | auto-stop 15min（容器）、auto-pause 60min（VM）、auto-archive 7 天 |

来源：[E2B persistence](https://e2b.dev/docs/sandbox/persistence)、[Modal snapshots](https://modal.com/docs/guide/sandbox-snapshots)、[Daytona persistence](https://www.daytona.io/docs/en/persistence/)

三个平台的共同做法：

1. **文件系统快照默认、内存快照显式**；内存快照都有 TTL、机型、连接、GPU 约束。
2. **快照是不可变 artifact，可扇出多个新沙箱**；Modal 的 fs snapshot 是 Image，Daytona 的 hot snapshot 可以 fork。
3. **生命周期是产品的一部分**：TTL、auto-archive、auto-delete、源沙箱终止语义都写进 API，而不是留给用户猜。

### 5.6 卷/文件系统派：agent-sandbox 与 LiteBoxd

**agent-sandbox（SIG）** 的 suspend 只删除 Pod，PVC 和 Service 保留；resume 重建 Pod、重挂同一 PVC，稳定 hostname 不变。它只保证 PVC 上的数据，内存和 PVC 外的写入会丢；运行时可以是普通容器、gVisor 或 Kata。[agent-sandbox](https://agent-sandbox.sigs.k8s.io/docs/)

**LiteBoxd** 用每沙箱一块 PVC 承载 rootfs overlay 的 upper/work，Pod 重建后重挂同一 PVC，用原镜像做只读下层重建 merged rootfs。它持久化整个 rootfs 增量，但恢复粒度是“同一个卷重新挂载”，没有快照/备份链路；RWO 卷在节点故障时要等 detach/attach，特权 overlay helper 也增加了攻击面。[LiteBoxd 拆解](liteboxd-persistence-and-recovery-analysis.md)

这两类的共同点是**用卷做持久化边界**：跨节点能力取决于卷能不能在目标节点重新 attach；它们不解决内存态，也不提供时间点回滚（除非底层存储另有快照）。

## 六、对照矩阵

### 6.1 机制家族

| 家族 | 代表 | 捕获状态 | 跨节点载体 | 恢复代价 | 主要风险 |
|---|---|---|---|---|---|
| 重建 + 外部数据 | OpenSandbox 池化 + S3、agent-sandbox + PVC | L2 数据；环境由镜像重建 | S3/PVC/DB | 低（冷启动） | 进程内状态丢失；回写失败/双写 |
| rootfs 快照/镜像 | OpenSandbox OCI commit、OpenKruise Commit、Modal fs snapshot | L1 rootfs | registry/S3/Image | 中（拉镜像） | 一致性；镜像体积；凭据残留 |
| 内存 + 文件系统 checkpoint | Fast Sandbox、E2B、Modal memory、CubeSandbox S3、OpenKruise Checkpoint(memory)、gVisor/CRIU | L0 + L1 | S3/registry/本地盘 + 传输 | 高（内存传输、兼容性） | 同构要求；连接断开；成本 |
| 暂停态保留（同节点） | OpenKruise 默认 pause、CubeSandbox xfs、Docker pause | L0 + L1（冻结） | 节点本地 | 低（原地） | 节点故障即丢；不能迁移 |
| 卷重挂 | agent-sandbox、LiteBoxd、K8s PVC | L1/L2 卷内数据 | PVC/云盘 | 中（attach） | RWO、跨可用区、卷驱动 |

### 6.2 实现对照

| 方案 | 捕获内容 | 跨节点载体 | 恢复位置 | 关键约束 |
|---|---|---|---|---|
| OpenSandbox 容器 pause | rootfs 可写层 | OCI registry | 任意节点（重建 Pod） | 单副本；无内存；仅 Succeed 后持久；卷不含 |
| OpenSandbox QEMU | rootfs + vmstate | OCI registry | 兼容 node class | 实验；QEMU 契约；公开 clone 暂不支持 |
| OpenSandbox Fast Sandbox | rootfs + vmstate + memory | S3 artifact store | 任意 Fastlet | 依赖 fsb；artifact 保留外部管理 |
| OpenKruise pause（默认/卷） | rootfs（+ 平台相关内存） | 卷/平台存储 | 同 Pod 身份；平台决定 | 内存态平台相关；唤醒抢容量 |
| OpenKruise pause（Stop） | 仅 PVC 数据 | PVC | 同 sandboxId，新 Pod | rootfs/内存丢失 |
| OpenKruise Checkpoint | memory + filesystem（驱动相关） | Checkpoint 驱动后端 | 克隆到新沙箱 | 一 Pod 一运行中 Checkpoint；ACS 仅 fs |
| OpenKruise Commit | rootfs | OCI registry | 任意节点 | Alpha；无内存 |
| CubeSandbox `xfs` | 内存 + 文件系统暂停包 | 节点本地盘 | 源节点 | 节点故障即丢 |
| CubeSandbox `s3` | 内存 + 文件系统暂停包 | S3 + 本地 WAL | 任意兼容节点 | `cpuid_hash`+内核匹配；后端创建时锁定 |
| runc + CRIU | 进程 + 文件系统 | 节点 checkpoint archive / 转 OCI | 兼容节点 | K8s 无原生 restore；内核/CRIU 兼容 |
| gVisor | 进程 + 文件系统 | state file | 兼容 CPU 特性的节点 | runtime 级；需固定 CPU 特性；GPU 限制 |
| Firecracker | 内存 + vmstate + 磁盘 | snapshot 文件 | 同构软硬件 | 恢复要求严格一致；UFFD 常驻 memory 文件 |
| E2B | 内存 + 文件系统 | 平台内部 | 平台节点 | 内存态成本；连接断 |
| Modal memory | 内存 + 文件系统 | 平台 Image/快照 | 相同 instance type | 7 天 TTL；源沙箱终止；TCP 断；无 GPU |
| Daytona VM | 内存 + 文件系统 | runner 近端存储/对象存储 | VM 机型 | 容器不支持 pause；archive 计费 |
| agent-sandbox | PVC 数据 | PVC | 重挂卷的节点 | 只保证 PVC；Pod 删除 |
| LiteBoxd | rootfs overlay upper/work | PVC | 重挂卷的节点 | RWO；无内存；特权 helper |

## 七、工程结论

### 7.1 选型决策树

```text
任务完成后环境可丢弃？
├─ 是 → 重建 + 外部数据（S3/PVC/DB）；不引入快照
└─ 否 → 需要保留到什么程度？
   ├─ 只保留文件/环境 → rootfs 快照或 Commit 到 OCI 镜像
   ├─ 需要保留进程/内存 → 内存 + 文件系统 checkpoint
   │  ├─ 能接受同构节点和连接断开？ → Firecracker/QEMU/gVisor/CubeSandbox/fsb
   │  └─ 不能 → 回退到 rootfs + 应用层状态机
   └─ 需要秒级恢复 → durable artifact + 节点本地 COW 缓存（两级）
```

对 OpenSandbox 的具体映射：

| 负载 | 推荐路径 | 不推荐 |
|---|---|---|
| 短任务、问答、一次性代码执行 | 池化重建 + S3 工作区 | pause/resume、rootfs 快照 |
| 长会话、需要保留装包/系统改动 | 独立长会话池 + rootfs OCI 快照 | 把 paused Pod 当持久化 |
| 需要进程连续、低恢复延迟 | Fast Sandbox 全量 checkpoint（rootfs+vmstate+memory） | 容器路径默认内存快照 |
| 仅需文档/工作区回滚 | workspace 目录快照 + 业务版本库 | 整机 OCI commit |
| 跨集群/离线交付 | OCI 镜像或 export/import 归档 | 依赖源节点本地盘 |

### 7.2 必须写进契约的不变量

1. **持久化完成才叫暂停完成**：artifact 完整、digest 校验通过、记录 Ready；中间态不允许 restore。
2. **digest-first**：恢复只信任不可变 digest，不信任 tag；manifest 记录格式版本、基础镜像 digest、兼容性摘要和 quiesce 结果。
3. **先 quiesce 再捕获**：至少 cgroup freeze + `sync`；能 `fsfreeze` 就做，并记录 `consistency=fs|crash|none` 和降级原因。
4. **fencing + 幂等**：sandbox UID / snapshot ID / generation 做条件写；重复 restore 返回同一结果；并发 restore 只有一个赢家。
5. **artifact 生命周期独立**：TTL、配额、孤儿扫描、删除审计；删除记录不等于删除 artifact，反之亦然。
6. **恢复容量预留**：暂停态不占计算，但恢复要抢容量；平台要有 headroom 或准入控制，避免“快照在、起不来”。
7. **路由和连接重建**：resume 后客户端要重新解析端点；WebSocket/PTY/DB 连接不会自动恢复；业务要能重连和重放。
8. **安全边界**：快照可能包含凭据、token、用户数据；registry/S3 权限、加密、租户隔离、镜像扫描要一起设计。

### 7.3 成本账

| 成本项 | 量级/说明 |
|---|---|
| 内存快照存储 | 约等于 guest RAM；E2B 量级是 pause ~4s/GiB、resume ~1s（官方/第三方口径） |
| rootfs 快照存储 | 可写层大小；OCI 层差分可共享 base，但会带上 `/root`、`/var` 等杂项 |
| 网络 | 跨节点恢复要传 rootfs/内存；S3/registry 的跨区流量可能比存储贵 |
| 节点本地缓存 | Fast Sandbox state root、CubeSandbox WAL/chunk cache；Cube 文档给的是每节点约 2C/19GiB + 本地盘 |
| 暂停态占用 | 暂停不是免费：卷、快照、元数据都占资源；Stop 最便宜但丢环境 |
| 恢复冷启动 | 拉镜像/下载 artifact；本地 COW 缓存能显著降低，但节点故障后要回源 |

### 7.4 常见失败模式

| 现象 | 根因 | 规避 |
|---|---|---|
| resume 后文件少了 | 只保存了 rootfs/卷的一部分；Stop 策略丢 rootfs；回写未完成 | 明确捕获范围；删除前确认回写/快照 Succeed |
| resume 卡住或 504 | 恢复路径的一致性校验、镜像引用、卷 attach 失败 | 版本固定；恢复路径加超时和可观测；失败可重试 |
| 快照成功但恢复失败 | 目标节点 CPU/内核/机型不兼容；artifact 未同步 | 兼容性门禁；digest 校验；恢复前预检 |
| 快照删了存储还在 | 记录和 artifact 生命周期解耦 | GC worker + orphan scan + 配额 |
| 暂停后节点故障，状态全丢 | 用了节点本地盘/本地 overlay | durable artifact + 节点本地只做缓存 |
| 恢复后连接全断 | 内存态不保留 socket；TCP 连接关闭 | 客户端重连；业务幂等；不要承诺连接恢复 |

## 八、对 OpenSandbox 的落点建议

结合本仓“短任务为主、资源有限、池化主路径、业务层管租户”的约束（`MEMORY.md` D-3/D-4/D-5），建议按以下优先级推进：

| 优先级 | 事项 | 改动面 | 验收 |
|---|---|---|---|
| P0 | 把“身份/文件系统/内存/连接”四类状态写进 pause/resume 文档和 API 错误语义；标注单副本、卷不含、egress sidecar 限制、快照 GC 现状 | `docs/guides/pause-resume.md`、SDK 文档、server 错误码 | 用户能从文档判断“我的状态会不会回来” |
| P0 | 容器快照 quiesce 契约：`sync` + 可选 `fsfreeze`，记录 `consistency` 和降级原因 | image-committer、`SandboxSnapshot.status`、server snapshot model | 持续写入下恢复后 fsck/哈希一致；超时回退可观测 |
| P0 | 统一 snapshot manifest（digest、base image、兼容性、quiesce 结果）；restore 先校验再执行 | CRD status、server snapshot store、CLI | 篡改 artifact 后 restore 失败；跨 registry digest 可寻址 |
| P0 | 快照 retention/TTL + registry/对象存储 GC（至少 dry-run + 告警） | snapshot service、controller、运维脚本 | 到期记录与 artifact 状态一致；restore 中的快照不被删 |
| P1 | 长会话池的节点本地 COW 快照 + durable 回退；本地快照标记 `Lost`，不参与跨节点恢复 | 新 snapshot helper、controller 调度、server runtime | 节点 drain 后本地快照失效、durable 恢复成功 |
| P1 | `osb snapshot export/import`（manifest + SHA256SUMS + 可选 artifacts） | CLI、server snapshot service | 无外网第二集群可导入；篡改失败 |
| P1 | workspace/directory 级快照，与 S3 版本化对象对齐 | snapshot service、S3 中间层 | 目录哈希一致；文档版本可独立回滚 |
| P2 | 统一 `mode=filesystem` / `mode=memory` API；内存模式只对 fsb/QEMU 开放，带 TTL、机型、连接约束 | API schema、runtime factory、文档 | 不支持的模式返回明确错误；跨机型恢复失败可读 |

运维侧建议：

- 短任务池和长会话池分开；长会话池才开快照，避免把 commit Job、registry push/pull 带进短任务热路径。
- 恢复容量单独预留；不要把“暂停态零计算”当成“恢复零成本”。
- 快照/镜像做敏感信息扫描；registry/S3 按租户前缀授权；内存快照默认不落敏感池。
- 每次发布前做一次“杀节点 + 恢复”演练，覆盖 rootfs、QEMU、fsb 三条路径。
- 监控补齐：pause 耗时、snapshot 大小、restore p50/p99、失败原因、artifact 年龄/配额、GC 残留。

## 九、边界与未验证

- 本文的外部性能数字（E2B 4s/GiB、1s resume；OpenKruise 8.64s/3.14s）来自公开文档或单节点小样本，未在本仓集群复测。
- OpenKruise Agents 的 Checkpoint 内存态依赖底层驱动；社区文档与 ACS 文档在“当前是否支持 memory”上不一致，落地前要按目标平台版本确认。
- ACS 文档在调研时只支持 `filesystem` Checkpoint；后续版本可能变化。
- CubeSandbox 跨机快照是 v0.7.0 preview；`xfs`/`s3` 后端在模板创建时锁定，不能事后切换。
- Kubernetes `ContainerCheckpoint` 的 beta 状态和 CRIU 恢复链路以目标 K8s/CRI 版本为准；它不是平台级跨节点恢复 API。
- 本文没有覆盖 GPU 内存快照、跨集群 artifact 复制、快照加密和合规审计的实现细节，这些需要单独设计。

## 十、来源

### 本仓

- [`docs/guides/pause-resume.md`](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/pause-resume.md)：容器 pause/resume 的 OCI commit 流程、单副本限制、持久化边界、卷和凭据边界。
- [`docs/guides/qemu-vmstate-snapshots.md`](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/qemu-vmstate-snapshots.md)：QEMU vmstate、launch manifest、兼容性字段和 node class。
- [`docs/architecture/fast-sandbox/checkpoints.md`](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/fast-sandbox/checkpoints.md)：rootfs + vmstate + memory 的 checkpoint、digest-first、任意 Fastlet 恢复。
- [`docs/architecture/fast-sandbox/storage.md`](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/fast-sandbox/storage.md)：S3 artifact store、XFS reflink state root、DART。
- [`docs/architecture/fast-sandbox/ha.md`](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/fast-sandbox/ha.md)：CRD-first 恢复、Fastlet 丢失和 checkpoint 恢复。
- [`wiki/opensandbox-pooled-session-s3-sync-middleware.md`](opensandbox-pooled-session-s3-sync-middleware.md)：池化会话的 S3 恢复/回写。
- [`wiki/opensandbox-boxlite-state-snapshot-design-references.md`](opensandbox-boxlite-state-snapshot-design-references.md)：BoxLite/E2B/Modal/Daytona/agent-sandbox/LiteBoxd 的快照对照和吸收清单。
- [`wiki/liteboxd-persistence-and-recovery-analysis.md`](liteboxd-persistence-and-recovery-analysis.md)：PVC + rootfs overlay 的持久化与恢复。
- [`wiki/opensandbox-open-issues-risk-review-no-pause-resume.md`](opensandbox-open-issues-risk-review-no-pause-resume.md)：快照相关 open issues（#1382、#1179 等）。
- [`oseps/0008-pause-resume-rootfs-snapshot.md`](https://github.com/opensandbox-group/OpenSandbox/blob/main/oseps/0008-pause-resume-rootfs-snapshot.md)：pause/resume 的设计目标、非目标和三阶段路线。
- [`MEMORY.md`](../MEMORY.md)：业务约束与 D-3/D-4/D-5 决策。

### 外部

- OpenKruise Agents：[休眠与唤醒](https://openkruise.io/zh/kruiseagents/user-manuals/pause-resume)、[快照管理](https://openkruise.io/zh/kruiseagents/user-manuals/checkpoint)、[自动休眠与唤醒](https://openkruise.io/zh/kruiseagents/user-manuals/auto-pause-resume)、[核心概念](https://openkruise.io/zh/kruiseagents/core-concept)、[提交沙箱镜像](https://openkruise.io/zh/kruiseagents/user-manuals/commit)。
- 阿里云 ACS：[休眠和唤醒 Agent Sandbox](https://help.aliyun.com/zh/cs/user-guide/hibernate-and-wake-up-the-agent-sandbox)、[使用 Checkpoint 克隆 Agent Sandbox](https://help.aliyun.com/zh/cs/user-guide/clone-agent-sandbox-using-checkpoint)。
- 实践复盘：[OpenKruise Agents 实战：预热池、沙箱任务与暂停恢复](https://aik8s.run/ai-k8s/rag-agent/openkruise-agents-kubernetes-practice/)。
- CubeSandbox：[跨机快照](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/zh/guide/cross-node-snapshot.md)、[路线图](https://cubesandbox.com/zh/guide/roadmap)。
- gVisor：[Checkpoint/Restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/)。
- Firecracker：[Snapshotting](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)。
- Kubernetes：[KEP-2008 ContainerCheckpoint](https://kep.k8s.io/2008)、[CRIU Kubernetes](https://criu.org/index.php?title=Kubernetes)。
- E2B：[Sandbox persistence](https://e2b.dev/docs/sandbox/persistence)。
- Modal：[Sandbox snapshots](https://modal.com/docs/guide/sandbox-snapshots)。
- Daytona：[Persistence](https://www.daytona.io/docs/en/persistence/)。
- agent-sandbox：[Documentation](https://agent-sandbox.sigs.k8s.io/docs/)。
