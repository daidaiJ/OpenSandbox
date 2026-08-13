# OpenClaw 插件对接自部署 OpenSandbox Server（代理模式）配置指南

> 日期：2026-08-12
> 前置设计：`wiki/opensandbox-openclaw-tool-plugin-design.md`（方式 B 插件，附录 A 部署拓扑）
> 前置分析：`wiki/opensandbox-openclaw-integration-analysis.md`
> 插件位置：`plugins/opensandbox-openclaw/`

## 1. 背景与适用场景

`opensandbox-openclaw` 是 OpenClaw 官方的 OpenSandbox 工具插件（13 个 `sandbox_*` 工具：生命周期 7 + 命令 2 + 文件 4）。本指南说明如何让它连接**自部署的 OpenSandbox lifecycle server**，并统一使用**代理模式**（`useServerProxy=true`，插件默认值）。

适用拓扑：

```
┌─────────────────────┐       HTTPS/HTTP        ┌──────────────────────────┐        ┌────────────────┐
│  OpenClaw 网关       │  ────────────────────▶  │  OpenSandbox Server（自部署）│  ────▶  │ 沙箱容器        │
│  （用户侧，任意位置）  │   仅需可达 lifecycle server │   :8090（proxy 路由）     │  内部解析  │  execd 44772    │
│  openclaw.json 配置  │       OPEN-SANDBOX-     │   /v1/sandboxes/{id}/proxy │          │  egress 18080   │
│  插件 domain/apiKey  │       API-KEY 认证       │   /{port}/...             │          │  用户端口        │
└─────────────────────┘                          └──────────────────────────┘        └────────────────┘
```

**为什么必须代理模式**：沙箱公开端口（docker bridge 随机映射）只对 server 所在主机可达；OpenClaw 网关与 server 通常异机。代理模式下插件只请求 lifecycle server，由 server 内部解析容器地址（`get_endpoint(..., resolve_internal=True)`）转发，客户端零直连要求。

## 2. 前置条件

| 项 | 要求 |
|---|---|
| OpenClaw | `>= 2026.5.17`（首个导出 `openclaw/plugin-sdk/tool-plugin` 的版本） |
| Node.js | 22.22.3+ / 24.15+ / 25.9+ |
| OpenSandbox server | 自部署、可从 OpenClaw 网关所在网络访问（HTTP(S) 端口放通） |
| API key（可选但推荐） | server 配置 `[server].api_key` 后启用认证；插件侧通过配置项 / 环境变量 / SecretRef 提供 |

## 3. 自部署 OpenSandbox Server

### 3.1 方式一：Docker Compose（推荐）

仓库提供参考编排：`server/docker-compose.example.yaml`。核心要点：

```yaml
services:
  opensandbox-server:
    image: opensandbox/server:latest
    ports:
      - "8090:8090"                 # 对外只暴露这一个端口即可（代理模式）
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    configs:
      - source: opensandbox-config
        target: /etc/opensandbox/config.toml
    environment:
      - SANDBOX_CONFIG_PATH=/etc/opensandbox/config.toml
```

config.toml 关键项：

```toml
[server]
host = "0.0.0.0"
port = 8090
api_key = "your-secret-api-key"     # 建议设置；留空时非交互启动需 OPENSANDBOX_INSECURE_SERVER=YES

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.21"

[docker]
network_mode = "bridge"
host_ip = "host.docker.internal"    # server 容器化时必须设置，否则 bridge 端点解析错误
port_range_min = 40000
port_range_max = 60000

[ingress]
mode = "direct"
```

> **注意**：代理模式下对外只需放通 server 端口（如 8090）；沙箱 host 端口范围（40000-60000）无需对客户端开放，仅 server 本地使用。

### 3.2 方式二：源码运行

```bash
cd server
uv sync --all-groups
cp opensandbox_server/examples/example.config.toml ~/.sandbox.toml
# 编辑 ~/.sandbox.toml：设置 [server] api_key、host/port
uv run python -m opensandbox_server.main
```

### 3.3 验证 server 可用

`/health` 端点免认证，可先探活：

```bash
curl http://<server-host>:8090/health
# 期望: {"status":"ok"}（或类似健康响应）
```

带认证的 API 可验证密钥（如 `GET /v1/sandboxes`）：

```bash
curl -H "OPEN-SANDBOX-API-KEY: your-secret-api-key" http://<server-host>:8090/v1/sandboxes?page_size=1
```

## 4. 安装插件

插件构建产物**自包含**（全部运行时依赖已打入 `dist/`，`package.json` 无运行时 dependencies），安装是纯目录拷贝，**无需联网、无需 npm install**：

```bash
# 本地路径安装（构建后）
openclaw plugins install ./plugins/opensandbox-openclaw

# 或发布后从 ClawHub 安装
openclaw plugins install clawhub:<org>/opensandbox-openclaw

# 验证
openclaw plugins inspect opensandbox-openclaw --runtime
```

安装后重启或 reload OpenClaw 网关。

## 5. 配置插件连接自部署 Server

在 `openclaw.json`（JSON5）的 `plugins.entries` 段配置：

```json5
{
  plugins: {
    entries: {
      "opensandbox-openclaw": {
        enabled: true,
        config: {
          domain: "sandbox.example.com:8090",   // 自部署 server 的 host[:port]，不含 scheme
          protocol: "https",                    // 按实际部署 http/https
          apiKey: "your-secret-api-key",        // 与 server [server].api_key 一致
          useServerProxy: true,                 // 代理模式（默认 true，保持开启）
          requestTimeoutSeconds: 30,
          defaultImage: "ubuntu",
          maxOutputBytes: 65536,
          sandboxCacheSize: 8,
        },
      },
    },
  },
}
```

### 配置项说明

| 配置项 | 默认 | 代理模式下的要求 |
|---|---|---|
| `domain` | `localhost:8080` | 必须改为自部署 server 地址（`host[:port]`；也可传完整 URL，SDK 自动归一化） |
| `protocol` | `http` | 自部署如有 TLS 用 `https` |
| `apiKey` | 环境变量 `OPEN_SANDBOX_API_KEY` | server 开启认证时必须提供；优先级：配置项 > 环境变量 |
| `useServerProxy` | `true` | **保持 `true`**（本指南场景）；仅本地开发同机时才可关闭 |
| `requestTimeoutSeconds` | `30` | 代理链路多一跳，网络差可调大 |
| `defaultImage` / `maxOutputBytes` / `sandboxCacheSize` | 见插件 README | 与代理模式无关 |

> **密钥注入**：`apiKey` 也可通过 OpenClaw 的 SecretRef 机制或进程环境变量 `OPEN_SANDBOX_API_KEY` 提供，避免明文写入 `openclaw.json`。

### 可选：工具权限收敛

`sandbox_*` 工具受 OpenClaw 全局 tool policy 管控，可按需放行/禁用：

```json5
{
  agents: {
    defaults: {
      tools: {
        allow: ["sandbox_create", "sandbox_connect", "sandbox_run_command",
                "sandbox_read_file", "sandbox_write_file", "sandbox_kill",
                "sandbox_get_info", "sandbox_list", "sandbox_renew",
                "sandbox_get_endpoint", "sandbox_interrupt_command",
                "sandbox_list_files", "sandbox_delete_files"],
        // deny: ["sandbox_delete_files"],
      },
    },
  },
}
```

## 6. 代理模式流量链路（对照直连）

| 环节 | 直连（`useServerProxy=false`） | **代理（`useServerProxy=true`，本指南）** |
|---|---|---|
| endpoint 形态 | 沙箱公开端点 `{public_host}:{port}/proxy/{port}` 等 | `{base_url}/v1/sandboxes/{id}/proxy/{port}`（`api/lifecycle.py` 直接改写返回） |
| execd 请求（44772） | 客户端直连沙箱 host 端口 | `http://{domain}/v1/sandboxes/{id}/proxy/44772/api/v1/...` |
| egress（18080）/ 用户端口 | 同上 | 同上模式 |
| 认证 | 沙箱端点 egress auth header | 复用 `OPEN-SANDBOX-API-KEY`（server 全局认证） |
| 客户端网络要求 | 需直达沙箱公开端口 | **只需可达 lifecycle server** |
| WebSocket | 直连 | 代理支持（`proxy.py` 有 websocket 路由） |

实现参考：`server/opensandbox_server/api/proxy.py`（HTTP + WebSocket 转发，`resolve_internal=True` 取容器内部地址）、`api/lifecycle.py:582`（`use_server_proxy` 改写 endpoint）、`sdks/sandbox/javascript/src/config/connection.ts`（SDK 侧 `ConnectionConfig.useServerProxy`）。

## 7. 验证清单（代理模式全链路）

装好并配置后，在 OpenClaw 里依次让 agent 执行：

1. `sandbox_create`（image 自选）→ 记下 `sandboxId` 与 `expiresAt`
2. `sandbox_write_file`（如 `/tmp/hello.txt`）
3. `sandbox_read_file`（读回内容）
4. `sandbox_run_command`（如 `cat /tmp/hello.txt && python3 --version`）
5. `sandbox_get_endpoint`（如 port 8080，验证返回 `…/v1/sandboxes/{id}/proxy/8080` 形态）
6. `sandbox_get_info`（确认 `expiresAt`，必要时 `sandbox_renew`）
7. `sandbox_kill`

任一步报错见第 8 节。

## 8. 常见问题排障

| 现象 | 原因与处理 |
|---|---|
| 工具报 `401` / `OpenSandbox SandboxApiException [UNEXPECTED_RESPONSE] (status=401)` | API key 不匹配。核对 `openclaw.json` 的 `apiKey` 与 server `[server].api_key`；确认未同时启用不同 key 的环境变量 |
| 报 `404` sandbox not found | `sandbox_id` 过期（TTL 已销毁）或写错；用 `sandbox_list` 确认现存沙箱 |
| `sandbox_create` 后健康检查超时（`SandboxReadyTimeoutException`） | 多为镜像拉取慢或 server 无法解析 execd 端点。确认 `docker.host_ip` 已设置（容器化 server）；`requestTimeoutSeconds` 可调大 |
| endpoint 形如直连地址（`useServerProxy` 未生效） | 检查插件配置确实命中 `plugins.entries["opensandbox-openclaw"].config.useServerProxy=true`（默认开启，无需显式写） |
| 大文件写入报错 | 代理模式下 multipart 上传要求 `Content-Length`（不能 chunked），SDK 已按此分支处理；自写 HTTP 客户端时注意 |
| 沙箱起不来 / 端口耗尽 | server 侧 `docker.port_range_min/max` 范围太窄；每个沙箱需 2–3 个 host 端口 |
| 想本地调试（server 与 OpenClaw 同机） | 可将 `useServerProxy` 临时设为 `false` 直连，延迟更低；排查完改回 |

## 9. 参考

- 插件 README：`plugins/opensandbox-openclaw/README.md`
- 设计文档：`wiki/opensandbox-openclaw-tool-plugin-design.md`（§3 配置、§4 工具集、附录 A 部署拓扑）
- 接入分析：`wiki/opensandbox-openclaw-integration-analysis.md`
- server 部署：`server/docker-compose.example.yaml`、`server/opensandbox_server/examples/example.config.toml`
- 代理实现：`server/opensandbox_server/api/proxy.py`、`server/opensandbox_server/api/lifecycle.py`
