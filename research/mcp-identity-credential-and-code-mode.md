# MCP 身份凭证管理与 Code Mode：Solo agentgateway、Higress 能力调研

> 调研时间：2026-11-28。范围：MCP 2026-07-28 授权与 Elicitation 规范、Solo Enterprise for agentgateway、阿里云 AI 网关（即 Higress 企业版）。文中“公开文档”指截至调研日可访问的官方文档与发布说明；“设计建议”是面向 OpenSandbox 的推断，不代表上述产品已经实现。

## 1. 结论

- MCP 2026-07-28 把“用户身份”拆成三条链路：MCP Client 到 MCP Server 的 OAuth、MCP Server 到第三方 SaaS 的 URL-mode Elicitation、企业 IdP 到资源 AS 的 EMA/ID-JAG。网关的价值是把这三条链路从每个 Agent 里收上来，做成统一的身份与凭证代理。
- Solo 的 Connector 是“每用户、每 target 的上游 OAuth 凭证代理”：用户预授权或按需授权，identity service 保存凭证，网关在转发时注入，Agent 和 MCP Server 都看不到真实凭证。配合 Token Exchange、OBO、ID-JAG 和 STS Elicitation，Solo 覆盖了“用户 + Agent + 上游 SaaS”三层身份。
- Higress 的身份模型以 Consumer 为中心：API Key、JWT、HMAC，MCP 服务/工具级授权，后端 Basic/Bearer/API Key，凭证透传，KMS 托管。它强在统一入口、租户/工具级治理和配额；公开文档中，每用户上游 OAuth 连接器与 Token Exchange 的深度不如 Solo。
- Code Mode 是 Solo 企业版的明确能力：Agent 写一小段脚本调用工具，减少大工具目录下的往返和上下文开销。Search Mode 按需找工具，Composition 把多个工具合成一个业务动作。Higress 的对应能力是虚拟 MCP、工具组装、语义检索和 Rerank 工具精选；公开文档没有把 Code Mode 作为独立产品能力。
- 对 OpenSandbox：Credential Vault 已经解决了“凭证不进沙箱”的问题，下一步可以补“每用户 OAuth 连接器 + Token Exchange + 工具级策略”，并把 Code Mode 的脚本执行放进沙箱，形成“身份感知的工具执行平面”。

## 2. MCP 2026-07-28 的三层身份链路

### 2.1 三层模型

| 链路 | 规范机制 | 谁做决策 | 网关可以承担的角色 |
|---|---|---|---|
| MCP Client 到 MCP Server | OAuth 2.1 资源服务器；Protected Resource Metadata（RFC 9728）；AS 发现（RFC 8414/OIDC）；CIMD；RFC 8707 `resource`；RFC 9207 `iss` 校验；按请求携带 Bearer token | MCP Server 对应的授权服务器 | 资源服务器、PRM/AS metadata 代理、JWT 验签、按工具授权、限流与审计 |
| MCP Server 到第三方 SaaS | URL-mode Elicitation；MCP Server 作为第三方 OAuth Client；令牌绑定用户身份；凭证不经过 MCP Client；禁止 token passthrough | 第三方 AS + 用户同意 | Connector / identity service / STS：保存每用户上游凭证，按 target 注入，提供授权链接与回调 |
| 企业 IdP 到资源 AS | EMA / ID-JAG 扩展；企业 IdP 统一决策；管理员预授权；用户一次 SSO 后零接触接入 | 企业 IdP | `crossAppAccess`、ID-JAG 交换、组/角色映射、集中审计 |

这三层经常被混为一谈。MCP Authorization 解决的是“客户端如何拿到访问这个 MCP Server 的 token”；URL-mode Elicitation 解决的是“MCP Server 如何拿到访问第三方 SaaS 的 token”；EMA/ID-JAG 解决的是“企业如何在不逐用户弹 consent 的情况下，集中批准跨身份域访问”。

### 2.2 授权规范的工程要点

- 授权服务器必须实现 OAuth 2.1，并提供 RFC 8414 或 OIDC Discovery 至少一种发现方式；MCP Client 必须同时支持两种。
- MCP Server 必须实现 PRM（RFC 9728），MCP Client 必须通过 PRM 发现授权服务器。
- 客户端注册优先使用 CIMD（Client ID Metadata Documents）；DCR（RFC 7591）被标记为 deprecated，仅为兼容保留。
- 客户端必须校验授权响应中的 `iss`（RFC 9207），并在授权请求和 token 请求中携带 RFC 8707 `resource` 参数。
- MCP Server 必须校验 token 的 audience 是自身；客户端不得把 token 发给其他 MCP Server，也不得接受或转发其他 token。
- Bearer token 只能放在 `Authorization` 请求头；禁止放在 URL query。
- 运行时 scope 不足返回 403 + `WWW-Authenticate: Bearer error="insufficient_scope"`；客户端做 step-up 时要把已有 scope 和挑战 scope 取并集。
- 支持 refresh token 的客户端要把 refresh token 当作机密保管；MCP Server 不应把 `offline_access` 放进 PRM 的 `scopes_supported`。

2026-07-28 的六项授权加固：

1. 客户端校验 `iss`。
2. DCR 时声明 OIDC `application_type`。
3. 客户端凭证绑定到签发它的 AS `issuer`，资源迁移时重新注册。
4. 支持从 OIDC 风格 AS 获取 refresh token。
5. Step-up 时保留已有 scope。
6. 明确 `.well-known` 发现后缀和 PRM 发现顺序。

同一版本还把协议核心改为无状态：移除 `initialize` 握手和 `Mcp-Session-Id`，版本、客户端信息、能力通过每个请求的 `_meta` 传递；新增 `Mcp-Method`、`Mcp-Name` 头，方便网关按操作路由和限流；`tools/list` 结果带 `ttlMs` 和 `cacheScope`；W3C Trace Context 的 `traceparent`、`tracestate`、`baggage` key 名被固定。对网关来说，水平扩展不再依赖粘性会话；对沙箱来说，工作负载状态仍然需要自己的快照/存储。

### 2.3 Elicitation 的边界

Elicitation 有两种模式：

- **Form 模式**：MCP Server 通过 JSON Schema 向用户收集结构化信息，适合非敏感补充参数。Schema 限制为扁平对象，属性类型是 string、number、boolean、enum 或多选 enum。
- **URL 模式**：MCP Server 把用户引导到外部 URL，适合 OAuth 授权、支付、API Key 等敏感交互。MCP Client 只负责展示目标域名并取得用户同意，凭证不经过 Client。

规范明确要求：

- URL 模式用于 MCP Server 获取第三方授权，不能用来授权 MCP Client 访问 MCP Server 本身。
- MCP Server 必须把 elicitation 请求绑定到 client 和 user 身份。
- 第三方凭证不得经过 MCP Client；MCP Server 不得使用 Client 的凭证访问第三方服务（token passthrough）。
- MCP Server 负责保存第三方 token，并把它绑定到用户身份；因此 MCP Server 需要状态。
- MCP Client 必须清晰展示请求信息的 Server、目标域名，并提供拒绝和取消选项。

这是 Solo Connector 和 STS Elicitation 的协议基础。

### 2.4 EMA / ID-JAG

Enterprise-Managed Authorization 扩展把企业 IdP 变成 MCP 访问的权威决策者：

- 管理员在 IdP 中配置哪些用户/组可以访问哪些 MCP Server。
- 用户登录后，客户端在 SSO 流程中拿到 ID-JAG（Identity Assertion JWT Authorization Grant），再向资源 AS 换取 access token。
- 不再逐个 MCP Server 弹 consent；访问决策集中在 IdP，审计链也集中在 IdP。
- Okta 是首个支持的 IdP（Cross App Access）；Anthropic、VS Code 等客户端已支持；Asana、Atlassian、Canva、Figma、Granola、Linear、Supabase 等服务端已支持或正在接入。

## 3. 凭证与身份管理

### 3.1 四种身份/凭证

| 身份/凭证 | 代表 | 生命周期 | 推荐存放位置 |
|---|---|---|---|
| 终端用户身份 | OIDC/SAML 登录后的用户 JWT | 短周期，可 refresh | 企业 IdP；网关只做验签和 claim 映射 |
| Agent 工作负载身份 | Kubernetes ServiceAccount、SPIFFE、OAuth client credentials | 工作负载周期 | Agent 运行时；用于 OBO 的 actor token 或双身份校验 |
| MCP Server 访问凭证 | 网关签发给 MCP Client 的 access token | 短周期，按 audience 绑定 | 网关/AS；不进入沙箱长期保存 |
| 上游 SaaS 凭证 | GitHub、Atlassian、Figma、Google 的 access/refresh token | 每用户、每 target | Connector identity service 或 STS；网关注入，Agent/Server 不可见 |

把这四类分开，是设计 Agent 身份系统时最重要的第一步。很多“MCP 认证”方案只做了第一类，把后三类混成一个静态 API Key，导致无法回答“哪个用户、哪个 Agent、在哪个工具上、做了什么”。

### 3.2 Solo：Connector、Token Exchange 与 STS Elicitation

#### 3.2.1 MCP Authentication：网关作为资源服务器

Solo 的 MCP Authentication 让网关充当 OAuth 2.1 资源服务器：

- 暴露 Protected Resource Metadata，代理 AS metadata 和客户端注册，使用 AS 的 JWKS 验签。
- 支持 Auth0、Okta、Keycloak、Entra、Authentik、Descope 等 IdP 适配；不同 IdP 的 JWKS 路径、DCR 行为、RFC 8707 支持差异由 `provider` 适配。
- **Eager Auth / Connect-time Auth**：用户连接时一次性完成企业 SSO 和上游 token exchange，后续工具调用不再弹 OAuth 窗口。
- 支持 strict、optional、permissive 三种模式；token 可以从 Header、Query、Cookie 或 CEL 表达式读取。
- 支持 route 级 MCP 认证，可以和限流、JWT claim 转换、授权策略组合。
- 支持 `clientId` 预注册客户端，短路 DCR；支持 `clientSecret` 服务端注入，MCP Client 不需要持有机密。

#### 3.2.2 Connector：每用户、每 target 的上游凭证代理

Connector 声明在 `EnterpriseAgentgatewayBackend`、MCP target 或 policy 的 `entConnector` 字段上：

1. 管理员在上游 Provider 注册 OAuth App；identity service 统一持有回调地址 `<publicBaseUrl>/connectors/v1/callback`。
2. 用户在 gateway UI 的 **Connectors** 页面预先连接上游，或从网关返回的授权链接按需连接。
3. 每个 MCP target 单独授权、单独存储凭证；同一个 backend 有多个 target 时也要分别连接。
4. identity service 保存每个用户的上游 credential，网关在转发到 MCP Server 时注入。
5. Agent 和 MCP Server 都看不到用户的真实凭证；Agent 只看到“需要授权”的提示和 grant URL。

Connector 的配置要点：

- 支持预注册 OAuth Client、PKCE（默认 always，可设为 publicOnly）、`client_secret_basic`、`client_secret_post`、`none`。
- 支持 `discovery.url` 自动读取 `/.well-known/oauth-authorization-server` 或 `/.well-known/openid-configuration`。
- token endpoint 可以指向集群内 Service，适合内网 IdP；调用超时 10 秒。
- 支持 `displayName`、`description`、`iconUrl`，用于 Connectors 页面和授权提示。
- Connector 不支持 `custom` MCP target；同一 target 多个声明时按“最具体优先”合并，冲突的 policy 报 `Accepted=False`。
- 支持配置 grant 生命周期；具体默认值以文档和 CRD 为准。

#### 3.2.3 两种认证模式

Solo 2.2 明确把 MCP 认证分成两种模式：

- **Connect-time / eager auth**：适合桌面 Agent、IDE、Claude Code 这类交互式客户端。用户连接时完成企业 SSO 和上游 SaaS 授权，之后工具调用无感。
- **Elicitation / deferred consent**：适合自主 Agent、多跳 Agent 链、后台任务。需要用户授权时，网关发起 URL-mode elicitation，用户完成后再继续；Solo STS 保存凭证。

这两种模式对应不同的用户体验和安全边界：前者把 consent 前移，后者把 consent 延迟到真正需要时。

#### 3.2.4 Token Exchange 与身份传递

Solo 的 Token Exchange 覆盖多种“入站 token 与后端 token 不一致”的场景：

| 场景 | 机制 | 结果 |
|---|---|---|
| 后端接受另一个 AS 的 token | RFC 8693 Token Exchange | 网关用入站 token 换后端 token |
| 后端接受 JWT assertion | RFC 7523 JWT Bearer Grant | 网关把入站 token 作为 assertion 换 token |
| 下游要同时知道用户和 Agent | OBO（On-Behalf-Of） | 用户 JWT + Agent 身份组合成 OBO token |
| 微软生态 | Entra OBO | 按 Entra 的 OBO 变体交换 |
| 跨企业边界访问 SaaS | ID-JAG / Cross App Access | 企业 IdP 预授权，资源 AS 签发 token |
| 后端只信任一个 issuer | STS Impersonation | 网关用自己的可信凭证代表用户 |
| 需要记录“谁替谁做事” | STS Delegation | 签发同时命名用户和 Agent 的凭证 |

工程细节：

- 支持 `allowedSubjectClaims` / `allowedActorClaims`，控制哪些 claim 从原始 subject/actor token 进入 OBO token。
- 支持 token 缓存（默认 8192 条，可关闭）、入站 token 过期检查、`WWW-Authenticate` 的 `resource_metadata` 提示。
- 支持 `failureMode` 显式声明 ext-auth 或 remote rate limit 后端不可达时 fail-open 还是 fail-closed。
- 支持 `preserveToken: true`，避免 JWT 认证策略在交换前把 token 移除。

#### 3.2.5 授权与审计

- MCP RBAC、Cedar、OPA、外部 ext-authz、JWT claim 规则、WAF、虚拟密钥。
- **Pre-issuance entitlement gating**：在 token 签发前先做权限判定，避免“先发 token 再拒绝”的无效授权。
- MCP tool 级 rate limit；按 persona 的工具列表；外部策略服务器做参数级限制（例如采购单金额上限、邮箱 allowlist）和结果脱敏。
- OTel trace 覆盖模型调用和工具调用；访问日志和 UI 可以看到身份、工具、token 使用和成本归因。

#### 3.2.6 安全属性与边界

- 真实上游凭证只存在于 identity service / STS，Agent 和 MCP Server 不可见。
- 每个 target 单独 grant，避免“一次授权访问所有工具”。
- 支持 scope 交集和按工具策略，弥补 SaaS OAuth scope 过粗的问题。
- 支持 audience 绑定和 issuer 校验，降低 token 被挪用到其他资源的风险。
- 运维边界：identity service 是独立 Deployment；Connector 依赖预注册 OAuth App；token endpoint 需要网络可达；Connector 不支持 custom target；暂停/恢复、密钥轮换、grant 撤销需要按产品文档设计。

### 3.3 Higress：Consumer、凭证透传与 KMS

#### 3.3.1 Consumer 抽象

Higress 把“人”或“AI Agent”统一抽象为 Consumer：

- Consumer 是认证、授权、限流、配额、观测的主体。
- 支持 Consumer Group、组级 API 授权、组级配额。
- 支持 Consumer 创建 DryRun 预检和 `clientToken` 幂等重试。
- 消费者认证支持 API Key、JWT、HMAC；Model API、MCP Server、Agent API 都可按需开启。
- 网关级全局认证支持 JWT、OIDC、自建认证鉴权；也支持 IP 黑白名单、mTLS、HTTPS、WAF、CORS、限流、熔断、超时。

#### 3.3.2 MCP 服务与工具级授权

- MCP 服务级和 MCP 工具级都可以配置消费者授权；服务级权限高于工具级。
- 开启消费者认证后，如果没有配置授权关系，请求无法访问。
- 支持虚拟 MCP 服务、工具组装、语义检索、Rerank 工具精选、分阶段发布。
- MCP Server 支持 SSE 和 Streamable HTTP；支持 HTTP 转 MCP、OpenAPI/Swagger 导入、Nacos MCP Router 同步。

#### 3.3.3 后端认证、凭证透传与 KMS

- 后端服务认证支持 Basic、Bearer、API Key；这些凭证由网关持有，Consumer 不需要知道。
- **透明凭证透传**：客户端带的用户 JWT 可以被 MCP Server 插件提取，原始 `Authorization` 头被移除，再按后端 `requestTemplate.security` 的 scheme 重新注入。适合“用户 token 直接访问后端 API”的场景。
- 支持在 Consumer、模型服务、Agent 服务、MCP 后端和插件中引用密钥；核心凭据可以托管到 KMS。
- 支持 `securitySchemes` 复用、工具级覆盖、默认凭证、`passthrough: true`。
- 官方文档说明 OAuth2/OIDC 后端 scheme 在规划中；当前以 Basic、Bearer、API Key 为主。

#### 3.3.4 身份深度的边界

Higress 的强项是“统一入口 + Consumer 级治理 + FinOps”，不是“每用户上游 OAuth 生命周期管理”：

- Consumer 更像 API 调用方身份，终端用户的 SSO 身份需要额外的 OIDC/JWT 集成来表达。
- MCP 服务/工具级消费者授权目前以 API Key 为主；平台级消费者认证同时支持 API Key/JWT/HMAC，具体以实例版本和控制台为准。
- 公开文档中没有看到与 Solo Connector 等价的“每用户、每 target 的上游 OAuth 授权 + 凭证保存 + 自动注入”能力。
- 公开文档中没有看到 RFC 8693/7523、OBO、ID-JAG 等 Token Exchange 能力；后端认证和凭证透传是主要手段。

### 3.4 凭证与身份对照

| 维度 | Solo Enterprise agentgateway | Higress / 阿里云 AI 网关 |
|---|---|---|
| 身份主体 | 终端用户 OAuth/OIDC + Agent 身份 + 上游 SaaS 凭证 | Consumer（人/Agent）+ Consumer Group |
| 认证方式 | MCP OAuth 2.1、JWT、IdP 适配、DCR/CIMD | API Key、JWT、HMAC、OIDC、自建认证 |
| 每用户上游凭证 | Connector / identity service / STS，按 target 保存并注入 | 后端凭证透传、KMS 托管、Basic/Bearer/API Key；以 Consumer 级凭证为主 |
| 用户同意 | Connect-time eager auth、URL-mode Elicitation | Consumer 授权、API Key 分发；未见等价的上游 OAuth consent 流程 |
| Token Exchange | RFC 8693、RFC 7523、OBO、Entra OBO、ID-JAG/EMA、impersonation、delegation | 公开文档以消费者认证、后端认证、凭证透传为主 |
| 授权粒度 | MCP Server / Tool / Route / JWT claim / Cedar / OPA / ext-authz | MCP 服务级 / 工具级 / Consumer / Consumer Group |
| 凭证存储 | identity service / STS / K8s Secret / 外部 IdP | KMS / 网关配置 / Secret 引用 |
| 审计与观测 | OTel trace、访问日志、成本归因、UI | AI 可观测、Consumer 统计、SLS、链路追踪 |
| 典型场景 | 企业 SSO + SaaS MCP + 多跳 Agent + 跨域授权 | 多租户 AI 网关 + MCP 工具市场 + Token/FinOps |

### 3.5 对 OpenSandbox Credential Vault 的映射

OpenSandbox 当前的 Credential Vault 已经具备很好的“凭证不进沙箱”基础：

- egress sidecar 做透明 MITM，按 scheme、host、port、method、path 精确匹配 binding。
- 支持 bearer、basic、apiKey、customHeaders、passthrough 五种 auth 类型。
- 支持 path/query/header/body 的 scoped placeholder substitutions，真实凭证不出沙箱。
- 沙箱进程只拿到 fake/empty 凭证；真实凭证由宿主侧 SDK 写入 sidecar。
- 推荐使用 `defaultAction="deny"` 的网络策略（default-allow 暂时兼容，但会发出安全告警）；vault 是 sidecar 进程内存，pause/resume 后需要重新注入。
- 私有 active-vault Unix socket 是硬可用性依赖；异常时 fail-closed。

面向 MCP 身份管理，可以补的能力：

| 能力 | 当前状态 | 建议 |
|---|---|---|
| MCP Resource Server / PRM | 未见 | 在 ingress 或独立 MCP 前置层暴露 `/.well-known/oauth-protected-resource`，代理 AS metadata，校验 `iss`、audience、scope |
| 每用户上游 OAuth | 未见 | 增加 connector/identity service：按用户、按 target 保存 OAuth grant；支持预授权和 URL-mode Elicitation |
| Token Exchange | 未见 | 在 egress 或前置层支持 RFC 8693/7523、OBO；把入站用户/Agent token 换成上游 token |
| 工具级策略 | 未见 | 增加 MCP tool 级 allow/deny、参数约束、rate limit、结果脱敏 |
| 凭证生命周期 | 进程内存，pause/resume 丢失 | 把 grant 元数据持久化到控制面；resume 时自动 rebind；短 TTL + refresh + 撤销 |
| 审计 | 访问日志/redaction | 增加 token 交换、grant、工具调用的结构化审计；记录 credential ID，不记录 secret |
| 多租户 | 网络策略/沙箱隔离 | 每租户独立 identity service/KMS/密钥域；跨租户 grant 隔离 |

一个可落地的演进路径：

1. **Connector API**：在 lifecycle server 增加“创建 connector / 查询授权状态 / 撤销 grant”的接口；SDK 暴露对应方法。
2. **Identity service**：独立 Deployment，持有 OAuth client secret、refresh token、grant 元数据；通过 mTLS 或本地 socket 向 egress 提供短期 access token。
3. **Egress token exchange**：egress 在匹配 binding 时，不再只读静态 credential，而是按 target 获取短期 token；支持缓存、过期刷新和 fail-closed。
4. **MCP 前置层**：在 ingress 增加 MCP resource-server 路由，处理 PRM、401 challenge、JWT 验签和按工具授权。
5. **Elicitation**：网关返回授权链接；用户完成 OAuth 后回调 identity service；credential 绑定用户和 target；Agent 只看到 grant URL。
6. **Pause/Resume**：vault 仍然可以是内存态，但 grant 元数据持久化；resume 后由控制面重新注入，避免用户重复授权。

## 4. 工具模式：Code Mode、Search Mode 与 Composition

### 4.1 为什么需要工具模式

当 MCP 工具目录从几十个增长到几百上千个时，三个问题会同时出现：

- **上下文成本**：把所有工具描述塞给模型，token 消耗和延迟都会上升。
- **选择准确率**：候选工具太多，模型更容易选错或调用参数不完整。
- **调用往返**：一个业务任务需要多次工具调用，每次都经过模型推理，延迟叠加。

业界大致有四类应对方式：

| 模式 | 核心思路 | 典型实现 |
|---|---|---|
| Federation | 一个端点聚合多个 MCP Server，按调用路由 | Solo MCP federation、Higress 虚拟 MCP |
| Search | 按任务检索相关工具，只把子集给模型 | Solo Search Mode、Higress 语义检索/Rerank |
| Composition | 把多个工具合成一个业务动作，一次调用扇出/合并 | Solo Composition、Higress 工具组装 |
| Code | Agent 写脚本编排工具调用，减少逐次推理 | Solo Code Mode |

这四种模式的凭证边界不同：Federation 和 Search 仍然由网关逐次注入凭证；Composition 由网关在扇出时分别注入；Code Mode 需要代码执行环境，凭证必须由工具代理按调用注入，不能出现在脚本里。

### 4.2 Solo 的工具模式

- **MCP Federation / Multiplexing**：一个端点聚合多个后端 MCP Server，按客户端虚拟化工具列表；支持 stdio MCP Server 转远程、协议升级/回退。
- **Search Mode**：Agent 按需检索工具，网关返回相关子集，避免一次加载整个工具目录。
- **Code Mode**：Agent 写一小段脚本调用工具，而不是逐个调用；公开材料强调在大工具目录下保持速度，减少模型往返和上下文开销。
- **Composition**：一次工具调用扇出到多个 MCP/HTTP 后端并合并结果；与 Federation 的区别是 Federation 每次调用只路由到一个后端，Composition 是一次调用聚合多个后端。
- **OpenAPI-to-MCP**：把已有 REST API 的 OpenAPI schema 直接暴露为 MCP 工具，不需要先起真实 MCP Server。
- **工具治理**：工具级 rate limit、按 persona 的工具列表、外部策略服务器做参数级限制和结果脱敏、fail-closed/fail-open。

Code Mode 的安全含义：

- Agent 生成的代码是不可信输入，需要沙箱隔离、资源限制、超时和网络出口控制。
- 代码不应该持有上游凭证；它只应看到逻辑工具名，由工具代理在调用时注入凭证。
- 每次工具调用都要做 per-tool 授权、参数校验、结果脱敏和审计。
- 高风险工具可以要求 URL-mode Elicitation 的人工确认。

公开材料没有展开 Code Mode 的脚本执行位置和隔离边界；从产品描述看，它需要一个能执行脚本、又能访问工具代理的运行时。这个运行时可以放在网关侧，也可以放在沙箱侧。

### 4.3 Higress 的工具模式

- **虚拟 MCP**：按业务场景重组工具列表，调用方不需要理解后端服务组织方式。
- **工具组装**：从已有工具创建新的虚拟 MCP Server，把多个工具组合成一个业务视图。
- **语义检索**：按任务筛选相关 MCP 工具，减少传给模型的工具描述。
- **Rerank 工具精选**：对 Function Calling 请求做查询改写和 Rerank，在转发模型前筛选请求体中的工具列表。
- **分阶段发布**：MCP 工具可以灰度发布，降低新工具上线风险。
- **工具级授权与观测**：MCP 服务/工具级消费者授权，工具调用可观测。

Higress 的公开文档没有把“Code Mode”作为独立能力；它的工具编排主要发生在网关侧（虚拟 MCP、工具组装、检索/精选），而不是让 Agent 写脚本。两者的差异在于：Higress 把工具选择前移到网关，Solo 把工具编排下放给 Agent 的脚本。

### 4.4 工具模式对照

| 模式 | Solo | Higress | 凭证边界（理想模型） | 适用场景 |
|---|---|---|---|---|
| Federation | MCP federation / multiplexing | 虚拟 MCP / MCP 代理 | 网关逐次注入 | 多团队、多后端 MCP 统一入口 |
| Search | Search Mode | 语义检索、Rerank 工具精选 | 网关过滤工具，凭证不变 | 大工具目录、按任务选工具 |
| Composition | Composition | 工具组装（网关侧组合） | 网关扇出时分别注入 | 固定业务动作、跨后端聚合 |
| Code | Code Mode | 公开文档未见独立能力 | 代码执行环境 + 工具代理按调用注入 | 复杂多步任务、大工具目录、低延迟 |

### 4.5 Code Mode 的安全模型

Code Mode 把“模型选择工具”变成“模型写代码调用工具”，攻击面从“选错工具”扩展到“执行任意代码”。建议的控制集：

1. **执行隔离**：脚本在沙箱内运行，限制 CPU、内存、磁盘、执行时间和进程数；默认无外网，只能访问工具代理。
2. **凭证隔离**：脚本只持有逻辑工具名和短期、audience 绑定的 token；上游凭证由工具代理或 egress 注入。
3. **按调用授权**：每次工具调用检查用户、Agent、工具、参数、数据分类；高风险工具要求人工确认。
4. **参数与结果约束**：限制参数大小、枚举值、金额、邮箱 allowlist；结果做脱敏和大小限制。
5. **审计**：记录脚本 hash、代码内容（按敏感级别脱敏）、工具调用序列、参数、结果摘要、token ID；接入 OTel trace。
6. **终止与回滚**：超时、循环检测、预算上限、kill switch；失败时清理沙箱和短期 token。
7. **供应链**：工具描述和 schema 的签名/版本校验，防 tool poisoning；工具代理只暴露 allowlist 中的工具。

## 5. 组合设计：OpenSandbox 的“身份感知 Code Mode”

一个参考架构：

```text
User / IdP
   │ SSO
   ▼
Agent ──► MCP / Code Mode 前置层 ──► Sandbox（Code Interpreter）
                │                         │
                │                         ├─ 脚本执行
                │                         └─ 工具调用（仅到 Tool Broker）
                ├─ MCP Resource Server（PRM / JWT / per-tool authZ）
                ├─ Identity Service（Connector / Token Exchange / Grant）
                └─ Tool Broker ──► MCP Servers / SaaS
                                      │
                                      └─ Credential Vault / Egress 注入上游凭证
```

角色分工：

- **MCP 前置层**：暴露 PRM，代理 AS metadata，校验 `iss`/audience/scope；按工具做授权和限流。
- **Identity Service**：管理 Connector、每用户 grant、refresh token、token exchange；向 Tool Broker 或 egress 发短期 token。
- **Sandbox**：运行 Code Mode 脚本；默认无外网，只能访问 Tool Broker；资源限制和快照由 OpenSandbox 负责。
- **Tool Broker**：把逻辑工具名映射到 MCP Server/SaaS；执行 per-tool 策略、参数校验、结果脱敏；调用时通过 Credential Vault 注入上游凭证。
- **Credential Vault / Egress**：保留现有的 MITM 注入能力；从 Identity Service 获取短期凭证；按 binding 精确匹配；fail-closed。
- **Observability**：OTel span 覆盖脚本执行、工具调用、token exchange；成本归因到用户/Agent/工具。

一次典型流程：

1. 用户通过企业 IdP 登录，MCP 前置层拿到用户 JWT。
2. Agent 请求创建 Code Mode 会话；前置层根据用户/Agent/工具策略创建沙箱。
3. Agent 写脚本，脚本在沙箱内执行。
4. 脚本调用 Tool Broker 的逻辑工具；Broker 检查策略，向 Identity Service 换取短期工具 token。
5. Broker 调用 MCP Server/SaaS；egress 按 binding 注入上游凭证；结果脱敏后返回脚本。
6. 审计记录脚本、工具调用、token ID、结果摘要；暂停/恢复时重新绑定 grant。

关键设计决策：

- **代码在哪里跑**：短脚本可以放在网关侧，长任务/重依赖放在沙箱侧。OpenSandbox 的隔离和快照能力适合后者。
- **凭证作用域**：按 user + target + tool 三级收敛；token 短 TTL、audience 绑定；避免“一次授权访问所有工具”。
- **同意时机**：桌面 Agent 用 connect-time；自主 Agent/多跳链用 URL-mode elicitation；高风险工具强制人工确认。
- **策略位置**：per-tool 策略放在 Tool Broker，网络策略放在 egress，身份策略放在 MCP 前置层；三层各自可审计。
- **状态分离**：MCP 协议无状态；Code Mode 会话和沙箱有状态；凭证 grant 持久化在控制面，vault 可以是内存态。

## 6. 风险与边界

- **Token passthrough**：MCP Server 不得把 Client 的 token 直接用于第三方服务；必须使用 elicitation 或 token exchange 获取独立 token。
- **Confused deputy**：网关不能用自己的高权限凭证替用户执行操作；需要用 OBO/delegation 或 impersonation 明确“谁在替谁做事”。
- **Prompt injection**：Code Mode 放大攻击面；沙箱、最小权限、工具 allowlist、结果脱敏缺一不可。
- **凭证缓存与撤销**：短期 token + refresh + 撤销传播；pause/resume 后要重新绑定；不能让旧 token 在快照中复活。
- **多租户**：每租户独立 identity service/KMS/密钥域；跨租户 grant 和工具调用要硬隔离。
- **供应商锁定**：Connector、EMA、Code Mode 都是产品能力；尽量把接口收敛到 OAuth/OIDC、RFC 8693/7523、ID-JAG 等标准，避免把业务逻辑绑死在某个网关的私有 API 上。
- **可观测性成本**：Code Mode 的脚本和工具调用会产生大量 span；需要采样、脱敏和成本归因，避免审计系统本身成为瓶颈。

## 7. 落地建议

按依赖关系分阶段：

**P0：身份前置层**

- 在 ingress 或独立组件增加 MCP Resource Server：PRM、AS metadata 代理、JWT 验签、`iss`/audience/scope 校验。
- 增加 MCP tool 级 allow/deny、rate limit、参数约束。
- Credential Vault 增加“credential ID / grant ID”元数据，审计只记录 ID，不记录 secret。

**P1：Connector 与 Token Exchange**

- 增加 connector/identity service：每用户、每 target 的 OAuth grant；支持预授权和按需授权。
- 支持 RFC 8693/7523 token exchange；入站用户/Agent token 换成上游 token。
- 支持 URL-mode Elicitation：授权链接、回调、grant 绑定用户和 target。
- Pause/Resume 后自动 rebind；grant 元数据持久化。

**P2：Code Mode 执行平面**

- 在沙箱内提供 Code Mode runtime（Python/JS），默认无外网，只能访问 Tool Broker。
- Tool Broker 做 per-tool 策略、参数校验、结果脱敏、审计。
- 脚本只拿逻辑工具名和短期 token；上游凭证由 egress 注入。
- OTel span 覆盖脚本、工具调用、token exchange；成本归因。

**P3：企业级身份**

- EMA/ID-JAG、OBO、delegation、cross-app access。
- 多租户 identity service、KMS、密钥轮换、撤销。
- 与 Okta/Entra/Keycloak 等 IdP 的集成测试。

## 8. 参考资料

- MCP Authorization 2026-07-28：https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- MCP Elicitation 2026-07-28：https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- MCP 2026-07-28 Release Candidate：https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- MCP Enterprise-Managed Authorization：https://blog.modelcontextprotocol.io/posts/enterprise-managed-auth/
- Solo agentgateway 2.2：https://www.solo.io/blog/agentgateway-mcp-authentication-multi-provider-ai
- Solo agentgateway 2.3：https://solo.io/blog/solo-enterprise-for-agentgateway-2-3-aws-bedrock-agentcore-intelligent-failover-and-deeper-mcp-control
- Solo Standalone 模式：https://www.solo.io/press-releases/extends-agentic-governance-any-environment-agentgateway
- Solo Connectors：https://docs.solo.io/agentgateway/kubernetes/latest/documentation/mcp/connectors/
- Solo Connector 配置：https://docs.solo.io/agentgateway/kubernetes/latest/documentation/mcp/connectors/configure/
- Solo Token Exchange：https://docs.solo.io/agentgateway/kubernetes/latest/documentation/security/backend-authn/token-exchange/
- Solo ID-JAG / EMA：https://aaif.io/blog/agentgateway-now-supports-id-jag-and-mcp-enterprise-managed-auth
- Solo Enterprise Workshop（能力全景）：https://github.com/solo-io/fe-enterprise-agentgateway-workshop
- Higress AI Gateway：https://higress.ai/en/ai-gateway/
- 阿里云 AI 网关产品页：https://www.aliyun.com/product/aigw
- 阿里云 AI 网关发布说明：https://www.alibabacloud.com/help/en/api-gateway/ai-gateway/product-overview/new-feature-release-notes-ai-gateway
- 阿里云 AI 网关消费者认证：https://help.aliyun.com/zh/api-gateway/ai-gateway/user-guide/consumer-certification
- 阿里云 AI 网关 MCP 服务管理：https://www.alibabacloud.com/help/zh/api-gateway/ai-gateway/getting-started/mcp-service-management
- Higress MCP 后端认证增强：https://www.alibabacloud.com/blog/higress-mcp-server-security-boost-api-authentication-safeguarding-ai-connections_602228
- OpenSandbox Credential Vault：../docs/guides/credential-vault.md
