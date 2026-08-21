---
name: egress-internals-reference
description: egress sidecar 实现细节进阶参考——能力边界代码核实、动态 TTL、iptables/nft 内部机制、HTTP API 细节、环境变量全集（主文档引用，非业务必读）
type: project
---

# Egress 实现细节进阶参考（附录）

> 调研日期：2026-08-21
> 定位：`opensandbox-egress-pool-higress-architecture.md` 与 `exporter/egress-network-policy-cookbook.md` 的进阶附录。内容为 `components/egress/` 实现代码核实结果，与业务需求不直接相关，排查/调优时查阅。

## 一、能力边界（代码核实）

### 1.1 规则解析与匹配

`pkg/policy/policy.go` `normalizePolicy` 按序解析 target：`netip.ParseAddr`（IP）→ `netip.ParsePrefix`（CIDR）→ 否则按域名。**IP/CIDR 已实现**——`specs/sandbox-lifecycle.yml` 与 `specs/egress-api.yaml` 中 "IP/CIDR not yet supported in the egress MVP" 是**过时注释**。

| 语义 | 实现 | 说明 |
|---|---|---|
| 顺序优先 | first-match wins | 同 target 多条规则第一条生效 |
| 通配符 | `*.example.com` 匹配子域，**不匹配裸域** | `domain_index.go`：exact map + wildcard suffix map |
| 大小写/尾点 | 域名匹配大小写不敏感、尾点自动去除 | `Evaluate` 统一 lowercase + TrimSuffix |
| IP/CIDR 生效条件 | 仅 `dns+nft` 模式 | 纯 `dns` 模式 DNS 层跳过非域名规则（`evaluateLinear` 只匹配 `targetDomain`） |
| 空策略 | 空/`null`/`{}` → deny-all | `ParsePolicy` |

### 1.2 不支持的能力

| 限制 | 说明 |
|---|---|
| 端口维度规则 | `NetworkRule` 只有 `action`+`target`，无 port 字段 |
| HTTP 路径/方法级管控 | OSEP-0001 Non-Goal：L7 DPI 不在范围；透明 MITM 仅用于凭据注入 |
| 速率限制 / 带宽控制 | OSEP Non-Goal |
| 每进程策略 | 策略作用于整个沙箱 netns |

> ⚠️ Credential Vault binding 匹配器（`schemes/ports/hosts/methods/paths`）是**凭据注入**条件，不是流量阻断。

## 二、启动流程与失败模式

`main.go` 启动顺序：加载初始策略（file > env > 默认 deny-all）→ 加载 always-rules → 启动 DNS 代理（127.0.0.1:15353）→ 加载 log_skip → 配置 deny webhook → **iptables 重定向** → **nft 静态策略** → policy server（:18080）→ mitmproxy（可选）。

**失败模式是 fail-closed**：

| 步骤 | 失败行为 |
|---|---|
| iptables 重定向安装失败 | `log.Fatalf` 退出（supervisor 重启） |
| nft 静态策略应用失败 | `log.Fatalf` 退出 |
| 初始策略/always-rules 解析失败 | `log.Fatalf` 退出 |
| OTLP 初始化失败 | 仅警告，继续运行 |

OSEP 早期"graceful degradation"（无 CAP_NET_ADMIN 时带警告继续）**已不适用**——没有 `CAP_NET_ADMIN` 时 sidecar 起不来，`/healthz` 不就绪的 pod 不会被分配。

## 三、iptables 重定向细节

`pkg/iptables/redirect.go`：

- 规则：OUTPUT 链 udp/tcp 53 → REDIRECT 到 15353，IPv4 + IPv6 双栈
- **SO_MARK 防自递归**：proxy 自身发出的 DNS 查询打 mark（`constants.MarkHex`），iptables 先 RETURN 跳过重定向
- **nameserver exempt**：`OPENSANDBOX_EGRESS_NAMESERVER_EXEMPT` 列表的 DNS 服务器直连不重定向
- **nft 后端自动回退**：iptables 在 nft 后端失败（`nf_tables rule_append failed`）时，回退原生 nft redirect（`opensandbox_dns_redirect` 表，priority -100）
- 启动时先清理残留的 nft redirect 表（防上次崩溃遗留）

## 四、nft 链结构与动态 TTL

### 4.1 链结构（`pkg/nftables/manager.go` `buildRuleset`）

表 `inet opensandbox`，链 `egress`（hook output，priority 0），规则顺序：

```
ct state established,related accept      # 存量连接放行（策略变更不掐断）
meta mark <MarkHex> accept               # proxy 自身流量
oifname "lo" accept                      # 本地回环
ip daddr 127.0.0.1 udp/tcp dport 15353 accept  # DNS 代理目标
tcp/udp dport 853 drop                   # DoT 默认阻断（防 DNS 绕过）
[DoH 443 可选阻断]                        # OPENSANDBOX_EGRESS_BLOCK_DOH_443
ip daddr @deny_v4/v6 drop                # 静态 deny 集
ip daddr @dyn_allow_v4/v6 accept         # 动态 allow 集（DNS 解析 IP）
ip daddr @allow_v4/v6 accept             # 静态 allow 集
drop / accept                            # 按 defaultAction
```

### 4.2 动态集 TTL（`pkg/nftables/dynamic.go`）

- 元素 TTL = DNS TTL + 60s slack，clamp 到 **[60, 360]s**
- 连接跟踪器每 30s 扫描 /proc 活跃 TCP 连接，活跃连接续期满 360s；连接关闭后留 360s 重连窗口
- **UDP/QUIC 不跟踪**，按 DNS TTL 过期
- 动态放行在 DNS 响应**返回客户端之前**同步执行（`proxy.go` `maybeNotifyResolved` 在 `WriteMsg` 前调用），避免竞态

## 五、DNS 代理行为（`pkg/dnsproxy/proxy.go`）

| 行为 | 说明 |
|---|---|
| 被拒域名 | 返回 NXDOMAIN（`RcodeNameError`），发布 blocked 事件（webhook） |
| 转发失败 | 返回 SERVFAIL |
| 上游 failover | NXDOMAIN/NOERROR 不重试；其他 rcode（SERVFAIL 等）尝试下一个上游 |
| 上游发现 | env `OPENSANDBOX_EGRESS_DNS_UPSTREAM` 优先，否则 resolv.conf（非 loopback 优先，cap 10 个） |
| 上游约束 | **必须字面 IP**（hostname 会命中 REDIRECT 自递归） |
| 出站日志 | `opensandbox.event=egress.outbound`，含 target.host/target.ips；`log_skip.always` 只抑制成功日志，错误仍记录 |

## 六、HTTP API 细节（`policy_server.go`）

| 项 | 行为 |
|---|---|
| 认证 | token 为空则**无认证放行**；设置后 `OPENSANDBOX-EGRESS-AUTH` 头 constant-time 比较（`crypto/subtle`） |
| `POST` 空 body | 重置为 deny-all |
| `PATCH` | merge 语义：新规则优先（同 target 覆盖），空数组 400 |
| `DELETE` | 按 target 删除（域名大小写不敏感），无匹配 200 + reason（幂等） |
| 规则上限 | `OPENSANDBOX_EGRESS_MAX_RULES` 默认 4096，超限 413 |
| 请求体上限 | 1 MiB |
| **提交顺序（fail-closed）** | 持久化 → 合并 always 规则 → nft ApplyStatic（30s 超时，失败 500 且策略不更新）→ 更新内存策略 |
| 并发 | `mu` 串行化 /policy 处理器（POST vs PATCH 无丢失更新） |
| 持久化 | `OPENSANDBOX_EGRESS_POLICY_FILE` 设置时原子写回（JSON indent + fsync），重启恢复；文件优先级 > env |

## 七、always-rules 热加载

`pkg/policy/rules_loader.go`：每分钟轮询 `/var/egress/rules/deny.always`、`allow.always`（mtime+size 变化检测），变更时自动重新应用 nft + 更新 DNS 代理，无需重启。文件格式：每行一个 target（支持通配符），`#` 注释，缺失文件忽略，非法行报错。

优先级：`deny.always` > `allow.always` > 用户策略（`MergeAlwaysOverlay` 前插实现）。

## 八、deny webhook（`pkg/events/webhook.go`）

`OPENSANDBOX_EGRESS_DENY_WEBHOOK` 设置后，被拒域名 POST JSON：

```json
{"hostname": "blocked.example.com", "timestamp": "2026-08-21T00:00:00Z", "source": "opensandbox-egress", "sandboxId": ""}
```

- 5s 超时、3 次重试指数退避（1s/2s/4s）
- 4xx 不重试；5xx 重试
- `sandboxId` 来自 `OPENSANDBOX_EGRESS_SANDBOX_ID`（server 非 pool 模式自动注入；**pool 模式为空**）

## 九、遥测自动放行（`telemetry_allow.go`）

配置 OTLP endpoint（`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`）时，自动注入该目标的 allow 规则（deny.always 可覆盖），保证 default-deny 下指标可导出。endpoint 未配置时回退节点 IP（`HOST_IP` / `/etc/hostinfo`）。

## 十、环境变量全集（`pkg/constants/configuration.go`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENSANDBOX_EGRESS_MODE` | `dns` | `dns` / `dns+nft`（token 顺序无关，必须含 dns） |
| `OPENSANDBOX_EGRESS_RULES` | 空=deny-all | 初始策略 JSON |
| `OPENSANDBOX_EGRESS_POLICY_FILE` | 无 | 策略持久化文件（优先于 env） |
| `OPENSANDBOX_EGRESS_HTTP_ADDR` | `:18080` | HTTP API 监听地址 |
| `OPENSANDBOX_EGRESS_TOKEN` | 无 | API 认证 token |
| `OPENSANDBOX_EGRESS_MAX_RULES` | 4096 | POST/PATCH 规则上限，0=不限 |
| `OPENSANDBOX_EGRESS_DENY_WEBHOOK` | 无 | 被拒域名通知 URL |
| `OPENSANDBOX_EGRESS_SANDBOX_ID` | 无 | 审计归因（server 注入，pool 模式缺失） |
| `OPENSANDBOX_EGRESS_LOG_LEVEL` | info | 日志级别 |
| `OPENSANDBOX_EGRESS_METRICS_EXTRA_ATTRS` | 无 | OTLP 指标/日志附加属性（key=value） |
| `OPENSANDBOX_EGRESS_NAMESERVER_EXEMPT` | 无 | 免重定向 DNS 服务器列表 |
| `OPENSANDBOX_EGRESS_BLOCK_DOH_443` | false | 阻断 DoH 443 |
| `OPENSANDBOX_EGRESS_DOH_BLOCKLIST` | 无 | DoH 阻断 IP/CIDR 列表（逗号分隔） |
| `OPENSANDBOX_EGRESS_DNS_UPSTREAM` | resolv.conf | 自定义上游（字面 IP，可选 :port） |
| `OPENSANDBOX_EGRESS_DNS_UPSTREAM_TIMEOUT` | 5s | 上游超时（上限 120s） |
| `OPENSANDBOX_EGRESS_DNS_UPSTREAM_PROBE` | false | 上游健康探测 |
| `OPENSANDBOX_EGRESS_DNS_UPSTREAM_PROBE_INTERVAL_SEC` | — | 探测间隔 |
| `OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT` | false | 透明 MITM（实验） |
| `OPENSANDBOX_EGRESS_MITMPROXY_PORT` | 18081 | MITM 端口 |
| `OPENSANDBOX_EGRESS_MITMPROXY_EXTRA_PORTS` | 无 | 额外拦截端口（含 80/443 共 ≤15 个） |
| `OPENSANDBOX_EGRESS_MITMPROXY_SCRIPT` / `_UPSTREAM_TRUST_DIR` / `_SSL_INSECURE` | — | MITM 脚本/上游信任/跳过校验 |
| `OPENSANDBOX_CREDENTIAL_PROXY_SOCKET` | `/run/opensandbox/credential-proxy/active.sock` | 凭据代理 unix socket |
| `OPENSANDBOX_EGRESS_CREDENTIAL_VAULT_REQUIRE_TLS` | false | 凭据保险库写操作要求 TLS/loopback/可信代理 |
| `OPENSANDBOX_EGRESS_CREDENTIAL_VAULT_TRUSTED_PROXY_CIDRS` | 无 | 可信代理 CIDR |

## 十一、观测

| 指标 | 含义 | 告警建议 |
|---|---|---|
| `egress.policy.denied_total` | 策略正常拒绝 | 不告警（预期行为） |
| `egress.dns.query.failed_total` | DNS 故障（SERVFAIL 等） | `rate(...[5m]) > 0` |
| `egress.nftables.updates.failed_total{operation="dynamic_add"}` | 动态放行失败（fail-closed 静默故障） | 告警 |

日志事件：`egress.outbound`（出站 DNS）、`egress.loaded`、`egress.updated`、`egress.update_failed`。

## 参考

| 路径 | 说明 |
|---|---|
| `components/egress/main.go` | 启动流程、失败模式 |
| `components/egress/policy_server.go` | HTTP API、提交顺序、认证 |
| `components/egress/policy_utils.go` | PATCH merge、DELETE、规则上限 |
| `components/egress/pkg/policy/` | 规则解析/匹配/合并/热加载/持久化 |
| `components/egress/pkg/nftables/` | 链结构、动态 TTL、连接跟踪 |
| `components/egress/pkg/iptables/redirect.go` | 重定向、SO_MARK、nft 回退 |
| `components/egress/pkg/dnsproxy/proxy.go` | DNS 代理行为、上游 failover |
| `components/egress/pkg/events/webhook.go` | deny webhook |
| `components/egress/pkg/constants/configuration.go` | 环境变量全集 |
| `components/egress/telemetry_allow.go` | 遥测自动放行 |