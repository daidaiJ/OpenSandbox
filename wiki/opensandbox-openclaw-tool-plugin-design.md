# OpenSandbox × OpenClaw Tool Plugin 设计方案

> 日期：2026-08-12
> 前置分析：`wiki/opensandbox-openclaw-integration-analysis.md`（方式 A/B/C/D 对比）
> 本文档对应**方式 B**：符合 OpenClaw 插件规范的官方 Tool Plugin（`opensandbox-openclaw`），封装 `@alibaba-group/opensandbox` JS SDK。

## 1. 目标与范围

让 OpenClaw 的 agent 通过**原生插件工具**使用 OpenSandbox 沙箱：创建/连接沙箱、执行命令、读写文件、获取端口端点，并由 OpenClaw 的 tool policy 统一管控。

**一期范围**（本设计）：生命周期 + 命令执行 + 文本文件 + endpoint。

**二期范围**（预留）：代码解释器、隔离会话、Credential Vault、快照、egress 策略 patch。

**明确不做**：pause/resume 相关工具——当前 OpenSandbox 为无状态沙箱，不支持暂停恢复（以实际产品状态为准，与 specs/SDK 文档中的接口声明不一致）。

## 2. 插件元数据与工程结构

### 2.1 基本信息

| 项 | 值 |
|---|---|
| 插件 ID | `opensandbox-openclaw` |
| 显示名称 | OpenSandbox Sandbox |
| 包名 | `@opensandbox/opensandbox-openclaw`（或独立 scoped 包，按发布策略定） |
| 入口 | `openclaw/plugin-sdk/tool-plugin` 的 `defineToolPlugin` |
| 依赖 | `@alibaba-group/opensandbox`（JS SDK）、`@sinclair/typebox`、`openclaw/plugin-sdk/*` |
| 运行时 | Node >= 20（与 JS SDK 要求一致） |

### 2.2 目录结构

```
opensandbox-openclaw/
├── src/
│   ├── index.ts          # defineToolPlugin 入口
│   ├── tools/
│   │   ├── lifecycle.ts  # sandbox_create/connect/list/get_info/renew/kill/get_endpoint
│   │   ├── command.ts    # sandbox_run_command/interrupt_command
│   │   └── files.ts      # 文件工具组
│   ├── client.ts         # ConnectionConfig/Sandbox 缓存单例
│   └── errors.ts         # SandboxException → 可读错误
├── src/index.test.ts     # vitest（脚手架生成）
├── openclaw.plugin.json  # openclaw plugins build 自动生成
├── package.json          # openclaw.extensions → ./dist/index.js
├── tsconfig.json
└── vitest.config.ts
```

## 3. 配置（configSchema，TypeBox）

```ts
import { Type } from "@sinclair/typebox";

export const configSchema = Type.Object({
  apiKey: Type.Optional(Type.String({
    description: "OpenSandbox API key。优先通过环境变量 OPEN_SANDBOX_API_KEY 或 SecretRefs 提供，避免硬编码。",
  })),
  domain: Type.Optional(Type.String({
    description: "OpenSandbox API domain (host[:port])，默认 localhost:8080",
    default: "localhost:8080",
  })),
  protocol: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("https")], {
    description: "API 请求协议",
    default: "http",
  })),
  requestTimeoutSeconds: Type.Optional(Type.Number({
    description: "SDK HTTP 请求超时（秒）",
    default: 30,
  })),
  useServerProxy: Type.Optional(Type.Boolean({
    description:
      "execd/endpoint 请求走 server 代理。OpenClaw 集成场景预期统一使用代理模式"
      + "（OpenClaw 网关与 sandbox server 异机，沙箱端口对客户端不可达），默认开启；"
      + "仅当沙箱公开端点对插件进程可达（如本地开发）时改为 false，见附录 A",
    default: true,
  })),
  defaultImage: Type.Optional(Type.String({
    description: "sandbox_create 未指定 image 时的默认镜像",
    default: "ubuntu",
  })),
  maxOutputBytes: Type.Optional(Type.Number({
    description: "命令输出/文件读取返回给 agent 的最大字节数，超出截断",
    default: 64 * 1024,
  })),
  sandboxCacheSize: Type.Optional(Type.Number({
    description: "插件内 Sandbox 实例 LRU 缓存上限",
    default: 8,
  })),
});
```

配置读取：`execute(params, config)` 第二参数即按此 schema 校验后的配置；密钥遵循 OpenClaw 凭据语义（环境变量 / SecretRefs），文档中不硬编码。

## 4. 工具集设计（一期 13 个）

命名统一 `sandbox_` 前缀，避免与 OpenClaw 内置工具（`exec`、`web_search` 等）冲突；所有工具要求显式 `sandbox_id`（由 agent 跟踪，与 MCP server 行为一致，保证无状态与幂等）。

### 4.1 生命周期（7）

| 工具 | 说明 | 关键参数 | 返回 |
|---|---|---|---|
| `sandbox_create` | 创建沙箱并注册到插件缓存 | `image?`（默认取配置）、`timeoutSeconds?`、`env?`、`metadata?`、`resource?`、`networkPolicy?`、`entrypoint?` | `{ sandboxId, state, createdAt, expiresAt }` |
| `sandbox_connect` | 连接已存在的沙箱（插件重启后恢复用） | `sandboxId` | `{ sandboxId, state }` |
| `sandbox_list` | 分页列出沙箱 | `states?`、`metadata?`、`page?`、`pageSize?` | `{ items: [{id, state, createdAt}], page, total }` |
| `sandbox_get_info` | 查询沙箱状态/资源 | `sandboxId` | `{ state, createdAt, expiresAt, resource, ... }` |
| `sandbox_renew` | 续期 | `sandboxId`、`timeoutSeconds` | `{ sandboxId, expiresAt }` |
| `sandbox_kill` | 终止并移除，同时清插件缓存。**description 内置强制提示：终止前必须先导出必要输入文件与最终产物**（无状态沙箱，销毁后数据不可恢复，见 4.5） | `sandboxId` | `{ sandboxId, state: "terminated" }` |
| `sandbox_get_endpoint` | 取端口端点 | `sandboxId`、`port` | `{ endpoint }`（`getEndpointUrl` 提供绝对 URL，供 agent 直接访问） |

### 4.2 命令执行（2）

| 工具 | 说明 | 关键参数 | 返回 |
|---|---|---|---|
| `sandbox_run_command` | 前台执行命令，收集完整输出 | `sandboxId`、`command`、`workingDirectory?`、`timeoutSeconds?` | `{ exitCode, stdout, stderr, executionTimeMs }`（按 `maxOutputBytes` 截断并标注 `truncated`） |
| `sandbox_interrupt_command` | 中断运行中的命令 | `sandboxId`、`executionId` | `{ interrupted: true }` |

> 设计取舍：工具调用是一次性语义，不暴露流式回调（SDK 的 `ExecutionHandlers` 留作二期 CLI/交互场景）；后台长任务不在一期（可用 `timeoutSeconds` 兜底）。

### 4.3 文件（4）

| 工具 | 说明 | 关键参数 | 返回 |
|---|---|---|---|
| `sandbox_read_file` | 读文本文件（text-only，支持 `encoding`、`rangeHeader` 分片） | `sandboxId`、`path`、`encoding?`、`rangeHeader?` | `{ content, truncated? }` |
| `sandbox_write_file` | 写文本文件 | `sandboxId`、`path`、`content`、`mode?` | `{ path, size }` |
| `sandbox_list_files` | 列目录 | `sandboxId`、`path`、`depth?` | `{ items: [{path, type, size, mode}] }` |
| `sandbox_delete_files` | 删除文件/目录 | `sandboxId`、`paths[]`、`recursive?` | `{ deleted: paths[] }` |

> 与 MCP server 保持能力对齐：文本读写 + glob 搜索可在二期补 `sandbox_search_files`、`sandbox_move_file`、`sandbox_make_dirs`——一期控制工具数量，避免工具目录臃肿。

### 4.4 工具定义示例（规范写法）

```ts
import { Type } from "@sinclair/typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { createSandbox, getSandbox } from "./client";

export default defineToolPlugin({
  id: "opensandbox-openclaw",
  name: "OpenSandbox Sandbox",
  description: "Create and manage OpenSandbox sandboxes: lifecycle, commands, and files.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "sandbox_create",
      label: "Create Sandbox",
      description: "Create a new OpenSandbox sandbox and return its sandbox_id.",
      parameters: Type.Object({
        image: Type.Optional(Type.String({ description: "Container image, defaults to plugin defaultImage." })),
        timeoutSeconds: Type.Optional(Type.Number({ description: "Server-side TTL in seconds." })),
      }),
      outputSchema: Type.Object({
        sandboxId: Type.String(),
        state: Type.String(),
        createdAt: Type.String(),
      }),
      async execute(params, config) {
        const sandbox = await createSandbox(config, params);
        return {
          sandboxId: sandbox.id,
          state: (await sandbox.getInfo()).status.state,
          createdAt: (await sandbox.getInfo()).createdAt,
        };
      },
    }),
    // ...其余工具
  ],
});
```

### 4.5 数据备份与产物回收（kill 前强制提示）— 两个载体的落地实现

背景：当前 OpenSandbox 为**无状态沙箱**，`sandbox_kill` 或服务端 TTL 到期都会销毁沙箱内数据。因此必须在释放前把必要输入文件与最终产物带出沙箱。实现载体有两个，机制不同：

#### 4.5.1 MCP server（`sdks/mcp/sandbox/python/src/opensandbox_mcp/server.py`）

FastMCP 的提示机制分两级，**两处都改**：

**(a) 工具级：`sandbox_kill` docstring（约 269 行）** —— docstring 即模型可见的 description，调用前必然读到：

```python
    @tool()
    async def sandbox_kill(
        sandbox_id: str,
    ) -> StatusResponse:
        """Terminate a sandbox by ID and remove it from local registry.

        WARNING: Sandboxes are stateless — killing destroys all data inside
        them permanently. Before calling this tool, first export any files or
        final artifacts you need: read small files with file_read, package
        directories with command_run (tar + base64), or download via the
        endpoint returned by sandbox_get_endpoint. After kill the data is gone.

        Parameters:
            sandbox_id: Target sandbox identifier.

        Returns:
            {"status": "killed"} when successful.
        """
```

**(b) 全局级：`create_server()` 的 instructions（约 736 行）** —— server 级系统提示词，agent 在 create 时就知道规则，覆盖面比单工具描述更广：

```python
    mcp = FastMCP(
        "OpenSandbox Sandbox",
        instructions=(
            "Use these tools to create and manage isolated sandboxes. "
            "Always keep track of the sandbox_id returned by sandbox_create/connect. "
            "Use command_run for execution, file_read/file_write for file IO, and "
            "sandbox_kill to terminate remote sandboxes. Use sandbox_get_endpoint to "
            "expose sandbox ports; for large files, prefer range reads. "
            "Sandboxes are stateless: sandbox_kill or TTL expiry destroys all data "
            "inside. Before terminating a sandbox, export necessary files and final "
            "artifacts first (file_read, tar via command_run, or download via "
            "sandbox_get_endpoint)."
        ),
    )
```

不需要新增工具：现有 `file_read`/`command_run`/`sandbox_get_endpoint` 就是导出路径。大文件/二进制导出（execd `downloadFile`）二期加 `sandbox_download_file`。

> 部署提醒：OpenClaw 集成预期统一使用 server 代理模式——`opensandbox-mcp` 需以 `--use-server-proxy` 启动（参数已补进 CLI，见附录 A.4），使 execd/文件流量经 lifecycle server 转发，客户端无需直连沙箱端口。

#### 4.5.2 OpenClaw Tool Plugin（`defineToolPlugin`）

`defineToolPlugin` **没有全局 instructions 机制**（仅 metadata/configSchema/tools），提示只能落在工具 description（模型可读）。落地即 `sandbox_kill` 的 description 字段：

```ts
tool({
  name: "sandbox_kill",
  label: "Kill Sandbox",
  description:
    "Terminates the sandbox and permanently destroys all data inside it. "
    + "Sandboxes are stateless: kill or TTL expiry destroys all data. "
    + "BEFORE calling this tool you MUST export any files or final artifacts "
    + "you need, e.g. read small files with sandbox_read_file, package "
    + "directories with sandbox_run_command (tar + base64), or download via "
    + "the endpoint from sandbox_get_endpoint. Once killed, the data is gone.",
  parameters: Type.Object({
    sandboxId: Type.String({ description: "Sandbox ID from sandbox_create/connect." }),
  }),
  outputSchema: Type.Object({
    sandboxId: Type.String(),
    state: Type.Literal("terminated"),
  }),
  async execute({ sandboxId }, config) {
    // 同 4.1：kill + 清插件缓存
  },
}),
```

同时 `sandbox_run_command` 的 description 追加一句："For artifact-producing commands, export the results before the sandbox is killed or expires."

#### 4.5.3 产物带出路径（两个载体通用）

| 场景 | 路径 |
|---|---|
| 文本/小文件 | `file_read` / `sandbox_read_file` 读取内容返回给 agent |
| 目录/多文件打包 | `command_run` / `sandbox_run_command` 生成 tar.gz 并 base64 输出，或拆小分片读取 |
| 对外服务/端口产物 | `sandbox_get_endpoint` 拿端点，OpenClaw 侧用 `web_fetch`/主机命令下载 |
| 大二进制文件 | 二期：`sandbox_download_file`/`sandbox_export_file`（execd `downloadFile` 已具备） |

配套说明：`sandbox_get_info` 返回 `expiresAt`，agent 可感知 TTL 临近；插件 LRU 逐出仅 `close()` 不 kill，无数据销毁风险。

## 5. 状态管理（client.ts）

`defineToolPlugin` 无生命周期钩子（onLoad/onUnload），采用**模块级惰性单例**：

- `getClient(config)`：按 `(domain, apiKey, protocol, useServerProxy)` 缓存 `ConnectionConfig`（复用 keep-alive 池），进程内单例。
- Sandbox 实例缓存：`Map<sandbox_id, Sandbox>` + LRU（上限 `sandboxCacheSize`），`sandbox_create/connect` 写入，`sandbox_kill` 与 LRU 逐出时 `close()` 释放 HTTP agent（**不 kill 沙箱**，避免误删远端资源）。
- 沙箱生命周期归 agent 显式管理（create → 使用 → kill），插件不做隐式回收；文档明确提示未 kill 的沙箱会按 `timeoutSeconds` 由服务端 TTL 回收。
- 无需 `process.on('exit')` 钩子：进程退出时依赖服务端 TTL，插件缓存仅影响本进程连接池。

## 6. 错误处理

- SDK 抛出的 `SandboxException`（含 `error.code`、`requestId`）统一转换为带错误码的可读 `Error` 抛出——OpenClaw 会将工具错误回传给模型，模型可自愈（如 `sandbox_create` 失败后换镜像重试）。
- 输出/文件读取按 `maxOutputBytes` 截断并返回 `truncated: true`，避免工具返回体撑爆上下文。
- `sandbox_run_command` 非零退出码不视为异常：正常返回 `{ exitCode, stdout, stderr }`，由 agent 判断。

## 7. 安全与权限

- 工具受 OpenClaw 全局 tool policy 管控（`agents.defaults.tools.allow/deny`），可针对 `sandbox_*` 粒度配置。
- OpenClaw sandbox mode 开启时，插件工具在沙箱内执行受 sandbox tool policy 双重管控——文档需说明此交互（与 MCP 工具一致）。
- API key 只经环境变量/SecretRefs 注入，日志不打印密钥；错误信息剥离 `Authorization` 头相关内容。

## 8. 测试

- 脚手架自带 `src/index.test.ts`（插件元数据契约测试：id/name/tools 清单与 `openclaw.plugin.json` 一致）。
- 单元测试：mock `@alibaba-group/opensandbox` 的 `Sandbox`/`SandboxManager`，覆盖每个工具的 schema 与错误映射。
- 集成测试（可选）：连本地 OpenSandbox server（`localhost:8080`），验证 create → run → read → kill 全链路，用环境变量控制开关。

## 9. 构建与分发

```bash
openclaw plugins init   # 脚手架
pnpm install
openclaw plugins build  # 生成 dist/ + openclaw.plugin.json
openclaw plugins install ./opensandbox-openclaw   # 本地安装验证
clawhub package publish ./opensandbox-openclaw    # ClawHub 发布
# 用户安装：openclaw plugins install clawhub:<org>/opensandbox-openclaw
```

配套文档（`docs/`）：OpenClaw 集成页面（安装、配置、工具清单、最小工作流、与 sandbox mode 的配合说明），与 `docs/sdks/mcp.md` 的 OpenClaw 配置示例相互引用。

## 10. 二期规划

1. **高级工具**：代码解释器（runCode）、隔离会话（isolation sessions）、Credential Vault、快照、egress 策略 patch——按用户需求逐个暴露，每个都是独立工具组。
2. **沙箱后端插件 POC**（分析文档方式 D）：调研 OpenClaw sandbox backend 接口（docker/ssh/openshell 实现），评估 OpenSandbox 作为后端让 OpenClaw 的 `sandbox.mode` 直接跑在托管沙箱上的可行性。
3. **明确不做的**：pause/resume（无状态沙箱不支持）。

## 11. 风险与待确认

| 风险 | 说明 | 对策 |
|---|---|---|
| OpenClaw 插件 API 演进 | `defineToolPlugin`/清单格式可能随版本变化 | 锁定支持的 OpenClaw 版本范围，发布前跑 `openclaw plugins build` 校验 |
| Node 版本兼容 | SDK 要求 Node >= 20 | 安装文档声明运行时要求，`engines` 字段声明 |
| 工具返回体大小 | 大输出/大文件会撑爆上下文 | `maxOutputBytes` 截断 + agent 引导用命令侧处理大文件 |
| `sandbox_id` 跟踪负担 | agent 需自管 id | 工具描述中强约束"先 create/connect 拿 id"，可考虑二期增加"最近 sandbox"默认值工具 |
| 与 MCP 能力重复 | 同一能力两条路径 | 文档区分定位：MCP 适合零代码快速接入，插件适合正式产品化 |
| MCP CLI 代理参数（已落地） | OpenClaw 集成预期代理模式，MCP server 若直连沙箱 endpoint（默认）在异机场景会失败 | 已给 `opensandbox-mcp` 增加 `--use-server-proxy`（透传 Python SDK `ConnectionConfig.use_server_proxy`），接入文档要求显式开启，见附录 A.4 |

## 12. 验收标准

- [ ] `openclaw plugins build` 通过，`openclaw.plugin.json` 契约（id、tools 清单、configSchema）正确
- [ ] 13 个一期工具在 OpenClaw 中可发现、可调用
- [ ] create → run → read → get_endpoint → kill 全链路在本地 server 跑通
- [ ] **代理模式下全链路验证**（`useServerProxy=true`）：创建沙箱 → 命令/文件/endpoint 均经 server 代理成功
- [ ] 单元测试覆盖所有工具 schema 与 `SandboxException` 错误映射
- [ ] 文档（安装/配置/工具清单、部署拓扑与 `useServerProxy` 说明）发布到 `docs/`

## 13. 附录 A：部署与网络拓扑（SDK/MCP ↔ 部署的 sandbox server）

本附录整理 OpenSandbox SDK/MCP 与**部署的 lifecycle server** 的完整关联机制，作为 `useServerProxy` 配置与部署决策的依据。代码依据：`sdks/sandbox/python/src/opensandbox/config/connection.py`、`server/opensandbox_server/api/lifecycle.py`、`server/opensandbox_server/api/proxy.py`、`server/opensandbox_server/services/docker/networking.py`、`docs/architecture/index.md` §3.4。

### A.1 控制面：连接 lifecycle server

| 要素 | 配置来源 | 默认值 |
|---|---|---|
| `domain` | MCP `--domain` / JS `ConnectionConfig.domain` / env `OPEN_SANDBOX_DOMAIN` | `localhost:8080` |
| `protocol` | `--protocol` / `protocol` | `http` |
| `api_key` | `--api-key` / `apiKey` / env `OPEN_SANDBOX_API_KEY` | 无（认证头 `OPEN-SANDBOX-API-KEY`） |

- `get_base_url()` = `{protocol}://{domain}/v1`；`domain` 若自带 scheme 则直接拼 `/v1`。
- 优先级：显式配置 > 环境变量 > 默认。
- MCP：CLI 参数 → `ConnectionConfig` → `register_tools(connection_config=...)`，所有工具共享同一配置。
- JS SDK：`new ConnectionConfig({domain, apiKey, ...})` → `Sandbox.create({connectionConfig, ...})`。

### A.2 数据面：沙箱内服务访问（execd 44772 / egress 18080 / 用户端口）

SDK 调 `GET /v1/sandboxes/{id}/endpoints/{port}?use_server_proxy=...` 拿 endpoint；**返回的 endpoint 字符串就是后续 execd/egress 请求的 base**（`_get_execd_url` = `{protocol}://{endpoint}{path}`）。两种模式：

| 模式 | server 返回的 endpoint | SDK 请求路径 | 前提 |
|---|---|---|---|
| **直连**（`use_server_proxy=false`，默认） | docker bridge：`{public_host}:{execd_host_port}/proxy/{port}`（docker host 上 ingress 暴露端口 + `/proxy/` 路由进沙箱）；docker host 网络：`{public_host}:{port}`；k8s：ingress gateway endpoint | `http://{public_host}:{port}/proxy/44772/api/v1/...` | **客户端进程网络能直达沙箱公开端口** |
| **server 代理**（`use_server_proxy=true`） | **`{base_url}/sandboxes/{id}/proxy/{port}`**（`api/lifecycle.py:582` 直接改写 endpoint） | `http://{domain}/v1/sandboxes/{id}/proxy/{port}/api/v1/...` | **客户端只需能访问 lifecycle server** |

### A.3 两种模式的完整链路

- **直连**：客户端 → 沙箱公开端点（ingress 暴露的 host:port）→ `/proxy/{port}` 路由进沙箱容器内指定端口。认证：ingress 侧使用 endpoint 附带的 egress auth header（`_attach_egress_auth_headers`）。
- **server 代理**：客户端 → lifecycle server 的 proxy 路由（`/v1/sandboxes/{id}/proxy/{port}/{full_path}`，支持 HTTP + WebSocket，`api/proxy.py`）→ server 用 `resolve_internal=True` 取容器内部地址（docker：server 本地 proxy host 或容器 IP；k8s：Pod IP）转发。认证复用 `OPEN-SANDBOX-API-KEY`；支持 secure-access 校验与 renew-on-access 集成。注意：代理模式下 multipart 上传要求 `Content-Length`（不能 chunked，`filesystem_adapter.py` 有对应分支）。

### A.4 部署拓扑决策（OpenClaw 集成预期：统一代理模式）

**结论：OpenClaw 集成场景（方式 A MCP / 方式 B 插件）预期统一使用 server 代理模式（`useServerProxy=true`）**——OpenClaw 网关（及 stdio MCP 进程）运行在用户机器，与部署的 sandbox server 异机，沙箱 execd 端口（docker host 随机映射）不对客户端开放；代理模式下客户端只需可达 lifecycle server 并复用同一认证，是唯一可靠路径。

| 场景 | `useServerProxy` | 说明 |
|---|---|---|
| **OpenClaw 集成（默认预期）** | `true`（默认） | MCP 以 `--use-server-proxy` 启动；插件 configSchema 默认 `true` |
| 本地开发：server + docker + 客户端同机 | `false`（显式关闭） | 直连沙箱 host 映射端口，延迟最低，调试用 |
| 同 VPC/内网且沙箱公开端口可达 | `false`（可选优化） | 直连省去 server 中转 |

- **MCP server**：`opensandbox-mcp` 已支持 `--use-server-proxy` 参数（argparse + 透传 Python SDK `ConnectionConfig.use_server_proxy`），默认关闭，但 OpenClaw 接入文档要求显式开启。
- **OpenClaw 插件**：`configSchema.useServerProxy` 直通 JS SDK 的 `ConnectionConfig`，默认 `true`，与预期一致、开箱即用。

### A.5 对 OpenClaw 集成的含义

- **方式 A（MCP）**：接入文档明确要求以 `--use-server-proxy` 启动（预期代理模式），OpenClaw `mcp.servers` 示例的 args 带上该参数。
- **方式 B（Tool Plugin）**：`useServerProxy` 默认 `true`（代理模式预期），本地开发可显式关闭；文档按 A.4 拓扑给出建议值。
- **方式 D（Sandbox Backend 二期）**：server 代理是 HTTP RPC 语义（HTTP/WS 转发），与 OpenClaw sandbox backend 的 SSH/容器执行语义存在适配成本，POC 时需一并验证。
