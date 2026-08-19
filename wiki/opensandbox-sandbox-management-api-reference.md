# 沙箱管理高阶 API 与参数参考（快速检索）

- 日期：2026-08-19
- 用途：**快速检索**业务所需能力——按"业务能力"查 API 和参数，不深入实现细节。
- 关联：`wiki/opensandbox-create-sandbox-params-reference.md`（参数详解）、`wiki/opensandbox-task-template-user-info-injection-example.md`（注入示例）
- 代码位置：`server/opensandbox_server/api/`、`server/opensandbox_server/api/schema.py`

---

## 1. 能力速查表（按业务需求查 API）

> 想做什么 → 用哪个 API / 参数。所有路由同时挂载在根路径和 `/v1` 前缀下。

| 业务需求 | API / 参数 | 说明 |
|---|---|---|
| **创建沙箱** | `POST /sandboxes` | 池化模式用 `extensions.poolRef` |
| **注入环境变量** | `POST /sandboxes` → `env` | 业务配置 / 用户信息 / token |
| **指定启动命令** | `POST /sandboxes` → `entrypoint` | 作为 task command，分配后执行 |
| **指定池** | `POST /sandboxes` → `extensions.poolRef` | 池化模式开关 |
| **自动续约**（访问即续约） | `POST /sandboxes` → `extensions.access.renew.extend.seconds` | 长会话沙箱不中途回收 |
| **手动续约** | `POST /sandboxes/{id}/renew-expiration` | 设新的绝对到期时间 |
| **沙箱到期时间** | `POST /sandboxes` → `timeout` | 不传 = 手动清理（伪永久） |
| **打标签 / 过滤** | `POST /sandboxes` → `metadata`；`GET /sandboxes?metadata=` | 管理 / 过滤 |
| **查询沙箱** | `GET /sandboxes/{id}` | 含状态、expiresAt、extensions |
| **列出沙箱** | `GET /sandboxes` | 按 state / metadata 过滤，分页 |
| **修改 metadata** | `PATCH /sandboxes/{id}/metadata` | JSON Merge Patch |
| **删除沙箱** | `DELETE /sandboxes/{id}` | 终止并清理 |
| **获取访问端点** | `GET /sandboxes/{id}/endpoints/{port}` | 支持 `use_server_proxy` / `expires` 签名路由 |
| **HTTP 代理访问** | `GET/POST/... /sandboxes/{id}/proxy/{port}` | 转发到沙箱内服务 |
| **WebSocket 代理** | `WS /sandboxes/{id}/proxy/{port}` | 转发到沙箱内服务 |
| **创建池** | `POST /pools` | 预热池 |
| **查询池** | `GET /pools` / `GET /pools/{name}` | 池状态 |
| **更新池容量** | `PUT /pools/{name}` | 仅 capacitySpec |
| **删除池** | `DELETE /pools/{name}` | 删除池 |

---

## 2. 沙箱生命周期 API 详解

### 2.1 创建沙箱 — `POST /sandboxes`

**核心参数**（业务开发高频）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `extensions.poolRef` | string | 指定池（池化模式开关）。`"*"` = 自动分配池 |
| `env` | map | 注入环境变量（业务配置 / 用户信息 / token） |
| `entrypoint` | list | 启动命令（作为 task command） |
| `timeout` | int | 到期秒数（最小 60）。不传 = 手动清理 |
| `metadata` | map | 打标签（转成 labels，可过滤） |
| `extensions.access.renew.extend.seconds` | string | 自动续约秒数（300–86400） |
| `extensions.opensandbox.extensions.*` | string | 透传注解（转成 pod annotation） |

**池化模式限制**（拒绝）：`snapshotId`、`networkPolicy`、`credentialProxy.enabled`、`volumes`、`platform`。

**触发 taskTemplate 条件**：`env` 非空 或 `entrypoint` 非默认 或 `execd_run_as_init`。都没传 → 走快路径，**注入不进去**。

### 2.2 续约 — `POST /sandboxes/{id}/renew-expiration`

| 参数 | 说明 |
|---|---|
| `expires_at` | 新的绝对到期时间（须在未来且晚于当前） |

**两种续约方式**：
- **自动**：创建时 `extensions.access.renew.extend.seconds`（访问即续约，SDK 访问 proxy 触发）
- **手动**：`POST /sandboxes/{id}/renew-expiration`

### 2.3 查询 / 列出 / 修改 / 删除

| API | 说明 |
|---|---|
| `GET /sandboxes/{id}` | 查询单个（含状态、expiresAt、extensions） |
| `GET /sandboxes` | 列出（`state` / `metadata` 过滤，`page` / `pageSize` 分页） |
| `PATCH /sandboxes/{id}/metadata` | 修改 metadata（JSON Merge Patch） |
| `DELETE /sandboxes/{id}` | 删除沙箱 |

### 2.4 访问沙箱

| API | 说明 |
|---|---|
| `GET /sandboxes/{id}/endpoints/{port}` | 获取端点。`use_server_proxy=true` 返回 proxy URL；`expires` 返回签名路由 |
| `GET/POST/... /sandboxes/{id}/proxy/{port}` | HTTP 代理到沙箱内服务 |
| `WS /sandboxes/{id}/proxy/{port}` | WebSocket 代理 |

---

## 3. 池管理 API

| API | 说明 |
|---|---|
| `POST /pools` | 创建预热池（name + pod template + capacitySpec） |
| `GET /pools` | 列出池 |
| `GET /pools/{name}` | 查询池（含运行时状态） |
| `PUT /pools/{name}` | 更新池容量（仅 capacitySpec；改 pod template 需删了重建） |
| `DELETE /pools/{name}` | 删除池 |

---

## 4. 不可用能力（重要）

| 能力 | 状态 | 说明 |
|---|---|---|
| **pause / resume** | ❌ 不可用 | 当前 OpenSandbox 为**无状态沙箱，不支持暂停恢复**（见 `wiki/opensandbox-open-issues-risk-review-no-pause-resume.md`） |
| **写文件 + 调用脚本**（分配时） | ⚠️ 需扩展 | proxy server 目前**不提供**该能力，需改 `_build_task_template` 或新增 k8s exec 接口 |

---

## 5. 快速检索示例

### 场景 A：创建池化沙箱 + 注入用户信息 + 自动续约

```json
{
  "extensions": {
    "poolRef": "my-pool",
    "access.renew.extend.seconds": "3600"
  },
  "env": {
    "OSB_USER_ID": "user-12345",
    "OSB_USER_AUTH_TOKEN": "eyJhbGciOiJIUzI1NiIs..."
  },
  "timeout": 600
}
```

### 场景 B：查询沙箱状态

```
GET /sandboxes/{id}
```

### 场景 C：手动续约

```json
POST /sandboxes/{id}/renew-expiration
{ "expiresAt": "2026-08-19T12:00:00Z" }
```

### 场景 D：获取访问端点（走 proxy）

```
GET /sandboxes/{id}/endpoints/8080?use_server_proxy=true
```

---

## 参考代码位置

| 路径 | 说明 |
|---|---|
| `server/opensandbox_server/api/lifecycle.py` | 沙箱 CRUD + 生命周期 + 端点 |
| `server/opensandbox_server/api/pool.py` | 池管理 |
| `server/opensandbox_server/api/proxy.py` | HTTP / WebSocket 代理 |
| `server/opensandbox_server/api/schema.py` | `CreateSandboxRequest` 字段定义 |
| `wiki/opensandbox-create-sandbox-params-reference.md` | 参数详解（池化 / extensions / 续约） |
| `wiki/opensandbox-task-template-user-info-injection-example.md` | 注入用户信息示例 |
