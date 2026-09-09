# 业务侧动态修改配置文件 KV（运行时）方案

- 日期：2026-09-09
- 状态：方案设计（未实施）
- 需求：业务侧**运行中任何时刻**对沙箱内指定配置文件（YAML/TOML/JSON）做 KV 的增/改/删
- 边界：本能力**只对业务网关暴露 server API**；SDK 侧暂不做（或后续只做 Java）
- 实现拆解：见 [opensandbox-config-kv-runtime-task-breakdown.md](opensandbox-config-kv-runtime-task-breakdown.md)（T1–T6 逐 task）
- 关联：`wiki/opensandbox-pool-allocation-time-injection.md`（分配时注入 vs 运行中修改）、`wiki/opensandbox-proxy-server-business-facts.md`（业务流量必经 server proxy）、`wiki/opensandbox-pooled-session-s3-sync-middleware.md`（配置持久化可复用的 S3 回写）

---

## 1. 结论

**给 execd 新增一个原生 `/config` 端点，读-改-写全部在容器内一次 I/O 完成；server 只做一条薄代理（透传 + secure-access + 审计），不承担任何解析/编辑逻辑。**

```
业务网关
   │  PATCH/GET/DELETE /sandboxes/{id}/config
   ▼
OpenSandbox Server（薄代理）
   │  get_endpoint(sandbox_id, 44772) → 透传给 execd（http_client）
   ▼
execd /config（单进程内，零出沙箱）
   │  1. path 白名单校验（ExpandAbsPath + allowed_roots fail-closed）
   │  2. 读文件 → 按格式解析（yaml.v3 / go-toml/v2 / goccy-json）
   │  3. 点分 key_path 增/改/删
   │  4. 序列化 → tmp 文件 → os.Rename 原子写回（per-path 互斥 + flock）
```

语义单源在 execd，server 不重复实现，避免两处读-改-写竞态/策略漂移。

## 2. 为什么是 execd 原生端点（决策记录）

**曾考虑把编辑逻辑放 server 端，被否。** 它的根本缺陷是：**配置文件内容要从沙箱拉到控制面、改完再传回**。

| 问题 | 影响 |
|---|---|
| **敏感配置出沙箱** | 配置内容进 server 内存/日志，违背「数据不出内网、强隔离审计」约束，这是硬伤 |
| **两次全文件传输** | 改一个 KV 传整个文件，放大传输量与竞态 |
| **读-改-写窗口放宽** | 下载后到上传前，沙箱内业务进程可能已改文件，被覆盖丢失（last-write-wins 无感知） |

execd 原生端点一次 I/O 在容器内解决，上述全部消除。

**execd 侧可行性已验证：**

| 能力 | 现状 |
|---|---|
| 三格式解析库 | **零新增** —— `go.mod` 直接依赖已有 `github.com/pelletier/go-toml/v2`、`gopkg.in/yaml.v3`、`github.com/goccy/go-json` |
| 路由 | Gin，`components/execd/pkg/web/router.go` 加一组 `/config`；`accessTokenMiddleware` 自动覆盖 |
| 原子写 | `os.Rename` 同目录原子替换；`golang.org/x/sys` 已在，可用 `flock` 跨进程锁 |
| 错误模型 | `model.ErrorCode*`（`INVALID_REQUEST_BODY` / `FILE_NOT_FOUND` / `INVALID_FILE`…）复用 |
| 指标 | `beginFilesystemMetric("config")` 同构复用 |
| path 校验 | `pathutil.ExpandAbsPath` 复用 |

server 无需新增任何依赖（**不引入 `tomli-w`**），业务侧仍是 `use_server_proxy` 通道。

## 3. API 设计

### 3.1 execd 侧（新端点的契约，单源）

| 方法 | execd 路径 | 请求体 / query | 语义 |
|---|---|---|---|
| GET | `/config` | `?path=&key_path=` | 读 key_path（缺省 = 全文档）；`key_path` 不存在 → `{found:false}` |
| PATCH | `/config` | `{path, key_path, value, format?}` | upsert（幂等：缺 key 建、有覆盖） |
| DELETE | `/config` | `{path, key_path, format?}` | 删 key；不存在 → no-op（200 `{found:false}`） |

- 附在现有 `files := r.Group("/files")` 旁新增 `config := r.Group("/config")`，handler 用 `withFilesystem`（复用 `FilesystemController` 或新建 `ConfigController`）。
- `format` 缺省按扩展名探测（`.yaml/.yml/.json/.toml`）；未知扩展名且无 `format` → 415/`ErrorCodeInvalidFile`。
- 错误码：坏 JSON → `INVALID_REQUEST_BODY`；文件不存在 → `FILE_NOT_FOUND`；语义错误（数组越界/容器类型冲突）→ `INVALID_FILE`；安全路径拒绝 → `INVALID_FILE_CONTENT`（或新增 `PATH_NOT_ALLOWED`，加码即可）。
- 响应统一结构，变更字段以 **`changes[]`（`keyName` / `oldValue` / `newValue`）** 呈现，`value_type` 一并返回给前端做渲染：

```jsonc
{
  "path": "/workspace/config/app.yaml",
  "found": true,
  "value_type": "string",
  "changes": [                       // V1 单 key 请求 => 恰好 1 项；数组形态天然支持未来多 key
    {
      "keyName": "model.name",       // 完整点分 key 路径（唯一定位字段）
      "oldValue": "qwen2",           // upsert 新键 / get 缺失 / delete 不存在 => null
      "newValue": "llama3"           // delete => null（表示删除；get 无此字段）
    }
  ]
}
```

- 各 op 的 `changes[0]` 语义：

| op | keyName | oldValue | newValue |
|---|---|---|---|
| PATCH upsert（新键） | 点分路径 | `null` | 写入 value |
| PATCH upsert（覆盖） | 点分路径 | 原值 | 写入 value |
| DELETE（存在） | 点分路径 | 原值 | `null`（删除） |
| DELETE（不存在） | 点分路径 | `null` | `null`，`found:false`（no-op） |
| GET | 点分路径 | — | 当前值（**无 changes，只有 `{keyName, found, value}`**，读不是变更） |

### 3.2 server 侧（薄代理）

| 方法 | server 路径 | 行为 |
|---|---|---|
| GET | `/sandboxes/{id}/config` | proxy 透传 execd `/config`（query 原样） |
| PATCH | `/sandboxes/{id}/config` | 透传 body |
| DELETE | `/sandboxes/{id}/config` | 透传 body |

- 用 `get_endpoint(sandbox_id, 44772, resolve_internal=True)` 解析 execd 端点，`app.state.http_client` 转发；**不做 path/key_path 的 server 端解析**。
- secure-access：先 `_verify_secure_access` 校验调用方 token，转发时合并 `endpoint.headers`（execd `accessTokenMiddleware` 用的 token）。
- audit：server 记 **同一变更三元组** `sandbox_id, op, path, keyName, oldValue, newValue`（值默认打 hash/长度，可配置 `audit_log_plaintext=true` 才落明文，默认关）。这保证**审计与业务侧看到的变更完全一致**，且不把敏感 config 内容进控制面。
- **注册顺序**：config 路由必须在 `proxy_router` 前（`main.py:240`），否则被 catch-all 吞掉；双挂 `/` 与 `/v1`。

### 3.3 语义（execd 内单源实现）

| op | YAML/JSON/TOML 统一 | 说明 |
|---|---|---|
| upsert | 点分 key_path 写入/覆盖（`model.name`、`servers.0.host`） | 幂等；中间 mapping 缺失自动创建；数组下标越界 → 400 |
| get | 点分 key_path 读取 | 不存在返回 `{found:false}`，不报错 |
| delete | 点分 key_path 删除 | 不存在 no-op；**V1 仅支持 mapping key 删除，删数组元素 → 400** |

- key_path 非法（空段、含 `/`、`..`）→ 400。
- 原子性：**解析失败 → 不写回**（fail-closed，原文件不动）；写回是 `tmp + os.Rename` 原子替换，无半文件。

## 4. execd 配置（单源白名单）

```toml
# components/execd 的 isolation/config 或主配置节（与现有 EXECD_* 对齐）
[config]
allowed_roots = ["/workspace/config", "/app/config"]   # 空 = /config 端点禁用（403）
max_file_size_bytes = 1048576                          # 超限拒绝
```

- 默认 deny：系统/敏感目录（`/etc`、`/proc`、`/sys`、`/usr`、`/opt/opensandbox`）**不可进入 allowed_roots**（fail-closed）。
- **这不是安全边界**（业务本可经 `/command` 跑任意 shell）+ 不覆盖 `/command`；它防的是「业务手滑改系统关键文件 + 日志面收窄」。安全由沙箱隔离/hardening 承担。
- `allowed_roots` 为空 → 整个端点 403，**默认关闭，需显式开启**。

## 5. 持久化语义（业务必读）

| 配置文件位置 | 持久化 | 说明 |
|---|---|---|
| `/workspace/...`（S3 同步目录） | ✅ 会话级复现 | 复用现有 postStop 回写，无需新机制 |
| `/app/config` 等镜像/Pool 模板内置路径 | ❌ 会话内有效 | Pod 回池重置；运行中修改仅当次生效 |

业务按需选位置；server/execd 不新增持久化层（simplicity first，S3 中间层已覆盖主场景）。

## 6. 明确不做的方案（决策记录）

| 方案 | 不做原因 |
|---|---|
| server 端读-改-写回 | **配置内容出沙箱**（违背强隔离），两次全文件传输，竞态放宽 —— 已被 execd 原生端点取代 |
| 业务拼 shell（`yq -i`）改 | 沙箱内未必有 yq/jq；shell 注入风险；业务要懂语法；无审计 |
| 池模板加 KV sidecar | Pod 预建无法动态加 sidecar（D-3 约束）；每沙箱多耗内存 |
| taskTemplate 注入 | 只能 create 时注入，无法满足「运行中任何时刻改」（需求已排除） |

## 7. 风险与注意

1. **格式往返丢注释/排版**：parse→serialize 会重排 YAML/TOML/JSON 格式、丢注释（这是所有解析库的固有限制，非 bug）。**要在 API 文档明示**：被编辑的文件需容忍「格式化重排 + 注释丢失」。若业务不能接受，后续可加「行级编辑」模式（线性格式按行匹配 key，不整体重排）作为 V2 演进。
2. **跨进程并发**：`os.Rename` 原子替换避免半文件；但 READ→WRITE 之间别的进程（如业务主进程）可能改文件，V1 用 execd 内 `flock`（按 path）尽量串行化，仍不保证「业务进程自己写」的并发。V1 接受（配置低频写）；如需强一致，可加 `content_hash`（GET 返回）做乐观锁——**schema 预留字段，不先实现**。
3. **`allowed_roots` 默认空**：不配置即 `/config` 403，避免默认开权限面。
4. **execd 是 fork**：改 execd 后需重build execd 镜像并更新 Pool 模板引用（`wiki/opensandbox-pool-sidecar-components-guide.md` 有装配骨架）；不同版本 execd 与 server 兼容矩阵见 `wiki/opensandbox-upgrade-compat-sop.md`。
5. **server 薄代理无校验**：恶意 `PATCH` 想写系统路径，会被 execd 的 `allowed_roots` 挡掉（fail-closed），server 只需确保透传 + 审计即可。

## 8. 参考代码位置

| 路径 | 用途 |
|---|---|
| `components/execd/pkg/web/router.go:36-46` | files group 落点，config group 加在其旁 |
| `components/execd/pkg/web/controller/filesystem.go:420` | ReplaceContent 实现（写文件先例，注意它用 `os.WriteFile` 非原子，patch 需改 `tmp+rename`） |
| `components/execd/pkg/web/controller/filesystem.go:49` | `handleFileError` / `beginFilesystemMetric` 复用 |
| `components/execd/pkg/web/controller/utils.go:36` | `pathutil.ExpandAbsPath` 复用 |
| `components/execd/pkg/web/model/error.go` | `ErrorCode*` 错误码 |
| `components/execd/go.mod:15,23,46,81` | `go-toml/v2`、`x/sys`、`goccy-json`、`yaml.v3`（均已有） |
| `server/opensandbox_server/main.py:240-250` | server 路由注册顺序约束 |
| `server/opensandbox_server/api/proxy.py:404,291` | proxy 客户端 / `_verify_secure_access` 复用 |
| `server/opensandbox_server/services/sandbox_service.py:347` | `get_endpoint(resolve_internal=True)` |
| `wiki/opensandbox-pooled-session-s3-sync-middleware.md` | 持久化（§5 方案 A）复用点 |
