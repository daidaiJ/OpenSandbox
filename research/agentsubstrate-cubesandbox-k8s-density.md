# Agent Substrate 与 CubeSandbox：K8s 上的毫秒级创建销毁与并发不超卖

> 调研时间：2026-11-15。代码来源：`github.com/agent-substrate/substrate`（`a4646466`，2026-11-14）与 `github.com/TencentCloud/CubeSandbox`（`72af66c3`，v0.6 之后）。所有性能数字标注来源，厂商自测只作量级参考。

## 1. 结论

- **两家都把 K8s 的调度单位从"每沙箱一个 Pod"上移为"每节点或每池一组常驻 worker"**。沙箱的创建、恢复、销毁由自定义控制面和节点代理直接完成，K8s 只负责低频的 worker/节点供给。
- **Agent Substrate 用 PostgreSQL 行锁事务严格预占容量**：`BindActorToWorker` 对 worker 行 `SELECT ... FOR UPDATE`，在锁内重算是否放得下，同一事务插入 assignment、累加 `allocated`、把 Actor 置为 `RESUMING`。并发争抢最后一个槽位时，后到者看到已更新的 `allocated` 并重试。
- **CubeSandbox 用节点 quota + 超卖比例 + 物理余量 + 并发闸门做有界超卖**：quota 上乘 CPU 3 倍 / 内存 2 倍，另有 `node_max_cpu_util` 80%、`node_max_mem_reserved_in_mb` 10GiB、`node_max_mvm_num` 3000、创建并发上限。创建调度是乐观的，真正的资源落账发生在 Cubelet 拉起 VM 并应用 cgroup 时，OS/cgroup 是硬防线。
- **K8s 层的资源账必须和自定义调度器对齐**：Agent Substrate 让 worker Pod 的 `limits` 覆盖它要承载的沙箱容量；CubeSandbox 用专用节点 + `compute` 污点把节点从 K8s 通用调度里隔离出来。两边各算一套账时，超卖和 Pod 驱逐会同时出现。
- **密度约束在网络层就分叉**：Agent Substrate 每个 Actor 复用固定 link-local `/30`，不消耗唯一 IP；CubeSandbox 每个 sandbox 在宿主机侧占一个唯一 IP，CIDR 大小（`/16`~`/24`）是单节点密度的硬上限。

## 2. 共同前提：为什么绕开调度器

K8s 为单个 Pod 建立运行态要经过一组异步收敛：API Server 写入、调度器绑定、kubelet 同步、CNI 配置、镜像拉取、容器启动。秒级完成对长生命周期 Pod 是合理的，对毫秒到低个位数秒的沙箱任务不可接受。

两家的做法相同：**把沙箱生命周期从 Pod 里剥离，改为在常驻 worker 内部完成**。

| 维度 | 传统路径 | 两家共同做法 |
|---|---|---|
| 沙箱创建 | 建 Pod → 调度 → 拉镜像 → 起容器 | 在已就绪 worker 上恢复快照或克隆 rootfs |
| 调度 | kube-scheduler 为 Pod 选节点 | 自定义调度器为沙箱选 worker |
| 资源记账 | Pod requests/limits | worker 内部 quota + 每沙箱 cgroup |
| 销毁 | 删 Pod → kubelet GC | 自定义控制面终止子进程或 VM |

## 3. Agent Substrate

### 3.1 K8s 上的形态

| 层级 | 组件 | K8s 资源 | 职责 |
|---|---|---|---|
| 池定义 | `WorkerPool` CRD | 自定义资源 | 声明副本数、sandbox class、worker 模板 |
| 池实例 | `atecontroller` | Deployment（owner 指向 `WorkerPool`） | 把 CRD 渲染成普通 Deployment 并维持副本 |
| 预热宿主 | worker Pod（`ateworker`） | 普通 Pod，未设 `RuntimeClassName` | 承载 N 个 Actor，提供 `atunnel` 数据面入口 |
| 节点管理 | `atelet` | DaemonSet | 监督本节点 worker、搬快照、注册 `/dev/kvm` device plugin |
| 控制面 | `ate-api-server` | Deployment + PostgreSQL | 生命周期 API、调度、租约、状态存储 |
| 数据面入口 | `atenet-router` | Deployment（Envoy + `ext_proc`） | 按请求头触发 resume 并路由 |

worker Pod 内部只有 `ateworker` 一个业务容器：它既是沙箱运行时宿主（调 `runsc` 或 Kata + Cloud Hypervisor），也是数据面代理（`atunnel` 监听 8443，接受 mTLS `CONNECT`）。

### 3.2 快路径

```text
CreateActor   → 只写一条 DB 记录，状态 SUSPENDED，指向模板的 golden snapshot
第一次请求    → atenet-router 的 ext_proc 调 ResumeActor
ResumeActor   → 控制面选 worker（PG 行锁预占）
              → atelet 下载快照、调 ateworker 的 RestoreWorkload
              → ateworker 恢复 sandbox，Actor 变 RUNNING
              → router 用 worker Pod IP:8443 开 mTLS CONNECT，atunnel 转发
SuspendActor  → checkpoint 进程/VM，上传快照，释放 worker
DeleteActor   → 终止运行中沙箱、释放 worker、删记录、GC 快照
```

官方指标：resume 小于 500ms、每秒 500 次以上激活，p95 目标 100ms。

### 3.3 多阶段并发为什么不会超卖

**容量模型**

- worker 的容量来自容器 `limits.cpu` / `limits.memory`，经 downward API 投影到 `/run/worker-capacity/`，减去 worker 自留内存后上报。
- Actor 槽位来自 `--max-actors`（默认 1000）。
- 一个 Actor 的 booking = 模板声明的 `limits` + 所用运行时的 overhead（固定值 + 每 GiB 增量）。

**提交点**

`BindActorToWorker` 在一个事务里：

1. `SELECT proto FROM workers WHERE name = $1 FOR UPDATE` 锁住 worker 行；
2. 在锁内重新执行 `Applies`（仍满足 class、runtime、label 约束）与 `HasRoom`（剩余容量仍够）；
3. 插入 `worker_assignments`；
4. `Allocated = AddToAllocated(Allocated, assignment, +1)`；
5. 更新 Actor 为 `RESUMING` 并写入 assignment。

缓冲在 watch 里的 worker 只是候选。两个请求争最后一个槽位时，后拿到锁的请求会看到已经变小的余量，返回可重试的 `errWorkerFilledUp` 或版本冲突，然后换 worker 重试。

**同一 Actor 的并发**

`acquireActorLease` 用 PostgreSQL 租约（默认 TTL 30s）串行化同一 Actor 上的 resume、suspend、delete、revert，配合 Actor 版本前置条件避免重复绑定。

**多阶段持有**

容量在下载快照和 restore 之前就已记账，整个 `RESUMING` 阶段都占着。restore 失败走 `crashActor`，在同一个 `UpdateActorAndRelease` 事务里删除 assignment 并按 `-1` 归还容量。瞬时错误（`Unavailable`、`DeadlineExceeded`）保留 assignment 供重试，避免出现"没记账的恢复"。

**选点**

候选 worker 做 power-of-two choices：随机抽两个，取负载较低者，负载取"槽位利用率"与"最高计算资源利用率"的较大值。

**硬兜底**

- 每个 Actor 的 sandbox 有 cgroup v2 `cpu.max` / `memory.max`，声明多少只能用多少。
- worker 的 `--max-actors` 是第二道闸；未注册或 `DRAINING` 的 worker 不接新活。
- 池满时 router 按 park 预算（默认 5s）重试，lot 容量默认 1024，超出直接 503，不会无限排队。

**边界条件**

`WorkerPool` 的 worker 模板必须设置 CPU/内存 `limits`。官方文档明确说：不设 limit 的维度被当成"无约束"，此时自定义调度器不会阻止超卖。

## 4. CubeSandbox

### 4.1 K8s 上的形态

| 层级 | 组件 | K8s 资源 | 职责 |
|---|---|---|---|
| 控制面 | CubeMaster | Deployment | 节点注册、模板分发、调度、元数据 |
| API | CubeAPI | Deployment | E2B 兼容 HTTP API |
| 计算面 | `cube-node` | DaemonSet（Big Pod，每节点一个） | 内含 `cubelet` + 内嵌网络运行时 |
| 产物安装 | `cube-node-installer` | DaemonSet | shim / kernel / guest 装到宿主机 toolbox |
| 节点引导 | `cube-node-bootstrap` | DaemonSet | 预检、写 `node-prep-ready` |
| PVM 宿主 | `cube-node-pvm` | DaemonSet（仅 PVM 节点） | host kernel 安装，可 reboot |
| 数据面 | CubeProxy + Cluster DNS | Deployment | `*.domain` 泛解析到沙箱 |

计算节点必须打 `cube.tencent.com/cube-node=true` 与 `cube.tencent.com/compute=true:NoSchedule`。Big Pod 只请求 `500m` CPU / `1Gi` 内存，真实 VM 容量不在 K8s accounting 内，所以节点必须专用。

### 4.2 快路径

```text
POST /sandboxes → CubeAPI → CubeMaster 过滤 + 打分选节点
                → Cubelet 用 CubeCoW 克隆模板 rootfs（FICLONE，O(1)）
                → shim 从内存快照恢复 VM
                → 应用 cgroup、接入 TAP、写 Redis 路由
                → 返回 sandbox id + IP
删除            → CubeMaster → Cubelet → shim 的 VM teardown
```

官方基准（Tencent BMI5，96 vCPU / 375 GiB，2 vCPU / 2 GiB 沙箱）：

| 场景 | 数值 |
|---|---|
| 串行创建 | 48ms（p95 57ms） |
| 20 并发吞吐 | 181 个/秒，摊销 5.5ms/个 |
| 从快照创建 | 64ms |
| resume | 42ms |
| 1000 个 2GiB 沙箱空载 | 约 25 GiB（CoW + 页共享） |
| pause（当前全量拷贝） | 558ms |

### 4.3 多阶段并发如何控制

**容量来源**

Cubelet 每秒上报 `quota_cpu`、`quota_mem_mb`、`max_mvm_num`、已分配量、磁盘水位。CubeMaster 在 quota 上乘超卖比例（默认 CPU 3、内存 2，可按实例类型覆盖）。

**多层过滤**

| 过滤器 | 判据 | 默认值 |
|---|---|---|
| `cpu` | quota 剩余 > 请求，且节点利用率 < `node_max_cpu_util` | 80% |
| `mem` | quota 剩余 > 请求，且 `MemMBTotal - MemUsage` > 请求 + 预留 | 预留 10GiB |
| `template_locality` | 目标节点有模板副本 | — |
| `realtime_create_num` | 节点实时创建数 < 上限 | Cubelet 上报或 100 |
| `disk` | 磁盘水位 | 80% |
| 节点 MVM 数 | `max_mvm_num` | 3000 |

**并发闸门**

- 每个实例类型一条 buffer queue 控制总并发。
- 每节点 `create_concurrent_limit` 默认 100。
- CubeMaster 用"本 master 的本地 in-flight 计数 × 健康 master 数"与节点上限比较。
- Cubelet 侧还有 `creation_concurrent_num` 的 engine flow limit。

**提交点**

CubeMaster 的选择是乐观的。没有一个跨副本的持久化 reservation ledger；真正的资源落账发生在 Cubelet 创建 VM、应用 cgroup 之后，再通过心跳汇总给调度器。失败会重试、换节点或清理。

**硬兜底**

- 每个 sandbox 的 cgroup v2 `memory.max` / `cpu.max` 限制 VM 与容器。
- VM 内存按需分配，配合 CoW 和页缓存，2GiB 沙箱空载时远小于 2GiB。
- 代码注释明确承认：创建调度是乐观的，resume 的 quota admission 在并发下可能瞬时超过 quota，OS/cgroup 是最后的硬防线。

**结论**

CubeSandbox 的设计目标是**有界超卖**。要接近严格零超卖，需要显式设置 `host.quota`、降低 `overcommit_ratio`、提高 `node_max_mem_reserved_in_mb`、压低 `creation_concurrent_num`，或者额外引入持久化预占账本。

## 5. 对比

| 维度 | Agent Substrate | CubeSandbox |
|---|---|---|
| K8s 调度单位 | `WorkerPool` → Deployment 的 worker Pod | 每节点一个 `cube-node` DaemonSet Big Pod |
| 沙箱单位 | Actor（数据库记录） | KVM microVM |
| 初始创建 | 只写 DB，首次请求时 resume | 同步创建并启动 VM |
| 热路径 | `ate-api-server` → `atelet` → `ateworker` restore | CubeMaster → Cubelet → shim restore |
| 容量来源 | worker Pod 的 cgroup limits - 自留内存；槽位 `--max-actors` | Cubelet 上报 quota / max MVM，再乘超卖比例 |
| 并发预留 | PostgreSQL 行锁事务，严格预占 | 并发闸门 + 物理余量，乐观创建 |
| 超卖模型 | 运行中资源不超卖；10–30x 来自 suspend 多路复用 | 显式超卖 CPU 3x / 内存 2x |
| 硬隔离 | gVisor / microVM + 每 Actor cgroup | KVM microVM + 每 sandbox cgroup |
| 每沙箱唯一 IP | 不需要，固定 `/30` 在 netns 内复用 | 需要，宿主机侧从 CIDR 分配 |
| 主要风险 | 池模板未设 limits 时容量不受限 | 1s 上报窗口 + 并发创建导致瞬时超卖；节点必须专用 |

## 6. worker Pod 在 K8s 视角是什么

Agent Substrate 的 worker Pod 是**普通 Deployment 管理的 Pod，未设置 `RuntimeClassName`**。Kata 在这里是作为 Go 库被 worker 进程调用（`cmd/ateworker-microvm/internal/kata`），用 Cloud Hypervisor 创建 VM，不经过 CRI 或 kubelet 创建 sandbox Pod。

概念映射：

| Kubernetes | Agent Substrate | 落地位置 |
|---|---|---|
| Node | Worker（worker Pod 的一条记录） | 一个普通 Pod |
| kubelet | `atelet` | 节点上的 DaemonSet |
| Pod | Actor | worker 容器里的子进程或 VM |
| kube-scheduler | `ate-api-server` 的 scheduler | 控制面，PG 行锁提交 |
| Node allocatable | worker 的 `capacity` | Pod `limits` 经 downward API |
| RuntimeClass | `sandboxClasses` + `SandboxConfig` | worker 镜像内部实现 |
| Cluster Autoscaler | `WorkerPool.replicas` | Deployment 副本数 |

细节：

- microVM 所需 `/dev/kvm` 作为扩展资源申请，由 `atelet` 的 device plugin 提供，不是 hostPath。
- `/dev/net/tun` 走 hostPath 字符设备 + `CAP_NET_ADMIN`。
- worker 容器以 root 运行，`privileged: false`，精简 capability 集，seccomp/AppArmor 为 Unconfined。
- `atelet` 通过宿主机共享目录 `/var/lib/ate/<node>/workers/<podUID>/worker.sock` 与 worker 通信，Unix socket，不走 Pod 网络。
- worker 注册成功后才 Ready；未注册则不接受调度。
- worker Pod 重启或被驱逐会中断其上所有正在运行的 Actor，但快照在对象存储或节点本地，可恢复到任意 worker。

## 7. 与 OpenSandbox 的对照

| Agent Substrate | OpenSandbox 对应物 | 是否等价 |
|---|---|---|
| worker Pod（`ateworker` + `atunnel`） | Pool Pod（sandbox 容器 + `execd`） | 定位相同：沙箱执行槽 + 节点内数据面入口 |
| `ateworker` 的 `Run/Restore/Checkpoint/Terminate` | `execd` 的 exec/files/metrics + containerd/shim 创建路径 | worker 还负责创建 VM 和快照，`execd` 不做 |
| `atelet` | 无等价物 | OpenSandbox 的调度和配额在 controller 与 server |
| `ate-api-server` scheduler + PG 行锁 | controller 的 allocator + `alloc-status` 注解 | 都是"把沙箱绑定到已预热 Pod" |
| `atenet-router` | `components/ingress` 或 server proxy | 都是入口路由；router 还能按请求触发 resume |
| `atunnel` | `execd` 的 `/proxy/{port}` | 都是容器内端口暴露到外层 |
| `WorkerPool` CRD → Deployment | `Pool` CRD → PodTemplate + `replicas` | 形态相同 |

关键差异在沙箱与 Pod 的基数关系：

- OpenSandbox Pool 模式是 **一个 sandbox = 一个 Pod**：控制器把 Pod 从 Pool 分配给 BatchSandbox 写进 `alloc-status`，server proxy 只是把请求转到那个 Pod 的 `execd`。
- Agent Substrate 是 **一个 worker Pod 承载最多 1000 个沙箱**。OpenSandbox 靠 Pod 边界和 ResourceQuota 保证隔离与配额；Substrate 靠 worker 内部为每个 Actor 建独立 cgroup，K8s 完全看不到。

## 8. VIP / 网段约束

区分两种"VIP 网段"：

### 8.1 K8s Service 的 ClusterIP/VIP 网段

两家的沙箱都不拿 ClusterIP。Agent Substrate 的 Actor 通过 router + worker Pod IP + `atunnel` 访问；CubeSandbox 通过 CubeProxy + 节点 IP/端口映射访问。

但 sandbox 内部使用的 CIDR 不能和 Service CIDR 重叠：

- CubeSandbox 在 Helm 安装前有 `cubevs-cidr-preflight` 钩子，`CUBE_SANDBOX_NETWORK_CIDR`（默认 `172.16.0.0/18`）与 Service CIDR 重叠会直接失败。原因是 `cube-node` 会把整个 sandbox CIDR 的路由指向 `cube-dev`，重叠会把 ClusterIP/DNS 黑洞掉。
- Agent Substrate 的每个 Actor 用固定 link-local `/30`（`169.254.17.0/30`），不会碰 Service CIDR；worker Pod 的 Pod CIDR 仍需与 Service CIDR 分开，这是 K8s 本身的约束。

### 8.2 每沙箱一个虚拟 IP 的地址池

**Agent Substrate：不按 Actor 分配唯一 IP。**

- 每个 Actor 有自己的 network namespace，复用同一组点对点地址：Actor 侧 `169.254.17.2/30`，网关 `169.254.17.1`。
- K8s 层面只消耗 worker Pod 的 IP。密度上限是 worker 数 × `--max-actors` 以及 CPU/内存。
- 真正的网络瓶颈在内核邻居表：超过约 1000 个沙箱需要调大 `net.ipv4.neigh.default.gc_thresh1/2/3`（例如 4096/16384/32768）。

**CubeSandbox：每个 sandbox 消耗一个唯一的宿主机侧 IP。**

- guest 内是固定的 `169.254.68.6/30`，但宿主机侧每个 TAP 从 `CUBE_SANDBOX_NETWORK_CIDR` 分配唯一 IP，由 Cubelet 的 bitmap IPAM 管理。
- 掩码只允许 `/16` 到 `/24`。默认 `/18` 有 16,384 个地址，减去网络地址、网关、广播约 16,381 个可用；`/24` 只剩 253 个。
- `tap_init_num`（默认 500）预创建 TAP 池，目标密度超过它必须调大。
- IP 分配失败返回 `ip exhausted`，不会因为 CPU/内存还够就继续创建。

| 维度 | Agent Substrate | CubeSandbox |
|---|---|---|
| 每 Actor/Sandbox 唯一 IP | 不需要 | 需要 |
| 地址池耗尽 | 不会按 Actor 耗尽 | 会，`/18` 约 1.6 万/节点，`/24` 仅 253/节点 |
| K8s IP 消耗 | 每个 worker Pod 一个 | 每个 `cube-node` Pod 一个 |
| 其他网络上限 | `--max-actors`、内核邻居表 | `tap_init_num`、SNAT 端口/会话表、CIDR 大小 |

## 9. 对 OpenSandbox 的启示

1. **热路径不要为每个沙箱创建 Pod**。Pool 预热与 BatchSandbox 方向正确，关键是让节点代理直接管理执行单元，绕开 Pod 的异步收敛。
2. **自定义调度器需要原子提交点**。数据库或 Redis 里的预占记录，配合行锁或版本号。只靠周期性指标加并发限流，会留下超卖窗口。
3. **K8s 层的资源账要和自定义调度器对齐**。要么让 worker Pod 的 requests/limits 覆盖它承载的沙箱容量（Agent Substrate 的做法），要么用专用节点和污点把节点从 K8s 通用调度里隔离出来（CubeSandbox 的做法）。两边各算一套账时，超卖和驱逐会同时出现。
4. **网络地址规划是密度设计的一部分**。如果采用"每沙箱一个唯一 IP"的模型，需要提前确定 CIDR 大小、与 Service/Pod/VPC 的关系，以及单节点地址池规模；复用固定 link-local 地址的模型可以把这一约束移到内核参数上。
5. **把 pause/suspend 当作密度杠杆**。Agent Substrate 的 10–30x 来自把空闲 Actor 换出内存；CubeSandbox 的自动暂停恢复是同一思路。它们的价值在空闲占比高的 agent 负载上，不在持续计算型任务上。

## 10. 参考

- Agent Substrate 架构文档：`docs/concepts/architecture.md`、`docs/concepts/request-parking.md`、`docs/reference/api-guide.md`
- Agent Substrate 调度实现：`cmd/ateapi/internal/scheduling/scheduling.go`、`cmd/ateapi/internal/controlapi/workflow_resume.go`、`cmd/ateapi/internal/store/atepg/worker_assignment.go`
- Agent Substrate worker 形态：`cmd/atecontroller/internal/controllers/workerpool_apply.go`、`internal/ateworker/register/register.go`
- CubeSandbox 产品架构：`docs/zh/architecture/overview.md`、`docs/zh/architecture/network.md`
- CubeSandbox K8s 部署：`docs/zh/guide/kubernetes/architecture.md`、`docs/zh/guide/kubernetes/index.md`
- CubeSandbox 调度配置：`docs/zh/guide/cubemaster-scheduler-config.md`、`CubeMaster/pkg/base/config/config.go`、`CubeMaster/pkg/selector/filter/`
- CubeSandbox 性能基准：`docs/blog/posts/2026-06-01-cubesandbox-perf-benchmark.md`
- OpenSandbox 对照：`kubernetes/apis/sandbox/v1alpha1/pool_types.go`、`kubernetes/internal/controller/allocator.go`、`server/opensandbox_server/api/proxy.py`、`components/ingress/README.md`
