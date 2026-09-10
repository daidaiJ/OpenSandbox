# execd 目录读取工具与 Server Proxy 限制

> 日期:2026-08-18
> 场景:沙箱插件(如 OpenClaw Tool Plugin)通过 execd `/directories/list` 或 server proxy 读取沙箱内目录时的限制梳理。

## execd `/directories/list` 的限制(`components/execd/pkg/web/controller/filesystem.go`)

| 限制 | 行为 |
|---|---|
| **depth 默认 1** | 只列直接子项;`depth=0` 返回空数组;负数/非数字 → 400 |
| **符号链接不穿透** | root 是 symlink → 400 拒绝(`refusing to traverse`);遍历时 symlink 只作为条目列出,不递归展开 |
| **必须是目录** | 传文件路径 → 400;路径不存在 → 404 |
| **路径展开** | `ExpandAbsPath` 展开 `~` 等,但**没有工作目录/根目录白名单**——execd 以 root 跑在沙箱内,可列整个容器文件系统(受容器/bwrap 挂载视图限制) |
| **无数量/大小上限** | `listDirectoryEntries` 递归无上限。列 `/usr`、`node_modules` 等大目录会返回巨大 JSON,可能撑爆响应体/客户端内存 |
| **只返回元数据** | `FileInfo`(path/name/size/mode/is_dir/modified),不含内容;要看内容需再调 read 接口 |

补充:`/files/search`(`SearchFiles`)支持 glob 模式(默认 `**`),`filepath.Walk` 全量遍历,同样无数量上限,适合定向找文件而非列大目录。

## Server Proxy 的额外限制(`server/opensandbox_server/api/proxy.py`)

1. **端口必须已暴露**:`get_endpoint(sandbox_id, port)` 只对 sandbox 暴露的端口生效,execd 端口(默认 44772)需在创建沙箱时暴露,否则 404/502。
2. **secure-access 校验**:endpoint 带 token 时,请求必须带 `OpenSandbox-Secure-Access` header,否则 401。
3. **runtime-id 门禁**(#954 新增):配置 `runtime_id_required` 时,请求必须带 `OpenSandbox-Runtime-Id` header;pod 被重建后旧 id 返回 **409 RUNTIME_REPLACED**,调用方需按响应 `runtime_id` 切换(每次重建最多感知一次)。
4. **敏感 header 不转发**:`authorization`/`cookie`/API key 等被剥掉,不影响 execd 调用。
5. **HTTP Upgrade 不支持**:HTTP 的 `Upgrade: websocket` 会 400(WebSocket 走 proxy 的独立路由)。

## 对插件实际影响

- **大目录是最大的坑**:`/directories/list` 无分页/截断,插件列大目录前先 `depth=1` 探一下,再按需深入;或改用 `/files/search` 定向找。
- **symlink 目录列不了**:如 `/workspace` 是 symlink 会直接 400,需传真实路径。
- **proxy 路径下要处理 409**:插件需维护 runtime-id,遇到 `RUNTIME_REPLACED` 要感知"环境已重置"并切换。

## 相关代码位置

| 文件 | 关键点 |
|---|---|
| `components/execd/pkg/web/controller/filesystem.go` | `ListDirectory` / `listDirectoryEntries` / `SearchFiles` |
| `specs/execd-api.yaml` | `/directories/list` 公开契约 |
| `server/opensandbox_server/api/proxy.py` | `_verify_secure_access` / `_verify_runtime_id` / `_filter_proxy_headers` |