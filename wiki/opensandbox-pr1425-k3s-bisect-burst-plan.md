# PR #1425 前后对照：ubuntu k3s 二分复现 + 突发创建相关 issue/PR

> 日期：2026-09-10
> 目的：在现有 ubuntu SSH k3s 上用 **controller 镜像 A/B** 确认 [#1425](https://github.com/opensandbox-group/OpenSandbox/pull/1425) 能否止血本地「Pending → scale-in 自噬」；并盘点上游对**短时多创建突发并发**还有哪些同类缺陷/优化。
> 关联：`origin/dev` `issues/2026-09-10-pool-pending-scalein-churn.md`；上游 [#1423](https://github.com/opensandbox-group/OpenSandbox/issues/1423)。

---

## 0. 结论先行

1. **不要在 2 节点 k3s 上原样复现 13 节点 / poolMax=400 / 2c4G / 100 并发。** 只复现同一条代码路径：Pending 堆进 buffer → trim 最老 idle → 预算回血再创建。
2. **不要对整仓做 `git bisect`。** 缺陷只在 controller 的 `scalePool` / `pickPodsToDelete`。先做两点对照（`0d82d87b^` vs `0d82d87b`）；只有「合入后仍自噬」才对 controller 提交做二分。
3. **当前 `dev` 未含 #1425。** 对照镜像必须从 `upstream/main` 检出构建，不能从本 fork 的 `dev` 历史里找这条 commit。
4. **#1425 必须连 CRD 一起上。** 它给 Pool CRD 补了 `status.updated`；只换二进制、CRD 仍是现在这份，会回到 #1423 的热调谐环，A/B 无效。
5. 突发创建上，**K8s Pool 控制器层**除 #1425 外几乎没有已合入的吞吐优化。server / execd 有另一类改进（打满快失败、事件循环、informer、隔离会话配额），**改的是创建失败语义和单进程并发能力，不消灭 trim 自噬**。客户端 Kotlin/JS `SandboxPool` warmup 是第三层。

---

## 1. 用哪套 k3s

用一直在做隔离会话/egress 实测的那套，不要换集群：

| 项 | 值 |
|---|---|
| 入口 | SSH → ubuntu master `10.254.254.105` |
| 集群 | k3s v1.30.5，双节点：105 master + `10.254.254.103` worker |
| 部署目录 | `/home/extvdiadmin/osb-deploy/` |
| server | NodePort **30809**（`http://10.254.254.105:30809`） |
| 现网 controller | helm `opensandbox-controller`，镜像 tag 多为 `latest`（见升级 SOP） |

原销毁风暴环境是 **13 候选节点、namespace 配额 ~900c、模板 2c4G、poolMax=400**。这套双节点撑不住那个量纲，所以下面用**缩比配方**打同一条公式，而不是追 293/193 那个绝对数。

上机先确认没连错集群：

```bash
kubectl get nodes -o wide
kubectl get deploy -n opensandbox-system -o jsonpath='{range .items[*]}{.metadata.name} {.spec.template.spec.containers[0].image}{"\n"}{end}'
kubectl get pools -A
```

---

## 2. 对照什么（两点，不是全历史二分）

| 侧 | git | 镜像 tag 建议 | 期望 |
|---|---|---|---|
| **前（坏）** | `0d82d87b^` | `controller:bisect-pre1425` | 缩比 ramp 出现 trim 自噬：`scaleIn>0` 且 `supplyCnt>0` 并存；`SuccessfulDelete` 明显高于 sandbox 删除次数 |
| **后（修）** | `0d82d87b`（PR #1425） | `controller:bisect-1425` | 上述病理标志消失或数量级下降；Pending 不再被计成 buffer |

指纹自检（镜像/源码）：

- 前：`pool_controller.go` 有 `bufferCnt := schedulableCnt - allocatedCnt`，没有 `countReadyIdlePods`
- 后：有 `countReadyIdlePods` / `desiredBufferCount`，且存在 `pool_scaling_stability_test.go`

当前 fork `dev` = **前**。不要把 `dev` HEAD 当成「后」。

**后侧额外动作**：用 `0d82d87b` 的 chart 重装/升级 controller，确保 Pool CRD 出现 `.status.updated`：

```bash
kubectl get crd pools.sandbox.opensandbox.io -o jsonpath='{.spec.versions[0].schema.openAPIV3Schema.properties.status.properties}' | grep -o updated
```

没有 `updated` 就不要开始压「后」侧。

---

## 3. 实施步骤

### 3.1 准备（只做一次）

在 ubuntu 上单独 worktree，避免弄脏现网用的源码树：

```bash
cd /path/to/OpenSandbox
git fetch upstream main
git worktree add /tmp/osb-1425-bisect 0d82d87b
```

构建两枚 **仅 controller** 镜像（task-executor / execd / server 不动）：

```bash
cd /tmp/osb-1425-bisect/kubernetes
# 后
git checkout 0d82d87b
COMPONENT=controller TAG=bisect-1425 PUSH=false ./build.sh
# 前
git checkout 0d82d87b^
COMPONENT=controller TAG=bisect-pre1425 PUSH=false ./build.sh

# k3s 用 containerd，必须导入
docker save opensandbox/controller:bisect-pre1425 | sudo k3s ctr images import -
docker save opensandbox/controller:bisect-1425     | sudo k3s ctr images import -
```

镜像仓库名以 `build.sh` 实际打出来的为准（可能是 `sandbox-registry.../opensandbox/controller`）。`kubectl set image` 用同一仓库名。

独立测试池，**不要动** `/tmp/osb-iso-test` 那套隔离会话池。

### 3.2 缩比 Pool（双节点可跑、仍能逼出 Pending）

目标：让 kube-scheduler 产生一段时间 Pending，同时 bufferMax 小到 trim 容易触发。

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: Pool
metadata:
  name: bisect-churn
  namespace: opensandbox
spec:
  recycleStrategy: {type: Delete}   # 保持默认；对照期间不要切 Restart
  capacitySpec:
    poolMin: 4
    poolMax: 24          # 对准双节点真实可调度量，略高于能跑满的数
    bufferMin: 2
    bufferMax: 6         # 小带，ramp 回落时容易越上限
  scaleStrategy:
    maxUnavailable: 25%  # 保持默认，复现「25% 预算平衡点」
  template:
    spec:
      containers:
      - name: sandbox
        image: <集群已预热的轻量镜像>   # 必须预拉，排除镜像拉取噪声
        resources:
          requests: {cpu: "500m", memory: 512Mi}
          limits:   {cpu: "1",    memory: 1Gi}
```

`requests` 按节点 `allocatable` 反推：希望峰值时有 **4–8 个 Pending**，不要 0 个（打不出病理），也不要全 Pending（分不出 Ready/未 Ready）。若 500m 仍全都能调度，把 requests 加大或把 poolMax 再抬一点。

沙箱 **timeout 拉长（≥ 30min）**，ramp 过程中不要删，避免 Delete 回收流和 trim 混在一起。

### 3.3 负载（同一脚本跑两轮）

按 40 一档的缩比：每档 **+6** 并发，档内保持 90s，打到 ~18 并发为止（约 4–5 档，总时长 ~8–10 min）。

```bash
SERVER=http://127.0.0.1:30809   # 或 10.254.254.105:30809
KEY=...
POOL=bisect-churn
for n in 6 12 18; do
  echo "=== ramp $n ==="
  for i in $(seq 1 $n); do
    curl -sS -X POST "$SERVER/v1/sandboxes" \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d "{\"extensions\":{\"poolRef\":\"$POOL\"},\"timeout\":1800}" &
  done
  wait
  sleep 90
done
```

每档采样（必须留日志，A/B 才能比）：

```bash
kubectl get pool bisect-churn -n opensandbox -o jsonpath='total={.status.total} alloc={.status.allocated} avail={.status.available}{"\n"}'
kubectl get pods -n opensandbox -l sandbox.opensandbox.io/pool-name=bisect-churn \
  --no-headers | awk '{print $3}' | sort | uniq -c
kubectl -n opensandbox-system logs deploy/opensandbox-controller-controller --since=2m \
  | grep -E 'Scale pool decision|Scaling (up|down) pool'
# Pending 原因（原 issue 待收口的那条）
kubectl get pod -n opensandbox -l sandbox.opensandbox.io/pool-name=bisect-churn \
  --field-selector=status.phase=Pending \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.conditions[*].message}{"\n"}{end}'
```

计数分离：

```bash
kubectl get events -n opensandbox --field-selector reason=SuccessfulDelete --no-headers | wc -l
```

对照 `Allocate action ... toRelease`（controller 日志）。trim 自噬 = SuccessfulDelete 远大于 sandbox 主动释放。

### 3.4 切换顺序

1. 装 **pre1425** 镜像 + **当前（无 status.updated）CRD** → 跑 3.3 → 存 `/tmp/bisect-pre/`  
2. 清空测试池（删 BatchSandbox，等 pod 回收，或删重建 Pool）  
3. 升级到 **1425 镜像 + 1425 CRD**（`helm upgrade` 用 `0d82d87b` 的 chart）→ 再跑同一脚本 → 存 `/tmp/bisect-1425/`  
4. 实验结束：**helm 滚回现网 `latest`**，删 `bisect-churn` 池

```bash
helm upgrade opensandbox-controller <chart> -n opensandbox-system \
  --reuse-values \
  --set controller.image.tag=bisect-pre1425 \
  --set controller.image.pullPolicy=IfNotPresent
# 后侧改 tag=bisect-1425，且 chart 必须来自 0d82d87b
```

### 3.5 何时才上真正的 git bisect

仅当 **后侧仍出现** `supplyCnt>0 && scaleIn>0` 或销毁/Running 比仍 >1。那时在 `upstream/main` 上对 `kubernetes/internal/controller/pool_controller.go` 做 `git bisect`，每次只重编 controller、只跑一档 ramp（12 并发保持 90s），bad=病理在、good=病理无。

预期：若前坏后好，引入点就是 `0d82d87b` 本身，不必再 bisect。

---

## 4. 判定表

| 观察 | 前（未修）应出现 | 后（#1425）应出现 |
|---|---|---|
| `Scale pool decision` 里 `bufferCnt` vs `Available` | buffer 明显大于 Available（Pending 算进 buffer） | buffer ≈ Available（只计 Ready idle） |
| `supplyCnt>0` 同时 `Scaling down` | 有 | 无或偶发 1 次后收敛 |
| Pending 数 | 顶在 ~25%×desired（双节点上大约数个到十来个） | 不随 trim 正反馈堆积 |
| SuccessfulDelete / 主动释放 | 删除明显偏多 | 接近 1:1（只剩 Delete 回收） |
| 日志 `podsToDelete` | 含未 Ready / 最老 Pending | 缩容有 `maxUnavailable` 批次上限 |

**#1425 已知残留（本方案要顺手看一眼）**：缩容排序是「未 Ready 先删、同就绪度再删较新的」，**不是**本地提案的「skip 未 Ready」。若后侧 buffer 口径已对，但仍把 6–10s 在途 pod 剪掉，记为残留，不要重开 #1423，另开「scale-in 跳过 in-flight」。

---

## 5. 突发短时多创建：上游同类项（分层）

### 5.1 K8s Pool 控制器（和这次同一层，优先看）

| 项 | 状态 | 和突发创建的关系 |
|---|---|---|
| [#1423](https://github.com/opensandbox-group/OpenSandbox/issues/1423) / [PR #1425](https://github.com/opensandbox-group/OpenSandbox/pull/1425) | **已合入 upstream/main**，本 fork `dev` **未合** | 正是 trim 自噬 + 缩容无门控。突发 ramp 回落时最容易引爆 |
| [PR #584](https://github.com/opensandbox-group/OpenSandbox/pull/584) `scale-up/down-per-minute` | 作者关掉，**未合入** | 唯一明确的「突发创建速率」token bucket；默认还是 0=不限，即使合入也要配 flag |
| [PR #906](https://github.com/opensandbox-group/OpenSandbox/pull/906) scale expectation stuck | 已合 | 创建/删除 in-flight 时期望值门闩；#1423 实测它过松（~4–7 次/分钟就 satisfied），挡不住风暴 |
| [#108](https://github.com/opensandbox-group/OpenSandbox/issues/108) expectations never satisfied | 已关 | 906 的前史：门闩卡死则反方向——突发时不补货 |
| [PR #621](https://github.com/opensandbox-group/OpenSandbox/pull/621) | 已合 | `maxUnavailable` 用在**滚动更新**，不是 scale-up 突发；不要误当成创建限速 |
| [PR #1143](https://github.com/opensandbox-group/OpenSandbox/pull/1143) pool-assign capacity predicate | 已合 | 没容量的池不再被选中；改善「打满后乱分配」，不减少创建 churn |
| [PR #1618](https://github.com/opensandbox-group/OpenSandbox/pull/1618) schedule 失败仍继续 scale/status | **仍 open** | 调度失败时不再把后续 scale 整段跳过；突发 Pending 时可能让缩容更勤，**合入前要评估是否加重 trim** |
| [#1650](https://github.com/opensandbox-group/OpenSandbox/issues/1650) / [PR #1651](https://github.com/opensandbox-group/OpenSandbox/pull/1651) 池容量指标 | open | 观测突发水位，不改调度 |

对短时突发，控制器侧**真正改变创建动力学**的已合修复就是 #1425；#584 是未落地的限速；#1618 需警惕。wiki 里「缩容无限速」那句（`opensandbox-pool-capacity-params.md` §6.4）在 `upstream/main` 上已过时，在本 `dev` 上仍成立。

### 5.3 Server（生命周期控制面：`POST /sandboxes` 突发）

server 不建/不删池 Pod，它把 CR 写进 apiserver 然后轮询 Ready。突发时它能优化的是：**别把事件循环堵住、别把打满误报成超时、别让 informer 把所有创建一起弄死**。token bucket（`services/k8s/rate_limiter.py`）只限 **server→apiserver 的 read/write QPS**，不是对客户端 create 的准入闸。

| 项 | 状态 | 和突发创建的关系 |
|---|---|---|
| [#1578](https://github.com/opensandbox-group/OpenSandbox/issues/1578) / [PR #1581](https://github.com/opensandbox-group/OpenSandbox/pull/1581) 池容量耗尽 | 已合 | 控制器报容量不够时，不再空等到 `POD_READY_TIMEOUT`。配置项 `pool_acquisition_timeout_seconds`（默认 30s，且不超过 create timeout）。**错误语义 + 更快腾出 server 等待槽**，Pod churn 照旧 |
| [#1750](https://github.com/opensandbox-group/OpenSandbox/issues/1750) / [PR #1752](https://github.com/opensandbox-group/OpenSandbox/pull/1752) ResourceQuota 快失败 | 已合 | 准入拒绝立刻 403，不再伪装成就绪超时。突发打到 namespace 配额墙时调用方能立刻退避 |
| [#1175](https://github.com/opensandbox-group/OpenSandbox/issues/1175) poolRef 指向不存在的 Pool | 已合 | 同类 fail-fast，避免每个错误请求占满 create timeout |
| [#620](https://github.com/opensandbox-group/OpenSandbox/issues/620) / [PR #903](https://github.com/opensandbox-group/OpenSandbox/pull/903) / [PR #1171](https://github.com/opensandbox-group/OpenSandbox/pull/1171) | 已合 | 同步 K8s/Docker/拉镜像移出事件循环；暴露 uvicorn `workers` / `limit_concurrency` / anyio threadpool。**单进程突发吞吐**的主优化。默认仍 `workers=1`，要吃到红利必须改 `[server]` TOML |
| [#1322](https://github.com/opensandbox-group/OpenSandbox/issues/1322) / [PR #1323](https://github.com/opensandbox-group/OpenSandbox/pull/1323)、[#1533](https://github.com/opensandbox-group/OpenSandbox/issues/1533) / [PR #1534](https://github.com/opensandbox-group/OpenSandbox/pull/1534)、[PR #1674](https://github.com/opensandbox-group/OpenSandbox/pull/1674) | 已合 | informer 不 relist / watch 卡住 / 直连响应污染缓存 → **所有创建一起 404 `POD_IP_NOT_AVAILABLE`**。突发时最像「集群挂了」，根因是 server 缓存 |
| [#1705](https://github.com/opensandbox-group/OpenSandbox/issues/1705) / [PR #1715](https://github.com/opensandbox-group/OpenSandbox/pull/1715) | 已合（**Docker 运行时**） | 并发 create 抢同一 host port → 500。K8s 池化路径无此问题 |
| [#954](https://github.com/opensandbox-group/OpenSandbox/issues/954) 静默换皮感知 | 本仓库已实施（`changes/954-runtime-perception-proxy.md`） | 突发中 pool Pod 被 trim 掉后，proxy 给 `RUNTIME_REPLACED/LOST` 而不是默打到空运行时。**感知层，不阻止 trim** |
| [#1570](https://github.com/opensandbox-group/OpenSandbox/issues/1570) 委托创建的准入 + 幂等 | **仍 open** | 同一租户多调用方突发 create 时缺独立配额/幂等键，盲重试会双建 |
| [PR #1730](https://github.com/opensandbox-group/OpenSandbox/pull/1730) 等待池化 execd 就绪 | **关掉未合** | 想把「CR Allocated」和「execd 可执行」对齐；未进 main，现网仍可能 Allocated 后第一跳 execd 还没起来 |

对这次 k3s 池化压测：**server 侧值得确认的是 1578/1750 是否已在现网 server 镜像里**（打满应是容量错误而不是 60s 超时）。它们不会让 `SuccessfulDelete` 下降。A/B #1425 时不要顺手升 server。

### 5.4 execd（沙箱内执行面：会话/命令突发）

execd 每个池 Pod 一份，**不参与 Cluster 级 `POST /sandboxes`**。只有压的是「一个沙箱里短时间开很多 isolated session / command」时才相关。没有创建速率闸，也没有类似 #1425 的扩缩容逻辑。

| 项 | 状态 | 和突发创建的关系 |
|---|---|---|
| [#1773](https://github.com/opensandbox-group/OpenSandbox/issues/1773) `upper_max_bytes` 只在 Allocate 检查 | **仍 open** | 最像 trim 自噬的对称缺陷：一个会话写爆 upper → **该 Pod 内所有新隔离会话创建失败**。写时不 ENOSPC。本 fork 已提，k3s 上复现过 |
| [#1780](https://github.com/opensandbox-group/OpenSandbox/issues/1780) / [PR #1784](https://github.com/opensandbox-group/OpenSandbox/pull/1784) 过期 upper 泄漏 | 已合 upstream | execd 重启后脏 upper 占额度，突发建会话会提前撞 #1773 的墙 |
| [#1547](https://github.com/opensandbox-group/OpenSandbox/issues/1547) 调用方幂等 execution create | **仍 open** | 突发重试会双跑命令；没有 caller-provided ID |
| [#1463](https://github.com/opensandbox-group/OpenSandbox/issues/1463) handler 持锁死等 resultChan | 已合 | 并发 command/SSE 下偶发整进程卡死，表现为「这个沙箱里什么都建不了」 |
| [PR #1746](https://github.com/opensandbox-group/OpenSandbox/pull/1746) / [PR #1710](https://github.com/opensandbox-group/OpenSandbox/pull/1710) | 已合 | 日志/输出保留上限，降低突发 command 的磁盘与读放大，不加速 create |
| 同会话 run 串行（设计如此） | — | 隔离会话实测：并发 run 排队，不是并行。突发要用多 session，不要单 session 打满 |
| [PR #1730](https://github.com/opensandbox-group/OpenSandbox/pull/1730) | 未合 | 见 server：池 Pod 刚分配时 execd 未就绪的窗口 |

#1425 对照实验**不要换 execd 镜像**。若后续要测「短任务 × 隔离会话」突发，那是另一条：每沙箱内 session create + #1773 配额墙，和控制器 trim 分开记账。

### 5.2 不是同一层（客户端 SDK SandboxPool）

这些修的是 **SDK 进程内连接池 warmup**，不经过 K8s Pool CR。压测若走 `POST /v1/sandboxes` + `poolRef`，它们帮不上 trim 自噬：

| 项 | 状态 | 要点 |
|---|---|---|
| [#1514](https://github.com/opensandbox-group/OpenSandbox/issues/1514) warmupConcurrency>~200 无效 | 已关 | 过高并发把连接打爆，吞吐反而下降 |
| [#1520](https://github.com/opensandbox-group/OpenSandbox/issues/1520) DIRECT_CREATE 无并发门闩 | 已关 | 缓冲空时同步现建无上限 |
| [PR #1494](https://github.com/opensandbox-group/OpenSandbox/pull/1494) | 已合 | Kotlin 完成驱动 reconcile 振荡（失败越快 tick 越快） |
| [PR #1575](https://github.com/opensandbox-group/OpenSandbox/pull/1575) / [#1604](https://github.com/opensandbox-group/OpenSandbox/pull/1604) / [#1621](https://github.com/opensandbox-group/OpenSandbox/pull/1621) / [#1697](https://github.com/opensandbox-group/OpenSandbox/pull/1697) | 已合 | Kotlin/Python 异步/增量 warmup，提高短时填充 |
| [PR #1512](https://github.com/opensandbox-group/OpenSandbox/pull/1512) Retry-After | 已合 | 限流时别死打 |

只有业务层自己用了 Kotlin/JS `SandboxPool` 做预热，才需要看 5.2。

---

## 6. 实验期不要做的事

- 不要同时改 `recycleStrategy`（Restart 会让销毁计数塌掉，A/B 不可比）
- 不要在对照周切换隔离会话池 / 改 execd 镜像
- 不要用 `controller.image.tag=latest` 当「后」——现网 latest 来自哪次构建未知，必须以 `0d82d87b` 构建物为准
- 不要把 13 节点那组 poolMax=400 抄过来打满双节点，那是 quota/调度墙，不是二分信号

---

## 7. 完成后回填

把 `/tmp/bisect-pre/` 与 `/tmp/bisect-1425/` 的四段采样（水位、Pending message、Scale pool decision、SuccessfulDelete）贴回 `issues/2026-09-10-pool-pending-scalein-churn.md` 的「验证判据」：前坏后好 → 本 fork 合 #1425；后仍剪 in-flight → 另开残留 issue。
