# OpenSandbox × OpenClaw 工具插件

[OpenClaw](https://docs.openclaw.ai) 工具插件，将 OpenSandbox 沙箱封装为 Agent 原生工具：生命周期管理、Shell 命令执行与文件操作。基于官方 `@alibaba-group/opensandbox` JS SDK 构建。

## 环境要求

- Node.js 22.22.3+ / 24.15+ / 25.9+
- OpenClaw `>=2026.5.17`（首个导出 `openclaw/plugin-sdk/tool-plugin` 的版本）

## 安装

```bash
openclaw plugins install ./plugins/opensandbox-openclaw
# 或从 tarball / ClawHub 安装（发布后可用）
openclaw plugins install clawhub:<org>/opensandbox-openclaw
```

安装完成后重启或重新加载 OpenClaw gateway，然后验证：

```bash
openclaw plugins inspect opensandbox-openclaw --runtime
```

### 离线 / 自包含安装

构建产物是**自包含**的：所有运行时依赖（`@alibaba-group/opensandbox`、`typebox`、`undici`）都已打包进 `dist/`，`package.json` 中**不声明任何运行时 `dependencies`**。因此 `openclaw plugins install` 会完全跳过 `npm install`（仅在插件声明依赖时才会执行），安装过程就是纯目录拷贝——消费端无需联网。唯一的运行时要求是宿主 `openclaw` 包本身（peer dependency），由 gateway 直接提供。

验证方式：`npm run check:bundle` 断言 `dist/` 只引用了 `openclaw` peer 与 Node.js 核心内置模块。

#### 离线安装（纯配置，无需 `openclaw plugins install`）

离线安装**只需要做两件事**：把插件目录拷到运行 OpenClaw 的机器上，然后在 `openclaw.json` 里写好配置。整个过程不需要联网、不需要 `npm install`、也不需要执行 `openclaw plugins install` 命令——因为构建产物自包含，`openclaw.json` 的 `plugins.load.paths` 直接指向插件目录即可加载。

**第 1 步：准备插件目录（只需发布产物）**

从 GitHub 下载仓库后拷贝 `plugins/opensandbox-openclaw/` 目录，或 `npm pack` 后解压 tarball。**不要**带 `node_modules/`、`src/` 等开发文件，必需文件只有：

```
opensandbox-openclaw/
├── package.json           # 声明 openclaw.extensions → ./dist/index.js（入口）
├── openclaw.plugin.json   # 插件 manifest（id / configSchema / contracts）
└── dist/                  # 自包含构建产物（唯一运行时代码）
    ├── index.js
    ├── chunk-*.js
    └── undici-*.js
```

**第 2 步：放到 OpenClaw 同一环境**

拷到 gateway 所在机器，路径任意（支持 `~`），建议与 `openclaw plugins install` 的默认目录一致：

```bash
cp -r plugins/opensandbox-openclaw ~/.openclaw/extensions/opensandbox-openclaw
```

**第 3 步：在 `openclaw.json` 中配置（核心）**

在现有 `openclaw.json` 里加两段：`plugins.load.paths` 指定插件位置，`plugins.entries` 按插件 id 启用并传入参数：

```json5
{
  plugins: {
    load: {
      paths: ["~/.openclaw/extensions/opensandbox-openclaw"]  // 指向插件目录本身
      // 也可指向父目录，自动扫描其下所有插件子目录：
      // paths: ["~/.openclaw/extensions"]
    },
    entries: {
      "opensandbox-openclaw": {
        enabled: true,
        config: {
          domain: "sandbox.example.com:8090", // 自部署 lifecycle server 的 host[:port]
          protocol: "https",                  // 按实际部署 http/https
          apiKey: "your-secret-api-key",      // 与 server [server].api_key 一致；或用环境变量 OPEN_SANDBOX_API_KEY
          useServerProxy: true,               // 代理模式（默认 true，保持开启）
          requestTimeoutSeconds: 30,
          defaultImage: "ubuntu",
          maxOutputBytes: 65536,
          sandboxCacheSize: 8
        }
      }
    }
  }
}
```

**第 4 步：重启 / reload 并验证**

```bash
openclaw plugins inspect opensandbox-openclaw --runtime
```

看到 13 个 `sandbox_*` 工具注册即安装成功。完整对接自部署 server 的配置示例、流量链路与排障见 [wiki/opensandbox-openclaw-plugin-selfdeployed-server.md](../../wiki/opensandbox-openclaw-plugin-selfdeployed-server.md)。

## 配置

在 `openclaw.json` 的插件配置段中配置本插件（插件 id：`opensandbox-openclaw`）：

| Key | 默认值 | 说明 |
|---|---|---|
| `domain` | `localhost:8080` | OpenSandbox 生命周期服务器域名（`host[:port]`），例如 `api.opensandbox.io` |
| `protocol` | `http` | `http` 或 `https` |
| `apiKey` | 环境变量 `OPEN_SANDBOX_API_KEY` | 优先使用环境变量或 SecretRef，避免硬编码 |
| `requestTimeoutSeconds` | `30` | SDK HTTP 请求超时时间（秒） |
| `useServerProxy` | `true` | 是否通过生命周期服务器代理转发 execd/文件/端点流量 |
| `defaultImage` | `ubuntu` | `sandbox_create` 未指定镜像时使用的镜像 |
| `maxOutputBytes` | `65536` | 返回给 Agent 的命令输出 / 文件内容上限（超出截断） |
| `sandboxCacheSize` | `8` | 进程内 Sandbox 实例 LRU 缓存上限 |

**`useServerProxy` 很关键。** 在预期的部署形态下（OpenClaw gateway 与沙箱服务器位于不同主机），沙箱的公网端点从插件进程无法直接访问——请保持 `true`，让所有流量都经由生命周期服务器转发。仅当沙箱端点对插件进程可直接访问时（例如本地开发）才设为 `false`。

> 详细对接指南：如何部署自建 OpenSandbox Server 并以代理模式（`useServerProxy=true`）接入，见 [wiki/opensandbox-openclaw-plugin-selfdeployed-server.md](../../wiki/opensandbox-openclaw-plugin-selfdeployed-server.md)（含 `openclaw.json` 完整配置示例、流量链路与排障）。

## 工具

所有工具均使用 `sandbox_` 前缀，且需要传入由 `sandbox_create` / `sandbox_connect` 返回的显式 `sandbox_id`。

### 生命周期

| 工具 | 说明 |
|---|---|
| `sandbox_create` | 创建沙箱（`image`、`timeoutSeconds`、`env`、`metadata`、`resource`、`networkPolicy`、`entrypoint`）→ `{ sandboxId, state, createdAt, expiresAt }` |
| `sandbox_connect` | 按 ID 连接已存在的沙箱（重启后恢复会话） |
| `sandbox_list` | 按状态 / 元数据筛选并分页列出沙箱 |
| `sandbox_get_info` | 状态、元数据、`expiresAt`（TTL 感知） |
| `sandbox_renew` | 延长沙箱生命周期：自当前时刻起 `timeoutSeconds` |
| `sandbox_kill` | 终止沙箱（销毁全部数据——见下方警告） |
| `sandbox_get_endpoint` | 获取沙箱端口的绝对 URL（默认经由服务器代理） |

### 命令执行

| 工具 | 说明 |
|---|---|
| `sandbox_run_command` | 前台执行命令 → `{ executionId, exitCode, stdout, stderr, executionTimeMs, truncated }` |
| `sandbox_interrupt_command` | 按 `executionId` 中断正在运行的命令 |

### 文件

| 工具 | 说明 |
|---|---|
| `sandbox_read_file` | 读取文本文件（支持编码 / 区间读取） |
| `sandbox_write_file` | 写入文本内容 |
| `sandbox_list_files` | 列出目录内容（支持递归 `depth`） |
| `sandbox_delete_files` | 删除文件 / 目录（删除目录必须传 `recursive`） |

## 无状态沙箱警告

OpenSandbox 沙箱是**无状态的**：`sandbox_kill` 或服务器端 TTL 过期会销毁沙箱内的一切数据。`sandbox_kill` 的工具描述会指示 Agent 先导出文件 / 产物（通过 `sandbox_read_file` 读取、`sandbox_run_command` 打包，或 `sandbox_get_endpoint` 下载）。未主动 kill 的沙箱会由服务器 TTL 回收。

## 开发

```bash
npm install
npm run plugin:build      # tsup 打包 + openclaw plugins build --entry ./dist/index.js
npm run check:bundle      # 断言 dist/ 自包含（无外部 npm 依赖）
npm run plugin:validate   # 针对构建产物校验 manifest
npm test                  # vitest 元数据契约测试
npm run typecheck
```

工具按 `src/tools/` 分组（`lifecycle.ts`、`command.ts`、`files.ts`）；每个工具导出 TypeBox 参数 schema 与签名 `(client, config, params, signal)` 的执行器，在 `src/index.ts` 中组装。`tsup.config.ts` 将全部运行时依赖打包进 `dist/`（仅 `openclaw` 保持 external）。

## License

Apache-2.0
