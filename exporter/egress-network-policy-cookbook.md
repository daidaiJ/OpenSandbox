# 池化模式统一出向管控 Cookbook

池化 K8s 部署下，通过 Pool 模板预置 egress sidecar，实现沙箱出向流量统一管控：定向阻断 + 特定服务（内外）放行 + 平台组件/业务运行时隔离；HTTP 路径级深入管控由 Higress 网关承担。

**前提**

| 项 | 约定 |
|---|---|
| 部署 | 池化（`extensions.poolRef`）；分配复用预热 pod，不重建 |
| 管控组件 | egress sidecar（域名/IP 白名单）+ Higress 网关（L7 路径级） |
| 运行时 | runc 或 Kata；**gVisor 不支持**（iptables nat 表缺失）；无 Istio/Envoy mesh 注入 |
| 生命周期 | 创建 → 使用 → 删除/到期；不使用 pause/resume |

相关：`pool-pod-template-cookbook.md`（Pool 模板）、`sandbox-management-cookbook.md`（创建/注入/续约）。实现细节（TTL、iptables/nft 内部、HTTP API）见 `wiki/opensandbox-egress-internals-reference.md`。

## 目录

- [1. 能力边界速查](#1-能力边界速查)
- [2. Pool 模板预置 egress sidecar](#2-pool-模板预置-egress-sidecar)
- [3. 策略规则编写（阻断 / 放行）](#3-策略规则编写阻断--放行)
- [4. 平台组件与业务运行时隔离](#4-平台组件与业务运行时隔离)
- [5. 平台级强制规则（deny.always / allow.always）](#5-平台级强制规则denyalways--allowalways)
- [6. 内部服务走 Higress 网关（L7 管控）](#6-内部服务走-higress-网关l7-管控)
- [7. 运行时动态调整](#7-运行时动态调整)
- [8. 验证](#8-验证)
- [9. 故障排查](#9-故障排查)
- [10. 参数边界与注意事项](#10-参数边界与注意事项)
- [参考](#参考)

---

## 1. 能力边界速查

| 需求 | 支持 | 说明 |
|---|---|---|
| 域名放行/阻断 | ✅ | FQDN、通配符 `*.example.com`（**不含裸域**，见 §3.3） |
| IP / CIDR 放行/阻断 | ✅ | 仅 `dns+nft` 模式生效（`OPENSANDBOX_EGRESS_MODE=dns+nft`） |
| 端口维度规则 | ❌ | `NetworkRule` 只有 `action`+`target`，无 port 字段（NodePort 影响见 §6.4） |
| HTTP 路径级管控 | ❌ | egress 不做 L7；由 Higress 承担（见 §6） |
| 默认拒绝 | ✅ | `defaultAction: deny`，只放行显式 allow |
| 平台级强制（用户不可覆盖） | ✅ | `deny.always` / `allow.always` 文件（见 §5） |
| 运行时动态调整 | ✅ | egress HTTP API `:18080`（SDK/CLI 封装，见 §7） |

> ⚠️ **易误解**：Credential Vault binding 的 `schemes/ports/hosts/methods/paths` 是**凭据注入**匹配条件，不是流量阻断，不能用于路径级管控。

## 2. Pool 模板预置 egress sidecar

**为什么必须预置在模板**：池化 create 时 `networkPolicy` 与 `poolRef` 同时使用会被 server **400 拒绝**——Pool pod 是预热创建的，生命周期 API 无法给已存在的 pod 注入 egress sidecar。因此 egress 必须写进 Pool 模板，所有从该 Pool 分配的沙箱**共享同一套策略**。

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: Pool
metadata:
  name: agent-pool
spec:
  template:
    spec:
      shareProcessNamespace: true   # task-executor 管理沙箱进程必需
      containers:
        - name: sandbox-container    # 沙箱应用容器（无特权）
          image: <sandbox-image>
          command: ["sleep", "3600"]
          ports:
            - containerPort: 80

        - name: task-executor        # pool 模式跑任务必需
          image: <task-executor-image>:<tag>
          securityContext:
            privileged: true

        # ---- egress sidecar：统一出向策略在此定义 ----
        - name: egress
          image: opensandbox/egress:v1.1.6
          securityContext:
            capabilities:
              add: ["NET_ADMIN"]     # 必需；缺失时 sidecar 启动失败（fail-closed），pod 不就绪不会被分配
          env:
            - name: OPENSANDBOX_EGRESS_MODE
              value: "dns+nft"       # 严格模式；IP/CIDR 规则仅此模式生效
            - name: OPENSANDBOX_EGRESS_RULES
              value: |
                {
                  "defaultAction": "deny",
                  "egress": [
                    {"action": "allow", "target": "api.github.com"},
                    {"action": "allow", "target": "*.pypi.org"},
                    {"action": "allow", "target": "10.96.0.0/12"}
                  ]
                }
            - name: OPENSANDBOX_EGRESS_TOKEN
              value: "<egress-token>"   # 建议设置；不设则 18080 无认证，任何能访问该端口的人都能改策略
          ports:
            - name: egress-api
              containerPort: 18080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 18080
              httpHeaders:
                - name: OPENSANDBOX-EGRESS-AUTH
                  value: "<egress-token>"
            periodSeconds: 1
            failureThreshold: 30
  capacitySpec:
    bufferMax: 10
    bufferMin: 2
    poolMax: 20
    poolMin: 5
```

完整示例：`examples/kubernetes/pool-egress-network-policy.yaml`。

## 3. 策略规则编写（阻断 / 放行）

### 3.1 规则模型

- `defaultAction`：`deny`（默认）或 `allow`；省略默认 `deny`
- `egress`：有序规则列表，**first-match wins**（同 target 多条规则，第一条生效）
- target 类型：FQDN、通配符、IP、CIDR

### 3.2 完整示例（外部服务 + 内部服务 + 定向阻断）

```json
{
  "defaultAction": "deny",
  "egress": [
    {"action": "allow", "target": "api.openai.com"},
    {"action": "allow", "target": "api.github.com"},
    {"action": "allow", "target": "*.pypi.org"},
    {"action": "allow", "target": "pypi.org"},
    {"action": "allow", "target": "10.96.0.0/12"},
    {"action": "deny",  "target": "*.blocked.corp"},
    {"action": "deny",  "target": "10.244.0.0/16"}
  ]
}
```

### 3.3 易误解点（务必阅读）

| 易误解点 | 正确理解 | 后果 |
|---|---|---|
| **通配符不含裸域** | `*.pypi.org` 只匹配 `a.pypi.org` 等子域，**不匹配** `pypi.org` 本身 | 只配通配符时访问裸域被拒（NXDOMAIN），需两条都加 |
| **内部 Service 双重放行** | 访问 K8s Service 需**同时** allow DNS 名（过 DNS 层）+ ClusterIP CIDR（过 nft 层） | 只 allow 域名时 DNS 能解析，但 TCP 连接被 nft 丢弃——现象是"解析成功但连接超时" |
| **defaultAction: deny 的连锁影响** | 所有出站都要显式放行；nameserver IP 和 127.0.0.1 自动放行，无需配置 | 漏配任何目标（含内部服务、监控端点）都会失败 |
| **规则顺序** | 同 target 多条规则第一条生效；PATCH 新规则覆盖旧规则 | 先 deny 后 allow 同 target 时 deny 生效 |
| **IP/CIDR 规则仅 dns+nft 生效** | `OPENSANDBOX_EGRESS_MODE=dns` 时 IP/CIDR 规则被忽略（仅警告） | 配了 CIDR 但模式是 dns，内部服务仍不可达 |

### 3.4 环境变量速查（业务相关）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENSANDBOX_EGRESS_MODE` | `dns` | `dns`（仅 DNS 过滤）/ `dns+nft`（推荐，IP/CIDR 生效） |
| `OPENSANDBOX_EGRESS_RULES` | 空=deny-all | 初始策略 JSON（同 `POST /policy` body） |
| `OPENSANDBOX_EGRESS_TOKEN` | 无 | HTTP API 认证；`OPENSANDBOX-EGRESS-AUTH` 头 |
| `OPENSANDBOX_EGRESS_MAX_RULES` | 4096 | POST/PATCH 规则上限，0=不限 |
| `OPENSANDBOX_EGRESS_DENY_WEBHOOK` | 无 | 被拒域名通知 URL（server 自动注入 sandbox_id，pool 模式为空） |

## 4. 平台组件与业务运行时隔离

**目标**：沙箱内代码**不能**访问平台基础组件（server/ingress/controller 等）与上层业务运行时，防止沙箱内代码管理沙箱、改策略、横向探测。

### 4.1 管控目标清单

| 目标 | 集群内位置 | 端口 | 阻断方式 |
|---|---|---|---|
| `opensandbox-server`（lifecycle API + proxy 管理面） | `opensandbox` 命名空间 Service | 80 | 域名 + Service CIDR |
| `opensandbox-ingress-gateway`（入站网关） | `opensandbox` 命名空间 Service | 80 | 域名 + Service CIDR |
| `opensandbox-controller-manager`（operator） | `opensandbox` 命名空间 Deployment | 8080/8081 | Pod CIDR |
| `opensandbox-node-agent`（节点代理） | DaemonSet | — | Pod CIDR |
| 其他沙箱（沙箱间互访） | Pod CIDR | 任意 | Pod CIDR |
| 上层业务运行时（编排平台、控制面、管理 API） | 按实际部署 | 任意 | 业务网段/域名 |

### 4.2 哪些**不能**阻断（容易误伤）

| 流量 | 为什么不能阻断 |
|---|---|
| 沙箱内 execd（44772）/ task-executor（5758） | **沙箱自己的组件**，SDK 依赖它们执行命令；走 127.0.0.1/lo，egress 自动放行，无需配置 |
| server → 沙箱的 proxy **入站**流量 | egress 只管**出站**，入站不受影响；SDK 命令执行正常 |
| DNS 上游（nameserver） | 自动放行（nft 白名单 + iptables 豁免），无需配置 |

### 4.3 deny.always（平台级强制，用户不可覆盖）

```text
# deny.always —— 平台强制阻断（用户不可覆盖）
# 平台组件 Service DNS（opensandbox 命名空间）
opensandbox-server.opensandbox.svc.cluster.local
opensandbox-ingress-gateway.opensandbox.svc.cluster.local
# 集群内部 CIDR（覆盖平台组件 pod/ClusterIP + 沙箱间互访）
10.244.0.0/16    # Pod CIDR（按实际集群替换）
10.96.0.0/12     # Service CIDR（按实际集群替换）
# 上层业务运行时（按实际网段替换）
10.40.0.0/16     # 业务控制面网段
*.admin.corp     # 业务管理域
```

> **域名写法选择**：`*.opensandbox.svc.cluster.local` 可覆盖平台命名空间全部 Service（沙箱 pod 无 Service，不受影响）；若沙箱需访问该命名空间内的合法服务（如内部 LLM 网关），则改为逐条 deny 平台组件名。

### 4.4 用户策略（Pool 模板，业务级阻断）

```json
{
  "defaultAction": "deny",
  "egress": [
    {"action": "allow", "target": "api.openai.com"},
    {"action": "allow", "target": "api.github.com"},
    {"action": "allow", "target": "*.pypi.org"},
    {"action": "allow", "target": "higress-gateway.corp.internal"},
    {"action": "allow", "target": "10.20.0.0/16"},
    {"action": "deny",  "target": "*.admin.corp"}
  ]
}
```

### 4.5 隔离效果一览

| 访问目标 | 结果 |
|---|---|
| 沙箱 → server / ingress / controller / node-agent | ❌ 阻断（域名 NXDOMAIN + nft drop 双重） |
| 沙箱 → 其他沙箱（Pod IP 直连） | ❌ 阻断 |
| 沙箱 → 内部合法服务（经 Higress） | ✅ 放行（网关域名/IP） |
| 沙箱 → 外部服务（LLM/GitHub/包源） | ✅ 放行（域名白名单） |
| server → 沙箱（proxy 入站，SDK 命令执行） | ✅ 不受影响（入站） |
| 沙箱内 execd/task-executor（127.0.0.1） | ✅ 不受影响（lo） |

## 5. 平台级强制规则（deny.always / allow.always）

优先级：`deny.always` > `allow.always` > 用户策略（API/env）。每分钟热加载，无需重启。

```dockerfile
FROM opensandbox/egress:latest
COPY deny.always /var/egress/rules/deny.always
COPY allow.always /var/egress/rules/allow.always
```

```text
# allow.always —— 平台统一放行（如内部 LLM 网关）
llm-gateway.corp.internal
10.20.0.0/16
```

server 配置指向自定义镜像：

```toml
[egress]
image = "registry.example.com/opensandbox/egress:hardened"
mode = "dns+nft"
```

**使用场景**：平台基线（§4.3 的 deny 清单）放 `deny.always`，保证用户通过 SDK/CLI 改自己的策略也无法突破；需要平台统一开放的内部服务放 `allow.always`。

## 6. 内部服务走 Higress 网关（L7 管控）

**为什么**：egress 不支持路径级管控（§1）。内部 HTTP 服务统一走 Higress：egress 只放行网关，路径级 allow/deny 在 Higress 做。

```
沙箱应用 → egress（默认拒绝 + 白名单）→ Higress（路径级管控）→ 内部服务
```

### 6.1 三步配置

**① egress 侧：只放行网关**

```json
{
  "defaultAction": "deny",
  "egress": [
    {"action": "allow", "target": "higress-gateway.corp.internal"},
    {"action": "allow", "target": "10.20.0.0/16"},
    {"action": "deny",  "target": "10.244.0.0/16"},
    {"action": "deny",  "target": "10.96.0.0/12"}
  ]
}
```

Pod/Service CIDR deny 保证沙箱**无法绕过网关**直连内部服务。

**② Higress 侧：路径级规则**

按 Higress 网关配置编写路由：`/svc/order-api/*` 放行、`/admin/*` 阻断等。egress 只负责把流量导向网关。

**③ 沙箱应用侧：base URL 指向网关**

应用访问内部服务时 base URL 指向网关（如 `http://higress-gateway.corp.internal`），路径带服务标识。**这是唯一需要应用配合的点**——egress 和网关都是透明的，但应用要知道走网关。

### 6.2 NodePort 场景

| 场景 | 方案 |
|---|---|
| 专用节点池 | egress allow 节点 IP（如 `10.30.1.0/24`），粒度可接受 |
| 共享节点 | **必须走 Higress**（egress 无法按端口区分；Higress 以 NodePort 暴露，egress 只放行网关节点 IP），或 ClusterIP + 网关转发 |
| 非 HTTP（数据库等） | egress 放行目标 IP/CIDR；端口级管控需 CNI 层方案 |

## 7. 运行时动态调整

已创建沙箱（含 pool 分配）可通过 SDK/CLI 动态调整策略，无需重建：

```bash
# 查看当前策略与 enforcementMode
osb egress get <sandbox-id> -o json

# 追加放行 / 阻断规则（merge 语义，同 target 新规则覆盖旧规则）
osb egress patch <sandbox-id> --rule allow=new-service.corp -o json
osb egress patch <sandbox-id> --rule deny=bad-domain.com -o json

# 删除规则（幂等）
osb egress delete <sandbox-id> --target bad-domain.com -o json
```

SDK 等价：`sandbox.patch_egress_rules(...)` / `sandbox.delete_egress_rules(...)` / `sandbox.get_egress_policy()`。

> **注意**：运行时 patch 只改当前沙箱；Pool 模板策略变更需滚动更新 Pool（`updateStrategy`），已预热 pod 不自动获得新策略。

## 8. 验证

### 8.1 策略与模式确认

```bash
osb egress get <sandbox-id> -o json
```

期望输出：

```json
{"status": "ok", "mode": "deny_all", "enforcementMode": "dns+nft", "policy": {"defaultAction": "deny", "egress": [...]}}
```

- `mode: deny_all` = 默认拒绝生效
- `enforcementMode: dns+nft` = 网络层强制生效（IP/CIDR 规则有效）

### 8.2 行为实测（策略文本 ≠ 实际生效）

```bash
# 放行目标 → 期望 200
osb command run <sandbox-id> -o raw -- curl -I https://api.github.com

# 阻断目标 → 期望失败（curl 报错/超时）
osb command run <sandbox-id> -o raw -- curl -I https://blocked.corp
osb command run <sandbox-id> -o raw -- curl -I http://10.244.0.5

# 平台组件 → 期望阻断
osb command run <sandbox-id> -o raw -- curl -I http://opensandbox-server.opensandbox.svc.cluster.local

# 网关路径级验证
osb command run <sandbox-id> -o raw -- curl -I http://higress-gateway.corp.internal/svc/order-api/v1/health   # 放行
osb command run <sandbox-id> -o raw -- curl -I http://higress-gateway.corp.internal/admin/xxx                # 网关阻断
```

### 8.3 观测指标

| 指标 | 含义 | 告警建议 |
|---|---|---|
| `egress.policy.denied_total` | 策略正常拒绝 | 不告警（预期行为） |
| `egress.dns.query.failed_total` | DNS 故障（SERVFAIL 等） | `rate(...[5m]) > 0` |
| `egress.nftables.updates.failed_total{operation="dynamic_add"}` | 动态放行失败（fail-closed 静默故障） | 告警 |

## 9. 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| 域名解析成功但连接超时/被拒 | 内部 Service 只 allow 了 DNS 名，缺 ClusterIP CIDR 放行（§3.3 双重放行） | 加 allow `10.96.0.0/12`（或更窄 ClusterIP 段） |
| 访问裸域失败但子域正常 | 只配了通配符 `*.example.com`，不含裸域（§3.3） | 加 allow `example.com` |
| 配了 CIDR 规则但不生效 | `OPENSANDBOX_EGRESS_MODE=dns`（IP/CIDR 仅 dns+nft 生效） | 改 `dns+nft` |
| 沙箱能访问平台组件 | deny 规则没进 `deny.always`（用户策略可被覆盖/未配置） | 平台基线放 `deny.always`（§4.3） |
| 沙箱内 SDK 命令执行失败 | 误把 execd/task-executor 当平台组件阻断（§4.2） | 不要阻断 127.0.0.1/lo 流量 |
| 策略改了但行为没变 | 存量连接不受影响（nft 放行 established）；或改的是模板但 pod 未重建 | 新连接验证；模板变更需滚动更新 Pool |
| `osb egress` 401 | token 不匹配（模板 `OPENSANDBOX_EGRESS_TOKEN` 与 SDK/CLI 配置不一致） | 核对 token |
| 沙箱创建后 egress 未生效 | `[egress] image` 未配置；或 pool 模式 create 带 `networkPolicy` 被 400 拒绝 | 配置 server `[egress]`；egress 预置在 Pool 模板 |

## 10. 参数边界与注意事项

- **池化 create 拒绝**：`networkPolicy`、`credentialProxy.enabled` 与 `poolRef` 同时使用 → 400；egress 只能预置在 Pool 模板
- **pool 模式 sandbox_id 归因缺失**：server 无法注入 `OPENSANDBOX_EGRESS_SANDBOX_ID`，deny webhook / 审计无法区分具体沙箱
- **CIDR 需按实际集群替换**：Pod/Service CIDR、网关网段、业务网段以实际部署为准（`kubectl cluster-info` / CNI 配置确认）
- **策略变更不掐断存量连接**：nft 链放行 `established,related`，新策略只影响新连接
- **token 必设**：不设 token 时任何能访问 18080 的人都能改策略
- **hostNetwork 禁止**：`hostNetwork=true` + network policy 被 server 拒绝
- **gVisor 不兼容**：需 gVisor 时改用 kata-qemu 或 CNI 级 FQDN 策略

## 参考

| 路径 | 说明 |
|---|---|
| `wiki/opensandbox-egress-pool-higress-architecture.md` | 方案文档：需求映射、平台组件隔离、Higress 分层 |
| `wiki/opensandbox-egress-internals-reference.md` | 实现细节附录：TTL、iptables/nft 内部、HTTP API、环境变量全集 |
| `examples/kubernetes/pool-egress-network-policy.yaml` | Pool 模板完整示例 |
| `docs/components/egress.md` | 官方组件文档（环境变量、HTTP API、always-rules） |
| `docs/architecture/network-isolation.md` | deny.always 平台隔离、集群内 Service 双重放行 |
| `wiki/opensandbox-egress-network-policy.md` | egress 组件定位、sandbox_id 归因 |
| `cli/src/opensandbox_cli/skills/opensandbox-network-egress.md` | `osb egress` 命令用法 |
| `server/opensandbox_server/services/k8s/egress_helper.py` | server 注入逻辑 |
| `kubernetes/charts/opensandbox-server/` | server / ingress-gateway 部署（Service 名、端口） |
| `specs/egress-api.yaml` | egress 运行时 API 契约（IP/CIDR 注释过时，以代码为准） |