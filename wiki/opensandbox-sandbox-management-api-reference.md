# 沙箱管理高阶 API 与参数参考（快速检索）

- 日期：2026-08-19（2026-09-03 补充 GET / LIST 响应字段详解，见 §2.3.1）
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

#### 2.3.1 GET / LIST 响应字段详解（K8s 运行时）

两个接口返回**同一 `Sandbox` 结构**（`api/schema.py:653`；K8s 映射实现 `services/k8s/workload_mapper.py:_build_sandbox_from_workload`，数据源是 BatchSandbox CR）：

| 字段 | 类型 | K8s 来源 | 说明 |
|---|---|---|---|
| `id` | string | label `opensandbox.io/id` | |
| `status.state` | enum | CR phase / Pod 状态推导 | 见下方状态表 |
| `status.reason` | string | — | 机器可读原因码（如 `POOL_CAPACITY_EXHAUSTED`） |
| `status.message` | string | — | 人类可读信息 |
| `status.lastTransitionAt` | datetime | CR creationTimestamp | K8s 实现用 CR 创建时间，非精确跳变时间 |
| `createdAt` | datetime | CR creationTimestamp | |
| `expiresAt` | datetime \| null | spec.expireTime | **null = 手动清理（伪永久）** |
| `image.uri` | string \| null | pod 模板 containers[0].image | 池化沙箱返回**池模板镜像**；异常情况为 `"unknown"`；快照创建时整个字段为 null |
| `snapshotId` | string \| null | label `opensandbox.io/snapshot-id` | |
| `platform` | object \| null | nodeSelector/affinity 推导 | `{os, arch}`，模板没约束时为 null |
| `metadata` | map \| null | **非 `opensandbox.io/` 前缀的 labels 回显** | 创建时 metadata 落成 labels，查询时剔除平台 label 后回显 → **可用 label 手工打标** |
| `extensions` | map \| null | annotations 提取 + `runtime.id` 注解合并 | 含创建请求透传的 extensions |
| `allocation` | object \| null | 池分配证据判定 | `{mode:"pool", poolRef, state:"allocated"}`，见下方判定条件 |
| `entrypoint` | list \| null | pod 模板 containers[0].command | |

**`status.state` 取值（池化场景实际会看到的）**：

| state | reason | 触发条件 |
|---|---|---|
| `Pending` | `CREATING` | CR phase=Pending（含刚认领 Pod 阶段） |
| `Pending` | `POOL_CAPACITY_EXHAUSTED` | **池容量不足**（PoolAllocationPending condition，message="Pool capacity is currently unavailable"）——业务层可据此重试或扩池 |
| `Allocated` | `IP_ASSIGNED` | **池化专属过渡态**：Pod 已分到 IP 但未就绪 |
| `Running` | `POD_READY_WITH_IP` | Pod ready + 有 IP（业务可发起调用的信号） |
| `Failed` | `POD_PLATFORM_UNSCHEDULABLE` 等 | 不可调度 / PodFailed / 操作失败 |
| `Terminated` | `user_delete` / `ttl_expiry` 等 | 已终止（删除后通常查询即 404） |

**`allocation` 返回判定（证据完整才返回，缺一即 null）**（`workload_mapper.py:_extract_confirmed_pool_allocation`）：spec.poolRef 非空且 ≠ `"*"`、无 deletionTimestamp、finalizer `pool.sandbox.opensandbox.io/pool-allocation` 存在、`alloc-status` 注解 JSON 有效且 poolRef 匹配、pods 列表合法无重复、`status.allocated` == pods 数、`alloc-release(d)` 注解与已分配 pods 无交集。
→ **allocation ≠ 就绪信号**：它只证明"当前确实分配在池 X 上"；可调用性看 `status.state=Running`。

**注意**：
- GET / LIST 响应**不含 `endpoints`**——端点只在 create 响应或 `GET /sandboxes/{id}/endpoints/{port}` 获取；
- `GET /sandboxes` 过滤：`state` 多值 OR（`?state=Running&state=Pending`）；`metadata` 过滤 k=v AND（URL 编码 `?metadata=project%3DApollo`）；`page`（默认 1）/ `pageSize`（默认 20）；响应为 `{items: Sandbox[], pagination}`；
- LIST 与 GET 走同一映射函数，单条字段含义完全一致。

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

典型响应（池化沙箱、已就绪）：

```json
{
  "id": "sb-20260903-0001",
  "image": { "uri": "registry.example.com/opensandbox/code-interpreter:v1.1.0" },
  "status": {
    "state": "Running",
    "reason": "POD_READY_WITH_IP",
    "message": "Pod is ready with IP (1/1 ready)",
    "lastTransitionAt": "2026-09-03T02:00:00Z"
  },
  "metadata": { "project": "apollo", "user_id": "u-123" },
  "extensions": { "poolRef": "my-pool", "runtime.id": "..." },
  "allocation": { "mode": "pool", "poolRef": "my-pool", "state": "allocated" },
  "entrypoint": ["/opt/opensandbox/bootstrap.sh"],
  "expiresAt": "2026-09-03T02:10:00Z",
  "createdAt": "2026-09-03T02:00:00Z"
}
```

字段含义见 §2.3.1；`allocation=null` 常见于：非池化沙箱、池已释放（归还中）、CR 正在删除。

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
