# OpenSandbox 上游 Open Issues 风险调研 ——「禁止暂停/恢复」场景

> 调研时间:2026-08-13
> 数据源:`opensandbox-group/OpenSandbox` 全部 open issues(约 90 个,gh CLI 拉取)
> 前提:OpenSandbox 实际为无状态沙箱,不支持 pause/resume,集成方案不依赖该能力。本调研只关注**与暂停/恢复无关**或**在禁用该能力后依然存在**的缺陷与风险,重点评估上规模后的影响。

## 结论速览

- 禁用 pause/resume 只绕开了少量直接依赖它的缺陷(#1366、#1422、#1169、#1448、#1457),**绝大多数规模化风险与暂停/恢复无关,禁用也躲不掉**。
- **最严重**:Kubernetes Pool 模式下存在一组未修复的复合缺陷(#1423 + #954 + #1433),上规模后会导致 Pod 创建/删除风暴、50% 创建失败、沙箱永久不可用。
- **「沙箱挂了自动拉起」目前不存在**:上游明确 resume 只恢复 Paused 状态,Terminated/Failed 不自动重启;重建 = 新 sandbox ID + 内存/未持久化状态丢失。
- **快照(snapshot)作为替代方案也有坑**:带 egress sidecar(即启用 network_policy)的沙箱**无法快照**(#1382);快照删除不清理 registry 镜像(#1179)。

## 一、P0:规模化致命缺陷(与暂停/恢复无关)

### 1. #1423 Pool 控制器热循环 + 缩容震荡(2026-07-30,无 PR)

六重缺陷复合成的自维持 Pod 创建/删除风暴:

- 每分钟**创建 ~2250 / 删除 ~2290 个 pool Pod**,~1300 个 Pod 永久 Pending,`status.Available` 卡在 0;
- 约**一半** `POST /v1/sandboxes` 失败(`KUBERNETES::POD_READY_TIMEOUT`);
- **重启控制器无效**,~15 分钟复发。

缺陷链条要点:

1. Helm chart 出的 CRD 缺字段,触发额外 reconcile;
2. supplyCnt 驱动无界扩容;
3. Pending Pod 被计入 bufferCnt 触发缩容;
4. 缩容无速率限制;
5. **Terminating Pod 对 scaler 不可见**:`totalPodCnt` 排除了 `DeletionTimestamp` 非零的 Pod,但 Pod 仍占节点资源 → `PoolMax` 不约束真实占用(kata-qemu 下窗口几十秒/个,实测 poolMax=1000 时命名空间里有 1355 个 Pending Pod);
6. **缩容优先删刚 Ready 的 Pod**:idle Pod 按 CreationTimestamp 升序删,长启动时间下"最旧空闲"= "刚启动完的",正好把可服务的 buffer 删掉,留下 Pending。

**上规模影响**:pool 越大越容易触发;一旦触发,创建大面积失败且自我维持。当前无修复 PR。

### 2. #954 BatchSandbox 分配的 Pod 被删后永不重绑(2026-06-12,无 PR)

Pool 模式下,分配到的 Pod 被外部删除(手动删除/节点驱逐/OOM Kill)后,`alloc-status` 注解中的 Pod 名残留 → `supplement = replicas - len(allocated)` 恒为 0 → **沙箱永久不可用**,`allocated: 0, replicas: 0` 永不恢复。源码中有 `// TODO consider supply Pods if Pods is deleted unexpectedly`。

**这是「挂了自动拉起」缺失的直接证据,恰好在规模化场景最常见(节点驱逐、OOM)。**

### 3. #1433 poolRef 可变更 → in-use Pod 被杀 + 永久饿死(2026-08-04,无 PR)

三个 CRD 均无 `x-kubernetes-validations`,也无 admission webhook。运行中把 `spec.poolRef` 从 A 改到 B 会触发破坏链:

1. Pool A 把 in-use Pod 当孤儿回收(默认 delete)→ 杀工作负载;
2. `alloc-status` 注解不清 → 新 Pool B 计算 `supplement=0`,永不分配;
3. BatchSandbox 状态假报 `allocated: 1`、`Progressing=True / "Sandbox is being created"`,无任何事件说明。

与 #954 同根(stale annotation 机制)。作者声明已有本地修复(CEL 规则 + 测试)并"马上开 PR",但截至调研无 open PR。

## 二、P1:规模化显著风险

### 4. #1472 SDK releaseAllIdle 串行释放(2026-08-11,无 PR)

Kotlin/Python/Go SDK 的 `releaseAllIdle` 都是**严格串行** kill:**500 个空闲沙箱 ≈ 480s(~1s/个)**;并行 50 并发可压到 ~150s/477 个且零失败。上规模后批量清理是明确瓶颈。

### 5. #969 BatchSandbox Ready 严重滞后于 Pod Ready(2026-06-04,无 PR)

批量 128 个 sandbox 实测:

| 指标 | P50 | P90 | P99 |
|---|---|---|---|
| READY_TO_BSB(Pod Ready → BSB Ready) | 26s | 35s | 40s |
| BSB_DELAY(创建 → Ready) | 44s | 56s | 60s |

主要耗时不在 Pod 调度/启动,而在 Pod Ready 之后到 BSB Ready 之间(约 68% 超过 20s)。上规模后"沙箱可用时间"被系统性拉长,且无明确等待原因暴露。

### 6. #1409 egress 指标错误归因 → 指标基数爆炸(2026-07-28,无 PR)

`egress.system.memory.usage_bytes` / `egress.system.cpu.utilization` 实际读的是**节点**的 `/proc/meminfo`、`/proc/stat`,却按 `sandbox_id` 打标签 → **N 个沙箱发布 N 条完全相同的节点级序列**。30 个沙箱/节点 = 30 条假"per-sandbox"序列。上规模后监控成本暴涨且误导。

### 7. #1408 server 无自监控(2026-07-28,无 PR)

Lifecycle server 只导出**一个**指标 `sandbox.create.duration`,而且那是 **SDK 客户端**上报的(`POST /metrics/events` 转发),不度量 server 自身:

- 不用 SDK(直连 REST)的部署**一个指标都没有**;
- `SandboxErrorCodes` ~40 种失败模式(镜像拉取失败、execd 启动失败、pod ready timeout、pool not found……)**零计数**;
- 无生命周期操作计数、无 server 实测耗时、无 live sandbox 数量。

**上规模后故障在指标层完全不可见,只能翻日志。**

### 8. #1450 BatchSandbox 状态与底层 Pod 脱钩(2026-08-12,无 PR)

底层 Pod OOM 被 K8s 重启后(文件系统/内存/CPU 已重置),BatchSandbox 状态仍保持 `Succeed`,误导用户。上规模后 OOM/重启频发,误报面扩大。

## 三、P1:长期运行的稳定性 / 资源泄漏

### 9. #1386 server 运行约 1 周后 httpx 连接池耗尽(2026-07-27,无 PR)

大面积使用方反馈:运行一周左右出现 `httpcore.PoolTimeout`(AsyncClient 连接池满),且**当时并发只有 1-5**,不应排队。疑似连接回收异常/泄漏。**上规模 + 长期运行必炸**,当前无方案。

### 10. #1179 K8s snapshot 删除不清理 registry OCI 镜像(2026-07-03,无 PR)

删除 `SandboxSnapshot` CR 只删 CR + Job,推送到 registry 的 OCI 镜像**永不删除**(Docker 后端正确调用 `docker images.remove`)。孤儿镜像无限累积 → 存储泄漏。

### 11. #1199 PVC ownerReferences 附着失败(2026-07-06,无 PR)

`patch_pvc` 传了 k8s python client 不支持的 `_content_type` 参数 → patch 抛异常被静默吞掉 → ownerReferences 缺失。后果:**直接 `kubectl delete BatchSandbox` 或 TTL 过期自动删除时 PVC 泄漏**(API 删除路径靠 label 清理,不受影响)。

### 12. #1370 egress sidecar 独立重启后 mitmproxy CA 轮换,agent HTTPS 全断(2026-07-22,无 PR)

- mitmproxy confdir 在容器 ephemeral layer(`/var/lib/mitmproxy`),不在共享卷 → **egress 容器每次重启都重新生成根 CA**;
- agent 端 bootstrap 一次性安装 CA,无 watcher;
- 结果:egress 容器单独重启(restartCount++)后,agent 所有 HTTPS 失败(`unable to get local issuer certificate`),直到 agent 自身重启。Docker/K8s 运行时而均受影响。

**启用 egress MITM(即 Credential Vault 注入)就会踩到,上规模后 egress 重启概率随之上升。**

### 13. #1403 execd 命令内核无限保留(2026-07-28,无 PR)

`commandClientMap` 中已知 ID 的 command kernel 在 controller 进程生命周期内不回收,terminal 条目可保留已提交命令内容(#1308 的有界 inventory 故意不驱逐 legacy map)。内存与命令内容留存无上界。

## 四、P2:SDK / 交互缺陷

### 14. #1010 JS SDK `getBackgroundCommandLogs` 静默期抛异常(2026-06-15,无 PR,0.1.5/0.1.7/0.1.8 均复现)

cursor ≥ 当前 buffer 长度时(命令运行中静默期、退出后最后一次 drain、cursor 过大)抛 `unexpected response shape`。**日志轮询的常规用法(每隔 1s 拉一次)会高频触发**。JS 集成需包 try/catch 兜底。

### 15. #1470 server proxy 重复 Date/Server 响应头(2026-08-11,无 PR)

后端返回的 `Date`/`Server` 头未被 hop-by-hop 过滤排除,Uvicorn 自身又生成一份 → 客户端收到两份 `Date`/两份 `Server`。影响 `/v1/sandboxes/{id}/proxy/{port}/` 代理。

### 16. #853 Go 组件在 aarch64 64KB page 内核崩溃(2026-08-12,无 PR)

execd/ingress/egress 的 Go 二进制 4KB PT_LOAD 对齐,在 `CONFIG_ARM64_64K_PAGES=y`(Grace Hopper、Neoverse-V2、aarch64+64k 内核)上直接崩溃。影响 ARM 异构集群调度。

### 17. #1127 / #1328:容器被终止后无法恢复,「自动拉起」不存在(2026-08-12)

Docker 容器被手动终止(模拟意外终止)后,SDK `resume` 报 **409 Conflict**;上游 PR #1483 澄清:**resume 只恢复有意的 Paused 状态,不重启 Terminated/Failed**;Docker 无重启策略;重建后 sandbox ID 变化,进程内存与未持久化 FS 丢失;原 TTL 不重置,新实例从新请求重新计时。

## 五、快照替代方案的额外坑(与禁止暂停/恢复直接相关)

| Issue | 问题 |
|---|---|
| **#1382** | 带 egress sidecar(启用 network_policy)的沙箱 **无法 snapshot/pause**:commit Job 对 pod 每个容器(含 egress)提交+推送,egress 基础镜像为多平台 manifest,`nerdctl push` 单平台化失败(`content digest ... not found`)→ Snapshot `Failed`/`PauseFailed`。**几乎所有真实工作负载(有网络隔离)都无法快照**。 |
| #1179 | snapshot 删除不清理 registry 镜像(存储泄漏),失败快照还会残留已推送的 `-sandbox` 镜像。 |
| SDK 行为 | `create_snapshot` 返回 `Creating`,不阻塞到 Ready,需轮询 `get_snapshot().status.state`。 |

## 六、对集成方案的规避建议

1. **不要假设任何自动恢复**。挂了 = 重建,ID 变化,内存/未持久化状态丢失。业务关键状态必须外置(快照或外部存储)。"自动拉起 + 保 ID + 保状态"在当前上游语义下不可实现。
2. **Pool 模式慎用**。先用 envtest/live 集群验证 #954、#1433 修复是否已合入(当前无 PR);CR 创建后禁止改 `poolRef`;预留 buffer 避免 #1423 震荡(小 pool、固定容量、关闭自动缩容可规避大部分触发面)。
3. **批量释放自实现并发受限 kill**(如 50 并发),不要用 SDK 串行 `releaseAllIdle`(#1472)。
4. **快照方案注意**:目标沙箱不能有 `network_policy`(#1382);快照后自行清理 registry 镜像防泄漏(#1179);创建后轮询 Ready。
5. **Server 运维**:长期运行建议监控 httpx 连接池并周期性重启 server(#1386);自建 server 侧指标,不要依赖自监控(#1408)。
6. **JS/TS 集成**:日志轮询 `getBackgroundCommandLogs` 必须 try/catch `unexpected response shape`(#1010)。
7. **egress MITM(credential vault)场景**:警惕 egress 容器独立重启导致的 CA 轮换断连(#1370),agent 侧需监听 CA 指纹变化或避免 egress 单容器重启。

## 附:依赖 pause/resume、禁用后可忽略的 issues

#1366(egress credential vault 在 pause/resume 中丢失)、#1422(Docker 下 egress 随沙箱 pause/resume)、#1169(基于 volume 的 pause/resume)、#1448(自动 idle-pause/resume-on-revisit)、#1457(改进 K8s resume 延迟)——均为功能请求或仅作用于被禁用的能力,不构成禁用场景下的风险。

## 数据来源

- 上游仓库 `opensandbox-group/OpenSandbox`,gh CLI 拉取全部 open issues(2026-08-13)。
- 关键 issue:#1423、#954、#1433、#1472、#969、#1409、#1408、#1450、#1386、#1179、#1199、#1370、#1403、#1010、#1470、#853、#1127、#1328、#1382。
- 修复状态:经 `gh search prs` 检查,上述缺陷均无关联 open PR。
