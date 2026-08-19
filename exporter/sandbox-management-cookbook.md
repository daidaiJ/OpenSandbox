# 沙箱创建与管理 API Cookbook

池化 K8s 部署下，通过 lifecycle server 创建、注入、续约、查询与删除沙箱。

**前提**

| 项 | 约定 |
|---|---|
| 部署 | 池化（`extensions.poolRef`）；分配复用预热 pod，不重建 |
| 访问 | `use_server_proxy=true`，经 `/sandboxes/{id}/proxy/{port}` |
| 生命周期 | 创建 → 使用 → 删除/到期；不使用 pause/resume |

路由同时挂在根路径与 `/v1`。池化判定：`extensions.poolRef` 非空。

## 目录

- [1. 规划：create 支持 lifecycle（未落地）](#1-规划create-支持-lifecycle未落地)
- [2. 创建沙箱 — POST /sandboxes](#2-创建沙箱--post-sandboxes)
- [3. 查询、删除与访问](#3-查询删除与访问)
- [4. 池管理](#4-池管理)
- [5. 池化 create：忽略与拒绝](#5-池化-create忽略与拒绝)
- [6. taskTemplate 生成条件](#6-tasktemplate-生成条件)
- [7. 示例](#7-示例)
- [参考](#参考)

---

## 1. 规划：create 支持 lifecycle（未落地）

> **规划（未落地）**：当前 `POST /sandboxes` 不支持 `lifecycle` / `preStart` / `postStop`。后续若 create 支持 lifecycle，有钩子时必须生成 taskTemplate（禁止走池化快路径丢钩子），使业务方可通过 API 直接配置启停钩子，无需手写 CR。

当前 create 请求**没有** `lifecycle` / `preStart` / `postStop` 字段。钩子机制本身（控制器 + task-executor）已支持，缺口在 API → 写入 CR。

---

## 2. 创建沙箱 — POST /sandboxes

### 2.1 请求字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `extensions.poolRef` | string | 池名；`"*"` 自动选池。本场景必填 |
| `env` | map | 注入 task 进程环境变量 |
| `entrypoint` | list | 启动命令（写入 taskTemplate） |
| `timeout` | int | 存活秒数，最小 60；省略则不自动到期 |
| `metadata` | map | 标签；`GET /sandboxes?metadata=...` 可过滤 |
| `extensions.access.renew.extend.seconds` | string | 访问续约秒数，`300`–`86400` |
| `extensions.opensandbox.extensions.*` | string | 透传为 pod annotation；**不进** task env |

### 2.2 指定池

```json
{ "extensions": { "poolRef": "my-pool" } }
```

- 具名池不存在 → **404**（非 400）
- `"*"`：自动分配，跳过池存在性预检

### 2.3 注入环境变量

```json
{
  "env": {
    "OSB_USER_ID": "user-12345",
    "OSB_USER_AUTH_TOKEN": "eyJhbGciOiJIUzI1NiIs...",
    "APP_MODE": "prod"
  }
}
```

`env` 非空会生成 taskTemplate，并附带 `OPENSANDBOX_ID`。凭证放 `env`，不要放进 `extensions`（extensions 只变 annotation）。

### 2.4 启动命令与写文件

```json
{ "entrypoint": ["python", "/app/main.py"] }
```

创建时已知参数时，可在 `entrypoint` 内写文件再启动：

```json
{
  "extensions": { "poolRef": "my-pool" },
  "env": { "OSB_USER_ID": "user-12345" },
  "entrypoint": [
    "/bin/sh", "-c",
    "cat > /workspace/.osb-user-info.sh <<'EOF'\nexport OSB_USER_ID=user-12345\nEOF\nchmod 600 /workspace/.osb-user-info.sh && . /workspace/.osb-user-info.sh && exec python /app/main.py"
  ]
}
```

- 默认 entrypoint 为 `["tail", "-f", "/dev/null"]`；非默认才会生成 taskTemplate
- 池化下会替换池 pod 的 warm entrypoint，在分配后执行
- 无单独「写文件」API；需要时用上述 shell

### 2.5 到期时间

```json
{ "timeout": 3600 }
```

- 省略 `timeout`：不自动到期，须显式 `DELETE`
- 上限受 `server.max_sandbox_timeout_seconds` 约束

### 2.6 访问自动续约

```json
{
  "extensions": {
    "poolRef": "my-pool",
    "access.renew.extend.seconds": "3600"
  },
  "timeout": 600
}
```

- 触发条件：请求命中 `/sandboxes/{id}/proxy/{port}`（HTTP/WebSocket）
- 公式：`new_expires = max(now + extend, current)`
- 须同时有 `timeout`，且服务端 `[renew_intent] enabled=true`
- 不经过 renew API，也不经过 lifecycle 钩子

### 2.7 手动续约 — POST /sandboxes/{id}/renew-expiration

```json
{ "expiresAt": "2026-08-19T12:00:00Z" }
```

`expiresAt` 必须晚于当前时间，且晚于现有到期时间。

### 2.8 标签

```json
{ "metadata": { "tenant": "t1", "app": "chat" } }
```

创建后可用 `PATCH /sandboxes/{id}/metadata`（JSON Merge Patch）修改。

---

## 3. 查询、删除与访问

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/sandboxes/{id}` | 状态、`expiresAt`、`extensions` |
| `GET` | `/sandboxes` | `state` / `metadata` 过滤；`page` / `pageSize` |
| `PATCH` | `/sandboxes/{id}/metadata` | 合并更新 metadata |
| `DELETE` | `/sandboxes/{id}` | 终止并清理 |

若 CR 配置了 `postStop`，删除时由控制器 → task-executor 执行；经 API 创建的沙箱默认无该钩子。

### 3.1 端点

```
GET /sandboxes/{id}/endpoints/8080?use_server_proxy=true
```

| 查询参数 | 行为 |
|---|---|
| `use_server_proxy=true` | 返回经 lifecycle server 的 proxy URL |
| `expires` | 请求签名网关路由（需 ingress + secure_access） |

`use_server_proxy` 与 `expires` 互斥；同时传 → 400。

### 3.2 Proxy

| 路径 | 说明 |
|---|---|
| `* /sandboxes/{id}/proxy/{port}` | HTTP 代理；可触发 renew-on-access |
| `WS /sandboxes/{id}/proxy/{port}` | WebSocket 代理；同上 |

---

## 4. 池管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/pools` | 创建池（name + pod template + capacitySpec） |
| `GET` | `/pools` | 列表 |
| `GET` | `/pools/{name}` | 详情（含运行时状态） |
| `PUT` | `/pools/{name}` | **仅**更新 `capacitySpec` |
| `DELETE` | `/pools/{name}` | 删除池 |

改 pod 模板：HTTP API 不支持。直接改 Pool CRD `spec.template` 时，控制器重建 **idle** pod，已分配不受影响。

---

## 5. 池化 create：忽略与拒绝

### 忽略（不改预热 pod）

| 字段 | 行为 |
|---|---|
| `image` | 镜像取自 Pool 模板 |
| `resourceLimits` / `resourceRequests` | 资源取自 Pool 模板 |
| `secureAccess` | 不改 pod；仍可能做网关鉴权；未配 gateway 时传 `true` → 400 |

### 拒绝

| 字段 | 状态码 | 原因 |
|---|---|---|
| `snapshotId` | 400 | 不可与 `poolRef` 同用 |
| `networkPolicy` | 400 | 预热 pod 无法加 egress sidecar |
| `credentialProxy.enabled` | 400 | 预热 pod 无法做 MITM |
| `volumes` | 400 | 卷只能在 Pool 模板预挂 |
| `platform` | 400 | 池化暂不支持 |
| 具名 `poolRef` 不存在 | 404 | 池未找到 |

跨会话数据：在 Pool 模板挂 PVC / 外部存储，或每次重建沙箱。不要用 `snapshotId` + `poolRef`。

释放回池后，`recycleStrategy` 默认多为 **Delete**（删 pod 再补预热），不是脏 pod 原样复用。

---

## 6. taskTemplate 生成条件

```text
needs_task_template =
  env 非空
  or entrypoint 非默认
  or execd_run_as_init
```

三项都不满足时走快路径：池 pod 继续 warm entrypoint，`env` / 自定义命令均不生效。

若将来 create 支持 lifecycle，有钩子时也必须生成 taskTemplate（见 §1 规划）。

---

## 7. 示例

**池化沙箱 + 用户 env + 自动续约**

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

**查询**

```
GET /sandboxes/{id}
```

**手动续约**

```json
POST /sandboxes/{id}/renew-expiration
{ "expiresAt": "2026-08-19T12:00:00Z" }
```

**取 proxy 端点**

```
GET /sandboxes/{id}/endpoints/8080?use_server_proxy=true
```

---

## 参考

| 路径 | 说明 |
|---|---|
| `server/opensandbox_server/api/schema.py` | `CreateSandboxRequest` 与池化校验 |
| `server/opensandbox_server/api/lifecycle.py` | CRUD、端点（`use_server_proxy` / `expires` 互斥） |
| `server/opensandbox_server/api/pool.py` | 池管理（PUT 仅 capacitySpec） |
| `server/opensandbox_server/api/proxy.py` | HTTP/WS 代理与 renew 调度 |
| `server/opensandbox_server/services/k8s/kubernetes_service.py` | 池化 create、池存在性 |
| `server/opensandbox_server/services/k8s/batchsandbox_provider.py` | `_create_workload_from_pool` / `_build_task_template` |
| `server/opensandbox_server/integrations/renew_intent/` | OSEP-0009 续约 |
