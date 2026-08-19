---
name: k8s-networkpolicy-vs-egress-sidecar
description: K8s 原生 NetworkPolicy 隔离 vs egress 边车网络隔离方案的优缺点对比分析
type: project
---

# K8s 网络策略隔离 vs Egress 边车网络隔离：方案对比

> 调研日期：2026-08-19
> 背景：OpenSandbox 沙箱平台需要控制沙箱出站/入站网络，评估两种隔离方案——K8s 原生 NetworkPolicy 与 egress 边车（sidecar）方案。

## 一、两种方案的本质区别

| 维度 | K8s 原生 NetworkPolicy | Egress 边车（OpenSandbox 采用） |
|---|---|---|
| 控制点 | **集群网络层**（CNI 实现，如 Calico/Cilium） | **沙箱 Pod 内部**（与沙箱共享 netns 的 sidecar） |
| 控制对象 | Pod 集合（namespace + label selector） | 单个沙箱（per-sandbox） |
| 声明方式 | 静态 YAML 声明（`NetworkPolicy` 资源） | 运行时 API（`POST/PATCH /policy`）+ 创建时 `network_policy` 参数 |
| 出站控制 | 需 Ingress+Egress 双向规则 | 天然 per-sandbox 出站控制 |
| 域名级控制 | 原生不支持（需 CNI 扩展如 Cilium `toFQDNs`） | 原生支持 FQDN 白名单（DNS 代理） |

## 二、K8s 原生 NetworkPolicy 的优缺点

### 优点

1. **平台原生、零侵入**：是 K8s 标准 API，无需在沙箱内注入额外组件，不占用沙箱资源，不增加镜像体积。
2. **集中管理**：策略由集群管理员统一声明，通过 RBAC 控制谁能创建/修改，审计清晰。
3. **性能好**：由 CNI 在数据面（eBPF/iptables）执行，对沙箱内进程透明，无额外代理开销。
4. **与运行时无关**：不依赖沙箱内是否有特定 capability，对 gVisor/Kata/runc 一视同仁。
5. **入站隔离天然支持**：Ingress 规则能阻止其他 Pod 访问本沙箱，这是沙箱间隔离的核心需求。

### 缺点（在沙箱隔离场景下是致命的）

1. **label 不可预测**：沙箱 Pod 的 label 由平台自动注入，用户不可控。不同租户/安全级别的沙箱可能共享同一套 label，无法用 label selector 精确划分隔离边界。
2. **动态生命周期不匹配**：沙箱频繁创建/销毁，NetworkPolicy 是静态声明，无法实时跟踪每个沙箱的隔离关系。
3. **粒度不匹配**：NetworkPolicy 作用于 Pod 集合，而沙箱隔离要求"每个沙箱是独立安全域，默认拒绝来自所有其他沙箱的访问"。用 NetworkPolicy 表达"拒绝所有其他 Pod 访问我"需要为每个沙箱单独建规则，且无法覆盖未来创建的沙箱。
4. **出站控制薄弱**：Ingress 规则能挡入站，但无法阻止沙箱进程主动发起出站连接（如 curl 另一个沙箱的 Pod IP）。要挡出站直连需要双向 Ingress+Egress 规则，又回到 label 不可预测和动态性问题。
5. **无域名级控制**：原生 NetworkPolicy 只能按 IP/CIDR/端口，无法按域名白名单放行（沙箱场景最常用的是"允许访问 api.github.com"这类域名规则）。需要 Cilium `toFQDNs` 等 CNI 扩展。
6. **多租户 CIDR 暴露**：用户需要知道集群 Pod/Service CIDR 才能写规则，多租户下这是敏感信息。

## 三、Egress 边车方案的优缺点

### 优点

1. **per-sandbox 精确隔离**：每个沙箱是独立安全域，策略按沙箱粒度生效，天然满足"默认拒绝来自其他沙箱的访问"。
2. **域名级白名单**：通过 DNS 代理（iptables 把 53 重定向到 127.0.0.1:15353）+ nftables 动态 allow 集，原生支持 FQDN 白名单（`api.github.com`、`*.pypi.org`），这是沙箱出站控制最常用的能力。
3. **运行时动态调整**：通过 egress HTTP API（`POST/PATCH /policy`）可实时增删规则，无需重建沙箱或改 YAML。
4. **平台级强制隔离**：`deny.always`/`allow.always` 文件机制，优先级高于用户策略，用户无法覆盖，实现平台级默认隔离基线。
5. **透明拦截**：iptables/nftables 透明拦截，沙箱内进程无感知，无需改应用代码。
6. **扩展能力**：同一 sidecar 还承载 Credential Vault（出站凭据注入）、透明 MITM、deny webhook 通知等，一个组件多能力。
7. **不暴露集群 CIDR**：用户只需声明域名，无需知道 Pod/Service CIDR。

### 缺点

1. **需要 `NET_ADMIN` capability**：egress 靠它装 iptables/nftables 规则。虽然只给 sidecar 不给沙箱容器，但增加了镜像/部署复杂度，且对安全审计是额外攻击面。
2. **与 gVisor 不兼容**：gVisor netstack 不实现 iptables `nat` 表，egress 的 DNS REDIRECT 无法工作。需要 Kata 或改用 CNI 级 FQDN 策略。
3. **与透明 mesh 冲突**：与 Istio/Envoy 透明 sidecar 不兼容（都在同一 netns 重写流量）。
4. **资源开销**：每个沙箱多一个 sidecar 容器，增加内存/CPU 占用和镜像拉取。
5. **Pool 模式限制**：预热 Pool 的 pod 无法注入 egress sidecar，`networkPolicy` 与 `poolRef` 冲突，需在 Pool template 手动预置。
6. **入站隔离不覆盖**：egress 只管出站，沙箱间入站隔离仍需配合其他机制（如 deny.always 挡 Pod CIDR 出站，间接实现）。
7. **DNS 依赖**：域名白名单依赖 DNS 解析，DNS 代理故障会影响出站；动态 allow 集有 TTL 刷新窗口。

## 四、五维深度对比（权限 / 隔离性 / 管控粒度 / 配置复杂度 / 可维护性）

> 本节从运维与安全视角，按用户关心的五个维度逐项对比。

### 1. 权限（Permission）

| 维度 | K8s NetworkPolicy | Egress 边车 |
|---|---|---|
| 谁有权限配置 | 集群 RBAC（`networking.k8s.io` 资源权限），通常只给集群管理员 | 平台 server 统一注入 + 沙箱 owner 通过 SDK/API 改自己的策略 |
| 沙箱内进程能否绕过 | **不能**——策略在集群网络层，沙箱内无权限触及 | **不能**——沙箱容器被去掉 `NET_ADMIN`，无法改 iptables/nftables 绕过 |
| 需要的特权 | 无（CNI 数据面执行） | sidecar 需 `NET_ADMIN` capability（只给 sidecar，不给沙箱容器） |
| 权限模型 | 粗粒度（按 namespace/label 集合授权） | 细粒度（per-sandbox，沙箱 owner 只管自己的） |

**结论**：NetworkPolicy 权限集中在集群管理员，模型简单但粗；egress 把"改自己沙箱策略"的权限下放给沙箱 owner（经 server 鉴权），同时用 `deny.always` 保留平台级不可覆盖的强制层。egress 多一个 `NET_ADMIN` 攻击面，但通过"只给 sidecar、沙箱容器去掉该 capability"来收敛。

### 2. 隔离性（Isolation）

| 维度 | K8s NetworkPolicy | Egress 边车 |
|---|---|---|
| 沙箱间默认隔离 | 需为每个沙箱建规则，且无法覆盖未来沙箱；label 不可控导致边界模糊 | `deny.always` 挡集群 Pod/Service CIDR，天然"沙箱间默认不可达" |
| 出站隔离 | 弱——Ingress 挡入站，挡不住沙箱主动 curl 别的 Pod IP | 强——per-sandbox 出站 default-deny + FQDN 白名单 |
| 域名级隔离 | 不支持（需 Cilium `toFQDNs`） | 原生支持 |
| 隔离强度 | 依赖 CNI 实现（Calico/Cilium 数据面） | 依赖 iptables/nftables + DNS 代理，沙箱内强制 |
| 运行时兼容 | 与 gVisor/Kata/runc 无关 | 与 gVisor 不兼容（无 iptables nat 表） |

**结论**：在"沙箱间默认隔离 + 出站域名白名单"这两个沙箱平台核心需求上，egress 明显更强。NetworkPolicy 更适合做集群内入站隔离的补充。

### 3. 管控粒度（Granularity）

| 维度 | K8s NetworkPolicy | Egress 边车 |
|---|---|---|
| 最小控制单元 | Pod 集合（namespace + label selector） | 单个沙箱（per-sandbox） |
| 动态调整 | 静态 YAML，改规则需 apply 新资源 | 运行时 API（`POST/PATCH /policy`）实时增删 |
| 规则维度 | IP/CIDR/端口/协议 | FQDN/通配符域名/IP/CIDR |
| 多租户区分 | label 不可控，难区分租户 | 每沙箱独立策略，天然区分 |
| 平台级 vs 用户级 | 只有平台级（集群管理员） | 平台级（`deny.always`）+ 用户级（`network_policy`）双层 |

**结论**：egress 的管控粒度远细于 NetworkPolicy——从"Pod 集合"细化到"单个沙箱"，且支持运行时动态调整和双层（平台/用户）策略叠加。

### 4. 配置复杂程度（Configuration Complexity）

| 维度 | K8s NetworkPolicy | Egress 边车 |
|---|---|---|
| 初始配置 | 写 NetworkPolicy YAML（label selector + ingress/egress 规则） | server 配 `[egress] image` + 沙箱创建时传 `network_policy` |
| 域名白名单 | 需额外 CNI 扩展（Cilium `toFQDNs`），配置复杂 | 原生，直接写域名规则 |
| 集群 CIDR 知识 | 用户需知道 Pod/Service CIDR 才能写规则 | 用户只需声明域名，无需知道 CIDR |
| 平台级隔离 | 需为每个沙箱/未来沙箱维护规则 | 一次 `deny.always` 镜像构建，全局生效 |
| 运行时调整 | 改 YAML + apply，有传播延迟 | 直接调 API，即时生效 |
| 运维依赖 | 依赖 CNI 是否支持（原生 NetworkPolicy 需 CNI 实现） | 依赖 egress 镜像 + `NET_ADMIN` + 运行时兼容 |

**结论**：对"域名级出站白名单 + 平台级默认隔离"场景，egress 配置更简单（用户不用知道 CIDR、不用维护每沙箱规则）；NetworkPolicy 在纯入站/集群内隔离场景配置更简单，但一旦涉及域名白名单就复杂。

### 5. 是否好维护（Maintainability）

| 维度 | K8s NetworkPolicy | Egress 边车 |
|---|---|---|
| 组件数量 | 无额外组件（CNI 自带） | 每沙箱多一个 sidecar 容器 + 镜像维护 |
| 升级 | 随 CNI/集群升级 | 需维护 egress 镜像版本、滚动更新 |
| 故障排查 | 策略在集群层，排查需看 CNI 数据面 | 沙箱内可查 iptables/nftables 规则、egress 日志 |
| 资源开销 | 无（数据面执行） | 每沙箱多一个容器（内存/CPU/镜像拉取） |
| 与生态兼容 | 与 mesh/CNI 天然兼容 | 与透明 mesh（Istio/Envoy）冲突 |
| 状态一致性 | 声明式，集群自愈 | 沙箱内规则，需保证 sidecar 与策略一致 |

**结论**：NetworkPolicy 维护成本低（无额外组件、声明式自愈），但排查域名级问题困难；egress 维护成本高（多一个 sidecar 组件、镜像、资源开销、mesh 冲突），但排查和动态调整更直接。对沙箱平台这种"每沙箱独立策略"的场景，egress 的维护成本是可控的（策略随沙箱生命周期走）。

### 五维总览

| 维度 | K8s NetworkPolicy | Egress 边车 | 胜出 |
|---|---|---|---|
| 权限 | 集中、简单但粗 | 下放 per-sandbox + 平台强制层，多一个 NET_ADMIN 面 | 平（egress 更灵活，NetworkPolicy 更简单） |
| 隔离性 | 入站强、出站弱、无域名级 | 出站强、域名级、沙箱间默认隔离 | **egress** |
| 管控粒度 | Pod 集合、静态 | per-sandbox、动态、双层 | **egress** |
| 配置复杂度 | 纯入站简单，域名级复杂 | 域名级简单，需维护镜像 | 视场景 |
| 可维护性 | 无组件、声明式、易维护 | 多 sidecar、镜像、mesh 冲突 | **NetworkPolicy** |

**综合判断**：在沙箱平台"多租户 + 动态生命周期 + 域名级出站白名单"的核心诉求下，**egress 在隔离性和管控粒度上完胜，配置复杂度在域名场景也更优**；NetworkPolicy 仅在"纯入站隔离 + 无域名需求"的简单场景下因零组件、易维护而占优。OpenSandbox 选择 egress 边车作为主力，NetworkPolicy 作为平台级入站/集群内隔离的补充，是合理的。

## 五、OpenSandbox 的取舍与理由

OpenSandbox **不采用原生 K8s NetworkPolicy**，而是用 egress 边车。核心原因（见 `docs/architecture/network-isolation.md`）：

1. **沙箱隔离的核心是"默认拒绝来自所有其他沙箱的访问"**，这是 per-sandbox 语义，NetworkPolicy 的 Pod 集合语义无法表达。
2. **沙箱出站控制需要域名级白名单**，原生 NetworkPolicy 做不到。
3. **沙箱生命周期动态**，静态 NetworkPolicy 无法跟踪。

### 实际落地组合

OpenSandbox 实际是**两层结合**：

- **平台级默认隔离**：用 egress `deny.always` 挡掉集群 Pod/Service CIDR，实现"沙箱间默认不可达"，这是 NetworkPolicy 想做但做不好的。
- **per-sandbox 出站白名单**：用 egress 的 `network_policy`（default-deny + FQDN allow）控制单个沙箱能访问哪些外部域名。
- **入站统一入口**：沙箱对外暴露服务只能走 `GetEndpoint()` API（经 Ingress 代理 + 认证授权），Pod IP 不作为外部服务端点。

## 六、结论与建议

| 场景 | 推荐方案 |
|---|---|
| 沙箱间默认隔离（平台级） | egress `deny.always` 挡集群 CIDR（或 CNI 级 NetworkPolicy 挡 Pod CIDR） |
| 单个沙箱出站域名白名单 | egress `network_policy`（default-deny + FQDN allow） |
| 纯入站隔离、无出站域名需求 | 可考虑 CNI NetworkPolicy（如 Cilium） |
| gVisor 运行时 | 不能用 egress，改用 CNI 级 FQDN 策略（Cilium `toFQDNs`） |
| 多租户、需域名级出站控制 | egress 边车（当前方案） |

**核心判断**：在"多租户 + 沙箱动态生命周期 + 需要域名级出站白名单"的沙箱平台场景下，**egress 边车方案明显优于原生 NetworkPolicy**——它把隔离控制点从"集群网络层"下沉到"沙箱内部"，实现了 per-sandbox 的精确、动态、域名级控制，这是 NetworkPolicy 的 Pod 集合语义无法提供的。NetworkPolicy 更适合作为**平台级入站/集群内隔离的补充**（如挡 Pod CIDR），而非沙箱出站控制的主力。

## 附：egress 边车实现机制补充（来自代码调研）

### 双层强制机制

egress 边车与沙箱应用容器**共享同一网络命名空间**，采用两层强制：

- **Layer 1 — DNS 代理**（`pkg/dnsproxy`）：iptables `nat` 表 REDIRECT 把所有端口 53 的 DNS 流量重定向到 `127.0.0.1:15353`，按域名白名单过滤，被拒域名返回 `NXDOMAIN`。
- **Layer 2 — nftables**（`pkg/nftables`，`dns+nft` 模式）：表 `inet opensandbox`、链 `egress`、集合 `allow_v4/allow_v6/deny_v4/deny_v6`。允许的域名解析出的 A/AAAA IP 以 TTL 动态加入 allow set，每 30 秒轮询活动 TCP 连接续期，实现"默认拒绝 + 域名放行"在网络层的落地。

### 权限隔离细节

启用网络策略时，server 的 `build_security_context_for_sandbox_container()` 会**drop 主沙箱容器的 `NET_ADMIN`**，只有 egress 边车持有该 capability——保证沙箱内代码无法改 iptables/nftables 绕过限制。

### spec 与实现滞后（已知问题）

`specs/egress-api.yaml` 的 `NetworkRule.target` 描述仍写"IP/CIDR not yet supported in the egress MVP"，但实现（`pkg/policy/policy.go` 的 `normalizePolicy`）**已支持 IP 和 CIDR target**。契约描述滞后于实现，若依赖该字段需以实现为准。

### 关键文件索引

- 边车入口：`components/egress/main.go`、`policy_server.go`、`nft.go`
- DNS 代理：`components/egress/pkg/dnsproxy/proxy.go`
- nftables：`components/egress/pkg/nftables/manager.go`
- 策略模型：`components/egress/pkg/policy/policy.go`、`always_rules.go`
- API 契约：`specs/egress-api.yaml`
- K8s 集成：`server/opensandbox_server/services/k8s/egress_helper.py`
- Docker 集成：`server/opensandbox_server/services/docker/networking.py`
- Helm 配置：`kubernetes/charts/opensandbox-server/values.yaml`

## 参考

- 组件：`components/egress/`（Go sidecar，nftables + iptables + DNS proxy）
- 文档：`docs/architecture/network-isolation.md`（官方方案设计）
- 相关 wiki：`opensandbox-egress-network-policy.md`（egress 实现细节）
- 兼容性：`docs/guides/secure-container.md`（gVisor/Kata 兼容矩阵）
