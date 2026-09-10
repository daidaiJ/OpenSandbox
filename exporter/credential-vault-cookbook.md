# 凭据注入 Cookbook（OSEP-0012 Credential Vault）

业务当前用 taskTemplate env 注入用户 token（D-8）：明文对沙箱内任意进程可读。上游 **Credential Vault** 把注入收窄为"仅匹配 host/method/path 的出向请求自动携带凭据"，沙箱内拿不到明文。本篇讲清原理、API、硬前提，以及**当前业务该不该迁、什么时候迁**。

**前提**

| 项 | 约定 |
|---|---|
| 现状 | D-8：taskTemplate env 注入；短期继续（见 §6 决策） |
| 模式依赖 | Vault 挂在 **egress sidecar**（per-sandbox）或 fleet 共享 MITM（OSEP-0022，server 编排未落地） |
| 状态口径 | oseps/README 仍标 implementing（2026-06-10 未刷新），但 per-sandbox 模式代码/spec/文档均已落地（PR #1009） |

## 目录

- [1. Vault 是什么、不是什么](#1-vault-是什么不是什么)
- [2. 工作原理](#2-工作原理)
- [3. API 形态](#3-api-形态)
- [4. 硬前提与 fail-closed](#4-硬前提与-fail-closed)
- [5. 可用性现状与池化差距](#5-可用性现状与池化差距)
- [6. 业务决策建议](#6-业务决策建议)
- [参考](#参考)

---

## 1. Vault 是什么、不是什么

OSEP-0012 定位是**经纪层（broker）**，不是 secret manager（Non-goal）：

| ✅ 是 | ❌ 不是 |
|---|---|
| 沙箱进程可用凭据发请求，但**拿不到明文** | 不做集中式 secret 存储/加密保管 |
| 凭据 write-only：inline 写入后转沙箱级**内存态** material，API 永不返回 | 不落盘、不进 K8s Secret、不进 env/文件 |
| 支持运行时 PATCH 原子轮换（revision 乐观锁） | 不保证 sidecar 重启后存活——**内存态，重建即失效需重推** |

## 2. 工作原理

```
应用容器（零改造，正常发 HTTPS）
   │  沙箱 netns 内 iptables REDIRECT 80/443（egress sidecar 既有机制）
   ▼
mitmdump --mode transparent（credential proxy = MITM 上的凭据 addon）
   │  按 binding 匹配：schemes + hosts（必填）+ methods + paths
   ▼
命中 → 删除同名 header → 注入凭据 header → 上游
未命中 → 原样放行；跨 host redirect 重评并剥离凭据
```

- 默认仅 `https:443` 注入；HTTP 需显式 opt-in。
- 同一请求命中多个 binding → **fail closed**（拒绝请求）。
- 注入前先删同名 header，防应用自带低权限凭据混淆。
- response 只做 header 脱敏，body 不重写（上游把 echo header 写进 body 属明确不保证项）。

## 3. API 形态（specs/egress-api.yaml `/credential-vault`）

所有写操作经 vault 级 PATCH 原子变更（proxy ack 后才返回成功，失败保持旧 revision）：

| 端点 | 语义 |
|---|---|
| `POST /credential-vault` | 创建首个 revision（唯一创建入口），请求体 `{credentials: [...], bindings: [...]}` |
| `GET /credential-vault` | 脱敏后的 vault 状态（`{revision, credentials[元数据], bindings[元数据]}`） |
| `PATCH /credential-vault` | `{expectedRevision?, credentials: {add/replace/delete}, bindings: {add/replace/delete}}` |
| `DELETE /credential-vault` | 删除 |
| `GET /credential-vault/credentials[/{name}]` | 只读凭据元数据列表 |

**凭据与 binding 示例**（bearer token 注入到内网知识库 API）：

```json
{
  "credentials": [
    { "name": "kb-token", "source": { "type": "inline", "value": "<token>" } }
  ],
  "bindings": [
    {
      "name": "kb-api",
      "match": {
        "hosts": ["kb.internal.example.com"],
        "methods": ["GET", "POST"],
        "paths": ["/api/*"]
      },
      "auth": { "type": "bearer", "credential": "kb-token" }
    }
  ]
}
```

match 字段：`schemes`（默认 `[https]`）、`hosts`（必填）、`methods`（默认 5 种写方法）、`paths`（默认 `/*`）；`ports` 已废弃（端口由 scheme 推导）。auth 类型：`bearer` / `basic` / `apiKey`（指定 header 名）/ `customHeaders` / `passthrough`。

**开启方式**：create 请求 `credentialProxy.enabled: true`（K8s Pod 不能后加 sidecar，必须创建前预备 MITM 路径）；凭据在沙箱创建后直调 sidecar vault API 推送。

## 4. 硬前提与 fail-closed

vault 创建/变更前逐项校验，任一不满足直接 400：

| 前提 | 说明 |
|---|---|
| egress 策略存在且 binding host **显式 allow** | `defaultAction: deny` 强烈推荐；default-allow 暂时可用但有安全告警（以 spec 当前文本为准） |
| host 不命中 `ignore_hosts` | pass-through 流量完全旁路，无法注入 |
| 禁 `ssl_insecure` | 凭据模式下强制上游 TLS 校验 |
| IPv6 禁用或等价覆盖 | 防 IPv6 绕过 MITM |
| 沙箱信任 MITM CA | 镜像预装或 runtime bootstrap 种信任栈 |

## 5. 可用性现状与池化差距

| 模式 | 状态 | 与业务的关系 |
|---|---|---|
| per-sandbox egress sidecar + vault | ✅ 已可用（PR #1009；`components/egress/pkg/credentialvault/`、`docs/guides/credential-vault.md`） | 与 D-7（去 sidecar）冲突：每沙箱多一份 sidecar 内存（20~50MB） |
| fleet 共享 MITM（OSEP-0022 A1，commit `f91f153c`） | 数据平面已落地：per-subject DNAT、Pod netns INPUT 强制链、**subject-aware active vault**（共享单 mitmdump 按源 IP 区分 subject 取凭据）、CA export 到 `/opt/opensandbox/mitm-ca` | **server 侧编排未落地**：fleets 创建路径仍拒绝 `credentialProxy`/`networkPolicy`（phase 1a，`create_mapping.py`），暂不可端到端使用 |
| OSEP-0022 后续 | bwrap uid adapter、slot store 契约稳定化、TLS 端到端验证待做 | 跟踪上游 |

关键收益点：fleet 模式下 egress 每 **Pod 一份**（进 FastletTemplate，目标 64 subjects/Pod），无 per-sandbox sidecar 开销——恰好消解 D-7 当时"per-sandbox sidecar 太贵"的核心顾虑，上游演进与池化架构收敛。

## 6. 业务决策建议

**短期（现在）**：维持 D-8 taskTemplate env 注入。理由：

- fleet vault 的 server 编排未落地，端到端不可用；per-sandbox sidecar 与 D-7 省内存决策冲突。
- 池化 use-and-burn 下 vault 是内存态：**每次分配都要重推完整 revision**，需要 server 或业务层编排配合（当前无现成钩子，等 OSEP-0020 phase 5 / 业务层 Ready 后注入均可）。

**迁移触发条件（满足其一再评估）**：

1. 出现"凭据不落地 + FQDN 最小权限 + 出向审计"硬需求的租户/敏感 Pool；
2. OSEP-0022 phase 1b（server fleets 编排放行 credentialProxy）落地，可在指定 Pool 的模板里加 egress 组件灰度；
3. 明文 token 曾发生过泄露事件/审计要求升级。

**迁移形态预判**：NetworkPolicy 做底座（D-7 不动），仅敏感 Pool 模板加 fleet egress 组件；用户 token 从 env 改为"分配后推 vault binding"（明文只出现在 server→sidecar 的 127.0.0.1:18080 推送与内存）。

## 7. 相关上游 issue

- **#1594** RFC: egress policy and credential vault persistence（磁盘策略 + 加密 vault 持久化）——若落地可解决"内存态重启失效/每次分配重推"的编排痛点，重点跟踪。
- **#1647** egress 支持 port-scoped rules（target-optional ports）——binding 粒度演进。

## 参考

- 提案：`oseps/0012-credential-vault.md`、`oseps/0022-multi-sandbox-egress-control-plane.md`
- 契约：`specs/egress-api.yaml`（`/credential-vault`、`Credential*` schema 族）
- 实现：`components/egress/pkg/credentialvault/`（vault.go / source_inline.go / active_socket.go）、fleet MITM `pkg/iptables/gateway_mitm.go`、`pkg/fleetnft/`
- 官方指南：`docs/guides/credential-vault.md`；fleet 数据平面：`docs/components/egress-fleet-mitm-data-plane.md`
- 姊妹篇：`egress-network-policy-cookbook.md`（出向管控现状）、`sandbox-management-cookbook.md`（taskTemplate env 注入现状）
- 相关 wiki：`opensandbox-egress-pool-higress-architecture.md`、`opensandbox-k8s-networkpolicy-vs-egress-sidecar.md`
