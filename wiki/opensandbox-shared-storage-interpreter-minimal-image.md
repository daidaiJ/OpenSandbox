# 共享存储挂载解释器实现镜像最小化与快速启动 —— 可行性评估方案

- 日期：2026-08-07
- 状态：可行性评估（基于代码调研，未实施）
- 关联：`wiki/opensandbox-crd-controller-reconcile-analysis.md`、`wiki/opensandbox-controller-defects-and-pitfalls.md`

---

## 1. 背景与目标

当前 code-interpreter 镜像（`sandboxes/code-interpreter/`）为**全量多语言运行时**：`/opt/python/versions`（uv 装 Python 3.10~3.14 共 5 个）、`/opt/node`（Node 18/20/22）、`/opt/go`（Go 1.23/1.24/1.25）、`/usr/lib/jvm`（JDK 8/11/17/21）+ Maven + 各语言 kernel。体量 GB 级，每个新节点首次拉取耗时长，拖慢 Pod 启动。

**目标**：把解释器运行时从镜像剥离，改为通过共享存储（PVC/NFS/CSI，ReadWriteMany）挂载进容器，镜像只保留最小 OS + 执行组件，实现：
1. 镜像缩小到几百 MB，新节点拉取成本大幅下降
2. 解释器版本集中管理、按需切换，无需重建镜像
3. 多版本并存成本趋近于 0（卷上放多少版本都行）

---

## 2. 现状调研结论（基础设施已就绪度 ~70%）

### 2.1 镜像内容与挂载点（明确的剥离对象）

| 路径 | 内容 | 体积权重 | 是否可卷挂载覆盖 |
|---|---|---|---|
| `/opt/python/versions` | uv 安装的 5 个 CPython | 高 | ✅ |
| `/opt/node` | Node 18/20/22 | 中 | ✅ |
| `/opt/go` | Go 1.23/1.24/1.25 | 中 | ✅ |
| `/usr/lib/jvm` | 4 个 OpenJDK + Maven | 高 | ✅ |
| `/opt/code-interpreter/code-interpreter-env.sh` | 版本切换脚本（PATH 维护） | 小 | ✅（脚本可留镜像内，PATH 指向卷） |
| `/opt/code-interpreter/code-interpreter.sh` | 启动脚本（注册 kernels + 起 Jupyter :44771） | 小 | 留镜像内 |
| Jupyter + ipykernel 等 | kernel 包（已为每 Python 版本安装） | 中 | 可随解释器上卷或保留镜像 |

镜像瘦身后剩余：ubuntu base + libseccomp2 + execd + 启动脚本 + 少量工具 ≈ 200~500MB（估）。

### 2.2 执行链（挂载敏感点）

```
用户 SDK → execd :44772 /code → Jupyter HTTP/WS (127.0.0.1:44771) → ipykernel 进程
命令执行 → execd exec.Command 直接起 /bin/sh（不经 Jupyter）
```

- 代码解释器的 python **是 Jupyter 拉起的 kernel 进程**，位于主容器内；task-executor（:5758）只服务 operator 的 taskTemplate 编排，非解释器主路径
- 解释器目录改卷挂载后需要保证：
  - (a) 卷在容器启动前 Ready —— **PVC 挂载发生在容器启动前，天然满足** ✅
  - (b) `code-interpreter-env.sh` 的 PATH/版本切换逻辑指向卷内路径 —— 需改脚本 ✅（改动小）
  - (c) pause/resume 的 `image-committer` 是**容器级 commit 整个 rootfs，不含卷内容** —— 需要单独策略（见 §4.4）

### 2.3 卷能力（三层已打通）

- **API 层**：`volumes[]` 支持 `pvc`/`host`/`ossfs` backend（`server/opensandbox_server/api/schema.py:146,164,239,297`）；server 可自动创建 PVC（`createIfNotExists`/`storageClass`/`storage`/`accessModes`，RWX 共享 NAS 可行）；OSEP-0003 状态 `implementing`
- **K8s 层**：BatchSandbox/Pool 的 `spec.template` 是 **Schemaless**（`batchsandbox_types.go:106-110`、`pool_types.go:54-57`），可直接写任意 `volumes`/`volumeMounts`——已有官方样例（`kubernetes/config/samples/sandbox_v1alpha1_pool.yaml` 的 emptyDir/initContainers）
- **server 层**：`apply_volumes_to_pod_spec`（`volume_helper.py:57-139`）已实现 PVC/hostPath 挂载；`_merge_pod_spec_extras`（`batchsandbox_provider.py:408-460`）处理模板卷合并
- **限制**：Pool 模式走 API 的 `volumes` 字段被拒（`batchsandbox_provider.py:139-142` "Pool mode does not support volumes"）；但 Pool CR 的 Schemaless template 可直接写卷绕开
- **无现成先例**：仓库内无"解释器/依赖放共享存储"的设计，属新方案；OSEP-0007（fast-sandbox fleets）明确拒绝 volumes，故本方案应落在 `kubernetes`/`docker` 后端

---

## 3. 方案设计

### 3.1 总体架构

```
                    ┌─────────────────────────────┐
                    │  共享存储 (NAS / PVC RWX)    │
                    │  /interpreters/python/{3.10..3.14}   │
                    │  /interpreters/node/{18,20,22}       │
                    │  /interpreters/go/{1.23,1.24,1.25}   │
                    │  /interpreters/jvm/{8,11,17,21}      │
                    │  /interpreters/kernels（可选）        │
                    └──────────────┬──────────────┘
                                   │ PVC（server 自动创建或 BYO）
                    ┌──────────────▼──────────────┐
                    │  最小镜像 code-interpreter-mini │
                    │  ubuntu + execd + jupyter +     │
                    │  code-interpreter.sh（PATH→卷）  │
                    │  主容器 volumeMounts:            │
                    │    /opt/python/versions → 卷    │
                    │    /opt/node → 卷              │
                    │    /opt/go → 卷                │
                    │    /usr/lib/jvm → 卷           │
                    └─────────────────────────────┘
```

### 3.2 关键设计决策

| 决策点 | 方案 | 理由 |
|---|---|---|
| 卷类型 | PVC(RWX NAS) 为主，host 卷用于单机部署 | 多节点共享；server 已支持自动建 PVC |
| 挂载只读性 | 解释器卷 **readOnly** 挂载 | 防沙箱内被篡改污染所有租户；版本升级 = 重建卷内容 |
| 版本切换 | 保留镜像内 `code-interpreter-env.sh`，仅把版本目录路径指向卷 | 复用现有机制，改动最小 |
| kernel 包 | 优先随解释器上卷（`/opt/.../site-packages` 已在卷路径内） | Jupyter kernel 由解释器版本自举 |
| 预载/缓存 | 可选：节点 DaemonSet 预热到本地卷，或依赖 NAS 读缓存 | 权衡 NAS 带宽 vs 节点本地磁盘 |

### 3.3 实施步骤（建议顺序）

1. **构建解释器卷内容**：一次性脚本在构建机上用与 `Dockerfile_base` 相同命令（uv/node 官方包/go 官方包）产出目录树，上传到共享存储的独立卷；版本清单作为配置项
2. **瘦身镜像**：新建 `sandboxes/code-interpreter/Dockerfile.mini`，去掉 L62-117 的运行时安装，保留 base 工具 + execd + 启动脚本；`code-interpreter-env.sh` 版本路径改为 `$INTERPRETER_ROOT/{python,node,go,jvm}`
3. **模板挂卷**：
   - server 模板模式：`create_workload` 组装 template 时注入解释器 PVC 卷（仿照 `volume_helper.apply_volumes_to_pod_spec`，或直接复用 `volumes[]` 的 pvc backend + 固定 mountPath）
   - Pool 模式：Pool CR 的 Schemaless template 直接写卷（如 `config/samples/sandbox_v1alpha1_pool.yaml` 的 emptyDir 样例）
4. **验证**：三语言 kernel 注册/执行、版本切换、并发创建 N 个 sandbox 的启动耗时对比
5. **文档 + 示例**：`docs/examples/` 新增共享存储解释器示例；OSEP 补充或新 OSEP

---

## 4. 可行性评估：关键风险与权衡

### 4.1 收益量化（估算，需实测）

| 项 | 全量镜像 | 瘦身镜像 + 共享卷 |
|---|---|---|
| 镜像体积 | GB 级（估 2~5GB） | 200~500MB |
| 新节点首拉 | 数十秒~分钟级（本地 registry ~100MB/s 计） | 数秒~10s |
| 多版本成本 | 每版本重建/拉大镜像 | 卷内加目录，零镜像成本 |
| 版本切换 | 改镜像 tag + 重建 | 改 PATH/环境变量，秒级生效 |

**重要前提**：收益最大场景是**镜像未预热 + 大批量新节点**。若节点已缓存基础镜像（池化预热），全量镜像拉取接近 0，共享卷反而多一次网络读解释器（NAS 延迟 1~5ms、带宽受限时读 1GB 解释器可能 ~10s）——**共享卷方案不是无条件更快**，需与"镜像预热 + 节点本地缓存"对比实测。

### 4.2 与 pause/resume 快照的交互（结合"重建优于快照"结论）

- `image-committer` 容器级 commit **不含卷挂载内容**（镜像层不含卷数据）——这是天然利好：快照镜像不会因卷内解释器而膨胀
- 但 resume 后卷挂载自动恢复（PVC 重挂），**快照与共享解释器可以正交共存**：rootfs 状态存镜像，解释器始终来自卷
- 结合此前结论（无状态场景下**新建 Pod 优于快照恢复**）：共享解释器卷进一步放大了"重建"优势——重建时镜像小、卷秒挂，无需快照链路（commit Job 10min 超时、registry push/pull 全省）
- **推荐产品形态**：无状态/任务型 sandbox 默认快速重建（小镜像 + 共享卷），需要保留状态的才走 pause/resume 快照

### 4.3 风险清单

| 风险 | 等级 | 说明与缓解 |
|---|---|---|
| NAS 读带宽/IOPS 成为瓶颈 | **高** | 数百 sandbox 并发启动同时读卷；缓解：节点本地缓存层（DaemonSet 预载）、NAS 只读副本、分层（热版本留节点） |
| 共享内容被污染（安全） | 中 | readOnly 挂载 + 卷内容签名/校验 + 与沙箱写路径隔离 |
| 版本升级的原子性 | 中 | 换版本 = 换卷或换目录（不可变 tag 目录），避免半更新状态 |
| `code-interpreter-env.sh` 依赖卷就绪 | 低 | PVC 先于容器启动挂载，天然满足；需处理卷空/缺失的降级提示 |
| kernel 自举路径不一致 | 中 | ipykernel/tslab/gonb 的 kernel.json 中 python/node 路径需指向卷内绝对路径（构建时生成） |
| Pool 模式 API 不支持 volumes | 低 | Pool CR Schemaless template 直写卷（已有样例）；或先落地模板模式 |
| 安全容器运行时 | 低 | `docs/guides/secure-container.md` 兼容矩阵显示 Volume 在 runc/gVisor/Kata 下均 Yes；Kata 下卷为 VM 内普通文件系统访问，无特殊限制 |
| 与 OSEP-0007 fast-sandbox 方向冲突 | 低 | fast-sandbox 明确不支持 volumes，方案只落在 kubernetes/docker 后端，不冲突 |

### 4.4 与现有缺陷文档的联动

- 控制器性能缺陷（3s 轮询、事件放大、注解 churn）与共享卷方案**无关但叠加**：共享卷解决"镜像拉取慢"，控制器 3s 轮询解决"调谐吞吐"——两者是启动链路的两个独立瓶颈，应分开治理
- 池化模式下共享卷可缓解 P2-3（池化 listPods 逐 Pod Get）的**镜像侧**成本，但 Pod 数量与注解 churn 问题依旧

---

## 5. 结论与建议

1. **方案可行**：三层卷能力已就绪，挂载点明确，改动集中在镜像瘦身 + 路径脚本 + 模板挂卷三处，预计可落地
2. **不是无条件最优**：需与"镜像预热 + 节点本地缓存"做基准对比；建议先做 5~10 个并发创建的实测（当前仓库无任何镜像大小/启动时间数据，见 `docs/kubernetes/index.md` 仅有 100 sandbox 池化交付 0.92s vs Agent-Sandbox 23~76s 的对比）
3. **推荐产品形态**：无状态任务走"小镜像 + 共享解释器卷 + 快速重建"，快照仅用于需保留状态的场景
4. **下一步**：若立项，建议以 OSEP 形式补充（或扩展 OSEP-0003），先做 POC：瘦身镜像 + 单节点 host 卷验证解释器可运行，再上 PVC/NAS

---

## 6. 附：关键证据索引

| 主题 | 位置 |
|---|---|
| 镜像运行时安装（剥离对象） | `sandboxes/code-interpreter/Dockerfile_base:62-117`（uv python/node/go/JDK） |
| kernel 注册与 Jupyter 启动 | `sandboxes/code-interpreter/scripts/code-interpreter.sh`（:44771） |
| 版本切换脚本 | `scripts/code-interpreter-env.sh` → `/opt/code-interpreter/code-interpreter-env.sh` |
| Schemaless template | `apis/sandbox/v1alpha1/batchsandbox_types.go:106-110`、`pool_types.go:54-57` |
| 池化模板卷样例 | `kubernetes/config/samples/sandbox_v1alpha1_pool.yaml`（emptyDir + initContainers） |
| server 卷注入 | `server/opensandbox_server/services/k8s/volume_helper.py:57-139`、`batchsandbox_provider.py:112-310,408-460` |
| Pool 模式拒 volumes | `server/opensandbox_server/services/k8s/batchsandbox_provider.py:139-142` |
| image-committer（容器级 commit 不含卷） | `kubernetes/cmd/image-committer/main.go:120-300` |
| 执行链（execd/Jupyter/task-executor） | `components/execd/pkg/web/controller/codeinterpreting.go:39-42`、`kubernetes/internal/task-executor/runtime/process.go:66-127` |
| 安全容器卷兼容 | `docs/guides/secure-container.md`（Volume: runc/gVisor/Kata 均 Yes） |
| OSEP-0003 / 0007 / 0008 | `oseps/0003-volume-and-volumebinding-support.md`、`0007-fast-sandbox-runtime-support.md`、`0008-pause-resume-rootfs-snapshot.md` |
