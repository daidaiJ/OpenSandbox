# 创建沙箱参数说明书（池化模式）

- 日期：2026-08-19
- 关联：`wiki/opensandbox-task-template-user-info-injection-example.md`、`wiki/opensandbox-pool-allocation-time-injection.md`
- 代码位置：`server/opensandbox_server/api/schema.py`、`server/opensandbox_server/services/k8s/kubernetes_service.py`、`server/opensandbox_server/extensions/`

---

## 0. 管理接口总览（沙箱生命周期）

> 所有路由同时挂载在根路径和 `/v1` 前缀下（`main.py`）。只列**沙箱生命周期管理**核心 API，不含快照、废弃诊断接口。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sandboxes` | **创建沙箱**（池化模式用 `extensions.poolRef`） |
| GET | `/sandboxes` | 列出沙箱（按 state / metadata 过滤，分页） |
| GET | `/sandboxes/{id}` | 查询单个沙箱（含状态、expiresAt、extensions） |
| PATCH | `/sandboxes/{id}/metadata` | 修改沙箱 metadata（JSON Merge Patch） |
| DELETE | `/sandboxes/{id}` | 删除沙箱 |
| POST | `/sandboxes/{id}/renew-expiration` | **续约**（手动设新 expireTime） |
| GET | `/sandboxes/{id}/endpoints/{port}` | 获取沙箱访问端点（支持 `use_server_proxy` / `expires` 签名路由） |
| GET/POST/PUT/DELETE/PATCH | `/sandboxes/{id}/proxy/{port}` | HTTP 代理到沙箱内服务 |
| WebSocket | `/sandboxes/{id}/proxy/{port}` | WebSocket 代理到沙箱内服务 |
| POST/GET/GET/PUT/DELETE | `/pools` 系列 | 池管理（创建/列出/查询/更新容量/删除） |

> **注意**：`pause` / `resume` **不可用**——当前 OpenSandbox 为**无状态沙箱，不支持 pause/resume**（见 `wiki/opensandbox-open-issues-risk-review-no-pause-resume.md`）。

---

## 1. 业务开发重点参数（着重介绍）

> 以下参数是**业务开发高频使用**的，每个都详细说明。池化模式判定：`extensions.poolRef` 非空。

### 1.1 `extensions.poolRef` — 指定池（池化模式开关）

**是什么**：从哪个预热池申请沙箱（复用已建 pod，不重建）。

```json
{ "extensions": { "poolRef": "my-pool" } }
```

**要点**：
- **必填**（池化模式）。`_create_workload_from_pool` 用它建 BatchSandbox。
- 特殊值 `"*"` = 自动分配池（`POOL_AUTO_ASSIGN_REF`）。
- 池不存在时 create 返回 400（`_ensure_pool_ref_exists`）。

### 1.2 `env` — 注入环境变量（业务配置 / 用户信息）

**是什么**：注入到沙箱 task 进程的环境变量。**业务开发最常用**——传配置、传用户信息、传 token。

```json
{
  "env": {
    "OSB_USER_ID": "user-12345",
    "OSB_USER_AUTH_TOKEN": "eyJhbGciOiJIUzI1NiIs...",
    "APP_MODE": "prod"
  }
}
```

**要点**：
- 透传到 `_build_task_template`，注入 task 的 `env`，沙箱内进程直接读。
- **非空即触发 taskTemplate**（`needs_task_template` 为 True）。
- **token 走 env**，避免进命令行日志（安全最佳实践）。
- 详见 `wiki/opensandbox-task-template-user-info-injection-example.md` 方式 A。

### 1.3 `entrypoint` — 指定业务启动命令

**是什么**：沙箱内要执行的启动命令（作为 task 的 `command`）。

```json
{ "entrypoint": ["python", "/app/main.py"] }
```

**要点**：
- **非默认即触发 taskTemplate**（`needs_task_template` 为 True）。
- 池化模式下，entrypoint 会替换池 pod 的 warm entrypoint，在分配后执行。
- 若需要"写文件 + 调用脚本"注入，entrypoint 里可用 `/bin/sh -c` 包裹命令（见示例文档方式 B）。

### 1.4 `timeout` — 沙箱到期时间（生命周期核心）

**是什么**：沙箱自动销毁前的存活秒数（转成 `expireTime`）。

```json
{ "timeout": 3600 }
```

**要点**：
- **不传 = 手动清理（伪永久）**，沙箱不会自动到期，需显式 delete。
- 与自动续约配合：`timeout` 设初始 expireTime，续约在此基础上延长。
- 范围：最小 60 秒，最大受 `server.max_sandbox_timeout_seconds` 限制。

### 1.5 `extensions.access.renew.extend.seconds` — 自动续约（OSEP-0009）

**是什么**：开启 **renew-on-access（访问即续约）**，每次 SDK 访问沙箱就续期 N 秒。**业务开发极有用**——长会话沙箱不会中途被回收。

```json
{
  "extensions": {
    "poolRef": "my-pool",
    "access.renew.extend.seconds": "3600"
  },
  "timeout": 600
}
```

**要点**：
- 值：300–86400 的整数字符串（5 分钟到 24 小时）。不传 = 关闭续约。
- **触发源是 proxy 访问**：SDK 每次访问 `/sandboxes/{id}/proxy/{port}`（HTTP/WebSocket）就触发续约，**不是** SDK 主动调 renew API。
- 续约公式：`new_expires = max(now + extend, current)`（取较大值，防提前）。
- **必须配合 `timeout`**：不传 timeout = 手动清理，无自动到期，续约无意义。
- 需 `renew_intent.enabled` 开启（server 配置）。
- 详见本文档 §3。

### 1.6 `metadata` — 打标签（管理 / 过滤）

**是什么**：自定义 key-value，转成 BatchSandbox labels，用于管理、过滤、标记。

```json
{ "metadata": { "tenant": "t1", "app": "chat" } }
```

**要点**：
- 转成 labels，`GET /sandboxes?metadata=...` 可按它过滤。
- 也可用 `PATCH /sandboxes/{id}/metadata` 事后修改。

---

## 2. 次要参数（忽略 / 拒绝）

### 忽略（不生效但不报错）

`image`、`resourceLimits` / `resourceRequests`、`secure_access`（都在 Pool CRD 定义或 `_create_workload_from_pool` 不接收）。

### 拒绝（报 400 / ValueError）

| 参数 | 原因 |
|---|---|
| `snapshotId` | 不能和 poolRef 一起用 |
| `networkPolicy` | 池化 pod 预创建，无法加 egress sidecar |
| `credentialProxy.enabled` | 池化 pod 预创建，无法做 MITM |
| `volumes` | 池化不支持 volumes（卷在 Pool 模板里） |
| `platform` | 池化暂不支持 platform 建模 |

---

## 3. 自动续约深入分析（OSEP-0009）

### 3.1 完整链路

```
创建时：
  extensions["access.renew.extend.seconds"]="3600"
    → validate_extensions：校验 300–86400 整数（否则 400）
    → apply_access_renew_extend_seconds_to_mapping
    → K8s annotation: opensandbox.io/access-renew-extend-seconds="3600"

访问时（renew-on-access）：
  SDK 访问沙箱（HTTP / WebSocket）
    → GET/POST /sandboxes/{id}/proxy/{port}...   （api/proxy.py）
    → _schedule_proxy_renew(request, sandbox_id)  （HTTP 411 行 / WebSocket 601 行）
    → ProxyRenewCoordinator.schedule(sandbox_id)  （proxy_renew.py）
    → RenewIntentConsumer.submit_from_proxy()     （非阻塞入队，source=SERVER_PROXY）
    → AccessRenewController._try_renew_sync()     （integrations/renew_intent/controller.py）
    → 资格判断：沙箱 running + 有 expires_at + 有 extend 值
    → new_expires = max(now + extend, current)   // 取较大值，避免续约反而缩短
    → renew_expiration(sandbox_id, new_expires)  // 更新 expireTime
```

### 3.2 关键机制

| 点 | 说明 |
|---|---|
| **访问即续约** | 每次有访问流量就续期 `extend` 秒，不是固定定时续约 |
| **触发源是 proxy 访问** | `/sandboxes/{id}/proxy/{port}` 的 HTTP 或 WebSocket，**不是** SDK 主动调 renew API |
| **`new_expires = max(now + extend, current)`** | 取较大值，防止续约把到期时间**提前** |
| **资格判断** | 沙箱必须 `running` + 有 `expires_at` + 有 extend 值，否则跳过 |
| **依赖配置** | 需 `renew_intent.enabled` 开启（Redis BRPOP 或 proxy-only 管道） |
| **与 `timeout` 关系** | `timeout` 设**初始** expireTime；续约在此基础上**延长**。不传 timeout = 手动清理（无自动到期，续约无意义） |

### 3.3 SDK 侧配置示例（Python）

```python
sandbox = client.sandboxes.create(
    extensions={"poolRef": "my-pool", "access.renew.extend.seconds": "3600"},
    timeout=600,
)
```

---

## 4. extensions 深入分析

> `CreateSandboxRequest.extensions` 是 `Dict[str, str]` 的**不透明容器**，承载 provider 特定 / 临时参数。设计原则：**命名空间前缀**（如 `storage.id`）防冲突；**SDK 透传**不解析。核心代码在 `server/opensandbox_server/extensions/`。

### 4.1 已知的 well-known 键

| 键 | 用途 | 消费点 |
|---|---|---|
| `poolRef` | **指定从哪个池申请沙箱**（池化模式开关） | `create_workload` 判断 `extensions.get("poolRef")`；`kubernetes_service` 校验池存在 |
| `access.renew.extend.seconds` | OSEP-0009 续约：每次访问续期 N 秒（300–86400） | `apply_access_renew_extend_seconds_to_mapping` → annotation |
| `bootstrap.execd.isolation` | OSEP-0013 bwrap 隔离：设 `"enable"` 给容器加 `CAP_SYS_ADMIN` | `_build_main_container`（`isolation_enabled`） |
| `opensandbox.extensions.*` | **透传**：`opensandbox.extensions.X` → annotation `opensandbox.io/extensions.X` | `apply_extensions_to_mapping` |

### 4.2 编解码机制（`extensions/codec.py`）

```
请求 extensions                          Pod annotation
─────────────────                       ─────────────────
opensandbox.extensions.pool-ref  ──→    opensandbox.io/extensions.pool-ref
access.renew.extend.seconds     ──→    opensandbox.io/access-renew-extend-seconds
```

- **`apply_extensions_to_mapping`**：`opensandbox.extensions.*` 前缀 → `opensandbox.io/extensions.*` annotation
- **`extract_extensions_from_mapping`**：反向恢复（读沙箱时还原）
- **`apply_access_renew_extend_seconds_to_mapping`**：续约键 → annotation
- **`extensions_with_runtime_id`**：读沙箱时合并 `runtime.id` annotation

**关键**：`poolRef` **不走** `apply_extensions_to_mapping`（它没有 `opensandbox.extensions.` 前缀），是**硬编码**在 `create_workload` / `kubernetes_service` 里直接读 `extensions.get("poolRef")`。

### 4.3 校验（`extensions/validation.py`）

`validate_extensions` 只校验一个键：`access.renew.extend.seconds`（必须是 300–86400 的十进制整数字符串，否则 400）。**`poolRef` 不做格式校验**（只做存在性校验：`_ensure_pool_ref_exists`）。

### 4.4 extensions 能/不能做什么

| 需求 | extensions 能否 | 说明 |
|---|---|---|
| 指定池 | ✅ `poolRef` | 池化模式开关 |
| 透传自定义配置到 pod annotation | ✅ `opensandbox.extensions.*` | 会转成 annotation，但**不会**进 task env / 文件 |
| 注入用户信息（user_id/token）到沙箱 | ⚠️ 间接 | extensions 本身**不注入**到 task env / 文件；需经 `env` 或改 `_build_task_template` |
| 续约 | ✅ `access.renew.extend.seconds` | OSEP-0009 |
| bwrap 隔离 | ✅ `bootstrap.execd.isolation` | OSEP-0013 |

**结论**：`extensions` 是**元数据/开关**容器，不是**数据注入**通道。用户信息（user_id/token）要进沙箱，应走 `env` 或改 `_build_task_template`，**不要**塞进 `extensions`。

---

## 5. 触发 taskTemplate 的条件（关键）

```python
needs_task_template = env or entrypoint != DEFAULT_ENTRYPOINT or execd_run_as_init
```

- **传了 `env`**（哪怕只有 `OSB_USER_ID`）→ 生成 taskTemplate，注入 env
- **传了自定义 `entrypoint`** → 生成 taskTemplate，作为 task command
- **都没传** → 走**快路径**，池 pod 继续跑自己的 warm entrypoint，**注入不进去**（连 `OPENSANDBOX_ID` 都注入不了）

---

## 6. proxy server 侧没有控制参数的字段

| 字段 | 说明 |
|---|---|
| `taskResourcePolicyWhenCompleted` | server 侧没暴露，走 CRD 默认值 `Retain`。**正好符合需求**（注入完成后保留沙箱），无需改 |
| `lifecycle`（preStart/postStop） | server 侧没暴露，`_build_task_template` 不生成 lifecycle。需要时只能**直接建 CR** 或**改 server 代码** |
| `shardTaskPatches` | server 侧没暴露 |

**结论**：走 server API 时，**env 注入用户信息原生支持**（`request.env`）；**写文件 + 调用脚本**需改 `_build_task_template`；`taskResourcePolicyWhenCompleted` 固定 `Retain`（符合需求）。

---

## 7. Proxy server 提供的注入能力 API

> 只列 **proxy server 提供**的注入能力（`POST /sandboxes` 创建沙箱时的参数 + 续约接口）。execd 接口（沙箱内）不在 proxy server 范围内。

### 7.1 创建时注入（分配时注入）— `POST /sandboxes`

| 参数 | 注入能力 | 说明 |
|---|---|---|
| `env` | **注入环境变量** | 沙箱内进程直接读。**非空即触发 taskTemplate**。token 走这里（不进命令行日志） |
| `entrypoint` | **注入启动命令** | 作为 task 的 `command`，分配后执行。**非默认即触发 taskTemplate** |
| `extensions.poolRef` | 指定池 | 池化模式开关 |
| `extensions.access.renew.extend.seconds` | 自动续约 | 长会话沙箱不中途回收 |
| `extensions.opensandbox.extensions.*` | 透传注解 | 转成 pod annotation，**不**进 task env / 文件 |
| `metadata` | 打标签 | 转成 labels，用于过滤 |

**特点**：**分配时一次性注入**，参数在 create 时已知。适合"用户信息、业务配置、启动命令"这类**创建时已知**的注入。**不能**写任意文件内容（除非改 `_build_task_template`）。

### 7.2 续约接口 — `POST /sandboxes/{id}/renew-expiration`

| 参数 | 注入能力 | 说明 |
|---|---|---|
| `expires_at` | 手动续约 | 设新的绝对到期时间（须在未来且晚于当前） |

**特点**：手动续约，与 `extensions.access.renew.extend.seconds`（自动续约）互补。

### 7.3 结论

- **分配时注入**（你的调研场景）→ 用 `POST /sandboxes` 的 `env` / `entrypoint`。
- **写文件 + 调用脚本** → proxy server 目前**不提供**该能力，需改 `_build_task_template`（见示例文档方式 B），或新增 k8s exec 接口。

---

## 参考代码位置

| 路径 | 说明 |
|---|---|
| `server/opensandbox_server/api/schema.py` | `CreateSandboxRequest` 字段定义与池化校验 |
| `server/opensandbox_server/services/k8s/kubernetes_service.py` | 池化 create 入口，构造 env / extensions |
| `server/opensandbox_server/extensions/` | extensions 编解码 / 校验 / 已知键 |
| `server/opensandbox_server/integrations/renew_intent/` | OSEP-0009 续约（proxy 触发 + controller） |
| `server/opensandbox_server/services/k8s/batchsandbox_provider.py` | `_create_workload_from_pool` / `_build_task_template` |
