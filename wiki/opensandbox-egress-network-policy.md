---
name: egress-network-policy
description: OpenSandbox egress 网络策略调研——组件定位、sandbox_id 归因、域名/IP 配置、K8s 池模式预置方式
type: project
---

# OpenSandbox Egress 网络策略调研

> 调研日期：2026-08-19
> 背景：企业多智能体沙箱外部执行环境，需要控制沙箱出站流量

## 一、egress 是什么

**Egress** 是 OpenSandbox 的**出站网络控制 sidecar**（Go 组件，`components/egress/`），与沙箱应用容器**共享网络命名空间**，通过 iptables/nftables 透明拦截沙箱的出站流量，实现 **FQDN 白名单 + 默认拒绝**。

### 是否原生组件？

**按需挂载**，不是每个沙箱默认带。两个条件同时满足才挂（`server/.../k8s/egress_helper.py:89`）：

```python
if not network_policy or not egress_image:
    return  # 不挂 egress
```

1. 请求带了 `network_policy`（SDK `Sandbox.create(network_policy=...)`）
2. server 配置了 `[egress] image`（如 `opensandbox/egress:v1.1.6`）

不传 network_policy 的沙箱默认无 egress，出站不受限。

### 两层拦截机制

| 层 | 机制 | 作用 |
|---|---|---|
| Layer 1 DNS 代理 | iptables 把 53 端口重定向到 `127.0.0.1:15353` | 按域名白名单过滤，被拒域名返回 NXDOMAIN |
| Layer 2 nftables（`dns+nft` 模式） | 允许域名的解析 IP 加入动态 allow 集（带 TTL） | 网络层强制 default-deny + 域名放行 |

- 默认策略 `defaultAction: deny`（默认拒绝所有出站，只放行显式 allow）
- 模式：`dns`（默认，只 DNS 过滤）或 `dns+nft`（DNS + nftables IP 层，严格 default-deny 推荐）
- 规则 target 支持：域名、通配符（`*.pypi.org`）、IP/CIDR（`10.0.0.0/8`）

## 二、`OPENSANDBOX_EGRESS_SANDBOX_ID` 归因（不是加请求头）

**关键澄清**：这个 env 是注入到 **egress sidecar 进程的环境变量**，用于**归因/审计**，**不是**往沙箱发出的 HTTP 请求加请求头。

用途（`components/egress/pkg/`）：
- **deny webhook 事件**：沙箱访问被拒域名时，webhook payload 带 `sandboxId`（`webhook.go:65` 读 `os.Getenv(EnvSandboxID)`）
- **OTel 资源属性**：导出的指标/日志带 `sandbox_id`（`telemetry/init.go:33`）
- **结构化日志**：egress 日志关联沙箱

只影响 egress 自己上报的观测数据，**不会出现在沙箱应用发出的任何出站请求里**。

> 注意：**Credential Vault** 的 `InjectionHeader`（bearer/basic/apiKey/customHeaders）才是"往出口流量加请求头"的机制——通过透明 mitmproxy 按绑定规则往匹配请求注入认证头，是可选的、按主机匹配的，不是默认对所有流量加沙箱 id。

## 三、如何配置允许的域名/IP

### 方式 A：创建沙箱时传 `network_policy`（声明式，推荐）

```python
from opensandbox import Sandbox
from opensandbox.models import NetworkPolicy, NetworkRule, NetworkRuleAction

policy = NetworkPolicy(
    default_action="deny",
    egress=[
        NetworkRule(action=NetworkRuleAction.ALLOW, target="api.github.com"),
        NetworkRule(action=NetworkRuleAction.ALLOW, target="*.pypi.org"),
        NetworkRule(action=NetworkRuleAction.ALLOW, target="10.0.0.0/8"),
    ],
)
sandbox = await Sandbox.create(image="python:3.12", network_policy=policy)
```

### 方式 B：运行时通过 egress HTTP API 动态调整

```python
await sandbox.patch_egress_rules([NetworkRule(action=NetworkRuleAction.ALLOW, target="api.openai.com")])
await sandbox.delete_egress_rules(["*.pypi.org"])
status = await sandbox.get_egress_policy()
```

### 方式 C：server 全局默认（运维层）

- `[egress] mode`：`dns` 或 `dns+nft`
- 静态 always-rules 文件（`/var/egress/rules/deny.always`、`allow.always`），优先级最高，热加载

## 四、K8s 池模式（Pooled）下的配置

### 核心约束

> **Pool pods 在分配前就创建好**（预热）。生命周期 API 无法给已存在的 pool pod 注入 egress sidecar，所以：
> - `networkPolicy` **不能**与 `extensions.poolRef` 同时用，server 会**拒绝**
> - 每沙箱请求的 `network_policy` 在 pool 模式下**不生效**

### 正确做法：在 Pool 的 pod template 里手动预置 egress sidecar

Pool CRD 的 `spec.template` 是完整 `corev1.PodTemplateSpec`（`pool_types.go`，Schemaless 原样透传）。egress 容器要手动写进 template，所有从该 pool 分配的沙箱共享同一套策略。

完整模板见 `examples/kubernetes/pool-egress-network-policy.yaml`。要点：

```yaml
- name: egress
  image: opensandbox/egress:v1.1.6
  securityContext:
    capabilities:
      add: ["NET_ADMIN"]   # 必需
  env:
    - name: OPENSANDBOX_EGRESS_MODE
      value: "dns+nft"
    - name: OPENSANDBOX_EGRESS_RULES
      value: '{"defaultAction":"deny","egress":[{"action":"allow","target":"api.github.com"}]}'
    - name: OPENSANDBOX_EGRESS_TOKEN
      value: "<token>"
  ports:
    - name: egress-api
      containerPort: 18080
```

### 两种模式对比

| | 非 pool（普通 BatchSandbox） | Pool 模式 |
|---|---|---|
| 创建时配 egress | ✅ `network_policy` 参数 | ❌ 拒绝（与 poolRef 冲突） |
| 预置方式 | server 自动注入 sidecar | 手动写进 Pool template |
| 每沙箱独立策略 | ✅ 每个请求独立 | ❌ 共享 template 策略 |
| 运行时动态改 | ✅ egress API | ✅ egress API（需 template 预置） |
| sandbox_id 归因 | ✅ server 自动注入 | ⚠️ 缺失（无法注入） |

## 五、`CAP_NET_ADMIN` 是什么

Linux **capability**（细粒度权限），全称"执行各种网络相关操作"。拥有它可：配置网络接口、改路由表、改 **iptables/nftables 规则**、改网络命名空间等。

**egress 需要它**：靠它安装 iptables/nftables 重定向规则来透明拦截沙箱出站流量。没有它无法装规则、无法拦截。

**安全含义**：只给 egress sidecar 这个能力，**沙箱应用容器不给**（`egress_helper.py` 的 `build_security_context_for_sandbox_container` 在启用 network policy 时去掉沙箱容器的 `NET_ADMIN`）。这样沙箱内代码无法自己改网络规则绕过 egress 限制——这是"沙箱出站受控"的关键。

## 六、注意事项（结合企业多智能体方案）

1. **默认 deny 的坑**：`default_action="deny"` 下所有出站都要显式放行。多智能体访问外部 API（LLM、GitHub、内部服务）必须把域名/CIDR 加进 allow 列表。
2. **K8s 集群内 Service 双重放行**：`defaultAction: deny` 下访问集群内 Service，既要 allow DNS 名，又要 allow ClusterIP 的 CIDR（如 `10.96.0.0/12`），否则 DNS 解析过了但 TCP 连接被 nft 丢弃。
3. **与 server proxy 的关系**：proxy 是 server 侧转发到沙箱 execd 的**入站**流量，egress 管沙箱**出站**，两者不冲突。但沙箱内 agent 代码访问外部 API 的出站受 egress 约束。
4. **与 mesh sidecar 冲突**：egress 与 Istio/Envoy 透明 mesh 不兼容（都在同一 netns 重写流量，会冲突）。
5. **pool 模式 sandbox_id 归因缺失**：server 无法给已存在的 pool pod 注入 `OPENSANDBOX_EGRESS_SANDBOX_ID`，egress 审计无法区分具体沙箱。

## 参考

- 组件：`components/egress/`（README 是薄指针）
- 文档：`docs/components/egress.md`、`docs/architecture/network-isolation`
- 模板：`examples/kubernetes/pool-egress-network-policy.yaml`
- 相关 wiki：`opensandbox-sandbox-config-and-env-reference.md`（egress env 全链路）
