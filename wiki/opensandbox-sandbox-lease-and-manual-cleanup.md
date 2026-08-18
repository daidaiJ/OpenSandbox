---
title: 沙箱续约机制与伪永久（manual cleanup）调研
description: OpenSandbox 沙箱生命周期：TTL 自动过期、手动续约 API、OSEP-0009 自动续约、伪永久（不传 timeout）四种模式及边界（基于 main 分支）
---

# 沙箱续约机制与伪永久（manual cleanup）调研

> 调研日期：2026-08-18。**完全基于 `main` 分支**（`git show main:<file>` 逐项核对，不含任何本地分支改动）。所有行号均为 `main` 分支行号。

## 结论速览

| 需求 | 是否支持 | 方式 |
|---|---|---|
| 配置续约时间（手动） | ✅ | `POST /sandboxes/{id}/renew-expiration`，传新的绝对 `expiresAt` |
| 自动续约（访问驱动） | ✅ | OSEP-0009：创建时 `extensions["access.renew.extend.seconds"]` opt-in |
| 伪永久（不自动过期） | ✅ | 创建时不传 `timeout`，`expiresAt` 为 null，上层主动 delete |
| TTL 上限 | 可选 | `[server] max_sandbox_timeout_seconds`，默认不配置 = 无上限 |

## 1. TTL 自动过期（默认模式）

- 创建请求 `CreateSandboxRequest.timeout`（秒，最小 60）→ 服务端计算 `expiresAt = createdAt + timeout`
- 到期后由过期扫描器/调度器终止沙箱；`shutdown_policy: Delete|Retain`（agent-sandbox runtime 配置，`config.py:677`）控制过期时删除还是保留
- 代码：`services/validators.py:218`（`calculate_expiration_or_raise`）、`services/docker/docker_service.py:623`、`services/k8s/create_helpers.py:64`

## 2. 手动续约（renew-expiration API）

**Spec 层**（`specs/sandbox-lifecycle.yml`）：
- `:628` `POST /sandboxes/{sandboxId}/renew-expiration`
- `:1432` `RenewSandboxExpirationRequest`：`expiresAt` 必填，RFC3339，*"Must be in the future and after the current expiresAt time"*
- `:1445` `RenewSandboxExpirationResponse`：只返回更新后的 `expiresAt`

**Server 层**：
- `api/lifecycle.py:344-381` 端点（薄路由，直接委托 `sandbox_service.renew_expiration`）
- 约束（`services/validators.py:139` `ensure_future_expiration`）：新时间必须在未来；spec 要求晚于当前 `expiresAt`（只能延长，不能缩短/取消）
- **manual-cleanup 沙箱（无过期）调此接口返回 409**（"does not have automatic expiration enabled"）——续约不能给伪永久沙箱"补"过期时间
- Docker 实现：`services/docker/docker_service.py:1173`（409 检查在 1196-1200）
- K8s 实现：`services/k8s/kubernetes_service.py:1321`（409 检查在 1352-1357；同步更新 BatchSandbox `spec.expireTime` 与 label）

**SDK 层**：仅 Python SDK 有生成客户端（`sdks/sandbox/python/src/opensandbox/api/lifecycle/api/sandboxes/post_sandboxes_sandbox_id_renew_expiration.py` 及 request/response 模型）；其他语言 SDK 未生成该端点

## 3. 自动续约（OSEP-0009，已实现）

**激活条件（三方握手）**：
- 服务端 `[renew_intent] enabled = true`（`config.py:170` `RenewIntentConfig`，`AppConfig.renew_intent` 字段在 `:972`）
- ingress 模式还需 `renew_intent.redis.enabled = true` + ingress 侧 `--renew-intent-*` 配置
- 沙箱创建时 `extensions["access.renew.extend.seconds"]` = 十进制整数字符串，范围 **300~86400**（5 分钟~24 小时），非法值创建即 400（spec `:1415`）

**触发与执行**：
- 触发源：反向代理访问流量
  - server proxy 路径：`integrations/renew_intent/proxy_renew.py` 本地触发（`api/proxy.py:265/431`，HTTP + WebSocket）
  - ingress gateway 路径：`components/ingress/pkg/renewintent/`（`publisher.go` Publisher 接口、`redis.go`）发布到 Redis List → server 侧 `integrations/renew_intent/consumer.py` BRPOP 消费
- 每次续约：`new_expires_at = now + extend.seconds`（且须大于当前 expiresAt）
- 门控（`integrations/renew_intent/controller.py:60-128`）：opt-in 检查 + Running 状态检查 + 冷却（`min_interval_seconds` 默认 60）+ 每沙箱 in-flight 去重（ingress 模式用 Redis 锁）
- **manual-cleanup 沙箱不参与自动续约**（`controller.py:69` `expires_at is None → return False`）
- Docker 直连模式不支持（无代理流量可观测）

**SDK 不参与自动续约**：
- SDK 层无任何自动续约逻辑；唯一相关是 Python SDK 的**手动续约**生成客户端（`sdks/sandbox/python/src/opensandbox/api/lifecycle/api/sandboxes/post_sandboxes_sandbox_id_renew_expiration.py`）
- SDK 工具调用（exec/文件）走 execd API（44772 端口），连接方式由 `ConnectionConfig.use_server_proxy` 决定（`sdks/sandbox/python/src/opensandbox/config/connection.py`）：
  - 默认 `use_server_proxy=False` → 直连沙箱 IP:44772 → **不触发自动续约**
  - `use_server_proxy=True` → 经 server proxy 转发 → 触发自动续约

**测试**：`server/tests/test_renew_intent.py`、`test_routes_renew_expiration.py`、`test_proxy_renew_coordinator.py`

### 3.1 完成度与依赖

- **完成度**：`main` 上已完整实现（OSEP-0009 status: implemented）——server 侧 controller/consumer/proxy_renew/redis_client/runner 全套 + ingress 侧 renewintent 包 + 3 个测试文件
- **新引入依赖**：
  - server：Python `redis>=5`（`server/pyproject.toml`，**硬依赖**，即使不用自动续约也安装）
  - ingress：Go `github.com/redis/go-redis/v9`（`components/ingress/go.mod`）
  - 运行时：Redis 服务（**仅 ingress 模式需要**；server proxy 模式无需 Redis）

### 3.2 坑点

1. **Redis 启用时 proxy 路径无冷却**：`consumer.py` `_process_work` 中 `self._redis is not None` 时直接 renew，跳过 `min_interval` 检查——proxy 提交的 work 也走此路，高 QPS 时 renew 调用频繁（幂等但浪费 API）
2. **无 Redis 分布式锁**：OSEP 设计有 `opensandbox:renew:lock:{sandbox_id}`，但实现只有进程内 `asyncio.Lock`——多副本 proxy 模式可能重复续约（renew 幂等、单调不减，影响有限；ingress 模式靠 BRPOP 竞争天然去重）
3. **Redis 不可用静默降级**：连接失败降级为 proxy-only 模式（仅日志警告），ingress 续约失效但无告警
4. **best-effort 语义**：intent 无 ack（消费后崩溃即丢）、超过 `INTENT_MAX_AGE_SECONDS=300`（5 分钟）丢弃、ingress 发布队列满（`publishChanCap=8192`）直接 drop
5. **SDK 默认直连**：`use_server_proxy=False`（默认）时自动续约对 SDK 工具调用完全不生效——业务要自动续约必须走 proxy/ingress
6. **内存上限**：proxy 路径每沙箱状态 LRU 上限 `PROXY_RENEW_MAX_TRACKED_SANDBOXES=8192`

## 4. 伪永久（manual cleanup）—— 池化会话推荐

- **创建时不传 `timeout`（或传 null）** → `expiresAt = null`
- schema 原文（`api/schema.py:419`）：*"When omitted or null, the sandbox will not auto-terminate and must be deleted explicitly"*；`expiresAt` 字段描述（`:560/599`）：*"Null when manual cleanup is enabled"*
- 实现：
  - Docker：容器打 `opensandbox.io/manual-cleanup=true` label，过期扫描器跳过（`docker_service.py:484`）；`_prepare_creation_context`（`:621-623`）timeout 为 None 时 `expires_at = None`
  - K8s：`create_helpers.py:67-68` 打同 label，BatchSandbox 不设 `spec.expireTime`；`workload_provider.py:71` 明确支持 `expires_at=None`（"None for manual cleanup (no TTL)"）
- 清理：上层业务主动调 `DELETE /sandboxes/{id}`
- **单向性**：伪永久沙箱无法通过 renew-expiration 转为自动过期（409），创建时就要决定

## 5. 对池化会话（pooled session）场景的建议

- 池化沙箱建议直接走**伪永久 + 上层主动删除**：创建不传 timeout，业务会话结束时显式 delete，避免 TTL 到期误杀正在使用的会话
- 若需要"空闲回收"兜底，可考虑：上层业务定期检查 `expiresAt == null` 的沙箱活跃度，自行删除；或改用 TTL + 自动续约组合（访问驱动续约天然贴合"活跃即续命"）
- 注意：伪永久沙箱若上层忘记删除会一直占用资源，需业务侧有清理兜底（如会话超时扫描）

## 关键代码位置（main 分支）

| 位置 | 内容 |
|---|---|
| `specs/sandbox-lifecycle.yml:628,1432,1445` | renew-expiration 端点与 schema 定义 |
| `specs/sandbox-lifecycle.yml:1415` | `access.renew.extend.seconds` opt-in 契约 |
| `server/opensandbox_server/api/lifecycle.py:344-381` | renew-expiration 端点 |
| `server/opensandbox_server/services/validators.py:139,186,218` | 过期时间校验与计算 |
| `server/opensandbox_server/services/docker/docker_service.py:1173` | Docker renew 实现（409 在 1196-1200） |
| `server/opensandbox_server/services/k8s/kubernetes_service.py:1321` | K8s renew 实现（409 在 1352-1357） |
| `server/opensandbox_server/integrations/renew_intent/controller.py:60-128` | 自动续约门控（`expires_at is None` 跳过在 69 行） |
| `server/opensandbox_server/integrations/renew_intent/{consumer,proxy_renew,runner,redis_client}.py` | Redis 消费 / server proxy 触发 / 运行器 / Redis 客户端 |
| `components/ingress/pkg/renewintent/{publisher,redis,intent}.go` | ingress 侧 renew-intent 发布 |
| `server/opensandbox_server/config.py:170,972` | `[renew_intent]` 配置（`RenewIntentConfig` 170、`AppConfig.renew_intent` 字段 972） |
| `server/opensandbox_server/config.py:546` | `max_sandbox_timeout_seconds` |
| `server/opensandbox_server/config.py:677` | `shutdown_policy: Delete\|Retain` |
| `sdks/sandbox/python/src/opensandbox/api/lifecycle/...` | Python SDK renew 客户端（唯一生成该端点的 SDK） |
| `oseps/0009-auto-renew-sandbox-on-ingress-access.md` | 自动续约设计文档 |