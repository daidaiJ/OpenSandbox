---
name: liteboxd-persistence-and-recovery-analysis
description: LiteBoxd 的 rootfs 持久化与恢复机制拆解（PVC + overlay + Deployment + reconcile），以及与 OpenSandbox 池化 + S3 方案的对照
type: project
---

# LiteBoxd 文件持久化与恢复机制拆解

> 调研日期：2026-10-23
> 调研对象：GitHub [`fslongjin/liteboxd`](https://github.com/fslongjin/liteboxd)，源码基线 `a17caecc653505b1be1e611c7e220cf450d4ce44`（2026-05-06）。
> 调研方法：阅读仓库 `docs/sandbox-persistence/`、后端 Go 源码与模板/CRD 示例，梳理资源模型、挂载时序、恢复路径和边界。本文未在真实 K3s + Longhorn 集群复测，性能与故障恢复时间以代码和官方文档为准。
> 对照基线：本仓当前 `dev` 分支的 K8s 池化路径（Pool + BatchSandbox + task-executor）与 `wiki/opensandbox-pooled-session-s3-sync-middleware.md` 的 S3 用户目录同步方案。

## 一、结论先行

LiteBoxd 解决文件持久化的核心是 **每个沙箱一块 PVC，PVC 上只存 rootfs overlay 的可写层（upper/work），沙箱以 Deployment 运行；Pod、节点或 server 重启后重新挂载同一块 PVC，用原镜像作为只读下层重建 merged rootfs**。

1. **持久化对象是整个 rootfs 的增量**，不只是 `/workspace`；写入 `/root`、`/opt`、`/var/lib`、`/workspace` 的内容都进入 PVC。
2. **恢复粒度是“同一个卷重新挂载”**；仓库没有快照、备份或对象存储恢复链路。
3. **自愈靠 Deployment + Reconcile**：Deployment 负责 Pod 重建，控制面每分钟对账 DB 与 Deployment/PVC/Pod 状态。
4. **删除是持久化状态机**，`requested → quiescing_runtime → deleting_storage → force_cleanup → verifying → completed`，server 重启后可以继续推进。
5. **删除后的数据恢复只有 `Retain` 一条路**：保留 PVC 供人工处理，平台不会自动把旧卷挂到新沙箱。
6. 方案适合“沙箱是宠物、状态需要原地保留”的长会话场景；对池化短任务主路径，直接照搬会显著降低资源密度。

## 二、需求拆解与方案选型

LiteBoxd 把需求拆成三条验收标准：

| 需求 | 验收标准 |
|---|---|
| 持久运行 | 进程崩溃自动拉起；Pod 重建/节点重启后自动恢复；支持 `ttl=0` 永久运行 |
| rootfs 全量持久化 | `/` 下任意可写路径（`/root`、`/opt`、`/var/lib` 等）在容器重建后仍在 |
| 单沙箱磁盘上限 | 每沙箱独立持久卷容量，超限写入失败且不侵占其他沙箱 |

仓库比较过两个方案：

- **仅给 `/workspace` 挂 PVC**：实现快，但 `/root`、`/var` 等写入仍会丢，不满足第二条，淘汰。
- **持久化 rootfs overlay**：镜像作为只读下层，PVC 承载 upper/work，业务进程在 merged rootfs 中运行。满足三条需求，作为目标方案。

已确认的决策：

1. `ttl=0` 表示永久运行，只能手动删除。
2. 只给 init/helper 容器提权，主业务容器不提权。
3. `persistent-rootfs` 默认使用 Longhorn（或同类支持硬配额的 CSI）。
4. `local-path` 不作为默认存储类，仅用于开发/测试。

## 三、资源模型与数据模型

### 3.1 Kubernetes 资源

每个持久化沙箱对应：

| 资源 | 名称 | 说明 |
|---|---|---|
| PVC | `sandbox-data-{sandboxID}` | `ReadWriteOnce`，容量即磁盘上限 |
| Deployment | `sandbox-{sandboxID}` | 1 副本，`Recreate` 策略，负责自愈 |
| EmptyDir | `rootfs-control` | 主容器与 helper 的挂载协调通道 |
| Pod 内边车 | `rootfs-prepare` init + `rootfs-helper` sidecar | 目录准备与特权 overlay 挂载 |

Deployment 使用 `Recreate` 而不是滚动更新，是因为 PVC 是 `ReadWriteOnce`，同一时刻只能挂在一个 Pod 上。

### 3.2 模板与 API

模板新增 `spec.persistence`：

```yaml
spec:
  persistence:
    enabled: true
    mode: rootfs-overlay       # 当前唯一支持的模式
    size: 1Gi
    storageClassName: longhorn
    reclaimPolicy: Delete      # Delete | Retain
```

`CreateSandboxRequest.overrides.persistence` 只允许覆盖 `size`，`mode` 不允许覆盖；`ttl` 的最小值从 `1` 调整为 `0`。校验逻辑会拒绝 `local-path`：

```text
persistence.storageClassName local-path is not supported for persistent-rootfs;
use Longhorn or another CSI with hard quota
```

### 3.3 控制面数据

`sandboxes` 表新增字段：

| 字段 | 用途 |
|---|---|
| `persistence_enabled` / `persistence_mode` / `persistence_size` / `storage_class_name` | 记录声明面配置 |
| `volume_claim_name` / `volume_reclaim_policy` | 沙箱与 PVC 的映射、删除策略 |
| `runtime_kind` / `runtime_name` | `pod` 或 `deployment`，以及 K8s 资源名 |
| `stopped_at` | stop/start 语义 |
| `deletion_phase` / `deletion_started_at` / `deletion_last_attempt_at` / `deletion_next_retry_at` / `deletion_attempts` / `deletion_force_level` / `deletion_last_error` | 删除状态机与重试/强删进度 |

installer 默认把 server 的 `/app/data` 挂到 PVC `liteboxd-api-data`，SQLite 元数据随 server 重启保留，这是恢复链路的前提。

## 四、rootfs overlay 持久化原理

### 4.1 挂载布局

```text
lowerdir = 主容器当前的 /                       （镜像 rootfs，只读）
upperdir = PVC/.liteboxd-overlay/upper
workdir  = PVC/.liteboxd-overlay/work
merged   = PVC/.liteboxd-overlay/merged

业务进程 = chroot(merged) + 镜像 entrypoint/cmd
```

PVC 挂载在 `/.liteboxd-rootfs`，merged rootfs 位于 `/.liteboxd-rootfs/.liteboxd-overlay/merged`。主容器 wrapper 最终执行：

```sh
chroot "$MERGED" "$@"
```

### 4.2 哪些内容持久化

| 路径 | 行为 |
|---|---|
| `/root`、`/opt`、`/var/lib`、`/workspace` | 写入进入 PVC upper 层，Pod 重建后保留 |
| `/proc`、`/sys`、`/dev`、`/run` | 每次启动重新绑定，不持久化 |
| `/etc/resolv.conf`、`/etc/hosts`、`/etc/hostname` | 每次启动从 Pod 环境重新绑定，不持久化 |
| 镜像基础文件 | 每次从镜像重新生成，不占 PVC 容量 |
| 运行中的进程、内存、PID | 不保留，Pod 重建后重新启动 |

`/workspace` 在持久化模式下不再是 EmptyDir，而是 merged rootfs 的一部分，因此同样持久化。

### 4.3 设计取舍

- **不做整份 rootfs 拷贝**：启动时不需要把镜像内容复制到 PVC，避免启动慢和小盘初始化失败。
- **PVC 只存增量**：容量约束的是 overlay 的 upper 层，镜像基础层不计入配额；实际可用空间约为“镜像大小 + PVC 容量”。
- **基础层每次从镜像重建**：升级镜像后，旧 upper 层仍会覆盖新镜像里的同名文件；这一点是后续风险，见第七节。

## 五、启动挂载时序

### 5.1 为什么需要特权 helper

Kubernetes 的 init 容器和主容器拥有独立的 mount namespace。init 容器里挂载的 overlay，主容器看不到。LiteBoxd 早期版本用 `Bidirectional` mount propagation 把挂载传播给主容器，代价是会泄漏到宿主机 kubelet 的 volume 路径。

当前实现改为：

1. `rootfs-prepare` init 容器（非特权）创建目录，清理上一轮残留的 `main.info`、`mounted.*`、`failed.*`、`stop-request.*`、`unmounted.*`。
2. 主容器先启动 wrapper，写入 `main.info`（generation + PID），然后轮询等待 `mounted.<gen>`。
3. `rootfs-helper` sidecar（特权）通过 `shareProcessNamespace` 看到主容器 PID，执行 `nsenter -t <pid> -m` 进入主容器 mount namespace，挂载 overlay，再绑定 `/proc`、`/sys`、`/dev`、`/run` 和 `/etc/{resolv.conf,hosts,hostname}`，最后写 `mounted.<gen>`。
4. 主容器收到标记后 `chroot merged`，启动镜像 entrypoint。
5. 收到 TERM 时，主容器写 `stop-request.<gen>`；helper 卸载挂载并回写 `unmounted.<gen>`，双方退出。

### 5.2 时序图

```text
kubelet                rootfs-prepare        main wrapper              rootfs-helper
   │                        │                     │                         │
   ├─ start init ──────────►│ mkdir/clean         │                         │
   │                        ├─ exit               │                         │
   ├─ start main ───────────────────────────────►│ write main.info(gen,pid)│
   │                        │                     │ wait mounted.<gen>      │
   ├─ start helper ────────────────────────────────────────────────────────►│
   │                        │                     │                         ├─ nsenter -t pid -m
   │                        │                     │                         ├─ mount overlay/proc/...
   │                        │                     │◄──── mounted.<gen> ─────┤
   │                        │                     ├─ chroot(merged)         │
   │                        │                     │  exec entrypoint        │
```

### 5.3 一致性细节

- generation 由时间戳和 PID 组成，避免 Pod 内多次重启后误读上一轮的标记。
- 控制通道使用 EmptyDir，生命周期跟随 Pod；Pod 重建后是全新目录。
- `shareProcessNamespace` 让 helper 能看到主容器 PID，同时保证 `/proc` 视图一致。
- 主容器保持非特权；只有 helper 拥有 `privileged` 和 `allowPrivilegeEscalation`。
- 脚本会检查 `nsenter`、`mount`、`umount`、`sort`、`awk` 是否存在，缺少时直接失败并写入 `failed.<gen>`。

### 5.4 exec / 文件 API 的路径语义

`Exec`、`UploadFile`、`DownloadFile` 在检测到持久化 Pod 后，会用 `chroot /.liteboxd-rootfs/.liteboxd-overlay/merged` 包住用户命令：

```go
func wrapCommandForRootFS(pod *corev1.Pod, command []string) []string {
    if len(command) == 0 || !isPersistentRootFSPod(pod) {
        return command
    }
    wrapped := append([]string{"chroot", rootfsOverlayMergedPath}, command...)
    return wrapped
}
```

因此 exec、上传、下载看到的 `/` 与业务进程一致，都是 merged rootfs。

## 六、恢复机制

### 6.1 恢复路径矩阵

| 故障场景 | 恢复机制 | 实际保证 |
|---|---|---|
| 业务进程崩溃 | kubelet 重启容器，helper 重新挂载同一 PVC | upper 层保留，文件恢复 |
| Pod 被删除/驱逐 | Deployment 创建新 Pod，重新挂载同一 PVC | `Recreate` 策略保证 RWO 卷不同时挂两个 Pod |
| 节点宕机 | Pod 重新调度，Longhorn 重新 attach 卷 | 需要等待卷 detach/attach，恢复时间取决于存储 |
| server 重启 | 启动时立即 reconcile 一次，之后每 1 分钟一次；删除执行器每 10 秒一次 | 状态从 DB + K8s 快照重建，删除阶段从 DB 继续 |
| 主动 stop/start | Deployment 副本数 0/1 | PVC 保留，停止期间继续占用存储 |
| TTL 到期 | 进入异步删除状态机 | `ttl=0` 不参与过期 |
| 删除沙箱 | 六阶段状态机 | 只有 `completed` 才标记 deleted |
| `Retain` 删除 | 保留 PVC | 没有自动重新挂载到新沙箱的 API，需要人工处理 |
| PVC/PV 丢失 | 无自动恢复 | 仓库中没有快照/备份集成，数据不可恢复 |

### 6.2 server 重启后的控制面恢复

- `reconcile` 启动时跑一次 `startup`，之后每 1 分钟一次；它按 DB 记录逐条读取 Deployment、PVC、Pod 快照，修正 `lifecycle_status`、`pod_uid`、`pod_phase`、`pod_ip`。
- 状态更新使用条件更新（`UpdateStatusIfActive` / `UpdateObservedStateIfActive`），删除中的记录不会被旧的 watcher 或启动监控覆盖。
- 删除执行器每 10 秒扫描 `desired_state=deleted && lifecycle_status!=deleted && deletion_phase!=completed` 的记录，按 DB 中的阶段继续推进。
- 持久化沙箱的 runtime 丢失超过 10 分钟宽限期后，会被标记为 `lost`；Pod 重建后会重新回到 `running`。

### 6.3 删除状态机

```text
requested
  └─► quiescing_runtime    删除 Deployment/Pod，等待退出
        └─► deleting_storage   按 reclaimPolicy 删 PVC
              └─► force_cleanup    分级强删
                    └─► verifying      确认无残留
                          └─► completed
```

关键细节：

- 删除时先把 Deployment 以 `Retain` 方式删掉，等 Pod 退出、卷不再被引用后，再按真实 `reclaimPolicy` 删 PVC，避免删卷时还有 Pod 在使用。
- 强删分四级：删 Pod/Deployment finalizer、删 PVC finalizer、清理 VolumeAttachment/PV finalizer。
- 每一步都校验 `app`、`managed-by`、`sandbox-id` 标签，确认资源属于目标沙箱后才动手。
- `Retain` 策略下保留 PVC；这是“人工审计/恢复”的入口，不是自动恢复能力。

### 6.4 启动失败分类

`persistent_status.go` 会从 K8s Event 中识别：

- `ProvisioningFailed`、`FailedBinding`、`FailedAttachVolume`、`FailedMount`
- `no available disk candidates`、`unable to create new replica`、`all replicas are failed`、`failed to auto salvage volume`、`failed to provision volume`

命中后会把沙箱标记为 `failed` 并写入具体原因，而不是一直卡在 `pending`。

### 6.5 可观测性

仓库设计了以下指标方向（设计文档，代码中未全部落地）：

- `sandbox_persistence_pvc_usage_bytes`
- `sandbox_rootfs_mount_fail_total`
- `sandbox_recover_success_total`
- `sandbox_disk_quota_exceeded_total`

日志中增加 `sandbox_id`、`pvc`、`storage_class`、`reclaim_policy`、`runtime_name` 等字段。

## 七、边界与风险

1. **镜像更新会污染 overlay 语义。** upper 层是旧镜像上产生的修改；换新镜像后，旧文件会继续遮蔽新镜像里的同名文件，旧的 whiteout 也可能把新镜像新增的文件继续隐藏。仓库没有镜像版本迁移逻辑，生产上需要固定镜像 tag，升级时重建沙箱或做迁移。
2. **特权 helper 提高攻击面。** helper 是 privileged，且与主容器共享 PID namespace。设计文档建议把持久化沙箱调度到专用节点池，并单独收紧 seccomp、capabilities 和宿主路径暴露。
3. **RWO + 单副本意味着没有沙箱级 HA。** 节点故障时依赖存储重新 attach，恢复可能持续数分钟；`lost` 状态要等 10 分钟宽限期才标记。
4. **没有时间点恢复。** 文件系统的一致性依赖底层存储和应用的写入顺序；崩溃时未落盘的数据会丢，PVC 损坏只能靠 Longhorn 自身的副本/备份能力，LiteBoxd 不编排备份。
5. **容量硬限制依赖 CSI。** Longhorn 可以通过卷大小实现 ENOSPC；`local-path` 被拒绝。PVC 配额约束的是 overlay 增量，不是整个 rootfs。
6. **启动依赖主容器镜像里有 `chroot` 和 `/bin/sh`。** distroless 或极简镜像无法直接使用；文件上传/下载还依赖镜像内有 `tar`。
7. **server 需要能访问镜像仓库。** 模板没有显式 `command`/`args` 时，server 会用 `go-containerregistry` 拉取镜像 config 来解析 entrypoint/cmd；离线环境要保证私有仓库可达。
8. **持久化模式的就绪判定有竞态。** 按当前源码，模板的 readiness probe 没有落到 Pod 上，启动监控只检查 Pod Ready；主容器 wrapper 在等待 helper 挂载时已经处于 Running，可能提前被标记为 running，启动脚本和文件上传也可能在挂载完成前执行。评估时建议实际压测这个窗口。
9. **恢复不等于“删除后可恢复”。** `Retain` 只是保留 PVC，仓库没有“用旧 PVC 创建新沙箱”的接口；跨集群迁移也不支持。
10. **stop 状态继续占用存储。** 副本数缩到 0 只释放计算资源，PVC 仍然绑定并计入容量。

## 八、与 OpenSandbox 池化 + S3 方案的对照

| 维度 | LiteBoxd | OpenSandbox 当前主线 |
|---|---|---|
| 持久化单位 | 每沙箱一块 PVC | 每用户/会话一个 S3 前缀 |
| 保存内容 | 整个 rootfs 的增量层 | 工作区目录（如 `/shared-workspace`） |
| 恢复方式 | 重建 Pod 后重挂同一 PVC | 分配后从 S3 恢复到工作区，销毁前回写 |
| 运行形态 | 长期存在的 Deployment | 池化 BatchSandbox，短生命周期 |
| 资源密度 | 每沙箱固定占一份存储和 Deployment | 资源可快速回收，密度高 |
| 一致性 | 文件系统语义，依赖存储 | 有明确的同步窗口，需要处理回写失败 |
| 适用场景 | 长会话、需要保留 rootfs 状态的 Agent | 多租户短任务、Q&A 为主 |

### 8.1 值得吸收的机制

1. **generation + ack 的跨容器挂载协调**：比依赖 mount propagation 更可控，也避免挂载泄漏到宿主机。
2. **删除状态机持久化**：阶段、重试、强删等级写库，server 重启后继续收敛；我们的池化路径也可以借鉴到 BatchSandbox/Pool 的最终回收。
3. **条件更新**：`UpdateStatusIfActive` 一类写法避免旧状态覆盖删除/停止状态。
4. **删除前归属校验**：按 `app`、`managed-by`、`sandbox-id` 校验 PVC/PV/Deployment，降低误删风险。
5. **启动失败分类**：把 K8s Event 映射为可读原因，减少卡在 `pending` 的排障成本。

### 8.2 不建议直接照搬的部分

- **每沙箱 PVC + Deployment + 特权 sidecar**：适合长会话宠物型沙箱，不适合资源受限、池化短任务为主的主路径。
- **Longhorn 依赖**：需要额外存储组件和节点依赖（如 `open-iscsi`），与“内网 K8s、有限节点资源”的约束冲突。
- **rootfs 全量 overlay**：镜像更新后的 upper 层迁移问题需要长期维护，池化场景用“重建 + 工作区恢复”更简单。
- **无备份的 PVC 恢复**：企业数据需要审计与备份时，块存储卷本身不够，仍需对象存储/备份系统配合。

### 8.3 适用判断

| 需求 | 建议 |
|---|---|
| 同一沙箱长期保留 rootfs、允许占用块存储 | LiteBoxd 方案直接匹配 |
| 多用户短任务、只恢复工作区 | 继续用池化 + S3 同步，成本更低 |
| 长会话与短任务混合 | 分池：长会话独立池走 PVC/overlay，短任务池保持 S3 同步 |

## 九、复现验证方法

如果要在目标集群验证 LiteBoxd 的持久化行为，最短路径如下：

1. 安装 Longhorn，确认 `kubectl get sc` 中有 `longhorn`。
2. 导入 `templates/code-interpreter-persistent.yml`。
3. 创建 `ttl=0` 的持久化沙箱：`liteboxd sandbox create --template code-interpreter-persistent --ttl 0 --wait`。
4. 写入文件并同步：`liteboxd sandbox exec <id> -- sh -lc "echo hello-persist > /root/persist.txt && sync"`。
5. 删除 Pod（不是删除沙箱）：`kubectl -n liteboxd-sandbox delete pod -l sandbox-id=<id>`。
6. 等待新 Pod 就绪后读取：`liteboxd sandbox exec <id> -- cat /root/persist.txt`。
7. 容量验证：在沙箱内持续写入超过 PVC 配额，预期 `No space left on device`。
8. 回收策略验证：分别用 `Delete` 和 `Retain` 删除沙箱，检查 PVC 是否保留。
9. 删除恢复验证：删除过程中重启 `liteboxd-server`，确认 `deletion.phase` 继续推进，Deployment/Pod/PVC 最终收敛。

## 十、源码索引

| 主题 | 位置 |
|---|---|
| 持久化设计、实施计划、PVC 管理、验证手册 | [`docs/sandbox-persistence/`](https://github.com/fslongjin/liteboxd/tree/a17caec/docs/sandbox-persistence) |
| PVC 创建、Deployment 组装、overlay 挂载脚本 | [`backend/internal/k8s/persistent_runtime.go`](https://github.com/fslongjin/liteboxd/blob/a17caec/backend/internal/k8s/persistent_runtime.go) |
| exec/上传/下载的 chroot 包装 | [`backend/internal/k8s/client.go`](https://github.com/fslongjin/liteboxd/blob/a17caec/backend/internal/k8s/client.go) |
| DB 与 K8s 对账、stopped 处理 | [`backend/internal/service/sandbox_reconcile.go`](https://github.com/fslongjin/liteboxd/blob/a17caec/backend/internal/service/sandbox_reconcile.go) |
| 删除状态机与分级强删 | [`backend/internal/service/sandbox_deletion.go`](https://github.com/fslongjin/liteboxd/blob/a17caec/backend/internal/service/sandbox_deletion.go) |
| 启动状态分类与存储失败识别 | [`backend/internal/service/persistent_status.go`](https://github.com/fslongjin/liteboxd/blob/a17caec/backend/internal/service/persistent_status.go) |
| 模板持久化字段 | [`backend/internal/model/template.go`](https://github.com/fslongjin/liteboxd/blob/a17caec/backend/internal/model/template.go) |
| 持久化模板示例 | [`templates/code-interpreter-persistent.yml`](https://github.com/fslongjin/liteboxd/blob/a17caec/templates/code-interpreter-persistent.yml) |

### 相关提交

| 提交 | 内容 |
|---|---|
| `3779310` | 初始持久化 rootfs 运行时与 PVC 管理、Longhorn installer 集成 |
| `6b04165` | 持久化沙箱 stop/start |
| `9737725` | 启动监控与状态分类 |
| `d04065a` | 异步删除状态机 |
| `4a68c7e` | 用非特权 init + 特权 sidecar + 控制卷重构 overlay 挂载 |
| `ab4fe9e` | stopped 持久化沙箱的 reconcile |
| `0166aa4` | 网络策略控制器与资源清理逻辑重构 |
