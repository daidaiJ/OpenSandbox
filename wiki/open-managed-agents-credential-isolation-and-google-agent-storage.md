---
name: open-managed-agents-credential-isolation-and-google-agent-storage
description: Open Managed Agents 的凭证隔离与持久化实现拆解，以及 Google Agent Compute Engine / Filestore agent volumes / Hyperdisk 三者的定性、关系、跨节点重建机制边界与对本仓的可吸收项
type: project
---

# Open Managed Agents 凭证隔离拆解 + Google Agent Compute Engine / Filestore agent volumes 对照

> 调研日期：2026-10-30
> 调研对象 A：GitHub `rogeriochaves/open-managed-agents`（AGPL-3.0，README 自称 Anthropic Claude Managed Agents 的开源自托管替代）。核对方式：浅克隆到本地后逐文件阅读源码与 BDD spec，核对 commit `e9a0743`（HEAD，`main`）。文中代码锚点为 `packages/server/src/...:行号`。
> 调研对象 B：Google Cloud「Filestore agent volumes」（2026-09-15 发布）、Agent Compute Engine（第三方报道简称 "ACE"）、Hyperdisk。
> 对照基线：本仓池化主路径（Pool + BatchSandbox + taskTemplate）、egress/Credential Vault、池化 S3 制品中间件。
> 结论口径：Google 侧数字均来自官方文档/blog 自述，未独立复测；未能确认的项在第七节单独列出。

## 一、结论先行

**1. Open Managed Agents（下称 OMA）没有沙箱。** 它的"沙箱凭证隔离"实际上是"沙箱不存在"带来的副产物：agent loop 跑在 API 进程内，工具调用由服务端自己执行，所以密钥可以始终留在控制面。全仓 `packages/server/src` 内不存在任何 Docker / 容器 / K8s / exec 调用（`grep -i "docker\|container\|sandbox\|isolat"` 只命中 web 端营销文案）。

**2. 它的凭证隔离是两段真实 + 一段占位。**

| 段 | 实现 | 证据 |
|---|---|---|
| 存储 | vault 凭据 AES-256-GCM 落库，API **只写不读**（无读取/reveal 路由） | `lib/encryption.ts:5-8`、`routes/vaults.ts:205`、`routes/vaults.ts:78` |
| 使用 | 唯一解密路径是 MCP connector token：服务端进程内解密后作为 `Bearer` 头直连 MCP server，模型侧永远拿不到明文 | `lib/mcp-client.ts:106`、`engine/index.ts:180-215` |
| 占位 | `sessions.vault_ids` 只存不读；环境 `networking.allowed_hosts` 只存不执行 | `db/schema.ts:80`、`routes/sessions.ts:157`、`routes/environments.ts:50-60` |

**3. 它的持久化只有控制面，没有数据面。** 会话连续性靠 `events` 表回放重建 LLM 消息数组（`engine/index.ts:317`），没有 workspace 卷、没有文件快照、没有产物存储。Helm 的 PVC 只服务数据库（SQLite 1Gi / 内嵌 Postgres 10Gi）。

**4. "ACE" = Agent Compute Engine，与 Filestore agent volumes 是两条并列路径，不是同一条链路。** ACE 是 per-agent 硬件隔离 microVM，持久化靠**每 microVM 一块 Hyperdisk**；Filestore agent volumes 是 GKE 侧的 NFS 工作区。官方交叉引用只在 Agent Substrate 的 "Dynamic storage" 一行出现。

**5. Hyperdisk 不能简单理解成"支持加密的文件存储"。** 它是块存储（表现为挂在 VM 上的物理盘，文件系统要客户自己在 VM 内创建），准确表述是"**默认静态加密、支持 CMEK 的块存储**"。要"加密的文件存储"应该看 Filestore agent volumes，但它的传输中不加密。

## 二、Open Managed Agents：凭证隔离

### 2.1 定位与运行形态

| 维度 | 事实 |
|---|---|
| 定位 | 自托管 agent 管理平台，1:1 复刻 Anthropic Claude Managed Agents 的 API/UI 表面 |
| 技术栈 | pnpm monorepo：Hono API server（`@hono/zod-openapi`）+ React/Vite web + Commander CLI + Helm chart |
| 执行位置 | **API server 进程内**。`engine/index.ts` 直接 `await provider.chat()` 并在同进程执行工具 |
| 存储 | SQLite（better-sqlite3）或 Postgres，同一套 dialect-aware schema |
| 测试规模 | README 自称 387 个测试，其中大量是"字段声明 ↔ handler 引用"对齐 lint |

关键含义：这里没有"沙箱"这一层，因此**不需要**解决"如何让沙箱拿到密钥又不让它泄漏"这个本仓要解决的问题。它的凭证隔离是控制面内部的一致性问题，不是跨信任边界的注入问题。

### 2.2 存储段：AES-256-GCM，写进去就出不来

`lib/encryption.ts`：

```text
ALGORITHM = "aes-256-gcm"   // :5
IV_LENGTH = 12              // :6   12 字节随机 nonce
AUTH_TAG_LENGTH = 16        // :7   GCM tag
KEY_LENGTH = 32             // :8   256 bit
```

- 打包格式：`IV(12) + ciphertext + authTag(16)`，整体 base64（`encryption.ts:64-78`）。
- 密钥来源：`VAULT_ENCRYPTION_KEY`，必须是 64 位 hex；缺省时**首启自动生成并回写 `.env`**，同时打印 `Generated new VAULT_ENCRYPTION_KEY - back this up!`（`:22-49`）。
- 无 KMS / HSM / envelope encryption / 每租户密钥；密钥就是进程环境里的一段 hex，和数据库同机。

写入路径 `routes/vaults.ts:205`：

```ts
const encrypted = encrypt(body.value);
// INSERT INTO credentials (id, vault_id, name, value_encrypted, ...)
```

读取路径：**不存在**。`routes/vaults.ts` 只注册了 vault 的 CRUD + archive 与 credential 的 list/create/delete；`CredentialSchema`（`:51`）只暴露 `id / vault_id / name / created_at / updated_at`，`rowToCredential`（`:78`）连 `value_encrypted` 都不投影。`decrypt()` 在整个 `packages/server/src` 里对 `credentials` 表零调用。

BDD spec `specs/encryption.feature` 把这个口径写死了：*"Secret values are never returned in API responses"*、*"Credential list does not expose secrets"*。同时它承认密钥轮换尚未实现——`specs/encryption.feature:84` 的注释就是 `# ── Key rotation (future) ──`。

### 2.3 使用段：唯一的真实消费路径是 MCP token

`lib/mcp-client.ts:96-108`：

```ts
export async function loadConnectorToken(organizationId, connectorId) {
  // SELECT token_encrypted FROM mcp_connections
  //   WHERE organization_id = ? AND connector_id = ?
  return decrypt(row.token_encrypted);   // :106
}
```

调用链：`engine/index.ts:resolveTools()` 按 `agentConfig.mcp_servers` 里的每个 connector 取 token → `listMCPTools(url, token)` 用 Bearer 拉工具目录 → 远端工具以 `__mcp__<connector>__<tool>` 前缀注册给模型 → 模型发出调用时 `executeBuiltinTool()`（`:180`）在服务端用同一 token 转发。

这个形状值得本仓注意：**密钥在控制面进程内、在出向请求的最后一跳才附加，模型上下文与"沙箱"都接触不到它**。这就是 credential brokering，与本仓 egress sidecar / Vault 注入的取舍是同一类问题，只是 OMA 用"取消沙箱"换来了实现的极大简化。

隔离粒度：`mcp_connections` 按 `organization_id` 分区，跨组织不可见（`__tests__/mcp-org-isolation.test.ts`）。团队级 MCP 策略（allow / blocked / requires_approval）在 `team_mcp_policies` 表，属治理层而非运行时隔离。

### 2.4 占位段：声明了但不生效的部分

| 字段 | 声明位置 | 实际行为 |
|---|---|---|
| `sessions.vault_ids` | `db/schema.ts:80`、`schemas/sessions.ts:130/156/163` | 只在 `routes/sessions.ts:157` 原样回显；`engine/` 全目录零引用 |
| `environments.networking.allowed_hosts` | `schemas/environments.ts:16` | 只在 `routes/environments.ts:50-60` 原样回显；engine 从不读 `environment_id` |
| `sessions.messages_cache` | `db/schema.ts:81` | 只有建表语句一处引用，无读写 |
| `sessions.status = 'rescheduling'` | `db/schema.ts:75` | 只是状态枚举 + UI badge 配色，无任何状态机迁移到它 |
| `agents.tools[].name` 的 `bash/edit/read/write/glob/grep` | `schemas/agents.ts:9-18` | 可声明但**无执行器**；`executeBuiltinTool()` 落到 `Unknown tool: ${name}`（`engine/index.ts:244`） |

两个额外观察，都与"密钥卫生"直接相关：

1. **`web_search` 是桩**：`engine/index.ts:223` 直接返回一句"Web search is available when connected to a search provider"的占位文本。真正实现的工具只有 `web_fetch` 和 MCP 转发。
2. **会话资源的 GitHub token 明文落库**：`schemas/sessions.ts:34-40` 的 `GitHubRepositoryResourceParamsSchema` 带 `authorization_token: z.string()`，`routes/sessions.ts` 把整个 `resources` 数组 `JSON.stringify` 进 `sessions.resources` 并在响应里原样 `JSON.parse` 返回（`:153`）。加密边界只覆盖 vault 凭据与 MCP token，不覆盖会话资源。`web_fetch` 也是服务端对任意 URL 发起请求、无 allowlist，与"环境已声明受限网络"的 UI 叙事不一致。

### 2.5 持久化：事件日志即状态

| 层 | 承载物 | 说明 |
|---|---|---|
| 会话消息 | `events` 表（`id/session_id/type/data/processed_at`） | `buildMessagesFromEvents()`（`engine/index.ts:317`）按时间序把 `user.message` / `agent.message` / `agent.tool_use` / `agent.tool_result` 重建成 provider 需要的消息数组 |
| 会话配置 | `sessions.agent_snapshot`（JSON 快照） | 创建会话时冻结 agent 版本，保证历史可复现 |
| 用量 | `sessions.usage` / `sessions.stats` | token 与费用聚合 |
| 环境 | `environments`（JSON 配置） | 无 provisioning，`config.type` 恒为 `"cloud"` 字面量 |
| 工作区文件 | **无** | 无卷挂载、无快照、无对象存储回写 |

部署形态同样印证这一点：`docker-compose.yml` 只有 Postgres 数据卷 `oma-pg-data`；`helm/.../pvc.yaml` 只在 SQLite 模式且 `persistence.enabled` 时创建一个 1Gi PVC；`values.yaml:130` 的 `storageSize: 10Gi` 是内嵌 Postgres。**没有一块卷是为 agent 工作区准备的。**

所以 OMA 的"resume"语义是：进程重启后从事件表重建对话，然后继续调 LLM。它没有"恢复一个工作区"的能力，也不需要——它没有工作区。

## 三、Google 侧事实

### 3.1 ACE = Agent Compute Engine

- 官方名称 **Agent Compute Engine**，2026-10-22 发布，preview；Google 官方文档/blog **从不使用 "ACE" 这个缩写**，"ACE" 只见于第三方报道（MarkTechPost 等）。在 GCP 语境里写 "ACE" 需消歧，另一常见含义是 Associate Cloud Engineer 认证。
- 形态：每个 agent 一个硬件隔离 microVM，container-speed 启动。
- 凭据口径（官方 deep dive 原文）：
  - `"a new Google Cloud service that gives every AI agent its own hardware-isolated microVM with container-speed and zero credentials held inside the sandbox."`
  - `"Guest environments hold zero persistent secrets, OAuth refresh tokens, or cloud service account keys in memory or on disk, and have no access to the cloud instance's metadata server."`
  - `"This identity is not usable to call a backend API directly, if it is exfiltrated off the machine."`（SPIFFE workload identity）
  - 凭据注入位置：`"egress proxies that enforce granular network policies and inject credentials outside the reach of the agents themselves."`
- 存储：`"each Agent Compute Engine microVM has its own Hyperdisk, enabling persistence of execution workspaces and agent context."`
- 磁盘附加的硬件中介：`"block storage attachments are hardware-mediated by the IPU using instance-bound cryptographic grants, ensuring that neither a compromised sandbox nor a compromised host OS can mount, read, or overwrite volumes across node or tenant boundaries."`
- 加密与恢复：`"MicroVM memory snapshots and block volumes are encrypted at rest and require dedicated or customer-managed cryptographic authorization tokens to attach or restore."`

要点：**ACE 的"凭证隔离"和"持久化"是同一套边界的两面**——零凭据在 guest 内，凭据由 egress proxy 在沙箱外注入；工作区落在每 microVM 专属的块设备上，附加动作由 IPU 用 instance-bound 授权做硬件中介。这比"给沙箱注入一个 token"强一个量级，但依赖 IPU 硬件，不是通用 K8s 能复刻的形态。

### 3.2 Filestore agent volumes

- 定性：**不是新文件系统，而是 Filestore 的新消费模式**。原文 `"Filestore agent volumes are a fully managed, high-density elastic NFS file storage capability built for stateful AI agent sandboxes, autonomous agent fleets, and multi-agent developer environments."`
- 两层资源模型：volume pool（区域级，预留共享容量与 IOPS）+ volume（池内一个独立 NFS 文件系统）。
- 协议：NFSv3（`AUTH_SYS`、POSIX、byte-range lock），可同时挂到多个容器/节点。
- 目标数字：卷创建/删除 < 1s，**重新挂载 < 100ms**，单区域池最多 100 万卷。
- 单卷配额：100 MiB – 100 GiB，默认 1024 MiB（`defaultVolumeQuotaMib`）。
- 生命周期分层：`HOT`（绑定物理 share）→ `WARM`（不可挂载、不计 active share、仍在热存储）→ `COLD`（释放物理 share）。
- 隔离模型：**一卷一独立文件系统 + 独立导出**，`Volume.ipAcls` 支持 `ipRanges`（单卷最多 64 条 IP/CIDR）、`accessMode`、`squashMode`（默认 `NO_ROOT_SQUASH`，文档建议对模型生成代码用 `root_squash`）、`securityFlavors`（默认 `AUTH_SYS`）。
- **没有 per-agent IAM 身份绑定**：IAM 只有项目级 `roles/file.editor`（给 CSI 的 KSA 与 Filestore service agent）；sandbox 本身不持有 GCP 身份（官方 manifest 用 `automountServiceAccountToken: false`）。"哪个卷属于哪个 agent"靠编排层记账 + 卷级 IP ACL + 目录/uid 权限，不靠云身份。
- 网络：PSC 私有连接，`"All storage and NFS traffic remains private within your Virtual Private Cloud (VPC) network without requiring external IP addresses or VPC peering."`
- 加密：Filestore 默认 Google 托管密钥静态加密；**CMEK 官方文档只覆盖 instance 与 backup**，volumePools/volumes 的 API schema 里没有任何 kms 字段 → agent volumes 是否支持 CMEK 官方未说明。传输中不加密：`"In NFSv3, only the sys security flavor is supported. This setting trusts the user uid and gid provided by the client during mounting."` / `"NFSv3 was not designed with authentication in mind."`
- GKE 集成：`filestore.csi.storage.gke.io`，StorageClass 参数 `volume-pool: projects/.../volumePools/...`，`volumeBindingMode: Immediate` + `reclaimPolicy: Delete`。两条消费路径：
  - **Agent Sandbox**：`SandboxTemplate.volumeClaimTemplates` + gVisor node pool + `SandboxWarmPool` + `SandboxClaim`。
  - **Agent Substrate**：`ActorTemplate.volumes[].externalVolumeTemplate`，不经 PVC，`ateapi` 经 gRPC 直连 CSI controller 按 actor 生命周期挂/卸卷；suspend 时内存快照进 GCS、卷 detach，resume 时 <100ms 重挂。
  - **late binding**：绕过 kubelet attach，用 privileged DaemonSet 在 host 上 `mount -t nfs` 进 Pod 的 `emptyDir`。文档自己承认配额弱点：`"standard Kubernetes emptyDir.sizeLimit settings can't enforce per-agent storage quotas on the mounted NFS path"`，建议改用独立卷。

### 3.3 Hyperdisk

| 维度 | 事实 |
|---|---|
| 类型 | **块存储**。`"Function as physical disks: you can use a Hyperdisk volume with a compute instance as if it were a physical disk attached to the instance."` 需自行格式化文件系统 |
| 挂载模式 | 默认单 VM；Balanced / Balanced HA / Extreme 支持多 VM 并发读写（`"Recommended for clustered file systems and highly available workloads"`，底层仍是块设备，多写要集群文件系统）；Hyperdisk ML 最多 2500 实例只读 |
| 静态加密 | 默认 Google 托管密钥；`"You can also encrypt your Hyperdisk volumes with customer-managed encryption keys (CMEK)."` |
| 密钥限制 | `"Hyperdisks support CMEKs and Google-owned and managed keys. You can't use CSEKs to encrypt Hyperdisks."` |
| 加密粒度 | 卷级（`"Google-owned and managed keys and CMEKs encrypt data at the volume layer"`），不是文件/目录级 |
| 加密形态 | Hyperdisk Balanced 可选 Confidential mode（硬件加密，仅 N2D Confidential VM） |
| 性能 | Balanced 单卷最高 160,000 IOPS / 2,400 MiB/s、最小 4 GiB；Extreme 350,000 IOPS、64 GiB 起；`"Hyperdisk Balanced and Hyperdisk Extreme offer sub-millisecond latency."` |
| GKE | `pd.csi.storage.gke.io`，type 可为 `hyperdisk-balanced` / `-throughput` / `-extreme` / `-ml` / `-balanced-high-availability` |

**能否称为 "encrypted file storage"：不能。** 三层理由：(1) 它是块设备，文件系统由客户在 VM 内创建，Google 不提供文件语义；(2) 加密是卷级，不是文件/目录级；(3) 没有 NFS/SMB 导出，也没有 per-share 权限模型。准确表述是"默认加密的块存储，支持 CMEK、不支持 CSEK"。

ACE deep dive 里有一句把它说成 `"via Hyperdisk, which is is fully encrypted, both at rest and in transit"`（原文重复 "is is"）。这里"at rest"指的是卷加密，"in transit"指的是 Google 网络内 NVMe/TCP 传输的链路保护，**不等于它变成了文件存储**，也不等于端到端客户可控加密。

### 3.4 三者关系

```text
Google Cloud agent 持久化/隔离的三条路径（并列，非一条链路）

ACE（Agent Compute Engine）          每个 agent 一个硬件隔离 microVM
  └── 持久化 = 每 microVM 一块 Hyperdisk（块存储，卷级加密，IPU 中介附加）
  └── 凭据   = guest 内零凭据，egress proxy 在沙箱外注入

GKE Agent Sandbox / Agent Substrate   K8s 编排 + gVisor
  └── 持久化 = Filestore agent volumes（NFSv3，一卷一导出 + IP ACL）
  └── 凭据   = Agent Substrate 自称 microVM/gVisor 隔离 + 每 agent 身份 + egress proxy 注入

对照：Filestore 实例（传统）/ GKE Filestore CSI / Persistent Disk、Hyperdisk
```

注意：Filestore 存储层**没有**任何"沙箱不持有凭据"的表述，凭证隔离故事在 ACE / Agent Substrate 层。官方对两者唯一的交叉引用是 Agent Substrate 的 "Dynamic storage: Integrates with Filestore agent volumes"。

### 3.5 ACE 的跨节点重建：公开材料的边界

**结论：ACE 的跨节点重建机制没有公开文档，不要外推。** 截至 2026-10-30，`docs.cloud.google.com/agent-compute-engine*`、`cloud.google.com/agent-compute-engine*`、`cloud.google.com/products/agent-compute-engine` 全部 404，ACE 无产品文档、无配额页、无定价页、无 release notes，唯一入口是 deep dive 末尾的意向登记表单。公开材料只有两篇博客。

能确证的骨架：

| 层 | 文档化内容 | 来源 |
|---|---|---|
| 计算/内存 | 空闲时 host 侧 `"fast checkpoint-and-restore model"`，状态保留、`"consuming zero active resources on the host"` | deep dive |
| 内存去重（**不是**状态快照） | 基础镜像用 `"pre-warmed snapshot images"` + DAX + CoW memory clone 映射进物理内存，仅私有页按 delta 分配 | deep dive |
| 块存储 | 每 microVM 一块 Hyperdisk；附件 `"hardware-mediated by the IPU using instance-bound cryptographic grants"` | deep dive |
| 授权门控 | `"MicroVM memory snapshots and block volumes are encrypted at rest and require dedicated or customer-managed cryptographic authorization tokens to attach or restore."` | deep dive |
| 身份 | 每次 microVM 启动发放 `"ephemeral, session-scoped public SPIFFE certificate and short-lived identity token via a dedicated, per-VM isolated local listener"` | deep dive |

三个关键判断：

1. **文档里"快"的是同一 host 上的 idle→active，不是跨节点。** 所有 resume/restore 语境都带 "on the host"；唯一涉及跨地域的句子讲的是**新会话**由全球 frontdoor 调度（`"When a new session is requested, the scheduler steers it to the optimal available capacity pool"`），不能当"已挂起会话可搬迁"的证据。
2. **`instance-bound` 是跨节点重建的阻力，不是助力。** 附件授权绑定实例身份，而"grant 能否重签给新实例"在 Titanium 官方文档里没有任何对应说明（Titanium 文档只有 NVMe 命令清洗、SSD 内私有密钥控制器、密钥不持久化在挂载机等通用能力，无 attach / grant / re-issue 字样）。结合"restore 需要 authorization token"这句，**能确定的是 restore 受授权门控，不能确定签发主体、有效期、是否绑定 host 度量**。
3. **延迟数字：ACE 一个都没有。** 只有 `"container-speed"`、`"agents resume instantly where they left off"`，以及作为对照的 `"Each VM boots and configures a full machine, so starting, suspending and resuming one takes seconds to minutes."`

### 3.6 Google 文档化的两条跨节点路径（都不是 ACE）

| | GKE Pod snapshots（gVisor 路径） | Agent Substrate |
|---|---|---|
| 捕获 | 进程 + 内存 + 文件（`runsc` checkpoint，state file） | Actor 内存 + 本地文件 |
| 落点 | Cloud Storage（`"Cloud Storage stores your Pod snapshots."`） | `"local disk and Google Cloud Storage"` |
| 恢复方式 | 目标 Pod 恢复；**background restore** 异步拉内存与文件，访问未恢复页时立即优先取该页（GKE Sandbox 拦截 page fault 从存储取页，优先于后台流） | 从 WorkerPool 取 warm Worker，把 snapshot 恢复到该 Worker |
| 跨节点 | 明确支持：`"move it to a different node, without losing progress."` | 明确支持：`"possibly on a different worker"`，Actor 不绑定 Worker |
| 兼容约束 | **same machine series, CPU vendor, and CPU feature set (`CPUID` flags)**；GKE Sandbox kernel 与 GPU driver 版本必须一致 | 文档只到 worker 池粒度，未列 CPUID 约束 |
| 数字 | — | `"in less than 500ms"`；仓库侧 sub-400ms / 1500 activations per second，North Star 100ms p95 |
| 连接语义 | 快照时的活动连接 **restore 后关闭**（listening / loopback / Unix socket 除外），应用须重连 | `"open network connections … aren't preserved when an agent suspends"`，agent 代码必须自行重连 |
| 与 microVM 关系 | **明确不适用**：`"Pod snapshots require gVisor and don't work with microVM sandboxes."` | 其 `ateworker-microvm`（Kata + Cloud Hypervisor）路径才是 microVM 侧，也是 Google 唯一公开的 microVM guest 内存快照往返实现 |

Agent Substrate 还把恢复拆成可观测阶段，这是"快在哪一层"的直接答案：

```text
Checkpoint: pause → snapshot → persist → worker_*
Restore:    download → worker_restore → vm_restore → wakeup_probe
```

（来源：agent-substrate 仓库 `docs/dev/suspend-resume-phase-breakdown.md`；`atelet` 负责外层阶段，`ateworker-microvm` 负责 `worker_*` 内部阶段。快照搬运经 object-store 插件，`atelet` 自身不持有对象存储凭据。）

### 3.7 块存储层能确定的部分

- Hyperdisk Balanced 是 **zonal**；跨 zone 只对 **Hyperdisk Balanced High Availability** 成立（同 region 两个 zone 同步复制，`"HA for disk data for up to one zonal failure"`）。
- zonal 卷多挂要求实例同 zone；regional 卷的挂载实例必须位于某个 replica 所在 zone。
- 多写上限 8 实例（Balanced / Balanced HA）。
- 故障切换：regional 卷可 force-attach 到 standby，`"less than one minute"`；集群化场景 RTO `"less than one second"`。
- Hyperdisk ML：只读多挂最多 2500 实例，**zonal 且不可跨 zone 复制**，定位是不可变数据集的高读吞吐加速加载 → 属冷启动加速，不是状态载体。
- **推断（非文档陈述）**：若 ACE 的 per-microVM Hyperdisk 是 zonal 卷，则跨 zone 重建只能靠"快照 + 恢复 + 新卷"，同 zone 换节点才可能靠 detach/attach；ACE 用哪种型号、zonal 还是 regional，均未文档化。

### 3.8 ACE 预览开放后要钉死的四件事

1. 是否有 snapshot 资源，字段里有没有 `region` / `zone` / `instanceAffinity` → 一次回答可移植性与同构要求。
2. `instance-bound cryptographic grants` 的重签主体与触发条件。
3. 快照落点（本地盘 / Hyperdisk / GCS）与是否增量。
4. 是否存在面向恢复的 warm pool（同族有：GKE Agent Sandbox warm pool 单集群 300 sandboxes/s、90% 分配在 200ms 内完成；Substrate WorkerPool 为 pre-started idle Workers）。

## 四、三方对照

| 维度 | OMA | Google ACE | Google Filestore agent volumes |
|---|---|---|---|
| 隔离原语 | 无（控制面进程内执行） | 硬件隔离 microVM + IPU 中介块设备 | gVisor sandbox + 卷级 NFS 导出 |
| 密钥存放 | 控制面 DB（AES-256-GCM）+ 进程内解密 | guest 内零凭据；egress proxy 沙箱外注入 | 不涉及（存储层无凭据语义） |
| 密钥可达性 | 模型/工具均不可见；服务端代理出向请求 | 沙箱内存/磁盘/metadata server 均不可达 | — |
| 每租户密钥 | 无（全局单密钥，无轮换） | 支持 CMEK / 专用授权令牌 | 未确认（文档只覆盖 instance/backup） |
| 持久化对象 | 事件日志（对话）+ agent 快照 | 每 microVM 专属 Hyperdisk + 内存快照 | per-session NFS 卷（100 MiB–100 GiB） |
| 恢复延迟目标 | 无此概念（无工作区） | 未公布 | 重挂载 < 100ms，卷 CRUD < 1s |
| 跨节点恢复 | 不需要（无数据面状态） | 未确认（IPU 授权绑定 instance） | 是（NFS 可任意节点挂载） |
| 配额/密度 | 无 | 未公布 | 单池 100 万卷；`emptyDir.sizeLimit` 无法约束 |
| 传输中加密 | 由调用方 LLM provider 决定 | 自述 at rest + in transit | **不加密**（NFSv3 AUTH_SYS 明文 uid/gid） |
| 成本模型 | 自托管，成本=自己的服务器 | 未公布 | 按实际消耗容量 + 自动分层；无公开 SKU |

## 五、对本仓（OpenSandbox）的可吸收项

### P0-1：把"沙箱零凭据 + 控制面代理注入"做成显式契约

ACE 的口径（`zero credentials held inside the sandbox` + egress proxy 在沙箱外注入）与本仓 `wiki/opensandbox-egress-netpol-vault-sop.md` 的三层管控是同一个目标。可吸收的是**把它写成契约而不是可选加固**：沙箱内不得存在长期凭据，出向请求的凭据由沙箱外的组件在最后一跳附加；沙箱内可观测到的只有"调用成功/失败"，看不到 token。ACE 的 SPIFFE 身份 + `"This identity is not usable to call a backend API directly, if it is exfiltrated off the machine."` 这条性质可以直接作为本仓凭据设计的验收项。

### P0-2：凭证存储的密钥卫生补齐

OMA 的实现足以作为**反面基线**参考：全局单密钥、密钥与 DB 同机、无轮换（spec 里明写 future）、无 KMS。本仓若走池化 + Vault 注入，至少要明确三件事：密钥来源（外部 KMS / 注入而非落盘 `.env`）、轮换路径、以及"哪些字段在加密边界内"。OMA 的加密边界只覆盖 vault 凭据与 MCP token，而 `sessions.resources[].authorization_token` 明文落库并原样返回——这类"边界漏一个字段"的错误在本仓同样容易出现（例如 taskTemplate 注入的 `user_auth_token`，见 `wiki/opensandbox-task-template-user-info-injection-example.md`），值得在评审清单里固定成检查项。

### P1-1：会话连续性用事件日志 + 配置快照，而不是快照整个工作区

OMA 的 `buildMessagesFromEvents()` + `agent_snapshot` 是低成本、可审计的方案：对话与 agent 版本可完整重放，不需要任何数据面存储。本仓池化短任务主路径下，若业务只需要"对话可续、agent 配置可复现"，这条路径的成本远低于卷快照；真正需要工作区时才落到 S3 制品中间件（`wiki/opensandbox-pooled-session-s3-sync-middleware.md`）。即：**把"要恢复什么"拆成对话态、配置态、文件态三档，分别给最便宜的机制。**

### P1-2：per-volume 导出的隔离粒度作为多部门池的存储基线

Filestore agent volumes 的隔离是"一卷一独立文件系统 + 卷级 IP ACL + `root_squash`"，且**不依赖云身份**。本仓在池化模式下按部门/租户隔离共享存储时，可以直接对齐这套口径：租户边界 = 独立卷/子路径 + 挂载侧 ACL + 降权，而不是指望工作负载自证身份。同时它的 `HOT/WARM/COLD` 分层给出了一个"卷在但不可挂载"的中间态，可用于长会话池的成本优化（对照本仓 `wiki/opensandbox-pool-mode-volumes-and-storage-practice.md` 的回收策略矩阵）。

### P1-3：重新挂载延迟 < 100ms 作为长会话池的验收指标

Filestore agent volumes 把"卷 attach < 100ms"作为公开指标，Agent Substrate 的 resume 语义也建立在这个数字上。本仓若要给长会话池做"计算释放 + 存储保留 + 快速重挂"，应把这个量级写成验收门禁，而不是只测 create 延迟。

### P1-4：恢复语义按"能跑就先跑"设计（durable artifact + 节点预热 + 按需取页）

GKE Pod snapshots 的恢复不是"全量下载完再启动"：`runsc restore` 默认 **background restore**，内核态加载完即开始执行，剩余内存与文件数据异步拉取；应用访问尚未恢复的页时，GKE Sandbox 拦截 page fault 并**优先取该页**。Substrate 侧同构：从 WorkerPool 取 warm Worker 再恢复 snapshot。

对本仓的含义：Fast Sandbox / 长会话池的恢复路径应显式分成"最小可运行集"与"后台补全集"，并把冷数据取回做成 page-fault 或首次访问驱动。同时 warm pool 是恢复速度的另一半——恢复请求到达时得先有地方跑，本仓池化模式天然有池，可直接复用为恢复目标池。

### P1-5：把兼容性约束与连接语义写进恢复接口契约

两条 Google 路径都把约束写在文档正面：Pod snapshots 要求目标节点 **same machine series、CPU vendor、CPU feature set（`CPUID` flags）**，且 kernel 与 GPU driver 版本一致；活动连接在 restore 后关闭（listening / loopback / Unix socket 除外），Substrate 也明写 open network connections 不保留、业务必须自行重连。

本仓的 QEMU vmstate、fsb checkpoint、容器 OCI 快照三条路径都隐含同类约束。建议：(1) 在恢复接口上显式声明并**校验**机型/CPU 特性/运行时版本，而不是留给运行时偶然失败；(2) 在业务契约里写死"恢复后既有连接失效、需重连"，与 execd 会话的断线语义对齐。

### P1-6：恢复耗时按阶段可观测

Substrate 把 restore 拆成 `download` / `worker_restore` / `vm_restore` / `wakeup_probe` 并打结构化日志，checkpoint 侧对称拆成 `pause` / `snapshot` / `persist` / `worker_*`。没有这层粒度，恢复变慢时无法判断是搬运、解压、guest 重建还是唤醒探测。本仓 Fast Sandbox 与 QEMU 恢复链路应给出同粒度阶段计时。

### P2-1：late-binding 的配额教训

官方承认 `"standard Kubernetes emptyDir.sizeLimit settings can't enforce per-agent storage quotas on the mounted NFS path"`。本仓池化 + 共享存储若采用类似"privileged DaemonSet 在 host 挂载进 Pod"的旁路，必须自带配额执行点（卷级配额或 quota 侧车），否则 K8s 的 `sizeLimit` 会给出虚假的安全感。

### P2-2：Hyperdisk 的多写语义作为"共享块设备"参考

若本仓未来要走 KVM/microVM + 远程盘（对照 `wiki/opensandbox-vm-microvm-remote-storage-mount-forms.md`），Hyperdisk Balanced HA 的"多 VM 并发读写、推荐给集群文件系统"是一个可参考的边界：块设备允许多写 ≠ 文件语义正确，仍需 guest 内集群文件系统或单写者约束。不要把它当作共享文件存储使用。

## 六、不建议吸收的项

- **IPU 硬件中介的块设备授权**：ACE 的 `"hardware-mediated by the IPU using instance-bound cryptographic grants"` 依赖 Google 自研加速器，在内网 K8s 上没有对应物，不可复刻。
- **"取消沙箱"换取简化**：OMA 的路径对本仓不成立。本仓的业务前提是执行不可信代码、需要网络与文件隔离；把 agent loop 放进 API 进程会让 `bash` 工具直接落在服务进程上（OMA 自己就因为无执行器而停在 `Unknown tool`）。
- **全局单密钥 + `.env` 落盘**：OMA 的首启自动生成密钥并回写 `.env` 的默认行为，在多部门共享部署下等于把 DB 与密钥放在同一个备份里。
- **NFSv3 + AUTH_SYS 作为敏感数据路径**：uid/gid 明文、无传输加密。Filestore agent volumes 面向的是"模型生成的代码在 gVisor 里跑"这一档，本仓的敏感数据场景需要更强的传输侧边界。

## 七、待验证与风险

**未确认（Google 侧）：**

1. agent volumes 的 CMEK 支持：文档只写 instance/backup，API schema 无 kms 字段；查过 cmek 页、create-volume-pools、overview、v1beta1 discovery。
2. agent volumes 传输中加密：无任何文档提及；由 StorageClass `vers=3` + 默认 `AUTH_SYS` 推断为不加密，官方未正面声明。
3. agent volumes 定价：Filestore 定价页无 volume pool/agent volumes 的 SKU，只有 blog 的定性说法。
4. 每卷/每池 IOPS 与吞吐数值：只有 API 字段 `activeVolumeIops`，无数值区间。
5. 卷级快照/备份：late-binding 文档提到触发 Filestore snapshot，但无独立卷快照 API；`Snapshot` 资源仍绑定 instance。
6. per-volume IAM：schema 只有项目级 role，未见 resource-level IAM policy 支持。
7. ACE 官方是否使用 "ACE" 缩写：官方 blog/docs 未出现，仅第三方使用。
8. Volume/VolumePool 的 REST 参考页尚未发布（404），字段信息取自官方 discovery JSON。
9. **ACE 的跨节点重建**：快照格式与内容范围、能否换机器/换 zone、落点、是否增量、恢复延迟数字、是否要求同机型/同 CPUID、是否有 live migration、是否有面向恢复的 warm pool、`instance-bound grants` 的重签语义、egress proxy 绑定的重建流程——全部未公开，详见 3.5 与 3.8。检索范围：两篇官方博客全文、`docs.cloud.google.com/agent-compute-engine*` 与 `cloud.google.com/agent-compute-engine*` 系列探测、Titanium 架构文档全文、HN Algolia 与多轮中英文检索。

**风险提示（OMA 侧）：**

- OMA 是本仓外部项目，`main` 分支 HEAD `e9a0743`；README 的"387 tests / 生产就绪"为其自述，本次只核对了与本主题相关的代码路径，未运行其测试套件。
- OMA 声称的 `bash/edit/read/write/glob/grep` 工具集与 `vault_ids` / `allowed_hosts` 运行时语义，在当前 HEAD 上均为"声明存在、执行缺失"；后续版本可能补齐，结论需按 commit 复核。

## 八、参考

### Open Managed Agents（核对 commit `e9a0743`）

- 仓库：https://github.com/rogeriochaves/open-managed-agents
- 代码：`packages/server/src/lib/encryption.ts`、`lib/mcp-client.ts`、`routes/vaults.ts`、`routes/sessions.ts`、`routes/environments.ts`、`engine/index.ts`、`db/schema.ts`、`schemas/agents.ts`、`schemas/sessions.ts`
- Spec：`specs/encryption.feature`、`specs/vaults-api.feature`、`specs/sessions-api.feature`、`specs/engine-mcp.feature`
- 部署：`docker-compose.yml`、`helm/open-managed-agents/values.yaml`、`helm/open-managed-agents/templates/pvc.yaml`

### Google Cloud

- Filestore agent volumes 发布：https://cloud.google.com/blog/products/storage-data-transfer/filestore-agent-volumes
- About Filestore agent volumes：https://docs.cloud.google.com/filestore/docs/agent-volumes-overview
- Set up Filestore agent volumes：https://docs.cloud.google.com/filestore/docs/agent-volumes-prerequisites
- Volume pools：https://docs.cloud.google.com/filestore/docs/create-volume-pools
- Agent Sandbox / late binding：https://docs.cloud.google.com/filestore/docs/agent-sandbox 、https://docs.cloud.google.com/filestore/docs/agent-sandbox-latebind
- Agent Substrate：https://docs.cloud.google.com/filestore/docs/agent-substrate
- Filestore CMEK：https://docs.cloud.google.com/filestore/docs/cmek
- NFSv4.1 与 AUTH_SYS 说明：https://docs.cloud.google.com/filestore/docs/configure-nfsv4
- Filestore API discovery（v1beta1，`Volume.ipAcls` / `VolumePool.activeVolumeIops` / `Volume.state`）：https://file.googleapis.com/$discovery/rest?version=v1beta1
- Agent Compute Engine 发布：https://cloud.google.com/blog/topics/ai-infrastructure/introducing-agent-compute-engine-and-expanded-agent-governance
- Agent Compute Engine deep dive：https://cloud.google.com/blog/topics/ai-infrastructure/agent-compute-engine-deep-dive
- Hyperdisk：https://cloud.google.com/compute/docs/disks/hyperdisks
- 磁盘加密（含 CMEK/CSEK 限制）：https://cloud.google.com/compute/docs/disks/disk-encryption
- Hyperdisk Balanced：https://docs.cloud.google.com/compute/docs/disks/hd-types/hyperdisk-balanced
- GKE Hyperdisk 持久卷：https://docs.cloud.google.com/kubernetes-engine/docs/how-to/persistent-volumes/hyperdisk
- Hyperdisk Balanced / Balanced High Availability：https://docs.cloud.google.com/compute/docs/disks/hd-types/hyperdisk-balanced 、https://docs.cloud.google.com/compute/docs/disks/hd-types/hyperdisk-balanced-ha
- Hyperdisk ML（只读多挂 2500 实例、zonal）：https://docs.cloud.google.com/compute/docs/disks/hd-types/hyperdisk-ml
- 卷在 VM 间共享的 zone 约束与 8 实例上限：https://docs.cloud.google.com/compute/docs/disks/sharing-disks-between-vms
- Regional Persistent Disk / force-attach 延迟：https://docs.cloud.google.com/compute/docs/disks/about-regional-persistent-disk
- Titanium 硬件安全架构（IPU / SSD 密钥控制器）：https://docs.cloud.google.com/docs/security/titanium-hardware-security-architecture 、https://cloud.google.com/titanium

### Google 侧跨节点恢复（文档化路径，均非 ACE）

- GKE Pod snapshots（概念，含 CPUID/机型约束、后台恢复与按需取页、连接关闭语义）：https://docs.cloud.google.com/kubernetes-engine/docs/concepts/pod-snapshots
- Agent Sandbox Pod snapshots 操作页（含 `"don't work with microVM sandboxes"`）：https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox-pod-snapshots
- Agent Substrate 概念与生命周期：https://docs.cloud.google.com/kubernetes-engine/ai-ml/about-agent-substrate
- Agent Substrate 发布 blog（`"less than 500ms"`、WorkerPool）：https://cloud.google.com/blog/products/containers-kubernetes/agent-substrate-available-on-gke
- Agent Substrate 安装与 mTLS 证书签发：https://docs.cloud.google.com/kubernetes-engine/ai-ml/install-overview-substrate
- agent-substrate 仓库（架构、suspend/resume 阶段分解、CSI 卷、objectstore 插件）：https://github.com/agent-substrate/substrate/blob/main/docs/concepts/architecture.md 、https://github.com/agent-substrate/substrate/blob/main/docs/dev/suspend-resume-phase-breakdown.md 、https://github.com/agent-substrate/substrate/blob/main/docs/guides/csi-volumes.md
- GKE Agent Sandbox warm pool 数字：https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate
- gVisor checkpoint/restore（background restore、CPU 特性校验、`ECONNRESET`）：https://gvisor.dev/docs/user_guide/checkpoint_restore/

### 本仓对照文档

- `wiki/opensandbox-egress-netpol-vault-sop.md`（三层出口管控与 Credential Vault）
- `wiki/opensandbox-pooled-session-s3-sync-middleware.md`（池化会话 S3 静默同步）
- `wiki/opensandbox-pool-mode-volumes-and-storage-practice.md`（池模式卷类型与回收策略）
- `wiki/opensandbox-vm-microvm-remote-storage-mount-forms.md`（KVM/microVM 远程存储形态）
- `wiki/opensandbox-vs-perplexity-space-architecture.md`（SPACE 凭据与数据面边界对照）
- `wiki/opensandbox-task-template-user-info-injection-example.md`（用户凭据注入沙箱的现有做法）
