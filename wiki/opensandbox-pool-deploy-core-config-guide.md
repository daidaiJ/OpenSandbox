# K8s 池模式三大部署核心配置：controller / server / Pool CR

> 日期：2026-09-03
> 依据：`kubernetes/charts/opensandbox-controller/values.yaml` + `templates/deployment.yaml`、`server/opensandbox_server/config.py`（KubernetesRuntimeConfig）、`server/opensandbox_server/examples/example.config.toml`、`kubernetes/apis/sandbox/v1alpha1/pool_types.go`。
> 定位：**只讲部署期必须拍板的核心配置**；调优细节与全量参数见关联文档（文末）。业务前提：无 pause/resume、租户管控在业务层、池化为主路径。

---

## 0. 部署拓扑一图

```
┌─ 集群级 ──────────────────────────────────────────────────────┐
│ controller（helm: opensandbox-controller @ opensandbox-system）│
│   ← 管理 Pool/BatchSandbox CR，3s 轮询 task-executor           │
├─ 业务接入 ────────────────────────────────────────────────────┤
│ server（无状态进程，config.toml + 外部 store）                  │
│   ← 业务层（认证/配额/审计）→ POST /sandboxes (poolRef)        │
├─ 工作负载 namespace（如 opensandbox）──────────────────────────┤
│ Pool CR（模板 + 容量） → 预热 Pod 池                            │
│ BatchSandbox CR（认领池 Pod）→ 沙箱 Pod（边车装配见组件文档）    │
└──────────────────────────────────────────────────────────────┘
```

---

## 1. controller（helm chart `opensandbox-controller`）

### 1.1 核心配置（values.yaml → 启动 flag）

| values | 默认 | flag / 说明 |
|---|---|---|
| `controller.image.tag` | chart appVersion | **版本红线：≥ PR #420** 才支持 taskTemplate lifecycle 字段（≤ v0.2.0 静默抹字段，实测结论）。内网部署常用 `--set controller.image.tag=latest` |
| `controller.replicaCount` | 1 | >1 时依赖 leader election（`leaderElection.enabled=true` 默认已开）——多副本 HA 与并发调参见[多副本调优文档](opensandbox-controller-multi-replica-tuning.md) |
| `controller.kubeClient.qps / burst` | 100 / 200 | `--kube-client-qps / --kube-client-burst`——controller→apiserver 限速；池规模大、轮询频繁时按调优文档放大 |
| `controller.resources` | limits 500m/128Mi，requests 10m/64Mi | 起点值偏小，规模化场景按实测调 |
| `controller.logLevel` | info | `--zap-log-level` |
| `controller.metrics.*` | disabled | `--metrics-bind-address`（默认 0=关闭）；接 Prometheus 时 `enabled=true`，`secure=false` 便于裸抓取 |
| `controller.leaderElection.enabled` | true | 多副本必开 |
| liveness/readiness | `:8081 /healthz /readyz` | 默认即可 |
| `crds.install / keep` | true / true | CRD 随 chart 装；uninstall 保留 CRD |
| `rbac.create` | true | controller 需要的集群权限由 chart 内置 |
| `controller.snapshot.*` | — | **pause/resume 快照专用**（image-committer 等）；业务不做暂停恢复，整段忽略 |
| `extraEnv / extraVolumes / nodeSelector / tolerations` | 空 | controller 打到管理节点等常规调度约束 |

### 1.2 部署命令（内网基线）

```bash
helm upgrade --install opensandbox-controller <chart-dir> \
  --namespace opensandbox-system --create-namespace \
  --set controller.image.tag=latest \
  --set controller.kubeClient.qps=200 --set controller.kubeClient.burst=400
```

---

## 2. server（无状态生命周期服务）

配置文件默认 `~/.sandbox.toml`（`OPENSANDBOX_CONFIG` 可覆盖）。示例文件 `server/opensandbox_server/examples/example.config.toml` 是 **Docker 运行时**样例——K8s 池化部署要改的核心节如下：

### 2.1 核心配置节

| 配置节 | 核心键 | 池化部署要点 |
|---|---|---|
| `[server]` | `host` / `port` / `api_key` / `max_sandbox_timeout_seconds` | 内网集群部署 `host` 监听 0.0.0.0 或 LB 地址；**生产必须设 `api_key`**（空 key 启动需显式确认，防裸奔） |
| `[runtime]` | `type = "kubernetes"`、`execd_image` | 池化必改；`execd_image` 版本红线 ≥ v1.1.0（OSEP-0020 hooks） |
| `[kubernetes]` | 见 2.2 | 池化核心节 |
| `[store]` | `type = "postgresql"` + DSN | server 无状态（D-2 决策）：元数据落外部 PostgreSQL，**一个库只允许一个 server 进程写**；多副本 server 需在上游分片或按 ns 拆实例 |
| `[ingress]` | `mode` | 集群有 ingress 网关组件时按部署选；纯 server proxy 流量模式（业务现状）不影响池化 |
| `[egress]` | `image` / `mode` / `readiness_timeout_seconds` | **池化默认不用 sidecar**（D-7：netpol 承担隔离），保留默认即可；敏感沙箱方案见 [egress SOP](opensandbox-egress-netpol-vault-sop.md) |
| `[renew_intent]` | `enabled`（默认 false） | OSEP-0009 自动续约服务端开关；业务依赖"访问即续约"时必须 `enabled=true` |
| `[storage]` | `volume_default_size` / `allowed_host_paths` | 只影响**直接创建**路径（池化卷在 Pool 模板，见卷类型文档） |
| `[log]` | `level` | — |

### 2.2 `[kubernetes]` 节核心键（`config.py: KubernetesRuntimeConfig`）

| 键 | 默认 | 说明 |
|---|---|---|
| `workload_provider` | 首个注册 provider | 池化用 `batchsandbox`（`agent-sandbox` 为另一 provider 形态） |
| `namespace` | null（默认 ns） | 沙箱工作负载 namespace（如 `opensandbox`） |
| `kubeconfig_path` | in-cluster | 集群内跑 server 留空 |
| `informer_enabled` / `informer_resync_seconds` / `informer_watch_timeout_seconds` | true / 300 / 60 | 读缓存的 API 降压开关（Beta）；高 QPS 查询场景保持开启 |
| `read_qps` / `read_burst` / `write_qps` / `write_burst` | 0（不限） | server→apiserver 限速；池规模大时建议设置上限保护 apiserver |
| `sandbox_create_timeout_seconds` | 60 | 等 Pod 拿到 IP 的超时 |
| `pool_acquisition_timeout_seconds` | 30 | **从池认领 Pod 的超时**——池容量不足时 create 在这里等；与 bufferMin/bufferMax 调参联动 |
| `execd_init_resources` | null | execd-installer init 容器资源（直接创建路径） |
| `execd_run_as_init` | false | **建议 true**：task 命令 `exec bootstrap.sh`，execd 成为 PID1（SIGTERM 送达、未来 preTerminate 可用） |
| `batchsandbox_template_file` | null | 非池化直建 BatchSandbox 的基础模板（池化路径不用） |

### 2.3 业务约束对照

- **租户管控在业务层**：server `[tenants]` 特性不启用；业务层做 user→部门→namespace 映射、配额与审计（D-3/D-4 决策）。
- **不做 pause/resume**：不配置快照相关能力；业务面也不暴露（D-x 决策）。

---

## 3. Pool CR（预热池）

### 3.1 spec 核心字段（`pool_types.go`）

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: Pool
metadata:
  name: my-pool
  namespace: opensandbox            # 工作负载 ns
spec:
  capacitySpec:                     # 必填，四参数（详见容量参数文档）
    bufferMin: 5      # 温缓冲下限
    bufferMax: 20     # 温缓冲上限（稳态目标 ≈ (min+max)/2）
    poolMin: 5        # 池总规模下限
    poolMax: 200      # 硬上限（防峰值失控）
  scaleStrategy:
    maxUnavailable: 25%   # 扩缩步长（绝对数或百分比）
  updateStrategy:
    maxUnavailable: 25%   # 模板变更滚动步长
  recycleStrategy:
    type: Delete          # 默认 Delete；Restart 有卷残留坑；Noop 任务场景禁用
  template:               # 必填，Schemaless PodTemplateSpec（PreserveUnknownFields）
    spec:
      # 边车装配（initContainer×2 装 task-executor/execd、主容器 PID1、NET_ADMIN 约束）
      # 完整骨架见《池模式沙箱 Pod 边车组件介绍与实践指导》§3.1
      ...
```

要点：
- **template 是原生 Pod spec，不做二次校验**——池化 create 请求的 `volumes`/`networkPolicy` 会被 server 拒绝，一切差异化都在模板里固化；per-allocation 差异只走 taskTemplate env；
- Restart 策略可加 Pool 注解 `sandbox.opensandbox.io/restart-config`（blacklist / retryInterval / maxRetries / restartCommand）；
- **改模板**：直接 kubectl apply 更新 Pool CR 触发滚动（只重建 idle Pod）；server 的 `PUT /pools/{name}` 只收 capacitySpec。

### 3.2 status 观测（排障第一入口）

| 字段 | 含义 | 排障用法 |
|---|---|---|
| `total` / `allocated` / `available` | 池总数 / 已分配 / 可用 | create 报 POOL_CAPACITY_EXHAUSTED 时先看 available |
| `updated` / `revision` | 已滚到最新 revision 的 Pod 数 / 当前版本 | 模板滚动是否卡住的判据 |
| `observedGeneration` | controller 已观察的代数 | CR 改了但没被 reconcile 时比对 |

---

## 4. 从零到可用：最小配置 checklist

1. **controller**：helm 装（image tag ≥ #420 版本线；kubeClient qps 按规模调）；
2. **存储**：外部 PostgreSQL 起库；netpol（NetworkPolicy）基线先行（同 ns 沙箱互隔 + 放行管理面→5758）；
3. **server**：`runtime.type="kubernetes"`、`[kubernetes] workload_provider="batchsandbox"`、`namespace`、`store.type="postgresql"`、`renew_intent.enabled=true`（若业务要自动续约）、`api_key` 设置；
4. **Pool CR**：模板含边车装配 + `EXECD_INIT=1`（execd-as-init）+ NAS 只读卷（如有）；capacitySpec 四参数；`recycleStrategy: Delete`；
5. **业务面**：`POST /sandboxes` 带 `extensions.poolRef` + taskTemplate 触发条件（env/entrypoint 任一）；
6. **验证**：`GET /pools/{name}` 看 available>0；create 后 `GET /sandboxes/{id}` 等 `state=Running`（见[管理 API 文档 §2.3.1](opensandbox-sandbox-management-api-reference.md)）。

---

## 5. 关联文档

- [池模式沙箱 Pod 边车组件介绍与实践指导](opensandbox-pool-sandbox-sidecar-components-guide.md) —— Pool 模板内组件装配
- [K8s 池模式卷类型、配置限制与副作用实践](opensandbox-pool-mode-volumes-and-storage-practice.md) —— 模板卷选型
- [沙箱控制器多副本部署与调优参数调研](opensandbox-controller-multi-replica-tuning.md) —— HA/并发细化
- [Pool 容量四参数调研](opensandbox-pool-capacity-params.md) / [池模式扩缩容机理与运维](opensandbox-pool-scaling-mechanism-ops.md) —— capacitySpec 调参
- [沙箱配置参数与环境变量参考（全链路）](opensandbox-sandbox-config-and-env-reference.md) —— server→Pod env 全链路
- [沙箱管理高阶 API 与参数参考](opensandbox-sandbox-management-api-reference.md) —— server API 面
- [Egress 出口管控与 Credential Vault SOP](opensandbox-egress-netpol-vault-sop.md) —— 网络隔离分层
