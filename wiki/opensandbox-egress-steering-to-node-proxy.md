---
name: egress-steering-to-node-proxy
description: CubeSandbox 与 OpenShell 如何把沙箱出口流量送到凭证交换代理，四维控流拆解与可选路线对比
type: project
---

# 沙箱出口流量如何精准牵引到节点级透明代理：CubeSandbox / OpenShell 拆解与路线选型

> 调研日期：2026-11-16
> CubeSandbox 依据：`TencentCloud/CubeSandbox` @ `5182230`（`docs/architecture/network.md`、`CubeEgress/` 源码与启动脚本；未读 CubeVS eBPF C 源码）
> OpenShell 依据：`D:\pro\openshell` @ `1358941`（本地源码 + `architecture/` 文档）
> 本仓依据：`dev` @ `8aff879f`（`components/egress/`、fast-sandbox 共享代理、`docs/guides/credential-vault.md`、`wiki/opensandbox-external-egress-control-plane-and-credentials.md`）
> 定位：机制整理与路线选型。**未做联调实测**；性能、兼容性结论需 PoC 验证。

---

## 0. 结论

两条完全不同的范式：

| 平台 | 范式 | 流量如何到达代理 | 主体如何识别 |
|---|---|---|---|
| **CubeSandbox** | **包级重定向** | eBPF 在 TAP 上给 flow 打 `skb->mark` → 主机 iptables `TPROXY` → 节点共享的 OpenResty 透明监听 | 沙箱源 IP（策略按 `sandbox_ip` 分区） |
| **OpenShell** | **socket 级虚拟化** | seccomp user-notification 拦截 `connect()`，或显式 CONNECT；**没有节点级透明代理** | 每沙箱一个 supervisor，天然隔离；另有 per-binary 身份 |

对"精准控流"的判断，先把问题拆成四个正交维度：**选流**（谁进来）、**送流**（怎么送到代理）、**主体识别**（代理怎么知道是谁）、**原始目的还原**（代理怎么知道上游是谁）。CubeSandbox 四者都在网络层解决；OpenShell 四者都在 socket 层解决。

对本仓池化路径的建议：**外栅栏用 NetworkPolicy，数据面用每节点共享代理；送流优先 TPROXY（fwmark）或按 pod IP 的 DNAT，主体用 pod IP 且必须做 anti-spoof；DNS 牵引只能做收敛辅助，不能当安全边界。** OpenShell 的 per-sandbox supervisor 不适合照抄（密度冲突），可借的是"占位符 + 逐请求端点限定解析"的凭证语义。

---

## 1. 四维判定框架

任何"把沙箱流量精确送到透明代理"的方案，都要回答四个问题；任何一个答不上来，方案在实现上都会退化成"全量解密"或"可绕过"。

| 维度 | 要回答的问题 | 典型实现 | 失败形态 |
|---|---|---|---|
| **选流** | 哪些连接需要进入代理 | 端口、目的 IP/CIDR、域名（DNS 学习 / SNI）、进程身份、请求级策略 | 该进的没进 = 策略旁路；不该进的进了 = 全量解密与性能损耗 |
| **送流** | 包或连接如何到达代理进程 | REDIRECT / DNAT、TPROXY + 策略路由、eBPF redirect、路由牵引、vsock/UDS、seccomp 虚拟化、显式代理 | 规则半配置、mark 与 iptables 不一致、代理故障后直连（fail-open） |
| **主体识别** | 代理如何知道这是哪个沙箱/租户 | 源 IP、conntrack mark、socket cookie、vsock CID、per-pod netns、per-sandbox 进程 | 串租户；伪造源 IP；共享代理无法区分请求归属 |
| **原始目的还原** | 代理如何知道真正要连的上游 | `SO_ORIGINAL_DST`、TPROXY 保留的原目的地址、合成地址映射表、`Host`/SNI | 依赖 `Host`/SNI 回退，遇直连 IP 或非标准端口出错；连接复用跨域 |

补充第五维：**失效语义**。送流规则装不上、mark 对不上、代理进程不健康时，流量应当被阻断而不是直连；这一条决定方案能不能当安全边界。

---

## 2. CubeSandbox：eBPF 选流 + TPROXY 送流

### 2.1 拓扑

每个沙箱是一台独立 KVM microVM，host 侧一块专属 TAP；CubeVS 在 TAP 的 TC ingress 上挂 `from_cube`，在主机 NIC ingress 上挂 `from_world`，在 `cube-dev` egress 上挂 `from_envoy`。

```
sandbox(VM) → TAP → TC from_cube
                      ├─ 不需要 L7：策略检查 + SNAT → 主机 NIC → 外网
                      └─ 需要 L7：打 mark → cube-dev → iptables TPROXY
                                                      → OpenResty 透明监听
                                                      → 上游
上游回包 → OpenResty → cube-dev → from_envoy（DNAT 回沙箱，保留真实源 IP）
```

### 2.2 选流：mark 契约决定"谁进代理"

- `from_cube` 读 `allow_out_v3`（`(host, port) → scheme` 映射）判断该 flow 是否需要 L7；需要则写 `CUBE_L7_MARK_HTTP = 0xCE010000` 或 `CUBE_L7_MARK_HTTPS = 0xCE020000`。高 16 位 `0xFFFF0000` 归 Cube 所有，低 16 位留给主机其他 fwmark 方案。
- 只有配置了 `rules` 的域名才按需牵引；其余流量直接 SNAT 出网，不做用户态处理。
- 域名→IP 的放行集合来自 DNS 学习：eBPF 拦截 UDP/53 查询，命中 `dns_allow` 后由 Cubelet 在响应中把解析地址写入 `allow_out_v2`，带 DNS TTL。**限制：只覆盖经 UDP/53 的解析；`/etc/hosts`、DoH、直连 IP 不在此列。**
- 结果：mark 把"选流"和"送流"解耦——iptables 不需要理解端口/域名，只认 mark。

### 2.3 送流：TPROXY + 策略路由

主机侧 `CubeEgress/scripts/cube-egress-iptables-init.sh` 做三件事：

1. `mangle PREROUTING` 中匹配入口 `cube-dev` 且 mark 命中：
   `-j TPROXY --on-ip <cube-dev 网关> --on-port 8080|8443`
2. `ip rule add fwmark <mark>/0xFFFF0000 table 100`
3. `ip route add local 0.0.0.0/0 dev lo table 100`

透明监听端由打过补丁的 OpenResty 提供（`CubeEgress/openresty/0001-nginx-support-TPROXY-listeners-...patch`）：

```nginx
listen 192.168.0.1:8080 transparent reuseport;
listen 192.168.0.1:8443 ssl transparent reuseport;
```

`IP_TRANSPARENT` 让 socket 接受"目的地址不是本机"的连接，并保留原始目的地址；因此上游用 `proxy_pass http://$server_addr:$server_port` 就能拨回真实目标，不需要 `Host`/SNI 回退。

工程细节值得借鉴：

- **原子安装**：规则先建在未被引用的 `TRANSPROXY.new` 链，校验 HTTP/HTTPS 两条规则都在，再整体换名挂到 PREROUTING；避免"装了一半"导致某类流量静默绕过。
- **mark 同源**：iptables 脚本与 eBPF 全局变量共用 `/etc/cubeegress/l7-marks.conf`，避免两边 mark 值漂移。
- **模块检查**：`xt_TPROXY`、`xt_socket`、`nf_tproxy_ipv4` 缺失时告警；`down` 只清自己的链与 table 100，不碰其他规则。

### 2.4 主体识别与凭证交换

- 策略存储以 **`sandbox_ip` 为 key**（`ngx.shared.policy_store`，128 MB）；管理 API 只监听 `127.0.0.1:9091`，沙箱不可达。
- 凭证以**内联密文值**写在 `inject[].secret`，写入时计算指纹 `secret_ref_synthetic` 供审计；GET 一律 `***REDACTED***`。真实值只存在于节点代理的共享字典里。
- 请求处理：L7 规则 first-match-wins；命中后按 `inject` 列表替换 header。注入前有五道门（HTTPS、SNI 匹配、`Host == SNI`、上游证书校验通过、策略允许）；任一失败只放弃注入、请求继续，属**凭证 fail-open、网络 fail-closed**。
- HTTPS MITM：Cube 根 CA 在模板创建时注入沙箱信任库；按 SNI 动态签发 ECDSA P-256 叶证书，7 天 TTL，`lua-resty-lock` 防并发重复签发，`cert_cache` 64 MB。
- 审计：JSONL，`Authorization`/`Cookie`/`X-Api-Key` 等按规则脱敏。

### 2.5 边界与代价

- 依赖 TAP/microVM 拓扑、主机 root、TPROXY 内核模块、打过补丁的 OpenResty；容器 CNI 下不能直接照搬。
- 身份只有**沙箱 IP**，没有进程/二进制维度；IP 不可伪造依赖 IPAM 与 guest 无 `NET_ADMIN/NET_RAW`（此点需按实际镜像验证）。
- L7 只覆盖 HTTP/HTTPS；QUIC/UDP 不拦截；域名策略依赖 DNS 学习，直连 IP 是已知盲区。
- 共享代理是**节点级单点**：代理故障时，若外栅栏没兜住，流量会直连；Cube 侧靠 `cube-dev` 与 eBPF 默认拒绝减少这种可能，但需要显式确认。

---

## 3. OpenShell：socket 层拦截，不做节点级透明代理

### 3.1 三段式职责

| 层 | 组件 | 职责 |
|---|---|---|
| 控制面 | gateway | 身份、策略存储与合成、provider/凭证存储与刷新、分发；**不做逐包判决** |
| 数据面 | 每沙箱一个 supervisor | DNS 中介、OPA 评估、TLS 终止、L7 解析、凭证注入、审计 |
| 外栅栏 | compute driver | Docker `network_mode=none`、K8s empty-egress NetworkPolicy、VM 无网卡 + vsock |

### 3.2 五个入口，汇到同一套授权

| 入口 | 机制 | 是否需要包重定向 |
|---|---|---|
| seccomp 中介（默认） | 沙箱内 seccomp user-notification broker **虚拟化 INET socket**；`connect()` 阻塞，broker 解析调用进程的二进制身份，把 `PendingTcpOpen` 交给 supervisor；批准后返回 relay 流 | 否 |
| 合成 DNS + 透明 TCP | supervisor 的 DNS 对获批域名返回**合成地址**；连到合成地址的连接在 bypass fence 之前被捕获，反查映射、校验二进制/端点/端口，只拨 pin 住的真实地址 | 否 |
| 显式代理 | CONNECT 隧道、absolute-form forward HTTP | 否 |
| Policy DNS | 沙箱内 `127.0.0.53:53`，UDP/TCP DNS 都经 supervisor 中介 | 否 |
| `policy.local` | 保留地址上的本地策略 API（自省、拒绝摘要、提案） | 否 |

关键事实：**不依赖 nftables、不依赖 proxy 环境变量、不需要在 workload netns 里装规则**。`connect()` 在进入 agent FD 表之前就被虚拟化，失败一律 fail-closed，外栅栏兜底。

### 3.3 为什么它不需要节点级透明代理

OpenShell 假设"每沙箱一个 supervisor"，所以主体识别是**结构性的**（这个进程只服务这个沙箱），不需要从源 IP 或 mark 反推。代价是每沙箱常驻 OPA、TLS 终止、DNS 中介与代理进程；本仓此前的拆解估计为 **20~50 MB/沙箱** 的固定开销，与池化密度模型直接冲突。

### 3.4 凭证语义（可借的部分）

- 沙箱进程只拿占位符（`openshell:resolve:env:<KEY>`）；真实值只存在于 supervisor 的逐请求 resolver。
- 网络授权与凭证授权是**两条独立边界**：网络策略放行某目标，不等于允许把凭证发往该目标。
- 逐请求按 `(host, port, path)` 解析；`CredentialGenerationGuard` 在首次上游写之前校验 revision，避免 TOCTOU。
- 明文只在"请求重写瞬间"出现；日志与 OCSF 事件不记录 secret、占位符、body。

---

## 4. 三方对照

| 维度 | CubeSandbox | OpenShell | OpenSandbox 现状（sidecar / fast-sandbox） |
|---|---|---|---|
| 选流粒度 | 域名 + 端口（eBPF mark） | 进程 + 域名 + 端点（seccomp + synthetic DNS） | sidecar：FQDN/IP + 端口；fsb：subject IP + 目标端口 |
| 送流机制 | eBPF mark → iptables TPROXY → 透明监听 | socket 虚拟化 / CONNECT / 合成地址 | sidecar：同 netns nft/iptables redirect；fsb：Pod netns 按源 IP DNAT 到网关 |
| 主体识别 | 沙箱源 IP | 每沙箱 supervisor（结构性） | sidecar：Pod netns；fsb：客户端源 IP |
| 原始目的 | TPROXY 保留原目的地址 | 合成地址映射表 + pinned 地址 | `SO_ORIGINAL_DST` |
| 节点开销 | 一份共享代理，按 flow 进用户态 | 每沙箱一份 supervisor | sidecar：每沙箱一份；fsb：每 Fastlet 一份 |
| 前提 | TAP/root/TPROXY/补丁 nginx | seccomp + launcher + 外栅栏 | NET_ADMIN + netns（sidecar）；fsb runtime |
| 失败语义 | 规则原子安装；mark 漂移会静默绕过 | fail-closed + 外栅栏 | 规则事务重建；sidecar 启动 fail-closed |

本仓 `components/egress/pkg/iptables/gateway_mitm.go` 已经实现了一个"准节点级"版本：在 Pod netns 的 prerouting 按 `ip saddr <sandbox>` 把 80/443 DNAT 到共享 mitmdump，源 IP 经 DNAT 保留，`SO_ORIGINAL_DST` 拿到真实目标；注释也说明了为何不能匹配 `iifname`（bridge-nf 下 skb->dev 是 bridge）。这与 CubeSandbox 的差别只在"选流靠端口还是靠 mark"和"DNAT 还是 TPROXY"。

---

## 5. 可选控流路线

下表的"精确度"指能否把"需要凭证交换的 flow"与"普通出网"分开，而不是能否拦截全部流量。

| # | 路线 | 选流 | 送流 | 主体 | 精确度 | 主要前提/代价 |
|---|---|---|---|---|---|---|
| R1 | 同 netns 全量 redirect | 端口 80/443（+额外端口） | iptables/nft REDIRECT，`SO_ORIGINAL_DST` | netns 隔离 | 低（全量解密） | 需每沙箱 NET_ADMIN；池化不可注入 sidecar |
| R2 | 按源 IP DNAT 到共享代理 | 源 IP + 端口 | nft DNAT 到网关端口 | 源 IP | 中（按沙箱，不按域名） | 需 Pod netns 规则权限；源 IP 需 anti-spoof |
| R3 | eBPF mark + TPROXY | 域名/端口集合，eBPF 打标 | TPROXY + `ip rule`/table | 源 IP（或 mark 编码） | **高**（可按域名/端口选流） | 需 eBPF 控制权、TPROXY、透明监听 |
| R4 | 纯 TPROXY（无 eBPF） | 源 IP + 端口 | TPROXY + 策略路由 | 源 IP | 中（L4） | 比 R3 简单，但无法按域名选流 |
| R5 | eBPF socket redirect（Cilium 类） | cgroup/进程 + 域名 | socket redirect / sockmap | socket/cgroup 身份 | 高 | 需现代内核 + CNI 控制权；对 VM TAP 不适用 |
| R6 | 路由牵引（默认路由/VRF 到网关） | 网段/命名空间 | 网关 inline 代理 | 源 IP | 中 | 全部流量必经；网关故障 = 全断；需改路由 |
| R7 | DNS 牵引（合成地址/VIP） | 域名 | 连到代理 VIP | 源 IP | 低-中 | 直连 IP/DoH 可绕过；不能当安全边界 |
| R8 | 显式代理（`HTTPS_PROXY`） | 应用请求 | CONNECT | 代理认证 | 中 | 不配合的二进制直连；适合兼容路径 |
| R9 | seccomp user-notification | 进程 + 目的地 | socket 虚拟化 + relay | per-sandbox 进程 | **高** | 需沙箱内 launcher；syscall 开销；特殊 socket 需兜底 |
| R10 | vsock/UDS 中继 | 沙箱级 | 无网卡，走 vsock/UDS | vsock CID / UDS 路径 | 高（不可绕过） | 需 guest agent 或 socket 虚拟化；只覆盖该通道 |

**组合原则**：外栅栏与选流分离。NetworkPolicy 负责"只能到网关"，网关再决定"哪些 flow 进 MITM"。这样即使 mark/规则出错，也不会直连外网。

---

## 6. 按场景选型

### 6.1 池化 K8s 容器（本仓主路径）

推荐顺序：

1. **R2（先落地）**：节点 DaemonSet 网关，按 pod IP 做 DNAT 或 TPROXY；NetworkPolicy 默认拒绝、只放行网关。域名集合由节点 DNS 代理按 pod IP 分区学习，只对命中集合的 80/443 做 MITM。落点可复用 fast-sandbox 的 per-subject DNAT + 凭证注入，把"每 Fastlet"扩展成"每节点"。
2. **R3（要域名级精确选流时）**：在 R2 基础上引入 eBPF mark，把"这个 flow 需要 L7"的判断前移到数据面；iptables 只认 mark。前提是能控制 CNI/主机 eBPF，且接受 mark 契约的运维复杂度。
3. **R5（已有 Cilium 时）**：用 Cilium 的 socket-level redirect / `toFQDNs` 替代主机规则，省掉 veth/iptables 适配。
4. **R8（无法加节点特权时）**：显式代理 + NetworkPolicy 只放行代理；接受"不透明"，由业务层注入 `HTTPS_PROXY`。这是可用的降级路径，但要明确它不是安全边界。

### 6.2 microVM / TAP（Cube 式）

直接采用 **R3**：eBPF 在 TAP 上打 mark，主机 TPROXY 到共享代理，透明监听保留原目的地址。注意三件事：mark 配置必须与数据面同源；规则安装要原子化；代理故障时外栅栏必须仍然生效。

### 6.3 单机 Docker

`R1` 已够用；需要共享时用 `R2`（本仓 fast-sandbox profile 已验证的形态）。

### 6.4 不建议

- 把 **R7 DNS 牵引**当唯一边界：直连 IP、DoH、连接复用都会绕过。
- 在已注入 mesh sidecar 的 pod 上再叠一层透明代理：两层都改写同一 netns，行为不可预期（本仓 `docs/architecture/network/egress.md` 已明确不支持）。
- 共享代理只用源 IP 识别身份而不做 anti-spoof：容器内 `NET_RAW` 即可伪造，串租户。

---

## 7. 最小可行路径（P0）与验收判据

P0 五步：

1. **外栅栏**：NetworkPolicy default-deny，只允许沙箱到节点代理的地址/端口。
2. **送流**：节点代理按 pod IP 安装 DNAT/TPROXY；先全量 80/443，再按域名集合收敛。
3. **主体**：pod IP → subject 映射；校验源 IP（CNI 或节点规则），拒绝伪造。
4. **凭证**：复用 Credential Vault 的绑定语义，但把 vault 从 sidecar 内存上移到控制面 + 节点代理快照；CA 按节点/租户隔离。
5. **观测与失效**：allow/deny/inject/mismatch 结构化事件；代理不可用时流量被阻断，不直连。

验收判据（缺一不可）：

| 判据 | 验证方式 |
|---|---|
| 原始目的还原不依赖 `Host`/`SNI` | 直连 IP、非标准端口、HTTPS 三种请求都能拨对上游 |
| 自定义端口可控 | 如 `tcp/3000` 的 HTTPS API 能被正确牵引 |
| 不可绕过 | 直连 IP、DoH、IPv6、RAW socket、伪造源 IP 五项测试 |
| 规则原子性 | 注入一条错误规则，旧规则仍生效，不出现半配置 |
| 故障语义 | 停掉代理，流量被阻断而非直连 |
| 多租户隔离 | A 沙箱的绑定不会被 B 沙箱的请求触发 |
| 资源 | 每节点 P99 延迟、代理内存、并发连接数在预算内 |

---

## 8. 未验证与边界

- CubeSandbox 侧只读了 `docs/architecture/network.md`、网络深度文章、`CubeEgress` 脚本/nginx/Lua；**没有读 CubeVS eBPF C 源码**，mark 写点与 anti-spoof 细节以脚本注释和文档为准。
- CubeSandbox 结论对应 master `5182230` 快照，后续版本可能变化。
- OpenShell 结论来自本地 `1358941` 源码与架构文档；"20~50 MB/沙箱"是此前拆解的估算，不是实测值。
- 本文所有性能、兼容性判断均未做联调；落地前应按第 7 节判据做 PoC。
