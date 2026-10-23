---
name: opensandbox-boxlite-state-snapshot-design-references
description: BoxLite、E2B、Modal、Daytona、agent-sandbox 的状态持久化与快照机制拆解，映射到 OpenSandbox 容器与 Fast Sandbox 两条路径的可吸收项、优先级、落点与验收
type: project
---

# BoxLite 及同类平台状态快照设计参考与 OpenSandbox 吸收清单

> 调研日期：2026-10-23
> 调研对象：BoxLite（`boxlite-ai/boxlite`）、E2B、Modal、Daytona、Kubernetes agent-sandbox、LiteBoxd。
> 对照基线：本仓当前 `dev` 分支的 K8s 池化路径（Pool + BatchSandbox + task-executor）、容器 pause/resume、QEMU vmstate 快照、Fast Sandbox checkpoint、OSEP-0024 idle policy、S3 用户目录中间层。
> 口径：外部平台的性能数字来自其官方文档或第三方对比，未在本仓环境复测；标为“设计提案”的内容指对应仓库里尚未合并的设计，只作为设计参考。BoxLite 的 snapshot 已有实现，与 issue 设计的差异见 §4.2。本文的“可吸收”限定为能落到现有分层、且不与内网 K8s、节点资源受限、池化短任务为主、业务层管租户这些约束冲突的机制。

## 一、结论先行

外部平台可移植的设计集中在四条契约上：

1. **快照前先 quiesce**：冻结写入、flush 脏页，必要时 `fsfreeze`，并定义超时、失败回退和一致性标记。BoxLite 的 issue 设计写的是 `FIFREEZE` + 30s 超时 + 失败可回退停机快照；当前实现用 VM pause 做 point-in-time quiesce（`with_quiesce_async`）。
2. **快照是不可变 artifact set**：manifest 记录格式版本、基础镜像 digest、每个 artifact 的 role/digest/size/compression、兼容性约束和 quiesce 结果；恢复只信任 digest，不信任可变 tag。
3. **默认文件系统级，内存级显式开启**：E2B、Modal、Daytona 都把内存快照做成可选能力，并附带机型、连接、过期时间等约束；默认路径用磁盘/rootfs 恢复，密度和成本更可控。
4. **生命周期由持久化状态机驱动**：创建、发布、过期、删除都先写意图再收敛，artifact 完整落盘后才释放计算；保留策略、租户配额和孤儿回收独立于沙箱生命周期。

OpenSandbox 已经具备容器 OCI 快照、QEMU vmstate、Fast Sandbox 全量 checkpoint、快照 CRUD、fsb idle auto-pause。当前缺口集中在容器路径：**一致性契约、统一 manifest、节点本地轻量快照、保留/回收、跨环境归档**。

优先级建议：

- **P0**：容器快照 quiesce 契约；统一 snapshot manifest（含 digest、兼容性、quiesce 结果）。
- **P1**：节点本地 COW 快照 + clone；retention/TTL/GC；跨环境 export/import 归档。
- **P2**：workspace/directory 级快照；内存快照模式与约束的统一 API；两级暂停（与 `opensandbox-vs-perplexity-space-architecture.md` 的 P1-1 合并）。

短任务池继续走“重建 + S3 工作区恢复”，不引入快照链路；以上能力主要服务长会话池、需要保留 rootfs 的调试会话和敏感池。

## 二、边界：快照解决哪一层状态

| 层 | 内容 | 负责机制 | 本文覆盖 |
|---|---|---|---|
| L0 运行态 | 进程、内存、连接、未保存编辑缓冲 | QEMU/fsb 内存快照 | 只讨论模式与约束，不把内存快照设为默认 |
| L1 执行环境 | rootfs、安装包、工作区文件 | OCI commit、PVC/overlay、QCOW2、本地 COW | 主要吸收对象 |
| L2 文档/业务数据 | 文档正文、版本、元数据、协作操作日志 | 业务层数据库 + 版本化对象存储 | 只定义边界：快照不能替代版本库 |
| L3 控制面 | sandboxId、snapshot 记录、manifest、状态机 | 关系库/CRD + CAS/fencing | 讨论 manifest 与保留/回收 |

文档型负载的权威副本放在 L2。沙箱里的 `/workspace` 是缓存和编辑现场，快照用于快速恢复环境；文档正文用 `docId + version` 的条件写或操作日志提交，恢复时按版本重放。把文档正文只放在 rootfs 里，会同时失去多副本、审计、跨镜像升级和多人协作能力。

### 2.1 OCI 镜像快照与目录归档的取舍

| 维度 | OCI 镜像快照（commit/push） | 容器内目录归档 → 对象存储 |
|---|---|---|
| 捕获范围 | 整个容器可写层 | 指定目录/文件 |
| 恢复结果 | 原执行环境，装过的包和系统改动都在 | 只恢复数据，环境由基础镜像重建 |
| 体积 | 层差分，基础层共享；会带上 `/root`、`/var` 等杂项 | 只含工作区，通常小一个数量级 |
| 恢复速度 | 需要 pull 镜像 | 基础镜像常已缓存，下载工作区通常更快 |
| 一致性 | 需要 freeze/sync，整机文件系统一致 | 需要应用 flush 或逐文件版本化；tar 活文件可能抓到半写状态 |
| 多租户安全 | 镜像可能夹带凭据、临时文件；registry 权限模型较粗 | 按租户前缀 + KMS + 对象级审计，最小权限更容易 |
| 成本与回收 | registry 存储、tag/GC 复杂 | 对象存储生命周期、版本化、对象锁成熟 |
| 适用场景 | 长会话环境复用、调试复现、整机回滚 | 文档编辑、代码工作区、产物留存、短任务 |

OCI commit 的粒度是整个可写层，没有目录白名单；只保存特定目录应走 workspace 归档或目录级快照。需要从 OCI 镜像里只取某几个目录时，通常先 commit 再做镜像裁剪，成本和复杂度都高于直接归档。

对 OpenSandbox 的落法：

- **短任务/文档型负载**：基础镜像 + workspace 目录归档到 S3；沙箱里只保留编辑缓存，按版本回写。OCI commit 不作为每次会话的默认动作。
- **长会话环境**：需要保留装包/系统改动时，用 OCI 快照或节点本地 COW 快照；把它当“环境里程碑”，按 TTL 回收。
- **混合恢复**：先拉基础镜像，再按 manifest 恢复 workspace；OCI 快照作为环境回退档，文档版本独立回滚。

## 三、OpenSandbox 现状基线

| 能力 | 当前实现 | 证据 | 缺口 |
|---|---|---|---|
| K8s 容器 pause/resume | 创建 `SandboxSnapshot`，commit Job 在源节点把容器 rootfs 提交为 OCI image 并推 registry；resume 重写模板并重建 Pod | `docs/guides/pause-resume.md`、`kubernetes/internal/controller/sandboxsnapshot_controller.go`、`kubernetes/cmd/image-committer/main.go` | 单副本；默认不含内存；commit 前只有 cgroup freeze，缺少显式 `sync`/`fsfreeze` 和一致性标记；commit Job 超时 10 分钟 |
| Docker 路径 | `container.pause()` 保留驻留内存；snapshot 走 `docker commit` | `server/opensandbox_server/services/docker/docker_service.py`、`services/docker/snapshot_runtime.py` | 单机语义；跨节点恢复依赖镜像仓库 |
| QEMU vmstate | rootfs + QEMU migration stream，记录架构、机型、CPU、内存、node class 等兼容性 | `kubernetes/apis/sandbox/v1alpha1/sandboxsnapshot_types.go`、`docs/guides/qemu-vmstate-snapshots.md` | 仅 QEMU 路径；容器路径没有等价的兼容性校验 |
| Fast Sandbox checkpoint | rootfs + vmstate + guest memory 写入 S3 artifact store；digest-first；可在任意 Fastlet 恢复；节点侧 XFS reflink + DART | `docs/architecture/fast-sandbox/checkpoints.md`、`docs/architecture/fast-sandbox/storage.md` | artifact 删除不随快照记录删除，保留策略由运维外部承担 |
| 快照 API/CRD | `POST /v1/sandboxes/{id}/snapshots`、list/get/delete、restore from snapshotId；`SandboxSnapshot` 有 Pending/Committing/Succeed/Failed | `server/opensandbox_server/api/lifecycle.py`、`services/snapshot_service.py`、`services/snapshot_models.py` | 无 TTL/配额；`SnapshotRecord` 没有 expiresAt；容器快照元数据只有 `containers[]` |
| OSEP-0024 idle policy | fsb 支持 idle auto-pause + wake-on-access；K8s pod 路径显式拒绝 | `server/opensandbox_server/integrations/idle_pause/`、`services/k8s/kubernetes_service.py` | 容器长会话池没有自动降级到快照 |
| S3 用户目录中间层 | create 恢复、delete 回写；按用户/会话前缀 | `wiki/opensandbox-pooled-session-s3-sync-middleware.md` | 目录同步，不是时间点快照；回写失败/双写需要额外保护 |

现状可以归纳为：**Fast Sandbox 的快照语义已经接近外部平台的完整 checkpoint；容器路径仍是“registry 为中心的整机 commit”，缺少轻量层和生命周期治理。**

## 四、BoxLite 的事实拆解

### 4.1 磁盘与快照布局

BoxLite 的每个 Box 在 `~/.boxlite/boxes/{box-id}/` 下有两块 QCOW2 盘：

```text
~/.boxlite/boxes/{box-id}/
├── disks/
│   ├── disk.qcow2              # 容器盘
│   └── guest-rootfs.qcow2      # guest rootfs
├── snapshots/{name}/
│   └── disk.qcow2              # 当前实现对 container disk 做 fork
├── .snapshot_pending           # 快照进行中的崩溃标记
└── db/                         # 实际在 ~/.boxlite/db/boxlite.db
```

基础层是只读 ext4（镜像层解出后缓存），Box 盘是 QCOW2 写时复制增量；快照是 `snapshots/{name}/` 下的独立 QCOW2 文件，不做 QCOW2 内部快照。当前实现只快照 container disk，guest rootfs 不在快照范围内。

### 4.2 Snapshot 实现与 issue #205 设计的差异

BoxLite 的 snapshot 代码已经落地在 `src/boxlite/src/litebox/snapshot.rs`、`snapshot_mgr.rs`、`local_snapshot.rs`、`clone_export.rs`；[issue #205](https://github.com/boxlite-ai/boxlite/issues/205) 记录的是较早的设计提案，当前实现与提案有几处边界差异：

| 维度 | issue #205 设计 | 当前实现 | 对 OpenSandbox 的启示 |
|---|---|---|---|
| 快照边界 | 同时抓 `guest-rootfs.qcow2` 和 `disk.qcow2` | **只对 container disk（`disk.qcow2`）做 fork**；guest rootfs 不在快照内 | 容器路径要把“rootfs / 工作区 / 运行时元数据”的边界写进 API，避免调用方误以为整机都保存了 |
| 状态内容 | 只抓磁盘，不抓内存/CPU，clean boot | 同样是磁盘级；恢复后干净启动 | 文件系统快照作为默认档，内存档单独抽象 |
| quiesce | `FIFREEZE`，默认 30s 超时，失败可回退停机快照 | 用 `with_quiesce_async` 暂停 VM 做 point-in-time 快照；没有 FIFREEZE 契约和一致性标记 | 把 quiesce 变成显式契约，并记录 `consistency` |
| 快照存储 | 外部 COW 文件，独立目录 | `fork_qcow2`：把 live container disk 移到 `snapshots/{name}/disk.qcow2`，在原路径创建 COW child；Box 继续运行，快照盘不可变 | 同节点 fan-out、回滚和快速恢复可复用这个模式 |
| clone | 默认 COW clone，约 1ms/个 | `clone_boxes` 在 quiesce 内把 container disk 变成共享 base，再创建 N 个 COW overlay；guest rootfs 不克隆，每个 clone 首次启动时自建 | 批量 clone 的密度来自共享 base + 薄 overlay |
| 导出 | `.boxsnap`（tar.zst）+ `manifest.json` + 两块盘 SHA-256 | `.boxlite`（tar.zst）+ `manifest.json` + container disk SHA-256；导出时先 flatten QCOW2 链，校验/打包阶段 VM 已恢复 | 跨集群/离线迁移需要可校验的归档，不只依赖 registry tag |
| 元数据/并发 | SQLite `box_snapshot`，记录两块盘大小；状态枚举互斥 | SQLite `snapshot` 表 + `.snapshot_pending` 崩溃标记 + `disk_ops` 锁；restore 要求 Box 处于 stopped | 快照记录与 artifact 生命周期分开建模；恢复要有锁/租约 |

盘布局和文件格式见 BoxLite `docs/reference/file-formats.md`；实现见 `snapshot_mgr.rs`、`local_snapshot.rs`、`clone_export.rs`。README 还宣称支持 stop/restart 持久化、clone、export/import `.boxlite` 归档和 detached box。

### 4.3 BoxLite 的适用边界

- 它解决的是**单机/单 runner 的 Box 状态原语**：`~/.boxlite` 下的 SQLite、QCOW2 和本地快照目录。节点丢失后，本地状态一起丢失。
- 它默认**不做跨节点复制、租户配额、审计和对象存储归档**；这些需要上层控制面补齐。
- 它的磁盘快照适合“环境留着、下次接着用”的长会话；对池化短任务，QCOW2 的存储运维成本换不来收益。
- 它的 clean boot 语义适合执行环境恢复，文档正文仍要放应用层版本库。

## 五、同类平台的做法对照

| 方案 | 捕获内容 | 存放与恢复 | 生命周期 | 可借鉴点 |
|---|---|---|---|---|
| **E2B** | 文件系统 + 内存；pause 可选 full memory，关闭时只持久化文件系统并冷启动 | 暂停后保留，恢复约 1s；pause 约 4s/GiB | 暂停态保留到显式删除；Pro 连续运行 24h，pause/resume 后重置 | 显式区分 fs-only 与 full-memory 两种 pause 语义 |
| **Modal** | 文件系统快照（相对 base 镜像差分）、目录快照、内存快照 | 文件系统快照是镜像，可多次创建沙箱；内存快照恢复为新沙箱 | fs/dir 默认 30 天 TTL；内存快照 7 天；内存快照绑定同机型 | manifest 中记录 base 与差分；目录快照可挂载到运行中的沙箱；把约束写进 API |
| **Daytona** | 容器盘、VM 盘、S3 volume；容器 stop 保盘，VM pause 保内存 | 容器 stop 留在 runner 并计配额；archive 移到对象存储；VM stop 卸载到近端存储 | auto-stop 15min（容器）、auto-pause 60min（VM）、auto-archive 7 天 | 三层持久化模型；archive 分层；volume 按 tenant subpath |
| **agent-sandbox** | 仅 PVC 上的数据；suspend 删除 Pod，resume 新 Pod 挂同一卷 | 稳定 hostname + PVC；冷启动 | 支持 suspend/resume、TTL、warm pool | 稳定身份与 PVC 语义；把“内存和 PVC 外数据会丢”写进文档 |
| **LiteBoxd** | 每沙箱 PVC 上的 rootfs overlay upper/work | 重建 Pod 后重挂同一 PVC；无内存 | Deployment 自愈；删除状态机；Retain 保留 PVC | 删除状态机、条件更新、启动失败分类（详见 `liteboxd-persistence-and-recovery-analysis.md`） |

共同结论：

1. **文件系统级是默认档，内存级是长会话可选项。** E2B/Modal/Daytona 都提供内存快照，但都附带机型、连接、TTL 或源沙箱终止等约束。
2. **快照要能扇出和归档。** Modal 的文件系统快照是镜像，BoxLite 的 clone 是 COW；两者都把“一个快照创建多个沙箱”作为核心用例。
3. **保留策略是快照系统的一部分。** Modal 有 TTL，Daytona 有 auto-archive，agent-sandbox 靠 PVC 生命周期；OpenSandbox 目前把 artifact 保留留给外部运维。
4. **内存快照的约束必须显式暴露。** 同机型、TCP 连接断开、后台进程恢复不完整、快照期间源沙箱可能终止，这些都会影响业务重试逻辑。

## 六、可吸收项

### P0-1：容器快照的 quiesce 契约

**解决的问题**：当前 image-committer 通过 cgroup freeze 暂停容器后 commit，能阻止新 CPU 写入，但没有显式的 `sync`/`fsfreeze`，也没有在快照状态里记录“这次快照是文件系统一致还是崩溃一致”。多文件写入、数据库 WAL、未 flush 的页缓存在恢复后可能出现不一致，业务无法判断是否需要 fsck 或重放。

**外部做法**：BoxLite issue #205 的设计在运行中快照前执行 `FIFREEZE`，默认 30s 超时，失败可回退到停机快照；当前实现改用 VM pause 做 point-in-time quiesce。OpenSandbox 的 QEMU 路径已有 QMP 暂停，可以把 guest freeze 作为增强项。

**移植设计**：

1. `SandboxSnapshotSpec` 增加 additive 的 `quiesce` 字段：`mode`（`cgroup-freeze` / `fs-freeze` / `none`）、`timeoutSeconds`、`onFailure`（`fail` / `stop-and-snapshot`）。默认保持当前行为，避免改变存量语义。
2. image-committer 的快照顺序改为：pause task → `sync` → 可选 `fsfreeze -f /`（容器内或 containerd task exec）→ commit → `fsfreeze -u /` → unpause。`fsfreeze` 不可用或超时则回退到 cgroup freeze，并在状态里标记降级。
3. QEMU 路径在 QMP `postmigrate` 前后调用 guest agent 的 `guest-fsfreeze-freeze` / `guest-fsfreeze-thaw`；guest agent 不可用时记录 `quiesceMode=none`。
4. `SandboxSnapshot.status` 增加 `quiesce` 结果：`mode`、`durationMillis`、`consistency`（`fs` / `crash` / `none`）、`fallbackReason`。server 的 snapshot record 同步保存，供 `get snapshot` 和恢复策略判断。
5. 默认超时和回退策略做成 controller 参数，按 Pool/租户覆盖；QEMU 容器保持现有的“跳过 cgroup freeze”特例，避免 KVM worker 死锁。

**落点**：`kubernetes/cmd/image-committer/main.go`、`kubernetes/cmd/image-committer/qemu_snapshot.go`、`kubernetes/internal/controller/sandboxsnapshot_controller.go`、`kubernetes/apis/sandbox/v1alpha1/sandboxsnapshot_types.go`、`server/opensandbox_server/services/snapshot_models.py`、`docs/guides/pause-resume.md`。

**风险**：`fsfreeze` 需要 mount namespace 内的权限；通过 containerd task exec 执行时可能受容器 capability 限制。应优先做“cgroup freeze + sync + 一致性标记”，`fsfreeze` 作为可选增强；不要因为 fsfreeze 失败而让 pause 整体失败。QEMU 路径要避免再次触发 cgroup freeze 死锁。

**验收**：快照期间持续写入小文件和多文件事务，恢复后跑 `fsck` 与文件哈希比对；记录 `consistency` 标记；验证超时回退、`fsfreeze` 不可用、QEMU 路径三种分支；对比 pause 增加的时间。

### P0-2：统一 snapshot manifest 与 digest-first 状态

**解决的问题**：容器快照的元数据是 `containers[]`（imageUri/imageDigest），QEMU 是 `virtualMachine`，fsb 是 `manifestRef + SHA256SUMS`；三种格式各自演进。恢复时缺少统一的 artifact 清单、校验和、基础镜像 digest 和兼容性摘要，跨环境迁移只能依赖 registry tag。

**外部做法**：BoxLite 当前导出的 `.boxlite` 用 `manifest.json` 记录版本、Box 名、镜像、container disk 的 SHA-256 和导出时间；issue #205 的设计曾计划 `.boxsnap` 和两块盘校验。Fast Sandbox 已经用 artifact set + `SHA256SUMS` + `manifestRef` + digest-first 发布。

**移植设计**：

1. 把 Fast Sandbox 的 artifact manifest 提升为公共 `snapshot-manifest-v1`，容器 OCI image、QEMU vmstate、fsb rootfs/memory 都是 `artifacts[]` 的一种 role。
2. `SandboxSnapshot.status` 增加 `manifestRef`、`manifestDigest`、`sizeBytes` 和 `compatibility`；大 manifest 放对象存储/ConfigMap，status 只放摘要，避免 CRD status 膨胀。
3. manifest 结构建议：

```yaml
version: 1
format: rootfs-v1        # rootfs-v1 | qemu-v1 | rootfs-local-v1
source:
  sandboxUid: ...
  generation: 7
  runtimeClass: runc
  baseImageDigest: sha256:...
artifacts:
  - role: rootfs         # rootfs | vmstate | memory | workspace
    uri: registry.example.com/sandboxes/...@sha256:...
    digest: sha256:...
    sizeBytes: 123456789
    compression: none    # none | zstd
    mediaType: application/vnd.oci.image.manifest.v1+json
compatibility:
  os: linux
  architecture: amd64
  nodeClass: ""
quiesce:
  mode: fs-freeze
  durationMillis: 420
  consistency: fs
createdAt: "2026-10-23T08:00:00Z"
```

4. 容器路径保留 `containers[]` 作为兼容视图，manifest 是新的权威视图；server 的 `SnapshotRestoreConfig` 增加 manifest 引用，restore 先校验 digest 再选 runtime。
5. 快照记录只有在 manifest 完整写入后才进入 `Ready`；`Creating` 中间态不允许 restore。这与 Fast Sandbox 的“Paused 没有 checkpoint 就不能 resume”保持一致。

**落点**：`kubernetes/apis/sandbox/v1alpha1/sandboxsnapshot_types.go`、`server/opensandbox_server/services/snapshot_models.py`、`services/snapshot_service.py`、`services/k8s/snapshot_runtime.py`、`cli/src/opensandbox_cli/commands/snapshot.py`。

**风险**：CRD status 有大小限制，manifest 应外置；OCI image 已经是不可变 digest，manifest 不要重复搬运大层；跨 registry 的 digest 兼容性要验证（同一 digest 在不同 registry 可寻址）。

**验收**：篡改 artifact 后 restore 必须失败；导出到无外网的第二个集群可导入并创建沙箱；manifest 版本不匹配、兼容性不匹配、digest 不匹配分别返回可读错误。

### P1-1：节点本地 COW 快照层与 clone

**解决的问题**：容器路径只有 registry 为中心的整机 commit，commit Job 默认 10 分钟超时，resume 要重新拉镜像；同一快照创建多个沙箱需要多次 pull。长会话需要“秒级回滚/扇出”，短任务不需要。

**外部做法**：BoxLite 用外部 COW QCOW2 快照，clone 默认 COW，设计目标约 1ms/个；Fast Sandbox 在节点侧用 XFS reflink 做 artifact 的 CoW 副本，并用 DART 做块级分发。

**移植设计**：

1. 新增 `snapshotTier=local|durable`（默认 `durable`，保持现有行为）。`local` 只在长会话池/指定 Pool 开启。
2. 节点侧新增 snapshot helper（Job 或 DaemonSet），把容器可写层复制/重链接到节点私有 state root；优先 XFS reflink，btrfs 次之，overlayfs 无 reflink 时用 freeze + 复制并明确标记 `copy`。
3. `SandboxSnapshot` 增加 `format=rootfs-local-v1` 和 `nodeName`、`stateRoot`、`baseLayerDigest`；`clonePolicy=cow` 时恢复必须调度到持有快照的节点，调度不到就回退 durable 层或重建。
4. 本地快照是短 TTL、节点绑定的加速层：节点 drain/重启后标记 `Lost`，不参与跨节点恢复；durable 快照仍是权威副本。
5. fan-out：从同一本地快照 clone 多个 BatchSandbox，controller 用节点亲和 + 预留 sandbox ID 降低绑定往返；clone 失败要回滚预留，不能把半初始化实例放回池。

**落点**：`kubernetes/internal/controller/sandboxsnapshot_*`、`kubernetes/cmd/` 下新增 snapshot helper、`kubernetes/apis/sandbox/v1alpha1/sandboxsnapshot_types.go`、`server/opensandbox_server/services/k8s/snapshot_runtime.py`；节点 state root 的布局可复用 `docs/architecture/fast-sandbox/storage.md` 的 reflink 经验，但容器路径需要独立的 helper，避免把逻辑塞进日志型 nodeagent。

**风险**：overlayfs 的 upperdir 不是原子快照，必须先 freeze/sync；reflink 依赖文件系统；本地状态是单节点故障域；快照会放大磁盘占用，需要配额和 GC。该能力应作为长会话池的可选档，默认关闭。

**验收**：同一快照 clone 100 个实例的 p50/p99 延迟；节点 drain 后本地快照标记 `Lost`、durable 回退成功；磁盘配额和 GC 生效；与 QEMU/fsb 路径互不影响。

### P1-2：快照保留、TTL 与孤儿回收

**解决的问题**：`SnapshotRecord` 没有 `expiresAt`，`SandboxSnapshot` 也没有保留字段；容器镜像/fsb artifact 的删除依赖外部 registry/对象存储策略。仓库文档明确“删除 SandboxSnapshot 记录不会删除已推送的 artifact”。长期运行会出现记录已删、artifact 仍在，或 registry tag 被覆盖导致旧快照不可复现。

**外部做法**：Modal 的文件系统/目录快照默认 30 天、内存快照 7 天；Daytona 容器快照 stop 后 7 天 auto-archive；BoxLite 的 Snapshot API 提供 CRUD，但保留策略留给调用方。

**移植设计**：

1. `CreateSnapshotRequest`/`Snapshot` 增加 `retention`：`expiresAt`、`maxSnapshotsPerSandbox`、`onExpire`（`delete` / `archive`）。默认值由 server 配置给出，租户可覆盖但不能超过平台上限。
2. `SandboxSnapshotSpec` 增加 `retention` 或使用注解；controller 在 `Succeed` 后计算到期时间，写入 status。
3. 新增独立的 snapshot GC worker（server 侧或 controller 侧，二选一）：扫描到期/超配额记录，先加 lease 防止与 restore 并发，再调用 runtime 删除 artifact，最后把记录置 `Deleted` 并保留审计字段。
4. artifact 删除要按 role 处理：OCI image 删除 tag/manifest（注意共享层）；fsb artifact 删除 manifest 及未被引用的 blob；本地快照删除目录。共享 base layer 不能按单快照删除。
5. 增加 orphan scan（dry-run 优先）：对比 registry/对象存储前缀与数据库记录，输出孤儿清单；第一版只报告，第二版按租户开关执行清理。

**落点**：`server/opensandbox_server/services/snapshot_service.py`、`services/snapshot_models.py`、`repositories/snapshots/*`、`kubernetes/internal/controller/sandboxsnapshot_*`、`components/nodeagent/cmd/oss-cleanup` 的清理思路可参考但不直接复用。

**风险**：registry 的 GC 语义因实现而异，删除 manifest 可能影响共享层；restore 进行中不能删 artifact；审计要求可能要求“记录保留、artifact 删除”或相反，需要可配置。建议默认只做记录到期和配额告警，artifact 删除先 dry-run。

**验收**：TTL 到期后记录与 artifact 状态一致；restore 中的快照不会被删；超配额创建被拒绝并返回明确错误；orphan scan 报告数量可重复；租户隔离下不能删除其他租户 artifact。

### P1-3：跨环境 export/import 归档

**解决的问题**：内网多集群、离线迁移和审计场景需要把快照带走；OCI registry 的 tag 不能跨 registry 直接复用，QEMU vmstate 与 rootfs 又是多 artifact。当前只有 `snapshot create/get/list/delete`，没有导出格式。

**外部做法**：BoxLite 当前导出 `.boxlite`（tar.zst + `manifest.json` + container disk SHA-256），`import` 创建新 Box；issue #205 的设计曾用 `.boxsnap` 并计划两块盘。Fast Sandbox 的 artifact set 用 `manifestRef` + `SHA256SUMS`，可跨 Fastlet 恢复。

**移植设计**：

1. CLI 增加 `osb snapshot export <id> -o demo.osbsnap` 和 `osb snapshot import demo.osbsnap --name ...`。默认只导出 manifest + artifact 引用（registry/object store URI），`--include-artifacts` 时才打包 OCI layout 或原始 artifact。
2. `.osbsnap` 是 tar.zst，根目录 `manifest.json` + `SHA256SUMS` + 可选 `artifacts/`；manifest 复用 P0-2 的 `snapshot-manifest-v1`。
3. 导入时校验格式版本、SHA-256、兼容性（架构、runtimeClass、nodeClass）；不匹配返回可读错误码。导入只创建 snapshot 记录，不自动启动沙箱。
4. 归档可以作为审计证据：记录导出人、时间、目标集群、artifact digest；导出/导入事件写审计日志。

**落点**：`cli/src/opensandbox_cli/commands/snapshot.py`、`server/opensandbox_server/services/snapshot_service.py`、`docs/guides/pause-resume.md`。

**风险**：大 artifact 导出会占带宽和本地磁盘；默认不内联大层，避免把 `.osbsnap` 变成巨型 tar。凭据/密钥不能进归档；manifest 里的 URI 可能包含内部 registry 地址，导入时需要重写。

**验收**：无外网的第二集群导入后能创建沙箱；篡改任意 artifact 或 manifest 后导入失败；仅 manifest 的轻量归档可被审计系统读取；大 artifact 导出不阻塞 server 请求线程。

### P2-1：workspace/directory 级快照

**解决的问题**：容器快照恢复整个 rootfs，体积大、恢复慢；文档型负载真正需要的是 `/workspace` 或某个目录的时间点版本。当前 S3 中间件按目录同步，没有时间点语义和快速挂载能力。

**外部做法**：Modal 的目录快照可以挂载到已经运行的沙箱；文件系统快照相对 base 镜像做差分。Daytona 的 volume 按 tenant subpath 挂载。

**移植设计**：

1. `SandboxSnapshot` 增加 `scope: rootfs|workspace` 和 `paths`；workspace 快照只打包指定目录，产出 tar.zst 或 erofs 镜像。
2. 恢复时把 workspace artifact 挂载/展开到新沙箱的 `/workspace`，rootfs 用基础镜像；可选只读挂载 + 上层 overlay，支持多沙箱共享同一基线。
3. 与 S3 中间件对齐：workspace 快照的 manifest 可以引用 S3 前缀 + version，恢复走 S3 下载/挂载；快照负责时间点，S3 负责长期权威副本。
4. 文档编辑场景建议“每次 autosave 写版本化对象 + 周期 workspace 快照”，恢复时先取最新文档版本，再用快照补齐环境文件。

**落点**：`server/opensandbox_server/services/snapshot_service.py`、`services/k8s/snapshot_runtime.py`、`docs/guides/pause-resume.md`、S3 中间件实现。

**风险**：目录权限、符号链接、稀疏文件、硬链接需要明确保留策略；只读挂载 + overlay 的写时复制在容器运行时支持不一致；workspace 快照不能替代文档版本库。

**验收**：workspace 快照恢复到新沙箱后文件哈希一致；只读挂载下写入进入上层；文档版本与快照版本可以独立回滚；大目录（10GB 级）恢复时间可测。

### P2-2：统一快照模式与兼容性约束

**解决的问题**：容器路径默认只有 rootfs，QEMU 有 vmstate，fsb 有 memory；API 没有统一的 `snapshotMode`，调用方需要知道后端才能选择。内存快照的机型、连接、密钥约束散落在文档里。

**外部做法**：E2B 的 pause API 用 `full memory snapshot` 布尔值区分内存/文件系统；Modal 明确内存快照 7 天、同机型、TCP 连接关闭、源沙箱会终止；Daytona 只在 VM 沙箱支持 pause/resume。

**移植设计**：

1. `CreateSnapshotRequest` 增加 `mode: filesystem|memory`（默认 `filesystem`）；不支持的 runtime 返回 501/409，并给出可用模式。
2. `mode=memory` 时要求 `compatibility` 中的机型/CPU/架构匹配；恢复优先同 node class，不匹配时明确失败而不是静默降级。
3. 内存快照默认较短 TTL；快照前清理或标记敏感内存（凭据、token），恢复后要求重新注入凭据；TCP 连接不保证恢复。
4. 在 manifest 的 `compatibility` 中记录 `runtimeClass`、`architecture`、`qemuVersion`、`machineType`、`cpuModel`、`memoryBytes`、`requiredNodeClass`；容器路径至少记录 `runtimeClass` 和 `baseImageDigest`。

**落点**：`server/opensandbox_server/api/schema.py`、`services/snapshot_models.py`、`services/snapshot_runtime_factory.py`、`kubernetes/apis/sandbox/v1alpha1/sandboxsnapshot_types.go`。

**风险**：内存快照会放大节点内存/存储压力，与“更多用户优先”冲突；建议只对长会话池开放，并设置每节点/每租户预算。QEMU 路径已有兼容性字段，容器路径需要新增但不要复制 QEMU 的全部字段。

**验收**：不支持的内存模式返回明确错误；同机型恢复成功、跨机型失败；TTL 到期不可恢复；凭据恢复后必须重新注入。

## 七、不吸收项

| 不吸收 | 原因 | 替代 |
|---|---|---|
| BoxLite 的 `~/.boxlite` + SQLite 作为平台控制面 | 单机状态，节点丢失即丢；与 K8s 控制面/多副本冲突 | 继续用 server 持久化记录 + CRD，节点本地只做缓存层 |
| 每 Box 一块 QCOW2 作为池化短任务默认 | 存储运维、配额、GC 成本高；短任务重建更便宜 | 池化 + S3 工作区同步；长会话池可选本地 COW |
| 默认开启内存快照 | 按 guest RAM 占资源，机型绑定，恢复约束多 | 默认文件系统级；长会话显式 `mode=memory` |
| 用 clean boot 快照保存文档正文 | 快照不提供版本、审计、协作语义 | 文档正文放 L2 版本库；快照只恢复环境 |
| LiteBoxd 的每沙箱 PVC + 特权 overlay helper | 密度低、特权面大、RWO 故障恢复慢 | 池化 + S3；长会话用独立池和受控 PVC |
| Modal 的“快照导致源沙箱终止”语义 | 对交互式会话不友好 | 快照后保留源沙箱，恢复创建新实例；源实例按 TTL 回收 |

## 八、落地路线与验收

| 阶段 | 内容 | 改动面 | 守卫 |
|---|---|---|---|
| A（低风险） | manifest v1 + status 摘要；`retention` 字段与 TTL 记录；quiesce 指标与实验开关 | server snapshot model/API、CRD status、docs | 字段 additive；默认行为不变；先 dry-run GC |
| B（一致性） | image-committer 接入 `sync`/可选 `fsfreeze`；QEMU guest freeze；GC worker；`osb snapshot export/import` | image-committer、controller、server、CLI | 按 Pool/租户灰度；失败回退到当前行为；审计删除 |
| C（长会话加速） | 节点本地 COW 快照 + clone；workspace/directory 快照；统一 `mode` | 新 snapshot helper、controller 调度、server API | 仅长会话池；本地快照默认关闭；节点 drain 回退 durable |

验收清单：

- **一致性**：快照期间持续写入，恢复后 `fsck` 通过、文件哈希一致；状态里能看到 `consistency`。
- **可移植**：`.osbsnap` 在无外网的第二集群导入成功；篡改 artifact 后 restore 失败。
- **密度**：本地 COW clone 的 p50/p99 延迟、节点磁盘占用、GC 后残留量都有基线。
- **生命周期**：TTL、配额、restore 并发、租户隔离四类用例通过；orphan scan 可重复。
- **兼容性**：容器/QEMU/fsb 三种路径的 manifest 都能被同一套 restore 校验；不支持的模式返回明确错误。

## 九、来源

本仓：

- `docs/guides/pause-resume.md`：容器 pause/resume 的 OCI commit 流程、单副本限制、持久化边界。
- `docs/guides/qemu-vmstate-snapshots.md`：QEMU vmstate 与兼容性字段。
- `docs/architecture/fast-sandbox/checkpoints.md`：rootfs + vmstate + memory 的 checkpoint、digest-first、跨 Fastlet 恢复。
- `docs/architecture/fast-sandbox/storage.md`：artifact store、XFS reflink、DART、artifact 保留边界。
- `wiki/opensandbox-pooled-session-s3-sync-middleware.md`：池化模式 S3 用户目录恢复/回写。
- `wiki/liteboxd-persistence-and-recovery-analysis.md`：PVC + rootfs overlay 的持久化与恢复对照。
- `wiki/opensandbox-vs-perplexity-space-architecture.md`：两级暂停、周期快照与温池状态机的既有吸收建议。

外部：

- BoxLite 仓库：<https://github.com/boxlite-ai/boxlite>
- BoxLite 文件格式：<https://github.com/boxlite-ai/boxlite/blob/main/docs/reference/file-formats.md>
- BoxLite 存储概念：<https://github.com/boxlite-ai/boxlite/blob/main/docs/concepts/storage.md>
- BoxLite snapshot 实现：<https://github.com/boxlite-ai/boxlite/blob/main/src/boxlite/src/litebox/snapshot.rs>、<https://github.com/boxlite-ai/boxlite/blob/main/src/boxlite/src/litebox/snapshot_mgr.rs>、<https://github.com/boxlite-ai/boxlite/blob/main/src/boxlite/src/litebox/clone_export.rs>
- BoxLite Snapshot API 设计：[issue #205](https://github.com/boxlite-ai/boxlite/issues/205)
- E2B Sandbox persistence：<https://docs.e2b.dev/sandbox/persistence>
- E2B Pause sandbox API（full memory snapshot 参数）：<https://docs.e2b.dev/api-reference/sandboxes/pause-sandbox>
- Modal Sandbox snapshots：<https://modal.com/docs/guide/sandbox-snapshots>
- Daytona Persistence：<https://www.daytona.io/docs/en/persistence/>
- Kubernetes agent-sandbox：<https://agent-sandbox.sigs.k8s.io/docs/>
- Agent Sandbox suspend/resume 的社区拆解（Pod 删除、PVC 保留）：<https://supraj.dev/blog/kubernetes-agent-sandbox-hotel/>
- Firecracker snapshot support：<https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md>
