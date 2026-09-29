# OpenShell 可移植策略设计（移植到 OpenSandbox）

**定位：** 从 [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) 的沙箱内管控/隔离策略设计中，筛选**可以移植进本仓库**的部分，并按可行性分档，给出落点与验收判据。
**状态：** 方案设计（未实施）。A 档各项若改动 `specs/*` 公共契约，需先立 OSEP 并同步 SDK/docs。
**核实依据：** OpenShell 源码 `D:\pro\openshell`（commit `1358941`，2026-09-28，浅克隆）+ 官方文档；本仓库 `oseps/`、`wiki/`、`specs/`、`components/`、`MEMORY.md`。

> **本文只做筛选与落点设计，不做实现，也不含实测数据。** OpenShell 侧语义全部来自源码与官方文档阅读，尚未在本仓库实现或验证。

---

## 0. 结论：可移植清单

| 档 | 项 | 优先级 | 是否需要 OSEP |
|---|---|---|---|
| **A 直接移植**（无新组件、不动 D-1~D-10） | A1 出网规则 `enforcement: audit \| enforce` 灰度 | P0 | 是（改 `specs/egress-api.yaml`） |
| | A2 出网决策结构化事件（audit/deny/mismatch/policy_stale） | P0 | 是 |
| | A3 SSRF/私网/元数据/控制面端口基线阻断清单 | P0 | 否（基线策略内容） |
| | A4 凭据"独立双边界"语义 + mismatch 事件（**但向业务 fail-open**） | P1 | 是 |
| | A5 `run_as` 策略字段 + 策略变更 diff 报告 | P1 | 部分是 |
| **B 需 OSEP / 中等改造** | B1 "边界确认属性"降级为**可观测状态**，不做门禁 | P1 | 是 |
| | B2 隔离会话内 FS allowlist 字段化（保持 opt-in） | P2 | 是 |
| | B3 凭据轮转与 readiness | P2 | 是（OSEP-0012 现为 non-goal） |
| **C 不移植** | C1 fail-closed 边界契约；C2 per-binary/per-request L7 + 中间件链；C3 provider profile 整体模型；C4 全局策略"替换"语义 | — | — |

---

## 1. 前提：两个正交的轴必须分开

对比时最容易把两件事混成一件，混了就会得出错误结论：

| 轴 | 含义 | OpenShell | 本仓库 | 本文主张 |
|---|---|---|---|---|
| **轴 A：默认姿态** | 没被策略允许的流量怎么处理 | default-deny（`network_policies` 无规则 = 全部出网拒绝） | default-deny（egress `defaultAction: deny`；池模式靠 NetworkPolicy） | **保持不变**。这是安全基线，不该因为"fail-open 友好"而放宽。 |
| **轴 B：失败行为** | 组件不可用 / 强制属性没确认 / 内核不支持时怎么办 | **fail-closed**（契约拿不到确认就不给 Ready、不启动 agent；凭据绑定不匹配 → 403） | **fail-open**（`oseps/0018` §R7：*"All features fail open (log + skip, never abort startup); actual state reported on the capabilities endpoint"*；文中亦自称 *"fail-open but honest"*） | **保持 fail-open，并把"honest"这一半补齐。** |

**本仓库的取舍（本文的设计前提）：** 业务部门没有集群管理员权限，平台基建（RuntimeClass、CNI、sidecar 镜像、策略加载）对他们不可反推；若把轴 B 做成 fail-closed，平台侧问题会直接表现为业务侧故障，且业务无法自助定位。因此：

> **原则：fail-open by default, never fail-open silently.**
> 失败一律放行（可用性优先），但每一次失败都必须在业务可见面上留下**可归因**的结构化记录；同时继续保证策略本身是 default-deny（轴 A 不受影响）。

这条原则正好是 `oseps/0018` 已有的方向；本文的贡献是**把 OpenShell 的"honest"部分（结构化事件、能力状态、策略视图）移植过来，而不移植它的 fail-closed 阻断契约**。

---

## 2. A 档：直接移植

### A1. 出网规则增加 `enforcement: audit | enforce` 灰度（P0）

**OpenShell 语义**（`docs.nvidia.com/openshell/.../policies/network-rules`、`.../policies/schema`）：

- `enforcement` 默认 **`audit`**：放行请求 + 记录 violation；显式 `enforce` 才拦截（HTTP 客户端收到 `policy_denied`）。
- 文档明确：*"an endpoint in audit mode does not block requests that break its rules"*；`audit` 只作用于该 endpoint 的 allow/deny 规则，无法安全处理的请求（畸形请求、发往其它 host 的请求）仍会被拒绝。
- 推荐流程：先 `audit` 上线，观察日志里的 violation，确认符合预期后再切 `enforce`。

**为什么这条最贴合本环境：** 它就是"fail-open + 可观测"的原生形态。业务上线新域名白名单时，先看"哪些请求会被拦"，不需要平台帮他们反推；切 enforce 的决定权也留在业务侧。

**落点：** `specs/egress-api.yaml` → `NetworkRule`（当前只有 `action: allow|deny` + `target`，且 `additionalProperties: false`，见 `specs/egress-api.yaml:387-400`）。

**关键兼容细节（必须写进 OSEP）：** 若把缺省值定为 `audit`，会**静默放宽**现有 deny 规则的行为。因此：**缺省必须保持现有行为（等价 `enforce`），`audit` 仅在显式声明时生效**；同时 `delete`/`patch` 的合并语义（"first rule wins"、"incoming 优先级更高"）要一并说明 audit 规则如何参与合并。

### A2. 出网决策结构化事件（P0）

**OpenShell 侧：** `crates/openshell-ocsf`（`builders/ enums/ events/ objects/ validation/ tracing_layers/`）提供 OCSF 事件构建与校验；凭据失败事件明确"不记录 secret、placeholder、环境变量名、查询串"。

**本仓库现状：** `oseps/0019` 明确"不定义未来沙箱内审计 schema"，节点本地状态+日志是持久化基础；egress 已有 OTel 接入（`components/egress/docs/opentelemetry.md`）。

**移植内容：** 定义最小事件集并落成结构化日志/OTel 事件：

| 事件 | 触发 |
|---|---|
| `egress_allow` / `egress_deny` | 规则命中放行/拒绝 |
| `egress_audit_violation` | `enforcement: audit` 下本会被拦的请求 |
| `credential_endpoint_mismatch` | 网络策略放行但凭据绑定不覆盖该 endpoint |
| `policy_stale` | 策略超过刷新窗口未成功更新 |
| `policy_failed_open` | 策略加载/解析失败，按 fail-open 放行 |

**公共字段：** `sandbox_id`、`rule`、`target`、`decision`、`reason`、`enforcement`、`policy_revision`、`ts`；**禁止**记录凭据值、占位符、凭据环境变量名、查询串。

**意义：** 这是 A1 与 B1 的前提——fail-open 不沉默，全靠这一层。

### A3. SSRF / 私网 / 元数据 / 控制面端口基线阻断（P0）

**OpenShell 语义：**

- 网络策略**从不**授权目标是 loopback、link-local、unspecified 的出网，**包括云元数据地址 `169.254.169.254`**；不阻止沙箱内连接自己的 loopback 服务。
- 通配主机只能通过 `allowed_ips` 访问私网；`openshell policy update` 拒绝与阻断段重叠的 `allowed_ips`。
- 对使用精确主机名 / IP / `allowed_ips` 的 endpoint，另外阻断 K8s/etcd 控制面端口 `2379、2380、6443、10250、10255`。

**本仓库现状与缺口：** `oseps/0001` 自认 *"DNS-only mode is a soft limit"*（直连 IP、DoH 可绕过）；egress 用户规则的 `target` **不支持 IP/CIDR**（MVP 限制）；池模式走 NetworkPolicy，本来就能做 IP/CIDR。

**移植方式（当作平台基线，不做成用户策略）：**

- **池模式**：基线 NetworkPolicy 增加"阻断指向元数据地址与控制面端口、只放行受控出站目标"的规则，pre/post 沙箱一律覆盖。
- **sidecar 模式**：写进 `deny.always`（`components/egress/pkg/policy/always_rules.go`，路径 `/var/egress/rules/deny.always`）；注意 `allow.always/deny.always` 在 IP 层同样生效（`components/egress/fastsandbox_server.go:374`）。

**注意这条不违反 §1 的原则**：它属于轴 A（默认姿态），是"本来就该拒绝的地址"，不是"组件失败时的降级行为"。

### A4. 凭据"独立双边界"语义 + mismatch 事件（P1，向业务 fail-open）

**OpenShell 语义：**

- 静态凭据解析有**两个相互独立的授权边界**：① 网络策略必须允许该二进制与目标；② 凭据绑定必须覆盖请求的 host/port/path。两者都过才注入。
- *"A network rule that allows traffic to a destination does not allow OpenShell to send provider credentials there."* —— 放宽网络规则不会顺带放宽凭据，修凭据问题应该改 binding 而不是放宽网络规则。
- 不匹配时 fail-closed（403 + `credential_endpoint_mismatch`），并发出事件且不记录 secret。

**本仓库已有：** Credential Vault 已按 scheme/port/host/method/path 绑定 + 代理处 header 注入（`oseps/0012`），且 `CredentialVaultMutationRequest` 已有 `expectedRevision` 乐观并发字段（`specs/egress-api.yaml:417-419`）。

**移植差异（按 §1 原则改写）：** **照搬语义、不照搬 fail-closed**：

- 绑定不匹配时**不返回平台侧 403**，让请求按上游方式失败（业务看到上游 401/403，自己能定位），**但平台侧必须发 `credential_endpoint_mismatch` 事件**。
- 文档化"独立双边界"规则：网络规则变更与凭据绑定变更必须分开审、分开改。
- **唯一不可协商的例外（必须 fail-closed）：占位符/空凭据绝不能被原样转发到上游。** 那是泄漏 + 静默失效，与可用性无关。

### A5. `run_as` 策略字段 + 策略变更 diff 报告（P1）

**(a) run_as 字段化。** OpenShell 的 `process.run_as_user / run_as_group` 是策略字段并拒绝 root。本仓库现状：未加固时继承容器身份（通常 root）；隔离会话用 `setpriv --reuid=N --regid=N`（默认 = execd 的 uid）；bwrap 白名单在 TOML（`components/execd/pkg/isolation/config.go` 的 `AllowedWritable`）。移植：把 run_as 提升为**模板/请求级策略字段并默认非 root**；设置失败按 fail-open 处理 + 能力状态上报（沿用 `oseps/0018` 的 capabilities 上报路径）。

**(b) 策略变更 diff 报告。** OpenShell 用 `crates/openshell-prover`（regorus 做 containment 形式化检查）+ policy advisor。**形式化验证不移植**（成本与本环境不匹配），降级为 CI 门禁脚本：解析策略变更，输出"**本次变更新增放行了哪些 target、会让哪些凭据绑定被实际用到**"的差异报告，人工确认后生效。价值：业务看得懂、平台不背锅，符合"业务层审计"约束（`MEMORY.md` 硬约束 4/7）。

---

## 3. B 档：需先立 OSEP / 中等改造

### B1. 把"边界确认属性"降级为可观测状态，不做门禁（P1）

**OpenShell**（`crates/openshell-isolation-interface/src/contract.rs`，RFC 0012）把状态机写死为 `attach → Bound → confirm → Ready → start_agent → Running`，并明确 *"the supervisor cannot obtain a ready boundary without confirmed backend-neutral enforcement properties"*；二进制身份解析不出即 deny。这是轴 B 的 fail-closed。

**移植改造：** 只取它的**信息模型**，不取它的阻断语义——把"运行时档位、加固、seccomp、Landlock、egress 策略是否**实际**生效"做成 **status condition + capabilities 端点**（execd 侧已有 capabilities 上报，即"honest"的另一半），**不作为 Pool/Sandbox 的 Ready 门禁**。

**理由就是本文 §1 的前提：** 门禁会让"平台侧没装 RuntimeClass / CNI 没实现 NetworkPolicy"表现为"业务沙箱起不来"，而业务无法反推。改为"照常起 + 状态可见 + 平台告警"。

**落点：** `kubernetes/`（Pool/BatchSandbox status conditions）、`components/execd`（capabilities）、监控告警。注意 `oseps/0018` §R7 已要求"fail open + 状态上报"，本项是把该要求**扩展到 egress 与运行时档位，并打通到业务可见面**。

### B2. 隔离会话内文件系统 allowlist 字段化（P2，保持 opt-in）

**OpenShell：** Landlock 路径白名单（绝对路径、≤256 条、`read_write` 不能是 `/`），且进程/文件系统/Landlock 三段**启动期固定**。

**本仓库：** `[landlock] enabled` 为可选、默认不启用，内置 allowlist 是系统路径（`docs/components/execd.md:327-368`）；bwrap 会话已有 `--ro-bind / /` + workspace `rw|overlay|ro` + `allowed_writable` 默认白名单。

**移植（克制版）：** 仅在隔离会话 / 敏感池，把"只读路径集合"与 `allowed_writable` 提升为**模板可声明的策略**；保持默认关闭、启用失败不阻断（fail-open + 上报）。**不要**给普通 `/command` 加 per-path allowlist——`oseps/0013` 已明确拒绝（理由：AI agent 路径依赖不可预测），该结论保留。

### B3. 凭据轮转与 readiness（P2）

**OpenShell：** provider refresh（网关侧铸造 OAuth2 / Google SA JWT / AWS STS 短期凭据）+ provider readiness（只表示"sandbox 是否已应用 credential/policy/env"，**不测试**后端连通性，也不取消已发出的请求）。

**本仓库：** `oseps/0012` 明确 rotation、versioning、审批 workflows 为 out of scope，MVP 只有 inline 值且仅内存。移植需新 OSEP：**先做 readiness 语义（轻），再做轮转（重）**；readiness 的措辞照 OpenShell 的克制定义，别让业务误以为它代表后端可用。

---

## 4. C 档：明确不移植，以及为什么

### C1. fail-closed 边界契约
见 §1 与 B1：本环境的权限结构（业务无集群管理员权限、无法反推平台基建）决定了轴 B 必须 fail-open。**降级为 B1 的可观测状态**，不移植阻断语义。

### C2. per-binary / per-request L7 出网策略 + supervisor 中间件链
OpenShell 的核心卖点（"哪个二进制 → 哪个 endpoint → 哪个 method/path"，配 `on_error: fail_closed` 的中间件链）**在本仓库无法低成本落地**，三条硬约束：

1. 需要每沙箱常驻代理，与 `MEMORY.md` **D-7（去 egress sidecar，省 20~50MB/沙箱）** 直接冲突；
2. gVisor netstack 不实现 iptables `nat` 表 → **与 egress sidecar 不兼容**（`wiki/opensandbox-k8s-networkpolicy-vs-egress-sidecar.md`），即"强隔离"与"L7 出网"二选一；
3. egress 用户规则的 `target` 只到 FQDN；L7 还需透明 mitmproxy 且历史默认模式解密所有配置端口，爆炸半径大（`oseps/0023` 的 credential-bound 才是收敛形态）。

**替代路径（已在用）：** L7 需求交由 Higress/Cilium 分层（`wiki/opensandbox-egress-pool-higress-architecture.md`；`wiki/opensandbox-execd-command-vs-k8s-exec-and-egress-isolation.md` 已写明"egress 到不了 HTTP 路由前缀"）。

> 补充一条**可用于未来**的判断：OpenShell 用 procfs（`/proc/net/tcp` → inode → `/proc/*/fd` → exe 真实路径 + 祖先链 + 首次使用 hash 冻结）反推发起进程；本仓库不需要这套——**execd 本身就是命令的启动者**，`/command` 请求时已知 session/command 与进程组。若将来要给"敏感池（带 sidecar）"做 per-command 出网策略，身份键应取 execd 的 session/进程组，而不是移植 procfs 归因。

### C3. provider profile / endpoint-bound 凭据模型整体搬
与 **D-1（租户/配额/审计在业务层，不用 server `[tenants]`）** 冲突：OpenShell 把凭据、endpoint 授权、profile 生命周期都收在网关侧。本仓库只吸收 A4 的两条语义（独立双边界、mismatch 事件），凭据来源与生命周期仍归业务层。

### C4. 全局策略"替换"语义
OpenShell 的 global policy **替换**每个沙箱自己的策略、并抑制 provider 贡献的规则、同时禁止沙箱侧改策略。本仓库应保持**叠加**语义（`deny.always` > `allow.always` > 用户策略），理由：D-1/D-2 下策略来源是多层且分属不同责任方，替换语义会让"业务层收敛"退化成平台裁决。

**但要吸收它的一个可取之处：** OpenShell 区分 **base policy 与 effective policy**，并要求"看沙箱实际能访问什么"要查 effective。本仓库 egress 侧已有 `refreshEffectivePolicy`（`components/egress/pkg/dnsproxy/proxy.go:108`，合并 `deny.always/allow.always` 覆盖层）——**缺的是把生效结果对外可查询**，让业务能自查"我的沙箱现在到底放行了什么"，这是 fail-open 环境下业务自助定位的关键前提。

---

## 5. 落点汇总（改哪里）

| 接缝 | 落点 | 涉及项 |
|---|---|---|
| `specs/egress-api.yaml` | `NetworkRule` 增 `enforcement`（缺省保持既有行为）；`/policy` 增生效视图；事件/状态字段 | A1、A2、A4、C4 |
| `components/egress/` | audit 模式判定；`policy.EgressRule` 事件；`always_rules` IP 层基线；`refreshEffectivePolicy` 暴露为对外查询 | A1、A2、A3、C4 |
| `components/execd/` | run_as 策略字段；隔离会话 FS allowlist 字段化；capabilities 上报扩展 | A5、B1、B2 |
| `kubernetes/` | 池模式基线 NetworkPolicy（元数据/控制面/私网）；Pool status conditions | A3、B1 |
| CI | 策略变更 diff 报告门禁 | A5 |
| `wiki/` | 本文 + 既有网络隔离选型文档互相引用 | 全部 |

> `specs/*` 是公共契约：改字段要同步 server、SDK、docs、examples（见根 `AGENTS.md` Guardrails）。

---

## 6. 验收判据

| 项 | 判据（**含 fail-open 的验证点**） |
|---|---|
| A1 | audit 模式下：请求成功 **且** 业务能收到"本会被拦"的事件；切 enforce 后同一请求被拦；**未显式声明 `enforcement` 的既有规则行为与改动前完全一致**（回归用例） |
| A2 | 制造三类失效（策略拉取失败 / 规则解析失败 / sidecar 不可用）：业务面各有一条带 `reason` 的事件；**不存在"策略未生效且无任何事件"的窗口** |
| A3 | 沙箱内连 `169.254.169.254`、直连 Pod/Service CIDR、连 6443 均失败；池模式与 sidecar 模式**都**成立 |
| A4 | 把 token 发往未绑定 host：业务侧看到的是**上游** 401/403（不是平台 403），平台侧有 mismatch 事件；抓包/日志确认占位符未出现在上游 |
| A5 | 策略 PR 自动产出"新增放行 target + 新增凭据使用"的 diff 报告 |
| B1 | 人为制造"未确认的强制属性"（如 CNI 不实现 NetworkPolicy）：沙箱**照常可用**，状态/告警可见，业务侧无阻塞 |

---

## 7. 来源与核实边界

**OpenShell 源码**（`D:\pro\openshell` @ `1358941`，2026-09-28）：

- `crates/openshell-isolation-interface/src/contract.rs`（RFC 0012 边界契约）、`src/linux/{landlock,seccomp_notify,child_seccomp}.rs`
- `crates/openshell-supervisor-network/src/opa.rs` + `data/sandbox-policy.rego`（嵌入式 regorus 策略引擎，在 **supervisor 侧**）
- `crates/openshell-sandbox/src/network_broker.rs`（workload 侧 seccomp-notification broker，只上报不判决）
- `crates/openshell-supervisor-middleware/src/lib.rs`（`on_error: fail_closed | fail_open` 中间件链）
- `crates/openshell-ocsf/`、`crates/openshell-prover/`、`crates/openshell-driver-mxc`（Windows/MXC）、`crates/openshell-vfio`

**OpenShell 官方文档：** `docs.nvidia.com/openshell/latest/` 的 `about/architecture`、`how-it-works/policies/{overview,network-rules,schema,default-policy}`、`how-it-works/providers/overview`、`how-it-works/inference`、`kubernetes/setup`。

**本仓库：** `MEMORY.md`（D-1~D-10）、`oseps/{0001,0004,0012,0013,0018,0019,0023}`、`wiki/opensandbox-k8s-networkpolicy-vs-egress-sidecar.md`、`wiki/opensandbox-egress-internals-reference.md`、`wiki/opensandbox-egress-pool-higress-architecture.md`、`wiki/opensandbox-execd-command-vs-k8s-exec-and-egress-isolation.md`、`specs/egress-api.yaml`、`components/egress/`、`components/execd/`、`docs/components/execd.md`。

**已排除的二手说法**（引用 OpenShell 时不要沿用）：

- 网传"策略在沙箱内用 OPA 评估、路径 `crates/openshell-sandbox/src/opa.rs`"——该路径在现行源码中**不存在**，引擎已位于 `openshell-supervisor-network`。
- 网传"OpenShell 只能 Linux 单机"——`openshell-driver-mxc`（Windows/MXC）与其 driver 集合已推翻。

**未做验证的部分：** 本文所有 OpenShell 语义来自源码/文档阅读（少量 grep 核验），**未在本仓库做过实现、未跑过 k3s 实测**；A/B 档每一项落地都需要独立 OSEP/PR 与实测数据。
