---
name: opensandbox-nonpool-node-local-volume-pause-resume
description: 非池沙箱用节点本地卷承载暂停状态的可行性调研：现有 pause 不含卷的证据链、hostPath/Local PV 两种落地方案与缺口、CubeSandbox（节点本地权威+钉源节点）与 Fast Sandbox（节点本地缓存+S3 权威）两种可吸收形态的取舍、跨节点 P2P 传递活目录的三个前置条件与传输工具横向对照、逻辑卷与节点本地副本两个新对象、per-sandbox 节点亲和的表达路径、P0~P2 落地路线与验收
type: project
---

# 非池沙箱的节点本地卷暂停/恢复：hostPath 形态、S3 归档与跨节点 P2P 传递

> 调研日期：2026-11-07
> 对照基线：本仓 `dev` 分支 tip `8aff879fa`（2026-11-02）的 K8s 非池路径（BatchSandbox + SandboxSnapshot + image-committer）、Fast Sandbox 架构文档、CubeSandbox（本地 `D:\CODE\ai\CubeSandbox`）
> 前提澄清：**"不保留内存状态"** 指只持久化 L1（可写文件系统）+ L2（业务数据），不承诺 L0（进程/内存/连接）恢复；恢复后进程重启、客户端重连、业务状态重放
> 口径：OpenSandbox 结论来自本仓 `dev` 工作树逐文件核对（已标 file:line）；CubeSandbox 结论来自其仓库 docs 与源码（已标 file:line）；Fast Sandbox 结论来自本仓 `docs/architecture/fast-sandbox/`、vendored CRD、chart 与脚本；外部项目维护状态用 `gh api` 于 2026-11-07 取 `pushed_at`；**外部性能数字未在本集群复测，本文也未改动任何代码**

关联（同目录，可直接点开）：

- [`opensandbox-cross-node-state-persistence-and-recovery.md`](opensandbox-cross-node-state-persistence-and-recovery.md)（状态分层与同类方案总览）
- [`opensandbox-boxlite-state-snapshot-design-references.md`](opensandbox-boxlite-state-snapshot-design-references.md)（快照机制吸收清单）
- [`opensandbox-dragonfly-s3-cache-acceleration-assessment.md`](opensandbox-dragonfly-s3-cache-acceleration-assessment.md)（P2P 三链路适用性判定）
- [`opensandbox-pooled-session-s3-sync-middleware.md`](opensandbox-pooled-session-s3-sync-middleware.md)（S3 用户目录中间层现状）
- [`opensandbox-pool-mode-volumes-and-storage-practice.md`](opensandbox-pool-mode-volumes-and-storage-practice.md)（卷类型与回收策略副作用）

关联（相邻主题，当前只在本机知识库目录，仓库侧暂无同名文件）：

- `wiki/opensandbox-artifact-local-cache-and-node-pinning.md`（本地热层与同节点钉定方案）
- `wiki/opensandbox-artifact-persistence-quota-capacity.md`（节点本地/共享 FS/对象存储三形态与三层配额）
- `wiki/opensandbox-node-sticky-state-vs-cross-node-migration.md`（节点粘性根因与四手段）
- `wiki/opensandbox-pooled-shared-files-s3-delivery-optimization.md`（共享依赖文件分发的带宽杠杆）

---

## 1. 结论速览

1. **当前容器路径的 pause 完全不含卷**。它只把容器可写层 commit 成 OCI 镜像层（`kubernetes/pkg/imagecommitter/image_containerd.go:52-196`），官方文档写明卷内文件"are not included in the OCI rootfs snapshot"（`docs/guides/pause-resume.md`）。所以"用节点本地卷承载暂停状态"不是对现有 pause 的调优，而是**新增一条与 OCI commit 并列的持久化通道**。
2. **hostPath 形态今天就能配，缺口在"钉节点"和"生命周期"**。非池 create 的 `volumes[].host` 已经映射成 hostPath（`server/opensandbox_server/services/k8s/volume_helper.py:95-110`），受 `[storage].allowed_host_paths` 白名单约束（`server/opensandbox_server/config.py:884-893`，**默认空 = 全部拒绝**）。但 resume 主动清空 `spec.NodeName`（`kubernetes/internal/controller/batchsandbox_pause_resume.go:111`），公开 API 也无法表达 per-sandbox 节点亲和（`platform` 只落到 `kubernetes.io/os|arch`，`server/opensandbox_server/services/k8s/workload_provider.py` 的 `apply_platform_node_selector`），所以"恢复到数据所在节点"目前没有表达方式。
3. **两个可吸收的系统恰好代表两种相反取舍**。CubeSandbox 把节点本地盘当**权威副本**（reflink 卷，resume 钉源节点 `CubeMaster/pkg/service/sandbox/sandbox_resume_pause.go:311-313`）；Fast Sandbox 把节点本地盘当**私有缓存**（"never shared between nodes… would turn every node into part of every other node's failure domain"，`docs/architecture/fast-sandbox/storage.md:19`），权威副本是 S3 上的 digest-first artifact，**任意节点都能 resume**。
4. **对"不保留内存 + 定时归档 S3 + 清理本地"这个需求，Fast Sandbox 的形态是正解，CubeSandbox 的形态是反例**：既然已经要求定时归档 S3，节点本地副本就只是缓存；缓存必须可重建，否则节点故障会把"已归档"变成"还需要人工搬回源节点"。CubeSandbox 之所以能钉源节点，是因为它的暂停包自带 `sandbox_spec.json` 且兼容性门禁严格（`Cubelet/services/cubebox/pause_package.go:24-25`、`CubeMaster/pkg/templatecenter/restore_compat.go`），代价是节点丢失即永久丢状态。
5. **跨节点 P2P 传递目录的前置条件是"内容寻址不可变"，不是传输协议**。所有可 P2P 的系统（DART、Dragonfly dfstore、Kraken、Spegel、casync/desync/bita、OSTree）都建立在 digest 身份 + 只读语义上；DART 明确写 "read-only, immutable data"。**活的、每用户唯一的、可变目录无法直接 P2P**，必须先本地 reflink 快照 + 生成 digest 索引，再让对端按缺失块拉取。
6. **对本业务规模，P2P 大概率不值得引入，S3 中转才是那条正确的直路**。per-user 会话目录的内容唯一（跨节点无复用）、写一次读少数次，P2P 退化为"节点本地缓存 + 冷路径额外开销"——这与本仓已有的 Dragonfly 评估结论一致（`opensandbox-dragonfly-s3-cache-acceleration-assessment.md` §5）。P2P 只在**同一份内容被多节点重复拉取**时才回本（镜像、共享数据集）。
7. **"跨节点恢复"的正确建模是"逻辑卷 = S3 前缀，节点本地副本 = 可丢缓存"**，而不是"卷跟着沙箱走"。这与本仓既有的两级存储结论一致（`opensandbox-node-sticky-state-vs-cross-node-migration.md` §3.1、`opensandbox-artifact-local-cache-and-node-pinning.md` §1）。
8. **本仓已经有了接口挂点，但都还在草稿态**：`SandboxSnapshot` CR 的 `status.sourceNodeName`（`kubernetes/apis/sandbox/v1alpha1/sandboxsnapshot_types.go:173-176`）和 `format: rootfs-v1|qemu-v1` 枚举（`:43-50`）是天然的"新增快照后端"位置；OSEP-0015 已经提出 `SandboxSnapshotClass` 的 `Local|BlobStore|S3` 三档（`oseps/0015-pod-snapshot.md`），其中 `Local` 正是本文要讨论的形态。
9. **`BatchSandbox.spec.template` 是 Schemaless 的原生 PodTemplateSpec**（`kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go:97-100`），所以 hostPath/Local PV/任何 CSI 卷都能塞进去且**不受 server 的 `allowed_host_paths` 白名单管**——这条路径既是能力也是风险（`opensandbox-artifact-local-cache-and-node-pinning.md` §7.2 已给加固清单）。
10. **现有 pause 路径的工程缺陷会直接继承到新通道**：`SandboxSnapshot` 没有 TTL/配额/孤儿扫描，删除记录不删 artifact；commit Job 超时 10 分钟、TTL 300 秒（`kubernetes/internal/controller/sandboxsnapshot_controller.go:43-56`）。节点本地卷的归档+清理必须自己补齐这套账，不能指望现有代码。
11. **磁盘/容量账必须写进调度**。CubeSandbox 给了可抄的三段水位（70% warn / 85% reject / 95% delete-only，`CubeMaster/pkg/templatecenter/snapshot_reconciler.go:32-37`）和 TTL（模板 artifact 7 天，`job_constants.go:66`；镜像 GC 未用 ≥24h、空闲盘 <10%、每轮最多 10 个，`Cubelet/config/config.toml:147-155`）；Fast Sandbox 给了硬地板（保持 >10 GiB 空闲、50% 余量、reflink 缺失时降级为全量拷贝，`storage.md:83-88`）。
12. **一个必须显式承认的失败语义**：节点上"未归档"的写入在节点故障时永久丢失。这是所有"节点本地热层"方案共有的代价（Substrate 架构文档自陈、CubeSandbox 暂停快照钉本地盘），所以必须把归档周期、脏窗口、可接受丢失量写成契约，而不是默认无损。

---

## 2. 需求拆解与本仓现状

### 2.1 需求拆成四件事

| 编号 | 需求 | 落点层次 | 本文对应章节 |
|---|---|---|---|
| R1 | 非池 sandbox 的沙箱内目录落在节点本地存储上（hostPath 或等价物） | K8s 卷 / 调度 | §3、§6.1 |
| R2 | 暂停/恢复快速完成，不保留内存状态 | 状态分层 L1+L2 | §3.3、§5 |
| R3 | 定时把节点本地卷归档到 S3，并清理本地 | 节点守护 + 控制面 | §6.2 |
| R4 | 跨节点传递这些节点上的目录文件（P2P） | 传输层 | §7（核心） |

### 2.2 现状：pause/resume 是 rootfs-到-registry 的单通道

`POST /v1/sandboxes/{id}/pause` 的链路：

```text
server api/lifecycle.py:283-316
  -> batchsandbox_provider.py:694-737  patch spec.pause=true
  -> BatchSandbox controller  batchsandbox_pause_resume.go:237-296 handlePause
       - 前置校验 spec.replicas == 1（:245-261，UnsupportedReplicas）
       - 停机前先停 task（:332-362）
       - 创建内部 SandboxSnapshot（名字 = <bs>-pause，:47-49、:298-330）
  -> SandboxSnapshot controller  sandboxsnapshot_lifecycle.go:41-143 handlePending
       - 解析源 Pod，要求 Running（回退：allocation → label → <name>-0）
       - 记录 sourcePodName / sourceNodeName / format / containers（:119-121）
       - 建 commit Job，NodeName = status.sourceNodeName（:485）
  -> image-committer（containerd API）
       - 读容器可写 SnapshotKey，rootfs.CreateDiff 出一层，追加到 base manifest
         （image_containerd.go:52-196）
       - 推 OCI registry
  -> succeed -> completePause（batchsandbox_pause_resume.go:436-517）
       - 非池：删除 Pod；池化：固化 pod 模板 + 清空 poolRef
       - phase=Paused 只在 Pod 删除/分配释放被接受之后才写
```

关键边界，逐条对应到"卷为什么不参与"：

| 事实 | 证据 |
|---|---|
| 只有容器可写层被 commit，**卷不在内** | `image_containerd.go:52-196`（`Snapshotter/SnapshotKey` → `CreateDiff`）；`docs/guides/pause-resume.md`："Files in mounted volumes … they are not included in the OCI rootfs snapshot" |
| QEMU 模式显式拒绝落在卷挂载下的 qcow2 overlay | `kubernetes/cmd/image-committer/qemu_snapshot.go:463-492` `validateRootfsDiskCapture` |
| commit Job 钉在源节点、用宿主机 containerd socket、namespace 默认 `k8s.io` | `sandboxsnapshot_lifecycle.go:349-366`、`:485`；`kubernetes/pkg/imagecommitter/cli/cli.go:33-34` |
| commit Job 超时 10m、backoff 3、TTL 300s | `sandboxsnapshot_controller.go:43-56` |
| **快照无 TTL / 无配额 / 删除记录不删 artifact** | 全仓无相关代码；`docs/guides/pause-resume.md` 指引"configure registry retention or garbage collection externally" |
| resume 主动清空 `spec.NodeName` | `batchsandbox_pause_resume.go:111`（`sourcePodTemplateForPause`） |
| resume 用 digest 固定镜像引用（防止可变 tag） | `kubernetes/internal/snapshot/image_reference.go`；`batchsandbox_pause_resume.go:599-607` |
| `SandboxSnapshot.status` 已有 `sourceNodeName` 与 `format` 枚举 | `sandboxsnapshot_types.go:43-50`、`:147-152`、`:173-176` |

**结论**：R1/R2 在本仓需要"新增持久化通道"，不是"改一个开关"。

### 2.3 现状：非池创建确实能挂节点本地目录

| 层 | 事实 | 证据 |
|---|---|---|
| API | `volumes[]` 支持 `host` 与 `pvc` 两个 K8s 后端，恰好一个 | `server/opensandbox_server/api/schema.py:460-517` |
| 实现 | `host` → `hostPath: {path, type: DirectoryOrCreate}`；`pvc` → `persistentVolumeClaim`；`subPath` 两者都支持 | `volume_helper.py:71-113` |
| 安全门 | `[storage].allowed_host_paths` 前缀白名单，**默认空 = 拒绝全部**；校验拒绝 `..`、未归一化路径 | `config.py:884-893`；`services/validators.py:400-437`、`:622-685` |
| 池化 | create 带 `volumes` 直接 400；卷只能写进 Pool 模板 | `batchsandbox_provider.py:158-170`；`opensandbox-pool-mode-volumes-and-storage-practice.md` §1 |
| 缺口 A | 公开 API 无法表达 per-sandbox 节点亲和：`platform` 只映射到 `kubernetes.io/os` 与 `kubernetes.io/arch` | `workload_provider.py` `apply_platform_node_selector` |
| 缺口 B | 集群里没有装 Local PV / 节点本地 CSI 驱动 | 全仓 `grep local-path / Local PV / WaitForFirstConsumer` 仅命中 docs 与 wiki，无产品代码 |
| 缺口 C | `hostPath.type: DirectoryOrCreate` 会在宿主机主动建目录，与既有加固建议（用 `type: Directory`）相反 | `volume_helper.py:98-102` vs `opensandbox-artifact-local-cache-and-node-pinning.md` §7.2 |

### 2.4 现状：已经有一个特权节点守护进程在用 hostPath state

`manifests/charts/node-agent`（对应 OSEP-0019）已经把节点本地目录作为投递保证的一部分：

- `values.yaml:93-99`：`logs: /var/log/pods`、`cgroup: /sys/fs/cgroup`、`tracing: /sys/kernel/tracing`、`state: /var/lib/opensandbox/nodeagent`、`fileData: /var/lib/opensandbox/nodeagent-data`
- `templates/daemonset.yaml:168-195`：`state` / `file-data` 为 `hostPath type: DirectoryOrCreate` **读写**
- `README.md:18-21`：*"Node-local checkpoint state and source-data retention jointly define the delivery guarantee. Do not remove the state host path…"*

**含义**：本仓已经有一处"节点本地 state 是契约一部分"的先例。新通道可以复用同一套部署形态（DaemonSet + hostPath + 节点标签），但要注意它的语义是**日志投递检查点**，不是沙箱卷快照（`components/nodeagent/README.md` 明确 `checkpoint.db` "contains recovery metadata, not record payloads"）。

### 2.5 现状：节点本地 COW / reflink 只在 fast-sandbox 存在

| 能力 | 本仓容器路径 | Fast Sandbox |
|---|---|---|
| 节点本地 reflink 快照 | 无（commit 走 containerd diff → OCI 层） | 有：私有 XFS state root，per-sandbox rootfs 是缓存 artifact 的 reflink 拷贝（`storage.md:19`、`firecracker.md:45-47`） |
| 节点本地 state 目录约定 | 无 | `/var/lib/fast-sandbox/firecracker`（`manifests/charts/fast-sandbox/values.yaml:223`）+ 建盘脚本（`scripts/fast-sandbox-state-root-setup.sh`） |
| 快照 artifact 的 TTL/配额 | 无 | 也无（明确留给运维策略，`storage.md:31`） |
| 快照后端的可插拔抽象 | 无 | 无（fsb 自成一套控制面） |
| **但有抽象提案** | OSEP-0015 的 `SandboxSnapshotClass{Local\|BlobStore\|S3}` + `operatingMode{KeepFS\|Hibernate}`（`oseps/0015-pod-snapshot.md`，draft；`KeepFS` 标注 implemented，`Hibernate` 标注 reserved） | — |

---

## 3. 目标形态

### 3.1 三层关系（对齐既有结论）

```text
逻辑沙箱
├─ 镜像层       → 环境重建（不变，继续用镜像/Pool 模板）
├─ 可写工作目录 → 节点本地卷：hostPath 目录 或 Local PV
│                   · 会话期：零网络读写
│                   · 暂停时：本地 reflink/目录级快照 + digest 索引（毫秒~秒级）
│                   · 恢复时：优先本地命中；未命中从 S3 回源并填充本地
└─ 权威副本     → S3 兼容对象存储（按用户前缀）
                    · 定时增量归档（脏窗口显式化）
                    · 跨节点/跨集群恢复的**唯一**正确性路径
```

### 3.2 与"暂停"语义的映射

| 现有状态 | 本方案对应动作 |
|---|---|
| `Paused`（今天）= Pod 删除 + OCI 镜像已推 registry | `Paused` 应扩展为"**artifact 已落 S3 且 digest 已记录**"；只落本地不算持久（对齐 `checkpoints.md:23` 的 digest-first 口径） |
| resume = 重写模板镜像 + 重建 Pod（任意节点） | resume = 优先选"本地有副本且节点健康"的节点；否则选任意节点 + 从 S3 回源。两条路径都**不恢复内存** |
| 快照记录 = `SandboxSnapshot` CR（`rootfs-v1`/`qemu-v1`） | 新增第三档 `format`（如 `local-vol-v1`），或用 OSEP-0015 的 `SandboxSnapshotClass.type: Local` |

### 3.3 "不保留内存"带来的简化

不恢复 L0，可以整块砍掉：

- 不需要 CPU/机型/内核兼容性门禁（这是内存态最贵的部分：CubeSandbox 的 `cpuid_hash` + `host_kernel_release` 严格相等、Fast Sandbox 的 vmstate/机型约束）
- 不需要 `/dev/shm` 级别的内存镜像暂存与传输
- 不需要连接重建语义之外的东西（客户端重连即可）
- 恢复时间从"传输 guest RAM"（CubeSandbox/Fast Sandbox 量级：2 GiB rootfs + 2 GiB memory ≈ 4 GiB 发布 45.61 s，`performance.md:164-177`）降到"本地 reflink 拷贝 + 进程重启"

代价：装过的包、系统改动、`/tmp` 外的运行时状态只要不在被归档的目录里就丢。所以**采集范围必须显式定义**（例如只采 `/workspace` 或指定挂载点），不要承诺"整机恢复"。

---

## 4. 可吸收模式 A：CubeSandbox（节点本地权威 + 钉源节点）

CubeSandbox 是"节点本地卷承载暂停状态"最完整的公开实现，做法逐条可抄：

| # | 机制 | 证据 | 对本文的可用性 |
|---|---|---|---|
| A1 | **reflink CoW 存储引擎**：普通文件当卷/快照，`FICLONE` 做 O(1) 快照与克隆；启动时探测 FICLONE，不支持则拒绝启动 | `cubecow/README.md:1-25`；`cubecow/src/engine/reflink.rs:80-87`、`:970-983`、`:134-173` | **直接吸收**。这就是"本地暂停快照"的原语，服务端调 `ioctl(FICLONE)` 或 `cp --reflink=always` 即可 |
| A2 | **卷与快照就是文件**，无独立 ledger，重启扫目录重建索引 | `cubecow/README.md`（Flat snapshot model / Simple crash recovery）；`reflink.rs:19-40` | 吸收：节点守护重启后能自恢复，不需要额外数据库 |
| A3 | **暂停包自带重建信息**：`sandbox_spec.json` 与 catalog/CoW 快照放一起，"so cross-node Resume can recreate without Master holding the full sandboxspec" | `Cubelet/services/cubebox/pause_package.go:24-25`、`:9-58` | **强吸收**：把"重建所需的最小 Pod 模板 + 卷映射"跟着 artifact 一起落 S3，resume 时才能在没有源节点的情况下重建 |
| A4 | **catalog.json 是恢复/列表/跨节点的必需项**，缺则不允许标 PAUSED | `Cubelet/services/cubebox/pause_cow.go:289-310`；`Cubelet/storage/snapshot_catalog.go:71-74` | 吸收：本地快照必须有清单文件 + "不可用即不可恢复"的硬门 |
| A5 | **resume 钉源节点**：`targetIP = rec.NodeIP` | `sandbox_resume_pause.go:311-313`；`pausesnap/store.go:120-170` | **不吸收**（见 §5 反例说明） |
| A6 | **粘性定价**：`paused_resource_release_ratio ∈ [0,1]`，0 = 暂停仍占满配额（resume 必成功）、1 = 全释放（resume 可能被拒 409 + `Retry-After`）；盘与 MvmNum 不受该比例影响 | `Cubelet/pkg/config/config.go:48-69`；`Cubelet/services/cubebox/update.go:241-334` | 吸收：把"暂停态占多少本地盘"变成可调参数，并让"恢复被拒"成为可重试状态而非静默失败 |
| A7 | **快照盘三段水位参与调度**：70% warn / 85% reject / 95% delete-only | `CubeMaster/pkg/templatecenter/snapshot_reconciler.go:32-37`、`:458-472` | 吸收：节点本地卷必须让调度器看得见水位 |
| A8 | **artifact TTL 与镜像 GC**：模板 artifact 7 天；镜像在"空闲盘 <10% 且未用 ≥24h"时清理，每轮最多 10 个、按 last-used 排序 | `job_constants.go:66`；`Cubelet/config/config.toml:147-155`；`Cubelet/services/images/image_gc.go:159-222` | 吸收：R3 的清理策略可以直接照这个形状写 |
| A9 | **按需加载的跨节点快照是路线图项，尚未实现**；今天的跨节点只有"模板/ext4 artifact 分发到目标节点后重建" | `docs/zh/guide/roadmap.md:7-13`；`CubeMaster/pkg/templatecenter/distribution.go:142-250`；`docs/zh/guide/lifecycle.md:262` | **重要**：连 CubeSandbox 都还没打通"跨节点搬目录"，说明这是行业性难题，不是配置问题 |
| A10 | S3 后端在 CoW 层只有占位：`NameS3 = "s3"` 标注 "reserved for a future remote-backed implementation" | `Cubelet/storage/cow/store.go:6-30` | 说明"节点本地权威 + S3 归档"这条路它自己也没走通 |

---

## 5. 可吸收模式 B：Fast Sandbox（节点本地缓存 + S3 权威）——推荐形态

Fast Sandbox 把同一批原语组织成"可丢缓存 + 不可变权威副本"，这是与 R3 需求同构的形态。逐条事实：

| # | 机制 | 证据 | 对本文的可用性 |
|---|---|---|---|
| B1 | **节点 state root 是私有缓存，明确不跨节点共享**："never shared between nodes… cross-node state sharing would turn every node into part of every other node's failure domain" | `docs/architecture/fast-sandbox/storage.md:19`；chart 注释 `values.yaml:219-223` | **核心吸收**：本地副本必须可丢、可重建；这一句就是"为什么不能把节点本地盘当权威"的答案 |
| B2 | **digest-first 落盘**："a pause is only reported complete after the artifact set is fully in the store"；恢复只信 manifest digest，不信 tag | `checkpoints.md:23`、`:54` | **核心吸收**：定义"暂停完成"的门槛；直接决定 R2 的语义 |
| B3 | **任意节点 resume**：artifact store（不是节点局部性）才是可移植性来源；resume 会推进 route generation，客户端必须重新解析 endpoint | `checkpoints.md:32-38`；`scheduling.md:33`（`state` 字段） | **核心吸收**：跨节点恢复走 S3 回源即成立，P2P 只是加速 |
| B4 | **4 MiB 块级 P2P，取数顺序 `cache → peer → origin`**：每块在集群内大约只从源站取一次，其余由 peer 提供；按节点统计 block source 计数 | `storage.md:21`；`firecracker.md:28-32` | 吸收（有条件）：见 §7.3 的适用性判断——它建立在"内容不可变"前提上 |
| B5 | **P2P 的前置声明**：只读、不可变数据；peer 通过 headless Service 名单发现，名单必须全量到齐才开拉 | `storage.md:21`、`firecracker.md:30-32`；task 侧证据 `scripts/fast-sandbox-env/integration-env.sh:1189-1227` | 吸收：P2P 身份 = 内容 digest；扩张到可变内容需要另设计 |
| B6 | **块级去重是可断言的性质**：集成脚本按 `(size + 4MiB-1)/4MiB` 算期望块数，校验集群 `origin_total` 不超过期望+4，否则判"未去重" | `integration-env.sh:1189-1227` | 吸收：P2P 收益必须可度量，否则无法证明它回本 |
| B7 | **state root 就绪检查与降级**：要求 `type xfs` + `reflink CoW supported`；盘不足 10 GiB 会让节点摘掉调度标签；reflink 缺失则 warn + 退化为全量拷贝 | `storage.md:110-115`；`firecracker.md:45-50` | 吸收：这是本方案节点侧的"就绪门槛 + 降级路径"模板 |
| B8 | **建盘脚本的安全形状**：拒绝已存在的 backing file / 符号链接 / 已挂载或非空挂载点；失败时保留数据供排查；打印 fstab 条目但不代改 | `scripts/fast-sandbox-state-root-setup.sh:41-108` | 吸收：节点本地卷的初始化必须同样保守 |
| B9 | **容量与余量规则**：预算 = 每个缓存模板的 rootfs + guest 内存快照 + 活跃可写数据 + 缓存开销；至少 50% 余量 | `storage.md:83-88` | 吸收（去掉内存那一项） |
| B10 | **缓存预热与保护**：`warmImages` 异步预拉并免于普通缓存淘汰；但就绪不等它 | `scheduling.md:21`；CRD `manifests/charts/base/files/fast-sandbox-crds.yaml:316-320` | 吸收：热点目录可预热，但不能阻塞 create |
| B11 | **本地缓存无自动 LRU 文档，且明确"提交过的缓存是 FINAL（永不刷新）"**；清理需先 drain 工作负载、且不得删活的 `images`/`cache`/`jails` | `storage.md:90-95`；`integration-env.sh:2087-2088` | **吸收并补齐**：本方案必须自己写 LRU/引用计数/守护规则，否则就是维护一个没有淘汰策略的缓存 |
| B12 | **量级参考（同节点）**：pause 被接受 22.4 ms；pause → 持久 `Paused` 61.14 s（其中冻结 11.15 s、发布约 4 GiB 45.61 s）；resume 运行时创建 35.49 ms、rootfs 准备 2.92 ms，但**端到端 SDK resume → /ping 62.66 s** | `performance.md:164-177` | 关键预期管理：真正耗时在**发布/传输**，不在本地 clone；跨节点回源只会更慢。跨节点冷路径在文档中标注为**未实测**（`performance.md:200-203`） |

**为什么推荐 B 形态而不是 A 形态**：

1. R3 已经要求"定时归档到 S3 + 清理" ⇒ 权威副本必然在 S3 ⇒ 本地副本必然可重建 ⇒ 没有任何理由把 resume 钉死在源节点。
2. 节点池会被 drain、缩容、故障；钉节点的方案在节点消失时会把"已归档数据 + 已丢失本地副本"组合成"必须先人工把数据搬回来才能 resume"。
3. B 形态允许渐进：第一阶段 P2P 可以完全不实现（只走 S3），后续再加 P2P 只是加速，不改变正确性。

---

## 6. 落点：与本仓现有接口的对接

### 6.1 R1 —— 目录怎么落到节点本地

两条路，按推荐度排序：

| 方案 | 机制 | 对本仓的改动面 | 边界 |
|---|---|---|---|
| **Local PV + `volumeBindingMode: WaitForFirstConsumer`**（推荐） | PV 的 `nodeAffinity` 声明数据位置，延迟绑定让调度器按它选节点；**Pod spec 里没有 hostPath**，能过 Pod Security Standards restricted | 需要集群侧装 `sig-storage-local-static-provisioner`（本仓目前没有）；create 走 `volumes[].pvc`，**公开 API 已支持**（`volume_helper.py:71-89`） | Local PV 不可搬迁：节点没了，PV 也废。所以必须"每节点一个副本对象"，逻辑卷与物理副本分开建模（见 §6.3） |
| **hostPath 目录**（可行但不推荐） | create 的 `volumes[].host` → hostPath（`volume_helper.py:95-110`），白名单控制前缀 | 零代码；但要放开 `allowed_host_paths`，且 `type` 现为 `DirectoryOrCreate` | PSS baseline/restricted 两档都禁止 hostPath；需要显式豁免命名空间 + 只读递归挂载 + SELinux/AppArmor（`opensandbox-artifact-local-cache-and-node-pinning.md` §7.2 已给清单） |
| BatchSandbox 模板内原生卷（非池 CR 直连路径） | `spec.template` 是 Schemaless 原生 PodTemplateSpec（`batchsandbox_types.go:97-100`），什么卷都能放，且**不受 server 白名单约束** | 零代码，但要绕过 server | 风险最高：等于把任意卷能力交给 CR 作者，必须靠 RBAC + 准入兜底 |

补一条：`hostPath.type: DirectoryOrCreate` 会在宿主机上主动创建路径（`volume_helper.py:98-102`），与既有加固建议（用 `type: Directory`，只允许管理员预置路径）方向相反。若要正式走 hostPath，这是一处应当收敛的实现细节。

### 6.2 R2+R3 —— 暂停/归档/清理的控制面挂点

本仓已有的、语义最接近的挂点是 `SandboxSnapshot`：

| 挂点 | 现状 | 扩展到本方案的形状 |
|---|---|---|
| `SandboxSnapshot.status.format` | 枚举 `rootfs-v1;qemu-v1`（`sandboxsnapshot_types.go:43-50`） | 增加第三档（如 `local-dir-v1`）：产物是节点本地目录快照 + S3 归档对象，而不是 OCI 镜像 |
| `SandboxSnapshot.status.sourceNodeName` | 已有（`:173-176`） | 已足够承载"本地副本在哪个节点"；不需要新字段 |
| OSEP-0015 的 `SandboxSnapshotClass.type` | 设计里已有 `Local / BlobStore / S3` 三档（`oseps/0015-pod-snapshot.md`） | **这就是本方案的容器**：`Local` = 节点本地快照（本方案的热层），`S3` = 归档后端；采纳它比自己发明字段更省评审成本 |
| `BatchSandbox.spec.operatingMode` | OSEP-0015 提出 `Running/Freeze/KeepFS/Hibernate`（`KeepFS` implemented / `Hibernate` reserved） | 本方案只需要 `KeepFS` 语义（文件系统、无内存），可选加"归档后才算 Paused"的强化 |
| 缺 TTL/配额/GC | 全仓无代码 | 新通道必须自带：artifact TTL、节点本地水位、孤儿扫描、引用计数（照 A8/B11 的形状写） |

### 6.3 节点本地副本的表达（必须新增的概念）

因为节点本地副本不可搬，需要显式区分两个对象：

```text
LogicalVolume（逻辑卷）
  · 身份：用户/会话（例如 tenants/<t>/users/<u>/sessions/<s>）
  · 权威副本：s3://<bucket>/<prefix>/     ← 唯一正确性来源
  · 状态：lastArchivedDigest / lastArchivedAt / dirtyBytes（未归档脏窗口）

LocalReplica（节点本地副本，可丢弃）
  · 位置：nodeName + hostPath/Local PV
  · 身份：snapshotDigest（内容寻址即身份）+ 生成代数
  · 状态：Ready / Stale / Evicted / Broken
  · 生命周期：受 LRU + 段落水位 + 引用计数约束
```

这个形状与既有结论一致：`opensandbox-artifact-local-cache-and-node-pinning.md` §6.2 提出"缓存位置发布成节点信号 + nodeAffinity"，以及 CubeSandbox 的 replica 行（`t_..._replica`）与 fast-sandbox 的"per-template indexKey 防止不同模板互相别名"（`fast-sandbox-crds.yaml:1465-1475`）。**注意后者的教训**：缓存身份必须带来源标识，否则两个不同逻辑卷的同名内容会互相污染。

### 6.4 还缺的一块：per-sandbox 节点亲和

今天 resume 会清空 `NodeName`（`batchsandbox_pause_resume.go:111`），公开 API 也不能表达节点亲和。三条可行路径：

1. **让 Local PV 承担**（推荐）：`WaitForFirstConsumer` 由调度器完成钉节点，无需新字段。前提是 §6.3 的 `LocalReplica` 在 create 前已存在并可被命名（例如按 `nodeName` 命名的 PV 组）。
2. **节点标签 + `nodeSelector`**：节点守护按本地副本写标签（如 `osb.local-replica/<hash>="true"`），create 时用 nodeSelector 表达偏好。需要 server 能接受动态 nodeSelector——今天不行（`platform` 只到 os/arch）。
3. **`nodeName` 直钉**：仅测试。

---

## 7. 核心问题：跨节点 P2P 传递节点上的目录文件

### 7.1 为什么"直接 P2P 传目录"不成立

三个必要条件，缺一条 P2P 就退化成"另一个 S3 客户端"：

| 条件 | 原因 | 本需求的符合度 |
|---|---|---|
| **内容不可变** | P2P 缓存按内容身份索引；内容可变会导致命中陈旧副本。fast-sandbox 把 "committed cache is FINAL (never refreshed)" 写成硬性质（`integration-env.sh:2087-2088`）；`opensandbox-dragonfly-s3-cache-acceleration-assessment.md` §3.2 已指出同一 key 被覆盖后的陈旧读风险 | **不符合**：每用户会话目录是活的、持续写入的 |
| **内容可寻址（digest）** | peer 需要能回答"你要的这块我有吗"。DART 是按块地址；Kraken 按 registry blob digest；Spegel 只服务它见过的 OCI digest | 需要额外生成：本地快照 + digest 索引（可做，代价远低于传输） |
| **跨节点有复用** | P2P 的收益来自"同一份内容被多节点重复拉取"。单节点单次拉取只有切分/做种开销（`opensandbox-dragonfly-s3-cache-acceleration-assessment.md` §3.2 记录了 Dragonfly 冷缓存比直连更慢的第三方实测） | **不符合**：per-user 目录内容唯一 |

所以直接结论：**节点本地目录必须先"本地快照 + 内容寻址"，才谈得上 P2P；而对唯一内容，P2P 省不到东西，S3 中转才是正路。**

### 7.2 推荐的传输分层

```text
写路径（每节点独立，无 P2P 价值）
  沙箱写入 → 节点本地卷（reflink 快照点） → 增量归档 → S3（权威）
                                        ↓
                                  本地 LRU / 水位清理

读路径（跨节点，按代价从低到高）
  1) 本地命中           → reflink 拷贝（毫秒级，零网络）
  2) 源节点仍健康且可达 → peer 拉块（P2P，可选加速层）
  3) 否则               → S3 回源（正确性路径，必须有）
```

关键：**第 3 条必须独立可用**。P2P 只能是 2 的优化，不能成为恢复的必要条件——这与 fast-sandbox 的形态完全一致（B1/B3）。

### 7.3 P2P 与传输工具横向对照（2026-11-07 状态）

按"身份是什么""能不能处理可变/活数据""是否需要 immutable artifact"三列看：

| 分类 | 项目 | 身份/粒度 | 处理活数据 | 关键限制 |
|---|---|---|---|---|
| 内容寻址分块同步 | **desync**（443★，2026-10-17 v1.1.5） | casync 格式 CDC 块（avg 64 KiB）+ catar 目录树 | 否，需先序列化成不可变 artifact；seed = 本地任意旧版本 | 客户端拉取，无 gossip；靠 `chunk-server` 镜像块 |
| | **casync**（1,619★，下游基本停滞） | 同上 | 否 | 上游休眠，desync 是维护中的兼容实现 |
| | **bita**（293★，v0.15.0 2026-09） | 滚动哈希块（~64 KiB），blake2 寻址 + brotli | 否，自包含归档 + 本地 seed（文件/块设备） | 单 HTTP 源 |
| | **OSTree**（1,701★，v2026.6） | SHA-256 对象 + 预计算 static delta | 否，需要先 commit 进对象库 | delta 是"commit 对" |
| | **zsync/zsync2** | 单文件 HTTP range + 预发布 control 文件 | 否 | 不支持目录树 |
| P2P 分发 | **DART**（data-accelerator/dart） | object digest / chunk 256 MiB / **block 4 MiB**（传输单元） | 否，明确 "read-only, immutable data" | 极新（7★），文档自述 "hardening in progress"；无 PUT 通道 |
| | **Dragonfly v2**（3,361★，v2.5.3） | dfstore 对象层（S3/OSS 后端，UrlWithFilteredQueryParams 作为任务 ID） | 读路径偏下载；写回非 P2P | 代理规则是 GET 导向（非 GET 直通源站）；`opensandbox-dragonfly-s3-cache-acceleration-assessment.md` §5 已判定不适合 per-user 前缀 |
| | **Kraken**（6,773★，v0.1.35） | Docker registry blob/manifest（20G 软上限） | 否，registry 形状 | 需要 registry 后端；Uber 自 2018 在用 |
| | **Spegel**（3,827★，v0.8.1） | 只服务本节点见过的 OCI digest | 否 | 只覆盖镜像；README 自陈 "evolving API, no guaranteed support" |
| | Nydus / stargz | 镜像层内 chunk，惰性拉取 | 否 | 仅镜像格式 |
| 同步/流式工具 | **rsync**（3.5.x） | 每文件滚动校验 delta，`--partial` 续传 | **是**：可直接同步活目录 | 目标端需 rsync/SSH；无 S3 后端；delta 语义不提供时间点一致性 |
| | **Syncthing**（90k★，v2.1.7） | 块级，BEP 协议，mesh；双向持续 | 是 | 无中心归档/S3 层；无时间点快照语义 |
| | **rclone**（60k★，v1.76.0） | 整对象，`--checkers/--transfers` 并发 | 是 | FAQ 明确无 rsync 式二进制差分；无去重 |
| | **s5cmd**（4,230★） | 整对象 S3 cp/sync，大并发 | 是 | 无差分；一次性批处理 |
| | **restic / kopia** | 快照树 + CDC 去重（restic 512 KiB–8 MiB，avg ~1 MiB），**原生 S3 后端** | 读活目录生成不可变快照 | 无 P2P；每次备份都要重扫活树；不感知 reflink |
| | **borg**（13.9k★） | 去重归档（buzhash avg 64 KiB） | 归档语义 | **无 S3 后端**（本地/SSH）；2.x 仍 beta |
| | **zfs send -i / btrfs send** | 文件系统级增量流 | 快照点须 quiesce | 增量流要求两侧有共同祖先快照；不是跨集群/对象存储形态 |
| K8s 原生 | Local PV + `WaitForFirstConsumer` | 整卷，节点绑定 | n/a | **无快照能力**；PV 生而绑定节点 |
| | `VolumeSnapshot` / `VolumeGroupSnapshot`（GA 1.36） | CSI `CreateSnapshot` | n/a | 快照落在**驱动的后端**；hostPath/local 驱动没有可跨节点的快照 |
| | OpenEBS lvm-localpv / zfs-localpv / TopoLVM | LVM/ZFS 原生快照 | n/a | 快照是节点本地 LVM/ZFS 对象，同样不可跨节点 |
| 生产参考 | Firecracker snapshot | 本地文件（memfile + vm state） | n/a | 无内建分发层，缓存要自己做 |
| | Lambda SnapStart / MicroVM images | Firecracker 快照 + 托管缓存 | n/a | 平台内部机制 |
| | Agent Substrate | 快照先落本地盘 + Google Cloud Storage 持久化 | n/a | 自述 <500ms 恢复（厂商口径） |

### 7.4 判断

| 选项 | 何时值得 | 对本需求 |
|---|---|---|
| **只用 S3 回源（不做 P2P）** | 默认 | ✅ 起点。正确性路径唯一，运维面最小 |
| **DART 形态的块级 P2P** | 内容被多节点反复读（镜像、共享数据集），或"源节点仍健康且同一快照被多次 resume" | ⚠️ 可选加速层。需要先把本地快照做成内容寻址；收益必须像 fast-sandbox 那样用块源计数证明 |
| **Dragonfly dfstore** | 需要"对象层 + 写回 + 多后端"的统一入口，且能接受组件与 500 GiB 级节点盘成本 | ⚠️ 组件重；写路径仍需自建 |
| **rsync / Syncthing 直连节点** | 需要同步活目录（不要求时间点一致） | ⚠️ 可作为"源节点仍在时搬目录"的临时手段；不满足暂停语义 |
| **Local PV / VolumeSnapshot 当跨节点载体** | — | ❌ Local PV 不可搬；`VolumeSnapshot` 对节点本地卷不提供跨节点可移植性 |
| **共享 RWX 文件系统（NFS/CephFS）替代节点本地卷** | 网络 FS 延迟可接受时 | ⚠️ 这是另一条路：它把 R1 从"节点本地"改成"共享"，直接消掉 R4。`opensandbox-artifact-persistence-quota-capacity.md` §3 已给 POSIX 缺口与半写文件风险清单 |

---

## 8. 落地路线（分阶段，带验收）

| 阶段 | 动作 | 验收 | 风险 |
|---|---|---|---|
| **P0 定量** | 量出真实基线：单会话目录体积/文件数、并发会话数、节点盘 IOPS、对象存储网关带宽、当前 S3 中间层 restore/回写耗时分布 | 有分布图，能回答"瓶颈是字节数还是文件数" | 无数据时的所有容量结论都是猜（`opensandbox-artifact-local-cache-and-node-pinning.md` §2.2 的量级同样是推算） |
| **P0 语义** | 定义采集范围（哪些目录算"沙箱状态"）与丢失窗口；把"Paused = 已归档且 digest 已记录"写进契约 | 文档 + 状态机；"只落本地"不返回 Paused | 与现有 `Paused`（OCI 已推）语义并存会造成歧义，需要 `format` 区分 |
| **P1 控制面骨架** | 逻辑卷 / 节点本地副本两个对象 + 归档状态（`lastArchivedDigest`/`dirtyBytes`）；`SandboxSnapshot.status.format` 增第三档（优先采纳 OSEP-0015 的 `SandboxSnapshotClass.type: Local`） | CRD 字段 + server 映射 + 单测 | `SandboxSnapshot` 是公开契约，按仓库 guardrail 需先评审，且要评估 OSEP-0015 的合并时序 |
| **P1 节点侧** | 节点守护（可扩展既有 `node-agent` DaemonSet 形态）：本地 reflink 快照、digest 索引、增量归档到 S3、水位清理、就绪检查（XFS+reflink 探针） | 断网/断 S3 时本地仍可暂停；恢复后归档追平；水位触发清理有日志 | 复用已有的特权 hostPath 组件会**扩张其安全契约**；建盘与清理必须照 B7/B8 的保守形状 |
| **P1 调度可见** | 节点把本地副本与磁盘水位发布成标签/扩展资源；分配器加"本地命中优先 + 冷路径回退"打分 | 命中率、跨节点回源比例、创建 p95 | 池化路径的分配器是热点，改动要压测（`opensandbox-pool-tuning-and-assign-guide.md` 已给方法论） |
| **P2 恢复路径** | resume 三分支：本地命中 / P2P / S3 回源；S3 回源必须独立可用 | 杀掉源节点后仍能恢复（验收演练） | 这是"节点本地权威"方案会失败的场景，必须专测 |
| **P2 P2P（可选）** | 若 P1 数据显示跨节点重复读真实存在，再引入块级 P2P（DART 形态或自建 4 MiB 块 + headless Service 名单） | 块源计数（cache/peer/origin）证明源站请求数下降 | 组件 + 节点盘成本；租户数据落到别的节点磁盘，与"敏感数据需审计"冲突，需要隔离域设计（`opensandbox-dragonfly-s3-cache-acceleration-assessment.md` §6） |
| **P2 清理** | artifact TTL + 配额 + 孤儿扫描 + 引用计数；保护活跃/warm 副本 | 到期记录与 artifact 状态一致；恢复中的副本不被删 | 现有代码零可复用，必须新写 |

---

## 9. 未验证与边界

- 本文未改动任何代码；所有"落点"都是设计判断，未提交、未评审。
- 外部项目的功能描述来自各自文档/源码，性能数字只在对应文章的测试条件下成立，**未在本集群复测**；`pushed_at`/stars 为 2026-11-07 的 `gh api` 快照。
- DART 的块地址格式、是否逐块校验 digest、`origin_total ≤ expected+4` 之外的去重保证，在本仓只有文档与集成脚本层面的证据，**没有 DART 源码**（本仓 vendored 的是 fsb CRD、gRPC 客户端、chart 与脚本；`manifests/third-party/fast-sandbox.commit` 指向外部实现）。
- **跨节点冷路径（从 S3 回源恢复）在 fast-sandbox 文档中明确标注为未实测**（`performance.md:200-203`），所以 §5 B12 的量级只覆盖同节点场景。
- CubeSandbox 的跨节点暂停/恢复与按需加载快照在调研时仍是路线图项（`docs/zh/guide/roadmap.md:7-13`、`docs/zh/guide/lifecycle.md:262`），其 S3 CoW 后端是占位（`Cubelet/storage/cow/store.go:6-30`）——即本文 A 形态的跨节点部分也没有可直接照抄的实现。
- `allowed_host_paths` 默认拒绝全部、PSS 两档都禁止 hostPath 这类前提取自当前代码与 kubernetes.io 文档，**未在集群实测**会不会与既有池模板/加固策略冲突。
- OSEP-0015 仍是 draft（`status: draft`），其 `SandboxSnapshotClass`/`operatingMode` 字段可能在被采纳前变化，本文把它当"抽象位置"而非"已成契约"。
- 未覆盖：租户级本地盘配额（XFS project quota 等，`opensandbox-artifact-persistence-quota-capacity.md` §4.2 已给命令）、快照加密与合规审计、跨集群 artifact 复制、GPU/大文件目录的传输代价。

---

## 10. 来源

### 本仓（`dev`，tip `8aff879fa`）

- `kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go`：`replicas`(:87-90)、`poolRef`(:91-94)、Schemaless `template`(:97-100)、`pause`(:135-141)、phase 与 conditions(:22-31, :44-60, :152-191)
- `kubernetes/apis/sandbox/v1alpha1/sandboxsnapshot_types.go`：`format` 枚举(:43-50)、VM 字段(:63-108)、`sourcePodName`(:168-171)、`sourceNodeName`(:173-176)
- `kubernetes/internal/controller/batchsandbox_pause_resume.go`：`handlePause`(:237-296)、`ensureInternalPauseSnapshot`(:298-330)、`completePause`(:436-517)、`sourcePodTemplateForPause` 清 `NodeName`(:100-121)、`continueResume` 镜像重写(:520-634)
- `kubernetes/internal/controller/sandboxsnapshot_controller.go`：超时/TTL 常量(:43-56)
- `kubernetes/internal/controller/sandboxsnapshot_lifecycle.go`：`handlePending`(:41-143)、status 写入(:119-121)、commit Job 挂载(:349-396)、`NodeName` 钉节点(:485)、unpause(:668-789)
- `kubernetes/pkg/imagecommitter/image_containerd.go`：只 commit 可写层(:52-196)、缺 base blob 时的回源(:199-234)
- `kubernetes/cmd/image-committer/qemu_snapshot.go`：拒绝卷内 qcow2(:463-492)
- `kubernetes/internal/snapshot/image_reference.go`：`ImmutableImageReference`
- `kubernetes/internal/snapshot/contract.go`：`ContractFromPod` 与 provider 注解(:54-90)
- `server/opensandbox_server/services/k8s/volume_helper.py`：PVC(:71-89)、hostPath `DirectoryOrCreate`(:95-113)、不支持后端报错(:118-123)
- `server/opensandbox_server/config.py`：`allowed_host_paths` 默认空 = 拒绝(:884-893)
- `server/opensandbox_server/services/k8s/workload_provider.py`：`apply_platform_node_selector`（只到 os/arch）
- `server/opensandbox_server/api/schema.py`：`Volume`/`Host`/`PVC`(:309-398, :460-517)
- `manifests/charts/node-agent/`：`values.yaml` hostPaths(:93-99)、`daemonset.yaml`(:168-195)、`README.md` 投递保证(:18-21)
- `docs/guides/pause-resume.md`、`docs/guides/qemu-vmstate-snapshots.md`、`docs/guides/kubernetes-resume-benchmark.md`
- `docs/architecture/fast-sandbox/`：`checkpoints.md`(digest-first :23；状态字段 :17-21；跨 Fastlet :32-38)、`storage.md`(私有 state root :19；DART :21；容量 :83-88；就绪 :110-115)、`scheduling.md`(`state`/`expireTime` :33-36；`warmImages` :21)、`performance.md`(:164-177 同节点量级；:200-203 跨节点未实测)
- `manifests/charts/fast-sandbox/`：`values.yaml` `stateRoot`(:219-231)、`templates/runtime-daemonset.yaml`(DART 发现 :70-76, :114-122)
- `manifests/charts/base/files/fast-sandbox-crds.yaml`：checkpoint/`artifactDigest`/`manifestRef`(:903-941)、per-template indexKey(:1465-1475)
- `scripts/fast-sandbox-state-root-setup.sh`(:41-108)、`scripts/fast-sandbox-env/integration-env.sh`(:1189-1227 去重断言, :2087-2088 committed cache FINAL)
- `oseps/0008-pause-resume-rootfs-snapshot.md`（implemented）、`oseps/0015-pod-snapshot.md`（draft：`operatingMode`、`SandboxSnapshotClass{Local|BlobStore|S3}`）、`oseps/0019-node-agent-sandbox-collection.md`、`oseps/0024-auto-pause-and-wake-on-access-for-fast-sandbox.md`

### CubeSandbox（本地 `D:\CODE\ai\CubeSandbox`）

- `cubecow/README.md`、`cubecow/include/cubecow.h:130-260`、`cubecow/src/engine/reflink.rs:19-40,80-87,134-173,637-733,970-983`
- `Cubelet/storage/plugin.go:129-206`、`Cubelet/storage/cow/store.go:6-30`、`Cubelet/storage/cow_store_ops.go:36-100`、`Cubelet/storage/cubecow_volume_manager.go:137-160`、`Cubelet/storage/snapshot_catalog.go:71-74`、`Cubelet/storage/local.go:900-981`
- `Cubelet/services/cubebox/pause_cow.go:70-90,127,140-160,239-283,289-310,319-360,433-510`、`Cubelet/services/cubebox/pause_package.go:9-58,24-25,130-195`、`Cubelet/services/cubebox/update.go:103-110,241-334`
- `CubeMaster/pkg/service/sandbox/sandbox_resume_pause.go:31-119,262-385,311-313,526-540`、`CubeMaster/pkg/pausesnap/store.go:5-9,120-170`、`CubeMaster/pkg/pausesnap/delete_paused.go:23-70`
- `CubeMaster/pkg/templatecenter/`：`distribution.go:142-250`、`snapshot_reconciler.go:32-37,458-472`、`restore_compat.go`、`artifact_gc.go:20-32`、`job_constants.go:66`
- `CubeMaster/pkg/selector/filter/template_locality.go:31-87`、`CubeMaster/pkg/localcache/template_locality.go:13-35`、`CubeMaster/pkg/localcache/image_cache.go:46-56`
- `Cubelet/pkg/config/config.go:48-69`、`Cubelet/config/config.toml:3-4,64-66,100-115,147-155`、`Cubelet/services/images/image_gc.go:159-222`
- `docs/zh/guide/lifecycle.md`、`roadmap.md:7-13`、`persistent-storage.md`、`volume-plugin.md`、`snapshot-rollback-clone.md`、`node-isolation.md`

### 外部

- DART（DADI）：https://github.com/data-accelerator/dart
- Dragonfly v2：https://github.com/dragonflyoss/Dragonfly2 ；dfstore 概念：https://d7y.io/docs/v2.1.x/concepts/terminology/dfstore/
- Kraken：https://github.com/uber/kraken ；Spegel：https://github.com/spegel-org/spegel
- desync：https://github.com/folbricht/desync ；casync：https://github.com/systemd/casync ；bita：https://github.com/oll3/bita ；OSTree static delta：https://github.com/ostreedev/ostree/blob/main/man/ostree-static-delta.xml
- restic 设计（CDC 块大小）：https://github.com/restic/restic/blob/master/doc/design.rst ；kopia：https://github.com/kopia/kopia ；borg：https://borgbackup.readthedocs.io/en/stable/usage/create.html
- Syncthing FAQ（块级）：https://docs.syncthing.net/users/faq.html ；rclone FAQ（无二进制差分）：https://rclone.org/faq/ ；s5cmd：https://github.com/peak/s5cmd
- zfs send：https://openzfs.github.io/openzfs-docs/man/master/8/zfs-send.8.html ；btrfs send：https://btrfs.readthedocs.io/en/latest/btrfs-send.html
- Local PV provisioner：https://github.com/kubernetes-sigs/sig-storage-local-static-provisioner ；external-snapshotter：https://github.com/kubernetes-csi/external-snapshotter ；VolumeGroupSnapshot GA：https://kubernetes.io/blog/2026/05/08/kubernetes-v1-36-volume-group-snapshot-ga/
- Firecracker snapshotting：https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md ；Lambda SnapStart：https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html ；Agent Substrate on GKE：https://cloud.google.com/blog/products/containers-kubernetes/agent-substrate-available-on-gke
