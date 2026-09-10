# 池化模式故障排查 Runbook

> 日期：2026-09-03 ｜ 适用：K8s 池化部署（Pool 预热 + BatchSandbox 认领 + taskTemplate 派发），无 pause/resume。
> 用法：先跑 §0 取证命令包，再到对应章节对号入座。所有结论基于 2026-09-03 代码核实（依据清单见文末）。

---

## 0. 取证命令包（值班第一步）

```bash
NS=opensandbox; ID=<sandboxId>   # 换成实际值

# 沙箱现在什么状态（state/reason/message/allocation 一把抓）
curl -s -H "Authorization: Bearer $API_KEY" $SERVER/sandboxes/$ID | jq '{status, allocation, expiresAt}'

# 找到沙箱对应的 CR 和 Pod
kubectl get batchsandbox -n $NS -l opensandbox.io/id=$ID
kubectl get pods -n $NS | grep <batchsandbox名字>

# 池子还剩多少货、滚动到哪个版本了
kubectl get pool -n $NS -o custom-columns='NAME:.metadata.name,TOTAL:.status.total,ALLOC:.status.allocated,AVAIL:.status.available,UPD:.status.updated,REV:.status.revision'

# Pod 出了什么事
kubectl describe pod <pod> -n $NS | sed -n '/Events:/,$p'
kubectl logs <pod> -n $NS --all-containers --tail=50

# Pod 里的两个关键组件还活着吗
kubectl exec <pod> -n $NS -c sandbox -- sh -c \
  'wget -qO- -T2 localhost:5758/health && echo && netstat -ltn | grep -E "5758|44772"'
```

---

## 1. 创建沙箱时就报错

### 1.1 报 400，提示 Pool mode does not support volumes / networkPolicy / platform
**怎么回事**：池化 Pod 是提前造好的，创建请求里这几样东西没法"现挂"到已造好的 Pod 上，server 直接拒收。这不是故障，是规则。
**怎么办**：请求里去掉这些字段。想给所有沙箱统一挂卷/配网络 → 写进 Pool 模板；想每次创建传点不一样的（用户信息、token、配置）→ 走 `env` 注入。参考[卷类型实践](opensandbox-pool-mode-volumes-and-storage-practice.md)。

### 1.2 创建请求挂住，最后报 429 KUBERNETES::POOL_CAPACITY_EXHAUSTED
**怎么回事**：池子里没现成 Pod 了（BatchSandbox 一直等不到可认领的 Pod）。server 默认等 30 秒（`pool_acquisition_timeout_seconds`），等不到就返回 429 并带 Retry-After。
**怎么办**：`kubectl get pool` 看 `available` 是不是 0。是 0 → 扩池（`PUT /pools/{name}` 调大 capacitySpec）或扩节点；业务侧按 Retry-After 退避重试。如果 429 频繁出现，说明 buffer 参数偏小或峰值估算不足，按[容量规划 SOP](opensandbox-capacity-planning-and-loadtest-sop.md) 重新画像。

### 1.3 报 400，提示 unschedulable
**怎么回事**：池模板里写的调度约束（指定 os/arch、nodeSelector）在集群里找不到能接的节点。
**怎么办**：`kubectl describe pod` 看 FailedScheduling 的具体原因；要么改模板约束，要么给节点补 label。

### 1.4 报 504 K8S_POD_READY_TIMEOUT
**怎么回事**：Pod 认领到了但一直没就绪，超时（默认 60 秒）。**看报错里 "Last state" 是什么**，按 §2 继续。
**怎么办**：Last state = Allocated → Pod 有 IP 但没 ready，多半是业务启动慢或探针没配好；Last state = Pending → 看 §2 的镜像/initContainer 问题。

---

## 2. 沙箱迟迟不就绪

| Pod 上的表现 | 怎么回事 | 怎么办 |
|---|---|---|
| ImagePullBackOff | 镜像拉不下来：内网 registry 地址错、缺 secret、mirror 没生效 | 池模板加 `imagePullSecrets`；核对 registry 地址与集群 mirror 配置 |
| initContainer 失败（task-executor-installer / execd-installer） | 安装镜像里的二进制路径和安装命令对不上 | `kubectl logs <pod> -c <安装容器名>` 看具体报错，对照官方样例模板改 |
| 容器跑起来了但 5758 没监听 | task-executor 没起来：主容器启动命令写错 | 模板里 command 应该是 `task-executor -listen-addr=0.0.0.0:5758 ...`；`kubectl logs` 看 PID1 报错 |
| 5758 通，但任务派下去没反应 | **网络策略把管理面到 Pod 5758 的路拦了**（最常见坑） | NetworkPolicy 必须放行 controller/server → 沙箱 5758 的入向。实测不放行任务派发全军覆没 |
| 44772（execd）不通 | 任务没派发成功，或 bootstrap 起 execd 失败 | 先看 BatchSandbox 的 task 状态确认任务是否下发了；再看 Pod 里 task-executor 的日志和任务目录（默认 `/var/lib/sandbox/tasks`，模板里也可能写 `-log-dir=/tmp`） |

---

## 3. 删除、回收、释放的问题

### 3.1 Pod 一直 Terminating 删不掉
**怎么回事**：Pod/BatchSandbox 带着 `pool.sandbox.opensandbox.io/pool-allocation` 这个 finalizer，要先走完"归还给池"的流程才能真删。**多半是 controller 挂了或没选主**，不是 Pod 本身的问题。
**怎么办**：先看 controller 部署状态和日志（`kubectl get deploy -n opensandbox-system`）。**不要手工摘 finalizer**——池子的账目（available 数）会和实际对不上，后面分配会出鬼。恢复 controller 它自己会收尾。

### 3.2 删了沙箱，池子 available 没涨回来
**怎么回事**：回收要删 Pod、池子再补货，有 1~2 个轮询周期的延迟，正常。
**怎么办**：等一两分钟再看。一直不涨 → 看 controller 日志里 alloc-release 相关报错。

### 3.3 任务明明失败了，沙箱状态还是 Running
**怎么回事**：上游已知问题（issue #1662），池化下任务失败不影响沙箱状态。
**怎么办**：业务轮询结果用 BatchSandbox 的 `status.taskSucceed / taskFailed`，别依赖沙箱 state。

### 3.4 沙箱自己消失了
**怎么回事**：到 `expiresAt` 了（TTL 到期自动删）。如果业务以为配了"访问自动续约"却没生效，检查三件事：创建时带了 `extensions.access.renew.extend.seconds`、server 配置 `[renew_intent] enabled=true`、业务流量确实走 server proxy（直连不触发续约）。
详见[沙箱续约机制](opensandbox-sandbox-lease-and-manual-cleanup.md)。

---

## 4. 数据串了、配置没生效

### 4.1 新任务进来，能看到上一个任务留下的文件
**怎么回事**：Pool 的回收策略是 `Restart`（容器重启而不是删 Pod）。emptyDir 这种 Pod 级卷**容器重启不会清空**，上一个用户的数据就留给了下一个。
**怎么办**：任务型池一律用默认的 `Delete` 策略。已经用了 Restart 的，评估数据暴露面并让任务入口先清工作目录。详见[卷类型实践 §4](opensandbox-pool-mode-volumes-and-storage-practice.md)。

### 4.2 创建时传的 env 没出现在沙箱里
**怎么回事**：创建请求里 env、entrypoint、execd_run_as_init 三样**一个都没带**时，走的是"零修改认领"快路径——什么都不注入，这是设计如此。
**怎么办**：需要注入就至少带一个（通常带 env）。见[分配时注入调研](opensandbox-pool-allocation-time-injection.md)。

### 4.3 改了池模板，跑着的沙箱没变化
**怎么回事**：模板更新只重建**空闲** Pod，按 updateStrategy（默认 25%）分批滚动，在用的 Pod 要等归还后才换新。
**怎么办**：看 Pool 的 `status.updated / revision` 确认滚动进度；着急就评估后手动 evict 空闲旧版本 Pod。详见[模板更新与分配行为](opensandbox-pool-template-update-and-allocation.md)。

### 4.4 升级后 taskTemplate 里的新字段（如 lifecycle）不见了
**怎么回事**：旧版 controller（≤ v0.2.0）处理 CR 时会**悄悄丢掉它不认识的字段**，不报错。
**怎么办**：升级 controller 到含 #420 的版本（`controller.image.tag=latest`）；检测和回滚注意事项见[升级 SOP §4](opensandbox-upgrade-compat-sop.md)。

---

## 5. 性能与规模

| 现象 | 怎么回事 | 怎么办 |
|---|---|---|
| controller 日志刷限流退避、apiserver 报 429 | controller 或 server 对 apiserver 的请求速率顶到限速值 | 调 `controller.kubeClient.qps/burst`（helm values）；server 侧 `[kubernetes] read_qps/write_qps`。注意 0 = 不限速，别盲目放开打爆 apiserver |
| create 延迟越来越长 | 池子补货速度跟不上消耗（补货受 maxUnavailable 25% 分批 + 镜像拉取 + 节点容量限制） | 按[容量规划 SOP](opensandbox-capacity-planning-and-loadtest-sop.md) 实测补货曲线，调 bufferMax/scaleStrategy |
| 大量沙箱时 GET /sandboxes 变慢 | 全量 list + 逐个映射 | 用 state/metadata 过滤缩小结果集；确认 server informer 缓存开着（`[kubernetes] informer_enabled`） |

---

## 附：依据（代码核实清单，2026-09-03）

- 创建拒绝/等待/超时逻辑：`server/opensandbox_server/services/k8s/kubernetes_service.py`（等待循环）、`batchsandbox_provider.py`（池化拒绝、状态推导）
- 错误码：`services/constants.py:123`（`KUBERNETES::POOL_CAPACITY_EXHAUSTED`）、`K8S_POD_READY_TIMEOUT`
- allocation 判定：`services/k8s/workload_mapper.py`
- 回收策略与 Restart 行为：`kubernetes/apis/sandbox/v1alpha1/pool_types.go`、`internal/controller/recycle/`
- task-executor API 与数据目录：`kubernetes/internal/task-executor/server/router.go`、`examples/task-executor/README`
- 上游已知问题：#1662（任务失败状态）、#1433（poolRef 修改杀在用 Pod）
