# KEDA 部署验证报告：Redis 队列驱动 OpenSandbox Server 扩缩容（k3s 实测）

> 日期：2026-09-13
> 验证环境：内网测试机 Ubuntu 10.254.254.105（k3s v1.30.5 单节点 16C/62G，OpenSandbox 池模式已部署）
> 适用读者：**集群管理员 / 平台工程师**（安装与验收）；业务开发者请看姊妹篇《[KEDA 服务接入 SOP](opensandbox-keda-integration-sop.md)》
> 结论：**可行且已闭环验证**——Redis 队列长度驱动 opensandbox-server 1↔3 副本扩缩，对 server 零侵入（不改代码、不改镜像）。

姊妹篇分工：

| 文档 | 读者 | 内容 |
|---|---|---|
| 本文（部署验证） | 管理员/平台 | 版本红线、镜像 digest、CRD/权限清单、安装、验收、测试→生产迁移 |
| [接入 SOP](opensandbox-keda-integration-sop.md) | 业务开发 | 任意服务接入五步法、ScaledObject 模板、验证与运维 |

## 1. 架构与验证结论

```
业务方(生产)/脚本(测试) --LPUSH--> Redis 队列（keda ns 共享）
                                     │ list 长度（默认 30s 轮询一次）
                                     ▼
                          KEDA ScaledObject（业务自己的 ns）
                                     │ 自动创建并托管 HPA → external.metrics.k8s.io
                                     ▼
                          目标 Deployment（验证对象：opensandbox-server，1↔3 副本）
```

**实测回归结果**：

| 步骤 | 操作 | 结果 | 耗时 |
|---|---|---|---|
| Ready | apply ScaledObject | `READY=True`，自动生成 HPA `keda-hpa-server-queue-scaler` | ~25s |
| 扩容 | `LPUSH task-queue` × 40 | 1 → **3/3 副本**（HPA 读数 13.3/5，maxReplicaCount=3 封顶），新副本全部健康 | ~30s |
| 缩容 | `DEL task-queue` | 3 → **1/1 副本** | ~6min（cooldown 60s + HPA 缩容稳定窗口 300s） |
| helm 化后 smoke | ScaledObject 指向 helm 管理的 redis，LPUSH × 1 | HPA 读数 1/5，trigger 正常 | ~40s |

**边界说明**：KEDA 驱动的是**无状态 Deployment/StatefulSet/ScaledJob**；池 pod 的扩缩不归 KEDA 管（Pool CRD 无 `/scale` 子资源，`kubernetes/apis/sandbox/v1alpha1/pool_types.go` 已确认），池子由 Pool 控制器按 capacitySpec 滞回算法自治。

## 2. 版本兼容红线（选错版本直接不可用）

| KEDA 版本 | HPA API | 支持 K8s | 用途 |
|---|---|---|---|
| 2.8.x（含 2.8.2） | `autoscaling/v2beta2` | **1.18 ~ 1.25** | **生产集群（K8s 1.18）用这个** |
| ≥ 2.9 | `autoscaling/v2` | 1.23+ | 新集群用（v2beta2 已在 K8s 1.26 移除） |

- **没有同时兼容 1.18 和 1.30 的 KEDA 版本**（两个 API 世代间无 fallback 逻辑）。
- 实测踩坑：k3s 1.30 上装 2.8.2，operator 报致命错误 `no matches for kind "HorizontalPodAutoscaler" in version "autoscaling/v2beta2"`，ScaledObject 永远不 Ready、HPA 不生成。
- Helm chart 与 app 版本映射（chart 版本 ≠ app 版本）：`chart 2.8.4 → app 2.8.2`（注意 chart 2.8.2 对应 app 2.8.1）；`chart 2.10.2 → app 2.10.1`。
- **ScaledObject YAML 两版本通用**（apiVersion 均为 `keda.sh/v1alpha1`，Redis scaler 代码路径一致），测试机验证结论可平移到生产 2.8.2。

## 3. 精准镜像号（digest 固定，离线同步用）

| 镜像 | sha256（index/repoDigest） | 环境 |
|---|---|---|
| `ghcr.io/kedacore/keda:2.8.2` | `sha256:5a719383be91157f14919b35c39aa893fd6fc3a2f4f5d44e8b58b7bd5df52e5e` | 生产 1.18 |
| `ghcr.io/kedacore/keda-metrics-apiserver:2.8.2` | `sha256:d4df0965633ffef08aa4a82164b998d30ce0878a21a65168a125e74391312102` | 生产 1.18 |
| `ghcr.io/kedacore/keda:2.10.1` | `sha256:1489b706aa959a07765510edb579af34fa72636a26cfb755544c0ef776f3addf` | 本测试机（实测运行） |
| `ghcr.io/kedacore/keda-metrics-apiserver:2.10.1` | `sha256:d1f1ccc8d14e33ee448ec0c820f65b8a3e01b2dad23d9fa38fa7204a6c0194ca` | 本测试机（实测运行） |
| `docker.io/library/redis:alpine` | `sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576` | 队列（39MB，实测 7.x） |

- 测试机网络实测：`ghcr.io` 直连可拉；`registry-1.docker.io` 不通，但 k3s 已配 daocloud/1panel 加速可拉 redis。
- 2.8.2 的 digest 来自 ghcr.io registry 匿名 token 查询（多架构 index digest）；落地内网 registry 时以同步工具输出的 digest 为准二次核对。
- 不装 admission webhooks（`--set webhooks.enabled=false`），少一个 pod 且免 `validatingwebhookconfigurations` 权限。
- 生产 Redis 建议钉 `redis:6.2-alpine`（2.8.2 官方支持 ≤6.x，Redis 7 支持是 2.10 才声明的）。

## 4. 权限分层与安装（管理员 / 业务开发各自做什么）⭐

### 4.1 需要集群管理员的一次性操作（集群级资源，业务开发申请单）

KEDA 安装涉及以下**集群级**资源，业务开发无权创建，需向 PaaS 管理员提交标准申请单（直接引用第 3、5 节的镜像号与 CRD 清单）：

| 资源 | 数量 | 明细 |
|---|---|---|
| `Namespace` | 1 | `keda` |
| `CustomResourceDefinition` | 4 | 见第 5 节 CRD 清单 |
| `ClusterRole` / `ClusterRoleBinding` | 3 组 | `keda-operator`（含 `*/scale` 通配、configmaps/pods/secrets/services/jobs/leases 等）、`keda-operator-external-metrics-reader`（`external.metrics.k8s.io` 全权限，绑给 `system:hpa-controller`）、`system:auth-delegator`（metrics-apiserver 认证委托） |
| `APIService` | 2 | `v1beta1.external.metrics.k8s.io`、`v1alpha1.keda.sh` |
| keda ns 内 | — | `ServiceAccount`×1、`Deployment`×2、`Service`×1 |

**给管理员的安装命令**（管理员执行一次即可，全公司业务复用）：

```bash
helm repo add kedacore https://kedacore.github.io/charts
# K8s 1.18 生产集群：--version 2.8.4（= app 2.8.2）；本测试机 k3s 1.30 用 2.10.2（= app 2.10.1）
helm install keda kedacore/keda --version <按集群版本选> -n keda --create-namespace \
  --set webhooks.enabled=false \
  --set operator.resources.requests.cpu=50m \
  --set operator.resources.requests.memory=100Mi \
  --set metricsApiServer.resources.requests.cpu=50m \
  --set metricsApiServer.resources.requests.memory=100Mi \
  --set image.keda.repository=<内网registry>/kedacore/keda \
  --set image.metricsApiServer.repository=<内网registry>/kedacore/keda-metrics-apiserver
```

> 若内网可直连 ghcr.io（测试机实测可直连），内网 registry 覆盖可省略；镜像 values 键名以 `helm show values kedacore/keda --version <chart版本>` 输出为准核对。

### 4.2 业务开发可自助完成的部分（namespace 级）

管理员装好 KEDA 后，业务开发在自己 namespace 内即可接入，**不需要管理员参与**：

| 需要 | 动作 |
|---|---|
| 创建 `ScaledObject` / `TriggerAuthentication` | 对自己 namespace 的 `keda.sh` CRD 有 create/get 权限（CRD 是集群级、实例是 namespace 级） |
| 目标 workload | 对自己 namespace 的 Deployment 有读权限即可（KEDA operator 用自己的 ClusterRole 去改 scale） |
| 事件源 | Redis/HTTP/Prometheus 等可达即可；也可复用 keda ns 的共享队列（业务开发账号实测可直接 exec 测试机的 redis） |

### 4.3 业务开发侧的最小权限核对单

- ✅ 自己 ns：`scaledobjects.keda.sh`、`triggerauthentications.keda.sh` 的 CRUD
- ✅ 自己 ns：目标 Deployment 的 get/watch（KEDA 只读 spec，写 scale 走 operator 自身权限）
- ✅ 事件源凭据：用 `TriggerAuthentication`（secretRef）注入 Redis 密码，不用明文 metadata
- ❌ 不需要：CRD、ClusterRole、APIService、kube-system 任何权限

## 5. CRD / APIService 资源清单（管理员验收核对用）

`group: keda.sh`，存储版本均为 `v1alpha1`（实测 dump）：

| CRD | 用途（业务开发用到哪个） |
|---|---|
| `scaledobjects.keda.sh` | **核心**：挂 workload + trigger（业务开发主要写这个） |
| `triggerauthentications.keda.sh` | 事件源凭据（secretRef） |
| `scaledjobs.keda.sh` | 按事件创建 Job（批处理场景，本次未用） |
| `clustertriggerauthentications.keda.sh` | 集群级共享凭据（管理员管） |

| APIService | 说明 |
|---|---|
| `v1beta1.external.metrics.k8s.io` | HPA 读外部指标的聚合 API，后端 = keda-operator-metrics-apiserver；装完验收 `kubectl get apiservice | grep -E "keda|external"` 应为 `True` |
| `v1alpha1.keda.sh` | KEDA API 聚合 |

**安装后验收三查**：

```bash
kubectl get crd | grep keda.sh                                      # 应有 4 条
kubectl get apiservice | grep -E "keda|external"                    # v1beta1.external.metrics.k8s.io = True
kubectl logs -n keda deploy/keda-operator --tail=50 | grep -i error # 无 "no matches for kind HorizontalPodAutoscaler"
```

## 6. 测试环境 vs 生产环境：版本差异对照与迁移指南

> 测试基线：k3s v1.30.5 + KEDA 2.10.1（chart 2.10.2）；生产目标：K8s 1.18 + KEDA 2.8.2（chart 2.8.4）。

### 6.1 差异对照表

| 维度 | 测试环境（实测） | 生产环境（预期部署） | 迁移影响 |
|---|---|---|---|
| K8s 版本 | k3s v1.30.5 | K8s 1.18 | 1.18 已支持 HPA `behavior`（1.18 引入），`advanced.horizontalPodAutoscalerConfig` 可用 |
| KEDA chart / app | 2.10.2 / **2.10.1** | **2.8.4 / 2.8.2** | ScaledObject YAML 无需改动（见 6.2） |
| HPA API | `autoscaling/v2` | `autoscaling/v2beta2` | KEDA 内部生成逻辑差异，对业务不可见 |
| admission webhooks | 组件存在（本次关闭） | **2.8 无此组件** | `--set webhooks.enabled=false` 传入无效但无害 |
| Redis scaler | 实测 redis 7.x（`redis:alpine` 当前为 7） | **2.10 才声明支持 Redis 7**，2.8.2 官方支持 ≤6.x | 生产 Redis 建议**钉住 6.2.x**（如 `redis:6.2-alpine`） |
| `autoscaling.keda.sh/paused: "true"` 注解 | 可用 | 可用（2.4+ 均支持） | 一致 |
| `autoscaling.keda.sh/paused-replicas` 注解 | 可用 | **不可用**（晚于 2.8 引入） | 生产暂停弹性用 `paused: "true"` 或临时调 min/max |
| operator/adapter 自身可观测 | 2.10 新增 scaler activity/latency 指标 | 2.8.2 无 | 生产监控改用 HPA 指标 + 事件（不影响功能） |
| 指标链路 | Redis → KEDA → external.metrics.k8s.io → HPA | 完全一致 | 无 |
| 默认节奏 | pollingInterval 30s / cooldownPeriod 60s / HPA 缩容稳定窗 300s | 完全一致 | 无 |

### 6.2 可平移性结论（迁移核心）

**ScaledObject / TriggerAuthentication YAML 直接复制可用，仅改事件源地址与凭据**。验证所用的全部字段（`scaleTargetRef`、`minReplicaCount/maxReplicaCount`、`cooldownPeriod`、`pollingInterval`、`triggers[].type: redis` + `address/listName/listLength`、`authenticationRef`）在 2.8.2 与 2.10.1 中语义一致，[接入 SOP](opensandbox-keda-integration-sop.md) 五步法在生产同样适用。

### 6.3 迁移步骤（测试 → 生产）

1. **镜像同步**：向内网 registry 同步 `ghcr.io/kedacore/keda:2.8.2` 与 `keda-metrics-apiserver:2.8.2`（digest 见第 3 节，同步后以 registry 输出二次核对），Redis 钉 `redis:6.2-alpine`。
2. **管理员安装**：`helm install keda kedacore/keda --version 2.8.4 ...`（完整命令见 4.1 节）。
3. **集群验收**：跑第 5 节验收三查（1.18 有 v2beta2，不应出现 HPA 报错）。
4. **事件源部署**：生产 Redis 主从 + 密码；凭据经 `TriggerAuthentication`（secretRef）注入，不用明文 metadata。
5. **业务接入**：apply 业务 ScaledObject（测试机 YAML 原样平移，改 address 与认证）。
6. **双向验证**：按[接入 SOP](opensandbox-keda-integration-sop.md) Step 4 跑正向灌压 + 反向清空，确认扩缩与延迟体感符合第 1 节量级（30~60s 扩 / ~6min 缩）。
7. **回滚预案**：`kubectl delete scaledobject`（业务立即恢复手动副本控制）→ `helm uninstall keda -n keda`（删 CRD 前备份各业务 ScaledObject）。

## 7. 测试机固化部署（已落地，全部 helm 管理）

目录：`/home/extvdiadmin/keda-stack/`（含 `README.md` 一键重装说明）

| 组件 | 形态 | 版本/位置 |
|---|---|---|
| KEDA | helm release `keda/keda`（ns keda） | chart 2.10.2 / app 2.10.1 |
| Redis | 本地 chart `keda-stack/redis-demo` → release `keda-queue`（ns keda） | 0.1.0 / redis:alpine |
| 接入模板 | `keda-stack/scaledobject-opensandbox-server.yaml` | 指向 `keda-queue-redis.keda.svc:6379` |

演示命令（完整脚本见测试机 README）：

```bash
# 扩容：40 条任务（listLength=5 → 需求 8 副本 → 封顶 3）
kubectl exec -n keda deploy/keda-queue-redis -- sh -c \
  'for i in $(seq 1 40); do redis-cli lpush task-queue t$i >/dev/null; done; redis-cli llen task-queue'
watch -n 5 'kubectl get hpa,deploy -n opensandbox'
# 缩容：清队列，~6 分钟后回 1 副本
kubectl exec -n keda deploy/keda-queue-redis -- redis-cli del task-queue
```

## 8. 清理（测试机演示环境）

```bash
kubectl delete scaledobject -n opensandbox server-queue-scaler
helm uninstall keda-queue keda -n keda          # 卸 keda 会连 CRD 一起删
kubectl delete ns keda
kubectl scale deploy -n opensandbox opensandbox-server --replicas=1
```
