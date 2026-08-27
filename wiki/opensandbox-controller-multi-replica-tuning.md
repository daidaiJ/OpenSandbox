# 沙箱控制器多副本部署支持与调优参数调研

> 调研日期：2026-08-27
> 范围：`kubernetes/` 下的 opensandbox-controller（BatchSandbox / Pool / SandboxSnapshot 三个 controller 的 operator）
> 结论：**支持多副本部署（leader election 模式），生产建议 2~3 副本 + podAntiAffinity；调优核心参数是 `--concurrency` 与 `--kube-client-qps/burst`**

## 1. 多副本部署：支持

### 1.1 实现机制（controller-runtime leader election）

`kubernetes/cmd/controller/main.go`：

- `--leader-elect` flag（默认 false），Helm chart 默认开启（`controller.leaderElection.enabled: true`）
- `LeaderElectionID: "2fa1c467.opensandbox.io"` —— 使用 `coordination.k8s.io` Lease 资源
- `LeaderElectionReleaseOnCancel: true` —— leader 优雅退出时主动释放 lease，故障转移无需等满 LeaseDuration
- lease 时长未自定义，用 controller-runtime 默认值（LeaseDuration 15s / RenewDeadline 10s / RetryPeriod 2s）

RBAC 已就绪（`charts/opensandbox-controller/templates/clusterrole.yaml` 的 leader-election Role）：configmaps + leases 的 get/list/watch/create/update/patch/delete，events 的 create/patch。

### 1.2 多副本时的行为

| 组件 | leader 副本 | 非 leader 副本 |
|---|---|---|
| BatchSandbox / Pool / SandboxSnapshot reconciler | ✅ 运行 | ❌ 不启动 |
| in-process TaskScheduler、DefaultAllocator、ProfileStore watch | ✅ 运行 | ❌ 不启动 |
| health probe（:8081） | ✅ | ✅ |
| metrics（启用时） | ✅ | ✅（每个副本都暴露，抓取会重复） |
| webhook server | 创建但**未注册任何 webhook**（无 `SetupWebhookWithManager` 调用） | 同左，无冲突 |

多副本安全性的关键前提：

- 所有状态（CRD status、annotations、finalizers）都在 K8s API 上，reconciler 幂等，无进程内共享状态
- 无 webhook，不存在多副本证书/注册冲突
- 非 leader 副本只占少量资源（cache 仍会 watch 全部资源，内存与 leader 相当）

### 1.3 部署方式

Helm（`charts/opensandbox-controller`）：

```yaml
controller:
  replicaCount: 3          # 默认 1
  leaderElection:
    enabled: true          # 默认 true，多副本必须保持开启
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: control-plane
            operator: In
            values: [controller-manager]
        topologyKey: kubernetes.io/hostname
```

- 官方文档示例（`docs/kubernetes/index.md`、`kubernetes/docs/HELM-DEPLOYMENT.md` values-prod.yaml）即 `replicaCount: 3` + podAntiAffinity
- Kustomize 路径（`config/manager/manager.yaml`）默认 `replicas: 1` + `--leader-elect`，改 replicas 即可

### 1.4 注意事项

- **多副本 ≠ 水平扩展**：非 leader 副本不干活，多副本只提供 HA（故障转移），不提升吞吐。吞吐靠 `--concurrency` 单副本内并发
- 若启用 metrics，Prometheus 会抓到每个副本的指标，需按 pod 维度区分或只抓 leader
- `--watch-namespace` 与多副本可叠加（所有副本 watch 同一 namespace）

## 2. 调优参数清单

### 2.1 核心：控制器并发度（吞吐）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--concurrency='batchsandbox=32;pool=128'` | batchsandbox=32, pool=16 | 按 controller 名设置 `MaxConcurrentReconciles`（`main.go` 常量 `defaultBatchSandboxConcurrency=32` / `defaultPoolConcurrency=16`） |

- 格式：`controller1=N;controller2=M`，可用名：`batchsandbox`、`pool`
- SandboxSnapshot controller **无并发参数**（固定 1）
- 调大并发时注意：每个并发 reconcile 都会打 K8s API，需同步调大 `--kube-client-qps/burst`，否则被 client 限流
- 参考：`kubernetes/DEVELOPMENT.md` 调试示例 `--concurrency='batchsandbox=1;pool=1'`

### 2.2 K8s client 限流

| 参数 | 默认 | Helm 路径 |
|---|---|---|
| `--kube-client-qps` | 100 | `controller.kubeClient.qps` |
| `--kube-client-burst` | 200 | `controller.kubeClient.burst` |

- 设置到 `rest.Config.QPS/Burst`，作用于所有 API 调用（list/watch/update/status 更新）
- 大规模集群（数百~数千 BatchSandbox）建议按并发度比例上调

### 2.3 作用域裁剪

| 参数 | 默认 | 说明 |
|---|---|---|
| `--watch-namespace` | 空（全 namespace） | 限制 cache watch/reconcile 到单 namespace，显著降低内存与事件量；Helm `controller.watchNamespace` |

### 2.4 日志

| 参数 | 默认 | 说明 |
|---|---|---|
| `--zap-log-level` | info | debug/info/error |
| `--enable-file-log` | false | 落盘日志 |
| `--log-file-path` | /var/log/sandbox-controller/controller.log | |
| `--log-max-size` | 100 | MB，轮转阈值 |
| `--log-max-backups` | 10 | 保留旧文件数 |
| `--log-max-age` | 30 | 保留天数 |
| `--log-compress` | true | gzip 压缩轮转文件 |

### 2.5 Metrics

| 参数 | 默认 | 说明 |
|---|---|---|
| `--metrics-bind-address` | 0（禁用） | `:8080` HTTP 或 `:8443` HTTPS；Helm `controller.metrics.enabled` |
| `--metrics-secure` | true | HTTPS + authn/authz（TokenReview/SubjectAccessReview，需 metrics-auth ClusterRole） |
| `--metrics-cert-path/name/key` | 空 | 证书目录/文件名；不配则自签 |

### 2.6 Snapshot（pause/resume）相关

| 参数 | 默认 | 说明 |
|---|---|---|
| `--image-committer-image` | image-committer:dev | commit Job 镜像（Helm 默认 v0.1.1） |
| `--image-committer-pod-template-file` | 空 | commit Job Pod 覆盖模板 |
| `--containerd-socket-path` | /var/run/containerd/containerd.sock | 宿主机 containerd socket |
| `--commit-job-timeout` | 10m | commit Job 超时 |
| `--snapshot-registry` | 空 | 快照镜像 OCI registry 前缀 |
| `--snapshot-registry-insecure` | false | 非 TLS registry |
| `--snapshot-push-secret` / `--image-committer-pull-secret` / `--resume-pull-secret` | 空 | 推送/拉取 Secret |

### 2.7 资源与调度（Helm）

- `controller.resources`：默认 limits 500m/128Mi、requests 10m/64Mi；多副本 + 大并发建议上调（文档示例 1000m/512Mi）
- `controller.nodeSelector` / `tolerations` / `affinity` / `priorityClassName` / `podAnnotations` / `podLabels`
- 探针：`livenessProbe`（/healthz）、`readinessProbe`（/readyz），默认开启

### 2.8 未暴露的调优点

- workqueue 重试退避：用 controller-runtime 默认指数退避，**无参数可调**
- lease 时长（15s/10s/2s）：**无参数可调**，故障转移最坏 ~15s
- SandboxSnapshot 并发：固定 1

## 3. 结论与建议

1. **多副本**：Helm `controller.replicaCount=2~3` + `leaderElection.enabled=true`（默认）+ podAntiAffinity 跨节点，即可获得 HA；故障转移最坏 15s
2. **吞吐调优**：先调 `--concurrency`（batchsandbox 从 32 起，pool 从 16 起），再按比例调 `--kube-client-qps/burst`；单副本即可吃满，多副本不增加吞吐
3. **大规模部署**：配合 `--watch-namespace` 裁剪 cache；监控 metrics 判断是否触达并发上限
4. 多副本下 metrics 会重复暴露，抓取端需按 pod 区分

## 参考

- `kubernetes/cmd/controller/main.go`（flags、leader election、concurrency 解析）
- `kubernetes/charts/opensandbox-controller/values.yaml` + `templates/deployment.yaml`
- `kubernetes/config/manager/manager.yaml`（Kustomize 默认）
- `kubernetes/DEVELOPMENT.md`（flags 表）
- `docs/kubernetes/index.md`、`kubernetes/docs/HELM-DEPLOYMENT.md`（多副本部署示例）