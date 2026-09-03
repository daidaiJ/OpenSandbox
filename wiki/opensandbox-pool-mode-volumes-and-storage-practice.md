# K8s 池模式卷类型、配置限制与副作用实践

> 日期：2026-09-03
> 业务前提：**不做暂停/恢复**（use-and-burn）、有 S3 兼容对象存储 + NAS；池化（Pool + BatchSandbox + taskTemplate）为主路径。
> 依据：`specs/sandbox-lifecycle.yml`（Volume/Host/PVC/OSSFS schema）、`server/opensandbox_server/services/k8s/volume_helper.py`、`services/k8s/batchsandbox_provider.py`、`services/validators.py`、`config.py`、`kubernetes/apis/sandbox/v1alpha1/pool_types.go`、`kubernetes/internal/controller/recycle/`。
> 定位：池模式"数据放哪、怎么配、有什么坑"的决策参考；卷之外的用户数据方案见 [S3 同步中间件文档](opensandbox-pooled-session-s3-sync-middleware.md)。

---

## 1. 先记住两条路径的卷规则

| 路径 | create 请求 `volumes` | 卷配置来源 |
|---|---|---|
| **直接创建 / 模板模式**（非池化 K8s） | ✅ 接受（`pvc`/`host` 后端），与基础模板卷合并 | 请求 + server 基础模板 |
| **池化模式**（`extensions.poolRef`） | ❌ **直接拒绝**："Pool mode does not support volumes. Remove 'volumes' from request or use template mode."（`batchsandbox_provider.py:166`；同段还拒绝 `networkPolicy`、`platform`） | **只能写在 Pool CR 模板里**（`spec.template.spec`，Schemaless 原生 Pod spec） |

原因：池 Pod 是**预热创建**的，分配时只做认领 + taskTemplate 注入，无法为单次分配动态挂卷。同 ns 的 `networkPolicy` 拒绝逻辑一致（spec 1379 行注记：pooled pods are pre-created）。

---

## 2. spec 卷 schema：三个后端 + 公共参数

```yaml
volumes:
- name: <dns-label>          # 唯一，DNS label（validators.py:289 ensure_valid_volume_name）
  mountPath: /abs/path       # 必填，容器内绝对路径
  readOnly: false
  subPath: rel/dir           # 可选；ossfs 后端时作为 bucket 前缀
  host:                      # 后端 1：hostPath
    path: /host/dir         # 受 server 白名单限制（spec 明示 security note）
  pvc:                       # 后端 2：平台托管命名卷（K8s→PVC / Docker→named volume）
    claimName: mydata
    createIfNotExists: true          # 不存在时自动建
    deleteOnSandboxTermination: false # 仅删除"本请求自动建"的卷；预存卷永不删
    storageClass: null               # null=集群默认
    storage: null                    # 默认 [storage].volume_default_size
    accessModes: null                # 默认 ["ReadWriteOnce"]
  ossfs:                     # 后端 3：OSS 挂载（见 §3 限制）
    bucket / endpoint / accessKeyId / accessKeySecret / version(1.0|2.0) / options
```

校验规则（`validators.py:676 ensure_volumes_valid`）：卷名唯一、恰好一个后端、DNS label、ossfs 参数校验（`ensure_valid_ossfs_volume`）；卷名不得与内部卷冲突（`volume_helper.py`：与 `opensandbox-bin` 等内部卷重名直接 ValueError）。

## 3. K8s 运行时支持矩阵

| 后端 | 直接创建 | 池模板 | 说明 |
|---|---|---|---|
| `pvc` | ✅（自动建 PVC，delete 时清理 server 托管 PVC） | ✅（原生 PVC 卷） | K8s 映射 `persistentVolumeClaim`；同一 claim 多次挂载只建一个 pod volume，readOnly 取"所有挂载都只读"策略（`volume_helper.py:_get_pvc_source_read_only_policies`） |
| `host` | ✅（hostPath，type `DirectoryOrCreate`） | ✅（原生 hostPath） | **节点绑定**；直接创建路径受 `[storage].allowed_host_paths` 白名单（`config.py:783`） |
| `ossfs` | ❌ **K8s 不支持** | ❌ | `volume_helper.py` else 分支明确报 "Supported backends: pvc, host"；ossfs 仅 Docker 运行时实现（`services/docker/ossfs_mixin.py`，挂 `ossfs_mount_root/<bucket>/<subPath>`，`config.py:798`） |
| 其余 K8s 原生卷（emptyDir / configMap / secret / nfs / csi 等） | 请求字段不支持 | ✅ **池模板全可用** | 模板 Schemaless，server 原样提取合并（`_extract_template_pod_extras`：volumes + sandbox 容器 volumeMounts + securityContext 一并带入） |

## 4. 回收策略 × 卷数据残留（池模式核心副作用）

Pool `recycleStrategy`（`pool_types.go:42`，Enum=Delete;Restart;Noop，**默认 Delete**）决定了"上一个任务的数据会不会留给下一个用户"：

| 策略 | 动作 | emptyDir/容器层 | PVC/NFS | 风险评级 |
|---|---|---|---|---|
| **Delete**（默认，推荐） | Pod 删除，池补新 Pod | ✅ 全清 | 保留（跨沙箱共享面，见 §5） | 低 |
| **Restart** | 容器重启（`kill 1` → kubelet 按 restartPolicy 重启，`recycle/restart/restart_default.go`） | ⚠️ **emptyDir 是 Pod 级卷，容器重启不清空** —— 任务产物、/tmp、写入 emptyDir 的用户数据**跨分配残留** | 同上 | **高：数据泄漏给下一个分配者** |
| **Noop** | 什么都不做，Pod 直接回池（`noop_recycler: do nothing, pod is immediately available`） | ⚠️ 全部残留，任务进程都可能仍在 | 同上 | **最高，任务型场景禁用** |

补充：
- Restart 策略可用 Pool 注解 `sandbox.opensandbox.io/restart-config` 微调：`blacklist`（排除容器）、`retryInterval`（默认 30s）、`maxRetries`（默认 3）、`restartCommand`（默认 `kill 1`）；要求 PID1 优雅退出（execd-as-init 拓扑满足该契约）。
- 业务"用完即焚"背景 → **选 Delete**；若因启动耗时想用 Restart，必须配套清理（entrypoint 开头清空工作目录 / postStop 钩子清理），且绝不能把敏感数据写 emptyDir。

## 5. 共享卷的隔离副作用（池模板 = 每 Pod 同一份）

| 卷类型 | 副作用 | 实践约束 |
|---|---|---|
| **RWX PVC（NAS/NFS）** | 池内**所有沙箱共享同一文件系统视图**：读写挂载 = 跨沙箱互见 + 并发竞争 | 只用于**只读预挂**（解释器/模型/数据集，readOnly: true）；读写场景必须应用层按用户目录自隔离（见 §6） |
| **RWO PVC** | ReadWriteOnce 只能单节点 attach：池多副本跨节点时 **FailedAttachVolume 卡死** / 调度被卷绑到单节点 | 池模板禁用 RWO；确需 PVC 一律 RWX |
| **hostPath** | 节点绑定 + 宿主机暴露面；Pod 漂移后数据"消失"（实际在别的节点） | 白名单前缀 + 只放节点级缓存类数据；敏感数据禁用 |
| **emptyDir** | Delete 策略下随 Pod 生命周期即焚；Restart/Noop 下残留（§4） | 当作易失工作区；不要做任何"以为会持久"的假设 |
| **configMap/secret** | 模板静态内容，所有沙箱同值；更新 ConfigMap 不自动重建存量 Pod | 适合平台级配置；per-allocation 差异走 taskTemplate env（分配时注入） |
| 模板 `subPath` | 是**静态字符串**：每 Pod 挂的是同一个子目录，无法在模板层做 per-allocation 动态子目录 | per-user 子路径 = 应用层拼（读注入 env）或 S3 中间件 |

另注意**模板更新传播**：模板卷配置变更只对 idle Pod 重建生效（[Pool 模板更新文档](opensandbox-pool-template-update-and-allocation.md)），滚动期间池内新旧 revision 并存 → 卷配置短期不一致，业务不要依赖"整池立刻生效"。

## 6. 业务落地建议（无 pause/resume + S3 + NAS）

```
数据分类决策树：
├─ 用户会话产物 / 需要跨沙箱存活的用户文件
│    → S3 中间件静默恢复/回写（已实施方案，per-user 目录隔离）
│      池化模式"不能挂 per-sandbox 卷"正是选它的原因（D-6 决策）
├─ 只读共享数据（解释器、模型、数据集）
│    → NAS RWX PVC，readOnly 预挂 Pool 模板（瘦镜像 + 快启动方案）
├─ 沙箱内临时工作区
│    → 容器可写层 / emptyDir，recycleStrategy=Delete 即焚
├─ per-allocation 配置/凭据
│    → taskTemplate env 注入（分配时）；不是卷
└─ 大文件出网交付
    → 业务层走 S3/对象存储 URL，不落盘沙箱
```

- **不要试图用卷重建"暂停恢复"语义**：业务已明确不做 pause/resume（D-x 决策），快照/卷都不是替代路径，重建 + S3 恢复就是方案。
- PVC 自动创建（`createIfNotExists`）仅直接创建路径有意义；池模式一律预建 PVC → 模板引用。
- `deleteOnSandboxTermination` 只清"该请求自动建"的 PVC（label `opensandbox.io/volume-managed-by=server`，`kubernetes_service.py:_cleanup_managed_pvcs`）；预存 PVC 永不自动删 → **池化共享 PVC 的生命周期归平台运维管**，删池不删卷，注意孤儿卷治理。

## 7. 避坑清单

| # | 坑 | 应对 |
|---|---|---|
| 1 | 池化 create 带 `volumes` 直接 400 | 卷进 Pool 模板；per-allocation 差异走 taskTemplate env |
| 2 | Restart 回收 + emptyDir → 数据跨用户残留 | 业务选 Delete；或 entrypoint/postStop 清理 + 不写敏感数据 |
| 3 | RWO PVC 进池模板 → 多节点 FailedAttachVolume | 只用 RWX |
| 4 | RWX 读写挂载 → 跨沙箱互见 | readOnly 预挂；写路径交给 S3 中间件/应用层用户目录 |
| 5 | ossfs 后端在 K8s 报 "Supported backends: pvc, host" | ossfs 是 Docker 专属；K8s 用 NAS PVC 或 S3 API |
| 6 | 卷名撞内部卷（opensandbox-bin 等）ValueError | 换名 |
| 7 | hostPath 绕过白名单认知 | 直接创建路径受 `[storage].allowed_host_paths` 限制；池模板是原生 spec **不受该白名单管**（自行约束） |
| 8 | 模板卷改了但存量 Pod 没变 | 只重建 idle Pod，滚动期新旧并存 |
| 9 | 删池/删沙箱后共享 PVC 还在 | 预存 PVC 生命周期自管，建立孤儿卷巡检 |
| 10 | Noop 回收当默认 | 任务型场景禁用 Noop |

## 8. 关联文档

- [池化沙箱 Pod 边车组件介绍与实践指导](opensandbox-pool-sandbox-sidecar-components-guide.md) —— Pod 内组件与装配
- [池化沙箱业务会话 S3 用户目录静默同步](opensandbox-pooled-session-s3-sync-middleware.md) —— 用户数据持久正道
- [共享存储挂载解释器镜像最小化与快速启动](opensandbox-shared-storage-interpreter-minimal-image.md) —— NAS 只读预挂方案
- [Pool 模板更新与 Pod 分配行为排查](opensandbox-pool-template-update-and-allocation.md) —— 模板滚动语义
- [用完即焚沙箱编排最佳模式](opensandbox-ephemeral-sandbox-orchestration-pattern.md) —— 共享解释器卷模板样例
- [沙箱配置参数与环境变量参考](opensandbox-sandbox-config-and-env-reference.md) —— `[storage]` 配置全集
