---
title: 业务流量走 Server Proxy 代理的业务事实梳理
description: 当前业务背景（所有沙箱工具调用经 server proxy 转发）下的连接拓扑、proxy 行为、自动续约生效条件、生命周期选择与边界
---

# 业务流量走 Server Proxy 代理的业务事实梳理

> 日期：2026-08-18。基于 `main` 分支代码 + 当前集成方案（池化会话 S3 同步中间层）。业务背景：**所有沙箱行为经 server proxy 代理**（SDK `use_server_proxy=True`）。

## 1. 连接拓扑

```
业务 / SDK（use_server_proxy=True）
  │  create / delete / renew-expiration（lifecycle API，直连 server）
  │  exec / 文件 / 健康检查（execd API，经 server proxy 转发）
  ▼
OpenSandbox Server
  ├── lifecycle API（/v1/sandboxes/...）
  ├── proxy（/sandboxes/{id}/proxy/{port}/...）──► 沙箱 execd（44772）
  └── renew_intent consumer（proxy 触发续约）
```

- 业务**无法直连**沙箱网络/端口，所有 execd 流量必须经 server proxy
- lifecycle 管理面（create/delete/get）走 server 的 lifecycle API，不经 proxy
- proxy 同时支持 HTTP（`proxy.py:257`）与 WebSocket（`proxy.py:431`）

## 2. Proxy 路径行为事实

每次 proxy 访问（HTTP/WebSocket）在转发前依次执行（`api/proxy.py`）：

1. `get_endpoint(sandbox_id, port, resolve_internal=True)` — 解析沙箱内部端点
2. `_verify_secure_access(endpoint, headers)` — 若沙箱启用 secure-access，校验 token 头（缺失/错误 → 403）
3. **`_schedule_proxy_renew(sandbox_id)`** — 提交自动续约信号（非阻塞，不增加转发延迟）
4. 转发到沙箱目标端口

当前分支（#954）额外注入 `OpenSandbox-Runtime-Id` 头，使沙箱侧可感知运行时替换。

## 3. 自动续约在 Proxy 路径的生效条件

**链路**：proxy 访问 → `_schedule_proxy_renew` → `ProxyRenewCoordinator.schedule` → `RenewIntentConsumer.submit_from_proxy` → 门控 → `renew_expiration`

**必须同时满足**（任一缺失则不续约）：

| 条件 | 配置/来源 |
|---|---|
| 服务端开关 | `[renew_intent] enabled = true`（`config.py:170`） |
| 沙箱 opt-in | 创建时 `extensions["access.renew.extend.seconds"]` = 300~86400（spec `:1415`） |
| 沙箱状态 | Running |
| 沙箱有过期时间 | `expiresAt != null`（manual-cleanup 沙箱跳过，`controller.py:69`） |

**续约语义**：`new_expires_at = max(now + extend.seconds, current_expires_at)`，单调不减、幂等。

**proxy-only 模式（不启用 Redis）**：本地 `min_interval_seconds`（默认 60s）冷却 + 每沙箱 `asyncio.Lock` 串行化。

## 4. 生命周期事实

| 事实 | 说明 |
|---|---|
| 沙箱无状态 | 不支持 pause/resume；跨会话持久状态靠 S3 同步中间层 |
| 伪永久可用 | 创建不传 `timeout` → `expiresAt=null`，永不自动终止，上层主动 delete |
| 伪永久单向 | 无法通过 renew-expiration 补过期时间（409）；自动续约也跳过 |
| TTL 上限 | `[server] max_sandbox_timeout_seconds` 默认不配置 = 无上限 |
| 过期行为 | `shutdown_policy: Delete\|Retain`（agent-sandbox runtime 配置） |

**当前方案选择**：池化会话走**伪永久 + 上层主动删除**（业务会话结束时显式 delete），避免 TTL 到期误杀；S3 回写由中间层 postStop 兜底，主动删与到期删同一路径。

## 5. 与池化会话 S3 同步中间层的关系

- proxy 只做流量转发，**不承担**会话同步（create 期恢复 / 销毁期回写由中间层在 lifecycle 语义内静默完成）
- 业务对 SDK 的 API 面不变：`create(poolRef, metadata.user_id?)` → 使用 → `delete`
- 中间层内部：`pods/exec` 注入 `.osb-sync-out.sh` + 固定 postStop 回写，业务不可见
- 可选访问闸门：proxy 发现"已 Ready 但未注入 prepare"返回 409（内部错误码，不进 SDK 公开面）

## 6. 关键边界与坑（对当前方案的影响）

1. **自动续约对当前业务生效**：业务流量必过 proxy → 每次工具调用都提交续约信号。若池化沙箱走 TTL + opt-in，活跃会话自动续命
2. **Redis 启用时 proxy 路径无冷却**：`consumer.py` 中 `self._redis is not None` 时跳过 `min_interval`——若同时启用 ingress 模式 Redis，proxy 流量续约频率不受冷却限制（幂等但 API 调用频繁）
3. **多副本无分布式锁**：proxy 模式多副本可能重复续约（幂等无害）；ingress 模式靠 BRPOP 竞争去重
4. **伪永久沙箱不续约**：若池化沙箱选伪永久，自动续约机制完全不参与（无需 opt-in）
5. **secure-access 与 proxy 共存**：启用 secure-access 的沙箱，业务每次 proxy 访问需带 token 头
6. **SDK 默认直连的坑不适用**：当前方案 `use_server_proxy=True`，无直连场景

## 7. 对集成方案的结论

- 池化会话推荐 **伪永久 + 主动删除**：无需 opt-in 自动续约，业务 delete 即触发 S3 回写
- 若需要"空闲回收"兜底：改用 TTL + `access.renew.extend.seconds` opt-in，活跃会话经 proxy 自动续命，空闲会话到期回收（回写由 postStop 兜底）
- 两种路径都不需要 Redis（proxy-only 模式），避免引入 Redis 依赖

## 参考代码位置（main 分支）

| 位置 | 内容 |
|---|---|
| `server/opensandbox_server/api/proxy.py:257,265,431` | proxy 转发 + 续约触发点 |
| `server/opensandbox_server/integrations/renew_intent/proxy_renew.py` | proxy → consumer 桥接 |
| `server/opensandbox_server/integrations/renew_intent/consumer.py` | 统一续约管道（冷却/去重） |
| `server/opensandbox_server/integrations/renew_intent/controller.py:60-128` | 续约门控 |
| `server/opensandbox_server/config.py:170,972` | `[renew_intent]` 配置 |
| `sdks/sandbox/python/src/opensandbox/config/connection.py` | `use_server_proxy` 开关（默认 False） |