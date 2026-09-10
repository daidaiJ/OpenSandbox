---
name: execd-command-vs-k8s-exec-and-egress-isolation
description: execd /command 与 K8s pods/exec 命令执行通道对比；egress 同 namespace 沙箱互隔离能力，以及 FQDN 之外能否做到 HTTP 路由前缀匹配
type: project
---

# execd 命令执行 vs K8s exec，以及 egress 同 ns 隔离与路由前缀

> 调研日期：2026-09-03
> 背景：池化主路径上同时存在「execd 命令 API」与「业务侧封装的 K8s `pods/exec` 进主容器」两条执行通道，需要分清设计和功能边界。网络侧需要确认：egress 能否隔离同 namespace 多沙箱 Pod，以及 FQDN 之外能否做到 HTTP 路由前缀匹配。
> 相关：命令注入时机见 [池化分配时间点动态注入](opensandbox-pool-allocation-time-injection.md)；出向分层见 [池化出向管控与 Higress](opensandbox-egress-pool-higress-architecture.md)；隔离选型见 [NetworkPolicy vs Egress](opensandbox-k8s-networkpolicy-vs-egress-sidecar.md)。业务决策 D-7（池化去 sidecar、改 NetworkPolicy）见根目录 `MEMORY.md`。

## 结论速览

1. **execd `/command` 是沙箱内应用级执行面；K8s `pods/exec` 是集群控制面直接进主容器。** 都能在沙箱里跑命令，但通道、进程模型、生命周期和安全边界不同。K8s exec **绕过** execd 的 hardening / session / launcher。
2. **egress 能挡住同 namespace 沙箱互访**，靠的是每边出站 default-deny + `deny.always` 拦 Pod/Service CIDR，不是按 `sandbox_id` 精细选邻接 Pod。egress **不管入站**。
3. **egress 到不了 HTTP 路由前缀。** FQDN 之外只到 IP/CIDR（且仅 `dns+nft`）。路径级 allow/deny 由 Higress（或 Cilium L7）承担。Credential Vault 的 `paths` 只用于凭据注入，不是流量阻断。

---

## 一、execd `/command` vs K8s `pods/exec`

### 1.1 定位

| | execd `/command` | 业务封装的 K8s exec（`pods/exec` 进主容器） |
|---|---|---|
| 控制点 | 沙箱 **内部 daemon**（`execd`，默认 `:44772`） | **kube-apiserver → kubelet → CRI attach** |
| 调用路径 | SDK / CLI →（可选 server proxy）→ execd HTTP | 业务接口 → K8s API → 主容器进程 |
| 是否经过 execd | 是 | **否，绕过 execd** |
| 协议 | HTTP JSON + **SSE** | SPDY / WebSocket 字节流 |
| 命令形态 | 一条 **shell 字符串**，内部 `bash -c` / `sh -c` | 通常是 **argv 数组**（要 shell 需自己包 `sh -c`） |
| 契约 | `specs/execd-api.yaml`（`POST /command`） | K8s 核心 API `pods/exec` 子资源 |
| 本仓库对外 API | SDK `commands.run`、CLI `osb command run` | lifecycle **无**对外 exec；S3 中间层等用**内部**静默 exec |

execd 实现把 `command` 交给 shell（`components/execd/pkg/runtime/command.go`）：

```go
shell := getShell()
cmd := exec.CommandContext(ctx, shell, "-c", request.Code)
```

K8s exec 是容器运行时在指定容器里直接 `exec` 新进程，不经过 execd 的 launcher / session / hardening。

池化路径上还有第三条通道：**taskTemplate → task-executor**（分配时已知参数、一次性任务）。与「运行中多次命令」的 execd、以及「绕过 execd 的控制面 exec」都不同。见 [分配时间点注入](opensandbox-pool-allocation-time-injection.md)。

### 1.2 功能对比

**execd `/command` 有、K8s exec 没有（或要业务自己造）：**

| 能力 | 说明 |
|---|---|
| 结构化生命周期 | SSE 事件：`init` / `stdout` / `stderr` / `error` / `execution_complete` |
| 状态与日志 | `GET /command/status/{id}`；后台日志 `GET /command/{id}/logs`（line cursor） |
| 前台 / 后台 | `background: true` 时 stdin 接 `/dev/null`，进程组独立，客户端断开后仍可查 status/logs |
| 服务端超时 | `timeout`（毫秒）；到期对**整个进程组 SIGKILL** |
| 按次身份 | 请求级 `uid` / `gid`、`envs`、`cwd` |
| 中断 | `DELETE /command?id=` |
| 有状态 shell | `POST /session` + `/session/{id}/run`（cwd/env 跨多次保留） |
| 交互式终端 | `/pty` WebSocket（resize / signal / viewer / replay）。`/command` **没有 stdin**，对得上 `kubectl exec -it` 的是 PTY，不是 `/command` |
| 隔离会话 | `/v1/isolated/session`（bwrap 命名空间） |
| 同进程配套 | 文件系统、代码解释器、metrics，SDK 一套走完 |
| hardening | 开启后 `/command` 走 `opensandbox-launcher`（丢 cap、seccomp、Landlock、剥 execd 凭据）。见 `docs/components/execd.md` |

**K8s exec 有、execd `/command` 弱或没有：**

| 能力 | 说明 |
|---|---|
| 双向 stdin + TTY | `/command` 是单向跑命令；交互必须另走 `/pty` |
| 指定容器 | 可打主容器 / sidecar / task-executor；execd 只活在装了它的那个容器里 |
| 不依赖 execd 存活 | execd 挂了仍能进容器（排障、写文件、拉起脚本） |
| 分配后才知道的信息 | Pod IP、分配状态、Ready 后再注入——taskTemplate 替代不了的场景 |
| 原生 argv | 少一层 quoting；execd 必须处理 `bash -c` 转义 |
| 集群审计 / RBAC | 走 `pods/exec`，kube-apiserver 审计天然有；execd 是沙箱 token + 应用日志 |

K8s exec **没有**后台任务句柄、服务端 timeout、status/logs 轮询、结构化 SSE。客户端一断流，进程通常吃到 SIGHUP（除非命令里自己 `nohup`/`disown`）。timeout、uid、env 都要业务接口自己包。

### 1.3 设计差异（选用时更关键）

1. **安全边界**  
   K8s exec 进主容器 = 容器里的完整用户态，**绕过** execd hardening / Landlock / isolated session。同一条 `curl` 或写文件，走 execd 可能被 seccomp/Landlock 拦住，走 exec 则按镜像用户原样跑。

2. **产品面 vs 控制面**  
   execd 给 **agent / SDK 用户**（多语言对齐、`osb command run`）。K8s exec 给 **平台**（注入、修复、S3 中间层内部 exec、task-executor 旁路）。不要把 K8s exec 当用户命令通道：RBAC 面太大，且绕过沙箱执行策略。

3. **资源与隔离模型**  
   execd 给每个 command 建进程组、可后台、可中断、可超时。K8s exec 是一次 attach 会话；并发、泄漏、僵尸进程要业务接口自己管。

4. **池化三条通道怎么选**

| 场景 | 推荐 |
|---|---|
| agent 跑命令、流式输出、后台、超时、SDK | **execd `/command`**（交互用 `/pty`） |
| 创建时已知参数、分配时注入一次 | **taskTemplate → task-executor**（不必 execd 也不必 k8s exec） |
| execd 未就绪 / 要绕过 hardening / 指定容器 / 分配后才知道的信息 | **K8s exec** |

---

## 二、egress：同 namespace 沙箱互隔离，以及路由前缀

### 2.1 同 namespace 多 Pod 怎么隔

K8s 默认 **同 namespace 全通**。egress **不管入站**，靠每边 **出站 default-deny + 拦集群 CIDR** 做成“彼此连不上”：

- 平台级：`/var/egress/rules/deny.always` 写上 **Pod CIDR + Service CIDR**（优先级高于用户策略，用户盖不掉）。热加载见 `components/egress/pkg/policy/always_rules.go`。
- 强制模式：`OPENSANDBOX_EGRESS_MODE=dns+nft`。DNS 层对未放行域名返回 NXDOMAIN；nft 对未放行 IP **drop**。
- A→B、B→A 都是各自的出站，两边都 deny Pod CIDR 就互访失败。
- 合法跨沙箱只能走 Ingress `GetEndpoint()`，不能直连 Pod IP。

同 namespace 隔离在 egress 上是 **L3 CIDR 互斥**，不是按 `sandbox_id` / label 精细选邻接 Pod。平台组件、其它沙箱、ClusterIP 一起被 CIDR 挡住。

**挡不住 / 易踩坑：**

| 缺口 | 说明 |
|---|---|
| 没挂 sidecar | 不传 `network_policy` 或池化未预置 → **出站不受限**，可扫同 ns 其它 Pod |
| 只开 `dns` 模式 | IP/CIDR **不生效**，直连 Pod IP 能通 |
| 入站 | egress 不挡别人连进来；靠对端也 deny 出站，或补 **K8s NetworkPolicy Ingress** |
| 池化 | 生命周期 API 不能给已存在的 pool pod 注入 sidecar；`networkPolicy` 与 `poolRef` 冲突。策略是 **Pool 模板级共享**，不是每沙箱一份 |
| `established,related` | 改策略 **不断已有连接**，验证必须用新连接 |
| 业务决策 D-7 | 池化主路径 **去掉 sidecar、改用 K8s NetworkPolicy**（省 20~50MB/沙箱）。该路径下本节的 sidecar 机制不适用，改看 §2.3 |

### 2.2 FQDN 之外能否做到路由前缀？

**到不了。** egress `NetworkRule.target` 停在 **主机名 + IP/CIDR**，没有 HTTP path / method / 端口。

实现：`components/egress/pkg/policy/policy.go`（`normalizePolicy` / `Evaluate`）、`domain_index.go`。

| 匹配层次 | 支持？ | 形态 |
|---|---|---|
| 精确 FQDN | 是 | `api.github.com`（大小写不敏感，尾点去掉） |
| 域名通配 | 是 | `*.pypi.org`（**不含裸域** `pypi.org`；实现按 suffix，多层子域也会中） |
| IP / CIDR | 是（**仅 `dns+nft`**） | `10.244.0.0/16` |
| **端口** | **否** | `NetworkRule` 只有 `action` + `target` |
| **HTTP 路由前缀** `/api/v1/*` | **否** | 不做 L7 |

容易混淆的两点：

- **Credential Vault** binding 的 `hosts` / `paths` / `methods` 只用于 **往匹配请求里注入凭据**，不是放行/阻断。
- 透明 **mitmproxy 不消费** egress `NetworkPolicy`。要 L7 拦截得自己写 mitm 脚本（`components/egress/docs/mitmproxy-transparent.md`）。

「部分路由可访问、部分阻断」的既有分层：

```
沙箱应用容器
  → egress（dns+nft，defaultAction: deny）
      只放行：外部服务域名 + Higress 网关域名/IP
      直连外部服务（LLM / GitHub / 包源）
  → Higress（L7：路径前缀 / 方法 / 认证 / 限流）
  → 内部服务
```

**FQDN/CIDR 在 egress（或 D-7 的 NetworkPolicy），路由前缀在 Higress 或 Cilium L7。** 应用访问内部服务时 base URL 必须指向网关。细节与 NodePort 限制见 [池化出向管控与 Higress](opensandbox-egress-pool-higress-architecture.md)。

### 2.3 与 D-7（NetworkPolicy 替代 sidecar）对齐

池化主路径按 `MEMORY.md` D-7 **不挂 egress sidecar**。原生 NetworkPolicy：

| 需求 | 原生 NetworkPolicy | 说明 |
|---|---|---|
| 同 namespace 沙箱互隔离 | **能做** | `policyTypes: [Ingress, Egress]` + default-deny，再按 label/`podSelector` 放行 server/ingress。比 sidecar 更适合「入站也要挡」 |
| FQDN 白名单 | **不能** | 要 Cilium `toFQDNs` 等 CNI 扩展 |
| HTTP 路由前缀 | **不能** | 要 Cilium HTTP 策略或 Higress |

内网目标主要是 IP/CIDR 时，D-7 合理。一旦要「只开放 `gateway.corp/v1/foo`、关掉 `/admin`」，必须在 **网关或 CNI L7**，不能指望 egress 或标准 NetworkPolicy。

---

## 参考

| 路径 | 说明 |
|---|---|
| `specs/execd-api.yaml` | `/command`、`/session`、`/pty`、isolated session 契约 |
| `components/execd/pkg/runtime/command.go` | `/command` 实现（`bash -c`、进程组、后台） |
| `docs/components/execd.md` | execd 能力总览、PTY、isolated session、hardening |
| `wiki/opensandbox-pool-allocation-time-injection.md` | k8s exec vs taskTemplate / lifecycle（注入时机，不是 vs `/command`） |
| `wiki/opensandbox-pooled-session-s3-sync-middleware.md` | 内部静默 `pods/exec` 先例 |
| `components/egress/pkg/policy/policy.go` | target 解析：域名 / IP / CIDR |
| `docs/architecture/network-isolation.md` | `deny.always` 挡 Pod CIDR 的官方方案 |
| `wiki/opensandbox-egress-pool-higress-architecture.md` | L7 由 Higress 承担的分层结论 |
| `MEMORY.md` D-7 | 池化去 sidecar、改 NetworkPolicy |
