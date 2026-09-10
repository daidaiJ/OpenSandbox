---
name: egress-pool-higress-architecture
description: 池化模式出向管控方案——定向阻断、特定服务（内外）放行、平台组件与业务运行时隔离、Higress 分层架构（L7 路径级管控）、NodePort 场景处理
type: project
---

# 池化模式出向管控与 Higress 分层架构

> 调研日期：2026-08-21
> 背景：企业内智能体沙箱（池化模式）出向流量管控。需求：定向阻断 + 特定服务（内外）放行 + 部分 HTTP 路由级深入管控（部分路由可访问、部分阻断）。集群无 Istio，已有 Higress 网关可承担部分流量管理。
> 实现细节（TTL 机制、iptables/nft 内部、HTTP API 细节等）见附录：[Egress 实现细节进阶参考](opensandbox-egress-internals-reference.md)。

## 一、需求与结论速览

| 需求 | 承担组件 | 结论 |
|---|---|---|
| 域名放行/阻断（外部服务：LLM、GitHub、包源） | egress sidecar | ✅ 原生支持（FQDN/通配符 allow/deny） |
| 内网 NodePort 服务放行 | egress sidecar | ⚠️ 仅按 IP/CIDR 放行节点，**无端口维度**；共享节点场景需走网关 |
| HTTP 路径级管控（部分路由可访问、部分阻断） | Higress 网关 | ❌ egress 不支持 L7；由 Higress 承担 |
| 平台组件隔离（server/ingress/controller 等） | egress `deny.always` | ✅ 域名 + CIDR 双层阻断，用户不可覆盖 |
| 上层业务运行时隔离 | egress `deny.always` / 用户策略 | ✅ 按网段/域名阻断，仅经 Higress 暴露白名单路由 |
| 平台级强制基线（用户不可覆盖） | egress `deny.always` | ✅ 优先级最高，热加载 |
| 默认拒绝（只放行显式 allow） | egress `defaultAction: deny` | ✅ 推荐 `dns+nft` 模式 |

**推荐架构**：egress 做粗粒度出向管控（默认拒绝 + 白名单），Higress 做细粒度 L7 管控（路径/方法/认证/限流）。内部服务与平台组件不直接暴露给沙箱——egress 强制 deny 集群内部 CIDR（除网关外），沙箱访问内部服务只能走 Higress。

## 二、能力边界速查

| 能力 | 支持 | 说明 |
|---|---|---|
| FQDN 放行/阻断 | ✅ | 大小写不敏感、尾点自动去除 |
| 通配符 `*.example.com` | ✅ | **不匹配裸域** `example.com`，需单独加 |
| IP / CIDR 规则 | ✅ | 仅 `dns+nft` 模式生效（spec 注释"未支持"为过时，代码已实现） |
| 默认拒绝 | ✅ | `defaultAction: deny`，空策略 = deny-all |
| 规则顺序优先 | ✅ | first-match wins，同 target 第一条生效 |
| 平台级强制规则 | ✅ | `deny.always` > `allow.always` > 用户策略，每分钟热加载 |
| 运行时动态调整 | ✅ | HTTP API `:18080`（SDK/CLI 封装），认证头 `OPENSANDBOX-EGRESS-AUTH` |
| **端口维度规则** | ❌ | `NetworkRule` 只有 `action`+`target`，无 port 字段 |
| **HTTP 路径/方法级管控** | ❌ | egress 不做 L7；由 Higress 承担 |

> ⚠️ Credential Vault binding 的 `schemes/ports/hosts/methods/paths` 是**凭据注入**匹配条件，不是流量阻断。

## 三、池化模式预置

### 3.1 核心约束

- Pool pod 预热创建，生命周期 API 无法注入 egress sidecar：`networkPolicy` 与 `extensions.poolRef` 同时使用被 server 拒绝（HTTP 400）。
- egress 容器必须手动写进 Pool `spec.template`（完整 `corev1.PodTemplateSpec`，Schemaless 透传）。
- 所有从该 Pool 分配的沙箱**共享同一套策略**（模板级统一管控）。
- 分配后仍可通过 SDK/CLI 动态 patch（需模板预置 `OPENSANDBOX_EGRESS_TOKEN`）。
- **已知缺口**：pool 模式无法注入 `OPENSANDBOX_EGRESS_SANDBOX_ID`，egress 审计/deny webhook 无法区分具体沙箱（非 pool 模式自动注入）。

### 3.2 模板要点

```yaml
- name: egress
  image: opensandbox/egress:v1.1.6
  securityContext:
    capabilities:
      add: ["NET_ADMIN"]        # 必需；缺失时 sidecar 启动失败（fail-closed）
  env:
    - name: OPENSANDBOX_EGRESS_MODE
      value: "dns+nft"          # 严格模式；IP/CIDR 规则仅此模式生效
    - name: OPENSANDBOX_EGRESS_RULES
      value: '{"defaultAction":"deny","egress":[...]}'
    - name: OPENSANDBOX_EGRESS_TOKEN
      value: "<token>"          # 建议设置；不设则 18080 无认证
  ports:
    - name: egress-api
      containerPort: 18080
  readinessProbe:
    httpGet:
      path: /healthz
      port: 18080
      httpHeaders:
        - name: OPENSANDBOX-EGRESS-AUTH
          value: "<token>"
    periodSeconds: 1
    failureThreshold: 30
```

完整模板：`examples/kubernetes/pool-egress-network-policy.yaml`；实操见 `exporter/egress-network-policy-cookbook.md`。

## 四、平台组件与业务运行时隔离

### 4.1 管控目标

沙箱内代码**不应**能访问（出站）：

| 目标 | 集群内位置 | 端口 | 阻断方式 |
|---|---|---|---|
| `opensandbox-server`（lifecycle API + proxy 管理面） | `opensandbox` 命名空间 Service | 80 | 域名 + Service CIDR |
| `opensandbox-ingress-gateway`（入站网关） | `opensandbox` 命名空间 Service | 80 | 域名 + Service CIDR |
| `opensandbox-controller-manager`（operator） | `opensandbox` 命名空间 Deployment | 8080/8081 | Pod CIDR |
| `opensandbox-node-agent`（节点代理） | DaemonSet | — | Pod CIDR |
| 其他沙箱（沙箱间互访） | Pod CIDR | 任意 | Pod CIDR |
| 上层业务运行时（编排平台、控制面、管理 API） | 按实际部署 | 任意 | 业务网段/域名 |

> 沙箱 pod 内的 execd（44772）/ task-executor（5758）是**沙箱自己的组件**，SDK 依赖它们，走 127.0.0.1/lo 不受影响。server proxy 的**入站**流量（server → 沙箱）不受 egress 影响（egress 只管出站）。

### 4.2 平台级强制（deny.always，用户不可覆盖）

```text
# deny.always —— 平台强制阻断
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

> 更稳妥的域名写法：`*.opensandbox.svc.cluster.local` 可覆盖平台命名空间全部 Service（沙箱 pod 无 Service，不受影响）；但若沙箱需要访问该命名空间内的合法服务（如内部 LLM 网关），则改为逐条 deny 平台组件名。

### 4.3 用户策略（Pool 模板）

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

### 4.4 隔离效果

| 访问目标 | 结果 |
|---|---|
| 沙箱 → server / ingress / controller / node-agent | ❌ 阻断（域名 NXDOMAIN + nft drop 双重） |
| 沙箱 → 其他沙箱（Pod IP 直连） | ❌ 阻断 |
| 沙箱 → 内部合法服务（经 Higress） | ✅ 放行（网关域名/IP） |
| 沙箱 → 外部服务（LLM/GitHub/包源） | ✅ 放行（域名白名单） |
| server → 沙箱（proxy 入站，SDK 命令执行） | ✅ 不受影响（入站） |
| 沙箱内 execd/task-executor（127.0.0.1） | ✅ 不受影响（lo） |

## 五、Higress 分层架构

### 5.1 架构

```
沙箱应用容器
   │
   ▼
egress sidecar（dns+nft，defaultAction: deny）
   │  只放行：外部服务域名 + Higress 网关域名/IP
   ├──────────────► 外部服务（LLM / GitHub / 包源）——域名直连
   │
   ▼
Higress 网关（L7 管控：路径级 allow/deny、认证、限流）
   │
   ▼
内部服务（HTTP API / NodePort 服务）
```

### 5.2 分工

| 层 | 职责 | 粒度 |
|---|---|---|
| egress | 默认拒绝 + 白名单；强制内部流量走网关；隔离平台组件/业务运行时 | 域名 / IP / CIDR |
| Higress | 路径级 allow/deny、方法、认证、限流 | HTTP 路由（L7） |

### 5.3 沙箱应用侧

应用访问内部服务时 base URL 指向 Higress 网关（如 `http://higress-gateway.corp.internal`），路径带服务标识，由 Higress 路由到后端。**这是唯一需要应用配合的点**——egress 和网关都是透明的，但应用要知道走网关。

## 六、NodePort 场景处理

| 场景 | 方案 |
|---|---|
| NodePort 服务在**专用节点池** | egress allow 节点 IP（如 `10.30.1.0/24`），粒度可接受 |
| NodePort 服务**共享节点** | egress 无法按端口区分 → 必须走 Higress（Higress 以 NodePort 暴露，egress 只放行网关节点 IP），或改用 ClusterIP + 网关转发 |
| 非 HTTP 协议（数据库等） | egress 放行目标 IP/CIDR（端口粒度限制同样适用）；如需端口级管控需配合 CNI 层方案 |

## 七、验证清单

```bash
# 1. 策略与模式确认
osb egress get <sandbox-id> -o json
# 期望: {"status":"ok","mode":"deny_all","enforcementMode":"dns+nft","policy":{...}}

# 2. 行为实测（策略文本 ≠ 实际生效）
osb command run <sandbox-id> -o raw -- curl -I https://api.github.com     # 放行 → 200
osb command run <sandbox-id> -o raw -- curl -I https://blocked.corp       # 阻断 → 失败
osb command run <sandbox-id> -o raw -- curl -I http://10.244.0.5          # 阻断 → 超时/拒绝
osb command run <sandbox-id> -o raw -- curl -I http://opensandbox-server.opensandbox.svc.cluster.local  # 平台组件 → 阻断

# 3. 运行时动态调整（无需重建沙箱）
osb egress patch <sandbox-id> --rule allow=new-service.corp -o json
osb egress patch <sandbox-id> --rule deny=bad-domain.com -o json
```

## 八、易误解点与注意事项

| 易误解点 | 正确理解 | 后果 |
|---|---|---|
| **内部 Service 双重放行** | 访问 K8s Service 需**同时** allow DNS 名（过 DNS 层）+ ClusterIP CIDR（过 nft 层） | 只 allow 域名时 DNS 能解析，但 TCP 连接被 nft 丢弃——现象是"解析成功但连接超时" |
| **通配符不含裸域** | `*.pypi.org` 只匹配子域，**不匹配** `pypi.org` 本身 | 只配通配符时访问裸域被拒（NXDOMAIN），需两条都加 |
| **IP/CIDR 仅 dns+nft 生效** | `OPENSANDBOX_EGRESS_MODE=dns` 时 IP/CIDR 规则被忽略 | 配了 CIDR 但模式是 dns，内部服务仍不可达 |
| **平台组件隔离的边界** | 沙箱内 execd/task-executor（127.0.0.1）是沙箱自己的组件**不能阻断**；server proxy 入站流量不受 egress 影响 | 误阻断会导致 SDK 命令执行失败 |
| **pool 模式策略共享** | 所有从该 Pool 分配的沙箱共用模板策略；改模板需滚动更新 Pool（`updateStrategy`），已预热 pod 不自动获得新策略 | 模板变更后旧 pod 仍执行旧策略 |
| **token 必设** | 不设 token 时任何能访问 18080 的人都能改策略（SDK 路径经 server 鉴权，但直连端口无保护） | 策略可被绕过 |
| **策略变更不掐断存量连接** | nft 链放行 `established,related`，新策略只影响新连接 | 验证需用新连接 |
| **gVisor 不兼容** | gVisor netstack 不实现 iptables nat 表 | 需 gVisor 时改用 kata-qemu 或 CNI 级 FQDN 策略（如 Cilium toFQDNs） |
| **CIDR 需按实际集群替换** | Pod/Service CIDR、网关网段、业务网段以实际部署为准 | 配置错误导致误放行/误阻断（`kubectl cluster-info` / CNI 配置确认） |

故障排查（症状 → 原因 → 解决）见 `exporter/egress-network-policy-cookbook.md` §9。

## 参考

| 路径 | 说明 |
|---|---|
| [Egress 实现细节进阶参考](opensandbox-egress-internals-reference.md) | 实现细节附录：TTL、iptables/nft 内部、HTTP API、环境变量全集 |
| `exporter/egress-network-policy-cookbook.md` | 实操 Cookbook（本调研的落地版） |
| `examples/kubernetes/pool-egress-network-policy.yaml` | Pool 模板完整示例 |
| `docs/components/egress.md` | 官方组件文档 |
| `docs/architecture/network-isolation.md` | deny.always 平台隔离、集群内 Service 双重放行 |
| `server/opensandbox_server/services/k8s/egress_helper.py` | server 注入逻辑 |
| `server/opensandbox_server/services/k8s/kubernetes_service.py` | poolRef + networkPolicy 拒绝逻辑 |
| `kubernetes/charts/opensandbox-server/` | server / ingress-gateway 部署（Service 名、端口） |
| 相关 wiki | `opensandbox-egress-network-policy.md`、`opensandbox-k8s-networkpolicy-vs-egress-sidecar.md` |