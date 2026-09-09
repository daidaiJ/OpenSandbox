# 配置文件 KV 运行时编辑 — 实现 Task 拆解

- 日期：2026-09-09
- 上游：`todo/opensandbox-config-kv-runtime-edit.md`（方案 §1–§4、§6–§8 决策/语义不复述）
- 范围：**只写怎么实现**，每个 task 含文件落点、代码要点、验收、依赖。
- **主路径：execd 原生端点（T1–T3）；server 只做薄代理（T4）。** T5（SDK/网关）、T6（S3 持久化）与 T4 平行独立。
- 依赖顺序：`T1 → T2 → T3 → T4 联调`；`T5/T6` 可并行。

---

## 0. 一页图

```
业务网关
   │  PATCH/GET/DELETE /sandboxes/{id}/config
   ▼
server main.py（薄代理路由 + secure-access + audit）        [T4]
   │  get_endpoint(id, 44772) → app.state.http_client 透传
   ▼
execd :44772  /config  (Gin)                                [T3 路由]
   │  withFilesystem → ConfigController
   ▼
pkg/runtime/configkv/                                       [T2 编辑器]
   │  resolve_path(ExpandAbsPath + allowed_roots 防穿越)
   │  parse(fmt) → apply/lookup(点分 key_path) → serialize
   │  per-path 互斥 + tmp + os.Rename 原子写回
   ▼
config files (YAML/TOML/JSON)
```

- 后端库依赖：`go.mod` **已有** —— `gopkg.in/yaml.v3`、`github.com/pelletier/go-toml/v2`、`github.com/goccy/go-json`、`golang.org/x/sys`（flock）。**零新增，只需把 `goccy/go-json`、`yaml.v3` 从 indirect 提升为 direct（`go mod tidy`）。**

---

## T1 — execd 配置节（单源白名单）

> 依赖：无。产出：execd 的 `[config]` 配置节 + 失败关闭语义。

- [ ] 在 execd 配置加载处（`components/execd/pkg/` 现有 flag/config 读取，或 isolation 配置节附近）新增节：

```toml
[config]
allowed_roots = ["/workspace/config", "/app/config"]
max_file_size_bytes = 1048576
```

- [ ] 读取为 `configkv.Options{AllowedRoots []string, MaxFileSizeBytes int}`，缺省 `AllowedRoots=nil`（→ 端点整体 403）。
- [ ] `AllowedRoots` 空 → `/config` 所有请求 `403 INVALID_FILE_CONTENT`（fail-closed）。
- [ ] 加一层**永远禁止**的前缀黑名单：`/etc`、`/proc`、`/sys`、`/usr`、`/opt/opensandbox`、`/bin`、`/sbin`（即使被配进 allowed_roots 也拒绝，防误配）。
- [ ] 单测：`configkv.Options.Load` 各默认值、空列表语义、黑名单优先级。

**验收**：`go test ./pkg/runtime/configkv/` 绿；黑名单/空列表行为断言通过。

---

## T2 — execd 编辑器包（纯函数 + 原子写）

> 依赖：T1（Options 类型）。产出 `pkg/runtime/configkv/`，无 Gin 依赖，可独立测。

### 2.1 包结构 `components/execd/pkg/runtime/configkv/`

```
configkv/
  paths.go      resolve_path(path string, opt Options) (abs string, err error)
  editor.go     Apply(doc, key_path, op, value) / Lookup(doc, key_path)
  formats.go    Parse(content, fmt) / Serialize(doc, fmt) / DetectFormat(path, explicit)
  store.go      Read/Write 封装：flock + tmp + os.Rename（原子）
```

### 2.2 关键实现

```go
// paths.go — 用 pathutil.ExpandAbsPath + 白名单前缀 + 黑名单拦截；拒绝 `..`
func resolve_path(p string, opt Options) (string, error)

// editor.go — 点分 key_path：a.b.0.c；中间 mapping 缺失则建（仅 mapping）；
//   数组只允许读/改已存在下标，越界写→ErrSemantic；delete 数组元素→ErrSemantic
//   upsert 命中目标类型不符（如标量当容器）→ ErrSemantic（不静默替换）
//   每次改必须同时返回 oldValue 与 newValue（先 Lookup 拿旧值再 Apply），供 changes 三元组与审计
func Apply(doc any, keyPath []string, op Op, val any) (any, FieldChange, error)
func Lookup(doc any, keyPath []string) (any, bool, error)

type FieldChange struct {   // 变更三元组，贯穿 editor → controller → server 响应/审计
    KeyName  string
    OldValue any
    NewValue any
}

// formats.go — JSON: goccy-json（保序/紧凑可配）；YAML: yaml.v3 (safe, 禁对象构造)；
//   TOML: go-toml/v2；DetectFormat 按扩展名，未知且无 explicit→ErrFormatUnsupported
func Parse(b []byte, f Format) (any, error)
func Serialize(doc any, f Format) ([]byte, error)

// store.go — per-path sync.Map 互斥串行化读改写；写 = 临时文件同目录 + os.Rename；
//   可选 unix.Flock(path.lock) 跨进程；MaxFileSizeBytes 读前先 Stat 拒绝
func (s *Store) ReadEditWrite(p string, mut func(doc any) (any, error)) (any, error)
```

- **必须 `tmp + os.Rename`**：现有 `ReplaceContent`（`filesystem.go:475`）用 `os.WriteFile` 直接截断写，非原子，patch 不能用它（这点写进代码注释，防止后来者复用）。
- 格式往返必然丢注释/排版 —— 这是设计接受项（见方案 §7.1），在 `formats.go` 加 doc 注释注明。

### 2.3 单测 `configkv/*_test.go`

- [ ] 三格式 × 三 op × 边界：缺 key（upsert 建 / get 不命中 / delete no-op）、数组越界（写报错/读不命中）、标量当容器（ErrSemantic）、空文档、白名单外、黑名单路径、`..` 穿越、**YAML 含锚点/自定义 tag（safe_load 拒或安全处理）**、TOML `[[array]]`
- [ ] 字段一致性：`apply(parse(x))` 往返；Write 后 `Read` 得到完整合法文档（无半文件）
- [ ] 并发：多 goroutine 同时 `ReadEditWrite` 同一文件，最终为单次提交结果且文件始终合法

**验收**：`go test ./pkg/runtime/configkv/` 全绿。

---

## T3 — execd HTTP 端点（路由 + controller + 契约）

> 依赖：T1/T2。产出 `/config` 端点 + `specs/execd-api.yaml` 契约。

### 3.1 路由 `components/execd/pkg/web/router.go`

```go
config := r.Group("/config")
{
    config.GET("",   withFilesystem(func(c *controller.FilesystemController) { c.GetConfigKV() }))
    config.PATCH("", withFilesystem(func(c *controller.FilesystemController) { c.PatchConfigKV() }))
    config.DELETE("", withFilesystem(func(c *controller.FilesystemController) { c.DeleteConfigKV() }))
}
```

- 复用 `withFilesystem`（`FilesystemController` 已注入 `basicController`：`bindJSON` / `RespondError` / `pathutil.ExpandAbsPath` / `beginFilesystemMetric`）。
- `accessTokenMiddleware` 全局生效，无需额外鉴权。
- 可新建 `config.go` controller 文件放三个 handler（与 `filesystem_download.go`/`filesystem_upload.go` 同构）。

### 3.2 契约对齐现 execd 风格

- 请求：GET 用 query `path` + `key_path`；PATCH/DELETE 用 JSON body `{path, key_path, value?, format?}`。
- 响应：`{path, found, value_type, changes:[{keyName, oldValue, newValue}]}`，**变更以三元组呈现**——GET 无 `changes`，只 `{keyName, found, value}`；字段语义见方案文档 §3.1。
- 错误映射：

| 条件 | 错误码 | HTTP |
|---|---|---|
| body 坏 JSON | `INVALID_REQUEST_BODY` | 400 |
| 文件不存在 | `FILE_NOT_FOUND` | 404 |
| 路径被 allowed_roots/黑名单拒 | `INVALID_FILE_CONTENT`（可加 `PATH_NOT_ALLOWED`） | 403 |
| 超 max_file_size | `INVALID_FILE` | 413 |
| 格式不支持 | `INVALID_FILE` | 415 |
| 语义错误（数组越界/类型冲突/key_path 非法） | `INVALID_FILE` | 400 |

- 指标：`beginFilesystemMetric("config_patch")` 等各 op 一条。
- **同步改 `specs/execd-api.yaml`**：新增 `/config` 三端点（public contract，`specs/` 是契约源）。

### 3.3 单测 `controller/config_test.go`

- [ ] 三 op 各一 happy path；404/403/413/415/400 各映射；GET 缺 key 返回 `found:false`
- [ ] `accessToken` 启用时无 token → 401（中间件已有测试，回归即可）

**验收**：`go test ./pkg/web/controller/` 全绿；`make build` 通过；specs 已更新。

---

## T4 — server 薄代理 + 审计（交付面）

> 依赖：T3（execd 已可用）。**注意：注册在 `proxy_router` 之前（`main.py:240`）。**

### 4.1 路由 `server/opensandbox_server/api/config_kv.py`（对齐 lifecycle.py 风格）

```python
@router.get("/sandboxes/{sandbox_id}/config")    # query path,key_path 透传
@router.patch("/sandboxes/{sandbox_id}/config")  # body 透传
@router.delete("/sandboxes/{sandbox_id}/config")
```

- 每步：`get_endpoint(sandbox_id, 44772, resolve_internal=True)` → `app.state.http_client` 转发到 execd `/config`——**不改 path/key_path、不解析格式**（编辑全在 execd）。
- secure-access：调用方 `_verify_secure_access` 校验（`api/proxy.py:291`）+ 转发时合并 `endpoint.headers`（execd access token）。
- 请求体模型进 `api/schema.py`（`UpsertConfigKVRequest`/`DeleteConfigKVRequest`/响应 `ConfigKVResponse`），仅为 OpenAPI 文档，**不做 server 端 parse**。
- 注册：`main.py` 在 `app.include_router(proxy_router)`（:245）前插 `config_kv_router`，并挂 `/v1` 前缀副本。
- 错误透传：上游 execd 状态码直接映射（403/404/413/415/400/500），加统一的 `{code,message}` 包装（对齐 `_normalize_error_detail`）。

### 4.2 审计

- server 记结构化日志：`sandbox_id, op, path, keyName, oldValue, newValue`（**值默认打 hash/长度**，同 egress token 脱敏策略；如需明文需显式 `audit_log_plaintext=true` 配置开关，默认关）。审计变更三元组与业务响应一致。

### 4.3 集成测试

- [ ] 起 server（k8s provider）+ 池化沙箱 → `PATCH /sandboxes/{id}/config {path, key_path, value}` → 沙箱内 `cat` 确认
- [ ] `GET` → `DELETE` → key 消失；DELETE 不存在 key → 200 no-op
- [ ] 白名单外路径 → 403；坏 YAML → 400 且文件未变；超大小 → 413
- [ ] 并发双写：终态为完整合法文档（无半文件），后者覆盖型 last-write-wins 可接受（文档写明）
- [ ] `use_server_proxy=True` 与直连各跑一遍
- [ ] OpenAPI `/openapi.json` 含 config 三路径

**验收**：`pytest server/tests/...config_kv...` 全绿 + e2e 全通过 + OpenAPI 生成正确。

---

## T5 — SDK / 网关（用户已定：V0 不做 / 可选只做 Java）

> 依赖：T4。

- [ ] **V0 不做**：业务网关直接调 server API（curl / 网关 HTTP client）。
- [ ] 若做 Java：`sdks/sandbox/java` 加 `SandboxConfigKV`（`get/upsert/delete(path, keyPath, value)`），仅拼 HTTP 到 server `config` 端点，**无本地解析**；对齐 `sdks/AGENTS.md` 手写 adapter 模式。

**验收**：不做则文档注明「业务经网关直调 server API」；做则 Java 单测 + 与 T4 e2e 联动。

---

## T6 — S3 持久化集成（方案 A，会话级复现）

> 依赖：T4。复用现有 S3 中间层，不改中间层代码。

- [ ] 约定：被 KV 编辑的配置文件放 **S3 同步目录**（如 `/workspace/config/`），并加入 execd `allowed_roots`。
- [ ] 验证：pooled create → PATCH 改 `/workspace/config/app.yaml` → delete（触发 postStop 回写 S3）→ 同用户再 create → 配置恢复上次 KV。
- [ ] 镜像内置路径（`/app/config`）不持久化，仅会话内有效，文档写明。

**验收**：S3 前缀出现修改后文件；二次 create 恢复；跨用户不串配置（S3 前缀隔离已有保障）。

---

## 验收清单汇总

| # | 验收项 | 对应 task |
|---|---|---|
| 1 | `goccy-json`/`yaml.v3` 转 direct，`go build` 过 | T2 前置 |
| 2 | 配置节空列表/黑名单 fail-closed 单测绿 | T1 |
| 3 | 编辑器三格式×三 op×边界 + 原子写 + 并发单测绿 | T2 |
| 4 | `/config` 端点 + specs 契约 + controller 单测绿 | T3 |
| 5 | server 薄代理 + secure-access + 审计 + e2e 三 op + OpenAPI | T4 |
| 6 | Java SDK（可选）或「业务走网关直调」成立 | T5 |
| 7 | 可复现配置：S3 前缀出现修改文件 + 二次 create 恢复 | T6 |

## 风险与注意（实现时盯）

1. **格式往返丢注释/排版**：parse→serialize 必然重排 + 丢注释（解析库固有限制）。`formats.go` doc 注释注明；API 文档明示。业务不能接受 → V2 做「行级编辑」（线性格式按行匹配，不整体重排）。
2. **写回必须 `tmp + os.Rename`**：**不要照抄** `ReplaceContent` 的 `os.WriteFile` 截断写（`filesystem.go:475`），非原子，会出半文件。
3. **并发**：`flock` 按 path + 原子 rename 避免半文件与 execd 内并发，但不保证业务进程自写；V1 接受。强一致 → `content_hash` 乐观锁（schema 预留，不先实现）。
4. **execd 是 fork**：改完要重build execd 镜像（含 `go-toml/v2`、`yaml.v3` 进 direct）+ 更新 Pool 模板引用；与 server 版本兼容矩阵见 `wiki/opensandbox-upgrade-compat-sop.md`。
5. **allowed_roots 默认空**：不配置即 `/config` 403；黑名单 `/etc` 等系统路径**永远**被拒，防止误配成「能改系统配置」。

## 参考代码位置

| 路径 | 用途 |
|---|---|
| `components/execd/pkg/web/router.go:36-46,123` | files group + `withFilesystem` 落点 |
| `components/execd/pkg/web/controller/filesystem.go:420` | ReplaceContent（**反例**：`os.WriteFile` 非原子） |
| `components/execd/pkg/web/controller/filesystem.go:49,254` | `handleFileError` / `ExpandAbsPath` |
| `components/execd/pkg/web/model/error.go` | `ErrorCode*` |
| `components/execd/pkg/runtime/` | configkv 新包放此（无 Gin 依赖） |
| `components/execd/go.mod:15,23,46,81` | 已有依赖 |
| `specs/execd-api.yaml` | `/config` 契约需同步 |
| `server/opensandbox_server/main.py:240-250` | server 路由注册顺序 |
| `server/opensandbox_server/api/proxy.py:291,404` | `_verify_secure_access` / proxy 客户端 |
| `server/opensandbox_server/services/sandbox_service.py:347` | `get_endpoint` |
