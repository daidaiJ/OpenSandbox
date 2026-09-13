# KEDA 服务接入 SOP：任意 Deployment 事件化弹性扩缩（业务开发自助）

> 日期：2026-09-13
> 适用读者：**业务开发者**（仅 namespace 级权限，无 PaaS 集群管理员）
> 前提：集群管理员已完成 KEDA 安装与验收（见姊妹篇《[KEDA 部署验证报告](opensandbox-keda-redis-autoscale-validation.md)》，含版本红线、镜像 digest、CRD/权限清单、测试→生产迁移）。
> 本文档所有操作均在**业务自己的 namespace** 内自助完成，无需管理员参与。

姊妹篇分工：

| 文档 | 读者 | 内容 |
|---|---|---|
| [部署验证报告](opensandbox-keda-redis-autoscale-validation.md) | 管理员/平台 | 版本红线、镜像 digest、CRD/权限清单、安装验收、测试→生产迁移 |
| 本文（接入 SOP） | 业务开发 | 可水平扩判定、信号源选型、ScaledObject 模板、验证与运维 |

## 1. 五步法总览

```
Step 1 判定可水平扩 → Step 2 选信号源 → Step 3 写 ScaledObject → Step 4 双向验证 → Step 5 收尾运维
```

## 2. Step 1 判定目标服务是否可水平扩

KEDA 只是改副本数，**扩缩的前提是目标服务本身能水平扩**。逐项过：

| 检查项 | 通过标准 | 不满足时的处理 |
|---|---|---|
| 无本地状态 | Pod 不存本地会话/文件状态（或有外部存储承接：DB/S3/共享存储） | 先外置状态再接入 |
| 副本数无外部耦合 | 不存在"单实例绑定某节点/某端口直连/本地锁"等假设 | 解耦后接入 |
| Service 意识 | 有 Service 负载均衡；扩副本后流量能均摊 | 补 Service |
| 启动可达 | 副本起来后能快速进入服务状态（readiness 探针合理） | 缩零/激进缩容场景重点看 |

> OpenSandbox server 本身满足：无状态设计（MEMORY.md 架构决策），多副本各自调 K8s API / 池模式分配。已实测 1↔3 副本扩缩闭环。

**不可水平扩的批处理负载**（一次性计算、每任务独立运行）：不用 Deployment 扩缩，改用 `ScaledJob`——按事件源信号创建 Job，跑完即退：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: <batch-job>-scaler
  namespace: <业务ns>
spec:
  jobTargetRef:
    template:
      spec:
        containers:
        - name: worker
          image: <worker镜像>
        restartPolicy: Never
  triggers:
  - type: redis
    metadata:
      address: redis.keda.svc:6379
      listName: task-queue
      listLength: "5"
```

> `ScaledJob` 与 ScaledObject 互斥选择：常驻服务用 ScaledObject，批处理用 ScaledJob。两者 YAML 触发器部分语法一致。

## 3. Step 2 选事件信号源

选信号的原则：**语义最贴近"待处理工作量"**——扩出来的副本要真的能消化积压。

| trigger | 信号 | 典型场景 | 备注 |
|---|---|---|---|
| `redis` | list 长度 | 任务队列（已验证） | 最简单，配合 LPUSH/LPOP 业务闭环 |
| `redisStreams` | stream pending/length | 流式任务、消费组 | 有消费组 ACK 语义时优先 |
| `prometheus` | 任意 PromQL | 已有监控指标（如 HTTP QPS、池水位） | server 值 = 每副本目标值 |
| `http` | 请求速率/并发 | ingress 暴露指标的服务 | 需要可访问的指标端点 |
| `cron` | 时间窗 | 定时保底扩容 | 常与其他 trigger 叠加 |
| `kafka` / `rabbitmq` | lag / 队列深度 | 消息中间件 | 内网如有部署 |

> 多 trigger 叠加时 HPA 取各 trigger 算出的最大副本需求。KEDA 2.8.2 支持 50+ 种 trigger，完整列表见 [keda.sh/scalers](https://keda.sh/docs/2.8/scalers/)。

## 4. Step 3 写 ScaledObject

### 4.1 Redis 队列完整模板（已验证形态）

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: <service>-scaler
  namespace: <业务ns>
spec:
  scaleTargetRef:
    name: <目标Deployment>          # 同 ns；StatefulSet 加 kind: StatefulSet
  minReplicaCount: 1                # 生产不建议 0（冷启动+注册延迟）
  maxReplicaCount: 5
  cooldownPeriod: 120               # trigger 不活跃后等 HPA 收尾的秒数
  pollingInterval: 30               # 查询事件源的周期（默认 30s）
  triggers:
  - type: redis
    metadata:
      address: redis.keda.svc:6379
      listName: task-queue
      listLength: "5"               # 每副本承载 5 条积压
```

### 4.2 Prometheus 指标模板（以 QPS 为例）

```yaml
triggers:
- type: prometheus
  metadata:
    serverAddress: http://prometheus.monitoring.svc:9090
    query: sum(rate(http_requests_total{service="<service>"}[2m]))
    threshold: "100"                # 每副本 100 QPS
```

### 4.3 核心换算公式

```
期望副本 = min( ceil(队列积压 / listLength), maxReplicaCount )，且 ≥ minReplicaCount
```

`listLength`（prometheus 的 `threshold` 同理）的语义是**每副本可承受的积压量**，不是扩容阈值——积压 40、listLength=5 → 8 副本需求（封顶 max）。定值方法：压测得出单副本消化速率，`listLength ≈ 单副本并发消化量 × 可接受的每副本利用率`。

### 4.4 有密码时：TriggerAuthentication（生产必配）

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: redis-secret
  namespace: <业务ns>
type: Opaque
stringData:
  password: <redis密码>
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-auth
  namespace: <业务ns>
spec:
  secretTargetRef:
  - parameter: password
    name: redis-secret
    key: password
```

ScaledObject trigger 里引用：

```yaml
  triggers:
  - type: redis
    authenticationRef:
      name: redis-auth
    metadata:
      address: redis.prod.svc:6379
      listName: task-queue
      listLength: "5"
```

### 4.5 调缩容节奏（可选）

默认缩容偏慢（cooldown + HPA 缩容稳定窗 300s，体感 ~6min）。需要更快时通过 HPA behavior 收紧：

```yaml
spec:
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 60   # 缩容稳定窗 300s → 60s
```

## 5. Step 4 验证（必做，两个方向都要跑）

| # | 验收项 | 命令/操作 | 通过标准 |
|---|---|---|---|
| 1 | ScaledObject Ready | `kubectl get scaledobject <name> -n <ns>` | `READY=True` |
| 2 | HPA 自动生成 | `kubectl get hpa -n <ns>` | `keda-hpa-<name>` 出现，MIN/MAX 与 SO 一致 |
| 3 | 指标读取 | `kubectl get hpa <name> -n <ns> -o jsonpath='{.status.currentMetrics}'` | currentMetrics 里有 external 指标值 |
| 4 | 正向扩容 | 灌入信号（如 LPUSH 40 条） | TARGETS 上升 → 副本上升至公式预期，新副本健康 |
| 5 | 反向缩容 | 清空信号 | 体感 ~6min 后回落（cooldown + 5min 稳定窗） |
| 6 | 业务冒烟 | 扩副本后走一遍业务请求 | 服务正常，流量均摊 |

排障入口：`kubectl logs -n keda deploy/keda-operator --tail=100 | grep <name>`、`kubectl describe hpa -n <ns> keda-hpa-<name>`（看 Events）。

## 6. Step 5 收尾与日常运维

| 场景 | 操作 | 注意 |
|---|---|---|
| 恢复手动控制 | `kubectl delete scaledobject <name>` | HPA 随之删除；副本保持当时值，需手动 `kubectl scale` 回 |
| 临时停用弹性 | ScaledObject 加注解 `autoscaling.keda.sh/paused: "true"` | KEDA 2.8.2 即支持；`paused-replicas` 注解 2.8.2 **不支持**（2.10+ 才有），别照抄新文档 |
| 观察扩缩行为 | `kubectl logs -n keda deploy/keda-operator \| grep <name>`；HPA events | KEDA 每 pollingInterval 打 trigger 读数日志 |
| KEDA 升级/重装 | 先 `kubectl get scaledobject -A > backup.yaml` | helm uninstall 不影响业务 ns 的 SO 实例，但 **CRD 删除会连带删实例** |

## 7. 常见坑（实测/官方高频）

1. **ScaledObject 一直不 Ready**：先查 operator 日志是否 `no matches for kind "HorizontalPodAutoscaler" in version "autoscaling/v2beta2"`——KEDA 版本与 K8s 版本不匹配（版本红线见[部署验证报告](opensandbox-keda-redis-autoscale-validation.md)第 2 节）。
2. **listLength 语义理解错**：是"每副本积压量"（除法），不是"扩容阈值"（比较）。
3. **扩缩不对称**：扩 ~30-60s（pollingInterval + HPA 同步），缩默认 ~6min（cooldown + HPA downscale stabilization 300s）。不是故障，是 HPA 防抖设计；要快按 4.5 节调 behavior。
4. **KEDA 接管后不要手动 kubectl scale**：副本数会被 HPA 改回。
5. **minReplicaCount: 0**：允许但意味着全冷启动，且依赖 `idleReplicaCount` 语义，生产慎用。
6. **Redis 单点**：redis 挂 → KEDA 读不到指标 → HPA 不动作（保持现状，不会误缩容到 0，前提 minReplicaCount ≥ 1）；生产 Redis 建议主从 + TriggerAuthentication 密码。
7. **多 trigger 抢信号**：叠加 trigger 时任一信号高的都会推副本数，确认没有调试期残留的临时 trigger。

## 8. 参考

- [KEDA 部署验证报告（版本红线/镜像/权限/迁移）](opensandbox-keda-redis-autoscale-validation.md)
- [KEDA 官方文档 2.8](https://keda.sh/docs/2.8/)（与生产 2.8.2 对应）｜[Scalers 列表](https://keda.sh/docs/2.8/scalers/)｜[ScaledObject Spec](https://keda.sh/docs/2.8/reference/scaledobject-spec/)
