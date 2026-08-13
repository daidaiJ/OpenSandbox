# OpenSandbox 接入 OpenClaw 方式分析

> 日期：2026-08-12
> 范围：分析 OpenSandbox（沙箱平台）与 OpenClaw（多渠道 AI 代理网关）的集成方式，并给出推荐方案。

## 1. 背景

OpenClaw 是自托管的开源 AI 代理网关（MIT，TypeScript/Node.js），把 Discord/Telegram/Slack/飞书等聊天渠道接到 AI agent，支持 skills、插件（ClawHub）、MCP、多 agent 路由、沙箱执行等能力。

OpenSandbox 是通用沙箱平台：沙箱生命周期 API + execd（命令/文件/代码解释器/隔离会话）+ egress 策略 + Credential Vault + gVisor/Kata 安全运行时，提供 5 语言 SDK、MCP server、`osb` CLI。

集成目标：让 OpenClaw 生态（网关 + agent）能使用 OpenSandbox 作为沙箱执行环境，双方能力互补：

- OpenClaw 缺：托管式、多租户、安全的远程沙箱执行面（本地 docker/ssh 为主）
- OpenSandbox 缺：agent 编排、渠道接入、生态触达

## 2. OpenClaw 侧关键事实（2026-08 文档调研）

### 2.1 工具扩展三条路径

| 路径 | 机制 | 能力边界 |
|---|---|---|
| **Skill** | `SKILL.md` 指令包，注入 agent 提示词 | 仅工作流/约束，不能新增可执行能力 |
| **Tool Plugin** | `defineToolPlugin`（TypeScript，`openclaw/plugin-sdk/tool-plugin`），TypeBox 定义参数，`openclaw plugins build` 生成 `openclaw.plugin.json` 清单自动发现，ClawHub/npm 分发 | 任意运行时能力，类型安全，可打包分发，有状态 |
| **MCP server 消费** | `openclaw.json` 的 `mcp.servers`，支持 stdio（command/args）与 HTTP（sse、streamable-http，可配 oauth、timeout） | 外部 MCP server 工具全集，配置驱动、零代码 |

另：OpenClaw 自身也可作为 MCP server（`openclaw mcp serve`）对外暴露频道对话工具。

### 2.2 OpenClaw 自带沙箱机制

- 模式：`off`（默认）/ `non-main` / `all`（`agents.defaults.sandbox.mode`）
- 作用域：`agent` / `session` / `shared`（控制容器创建数量）
- 后端：`docker`（默认）/ `podman` / `ssh` / `openshell`（OpenClaw 官方远程沙箱服务，remote/mirror 模式）
- **自定义后端可通过插件实现**（生命周期：创建/获取/删除 + 文件系统桥）
- 工具在沙箱内执行受双重管控：全局 tool policy 且 sandbox tool policy；`tools.elevated` 可绕过沙箱在主机执行

### 2.3 部署形态

OpenClaw 网关对运行环境要求简单（可 SSH 的 Linux + Node.js），可部署在任意远程沙箱（Daytona 等）中。

## 3. OpenSandbox 侧集成面

| 方式 | 位置 | 说明 |
|---|---|---|
| MCP server | `sdks/mcp/sandbox/python`（`opensandbox-mcp`） | 19 个工具：生命周期 9 + 命令 2 + 文本文件 8；stdio + streamable-http；`--api-key/--domain/--protocol` 或环境变量配置；**不含**代码解释器、隔离会话、Credential Vault、快照 |
| TS SDK | `sdks/sandbox/javascript`（`@alibaba-group/opensandbox`） | 全能力：Sandbox/SandboxManager/ConnectionConfig、命令流式执行回调、文件、endpoint、egress 策略、Credential Vault、隔离会话、pause/resume；ESM+CJS |
| REST API | `specs/`（sandbox-lifecycle.yml + execd-api.yaml 48 ops + egress + diagnostic） | 契约源头 |
| CLI | `cli/`（`osb`） | sandbox/command/file/egress/devops/skills |

统一连接配置：`OPEN_SANDBOX_API_KEY` + `OPEN_SANDBOX_DOMAIN`（默认 localhost:8080）；base URL = `{protocol}://{domain}/v1`。沙箱内服务（execd/egress）经 `GET /v1/sandboxes/{id}/endpoints/{port}` 解析：**OpenClaw 集成预期统一使用 server 代理模式**（`use_server_proxy=true`，走 `{base_url}/sandboxes/{id}/proxy/{port}`，客户端仅需可达 server；直连模式需沙箱公开端点对客户端可达）——完整机制见设计文档附录 A。

## 4. 接入方式对比

### 方式 A：MCP 接入（零代码，最快验证）

OpenClaw `openclaw.json` 中配置 `mcp.servers` 指向 `opensandbox-mcp`：

```json5
{
  mcp: {
    servers: {
      "opensandbox-sandbox": {
        command: "opensandbox-mcp",
        args: ["--api-key", "xxx", "--domain", "api.example.com"],
      },
    },
  },
}
```

或 HTTP 模式（`url` + `transport: "streamable-http"`）。

- ✅ 零开发：OpenSandbox 现成 MCP server，OpenClaw 原生支持消费，分钟级接入
- ✅ 覆盖核心场景：建沙箱 → 写文件 → 跑命令 → 取端口 → kill
- ❌ 工具面受限：无代码解释器、隔离会话、Credential Vault、快照
- ❌ 工具平铺：19 个工具直接进 agent 工具目录，sandbox_id 由 agent 自行跟踪，无状态管理/复用
- ❌ 与 OpenClaw 沙箱策略叠加时需额外配置（MCP 工具在 sandbox 内也受 sandbox tool policy 管控）
- ❌ 前置要求：预期代理模式，需以 `--use-server-proxy` 启动 MCP（参数已补进 CLI，见设计文档附录 A.4）
- 适用：POC、快速验证产品契合度、轻量用户

### 方式 B：Tool Plugin（TS 插件封装 SDK）⭐ 推荐主方案

用 `defineToolPlugin` 写一个官方插件，`tools` 内注册 sandbox 工具，`execute` 调 `@alibaba-group/opensandbox`：

- ✅ 全能力覆盖：流式命令输出、代码解释器、隔离会话、Credential Vault、快照、pause/resume 都可按需暴露
- ✅ 类型安全：TypeBox 参数/输出 schema，configSchema 管理 apiKey/domain（支持 SecretRefs 语义）
- ✅ 代理模式默认开启：configSchema `useServerProxy` 默认 `true`，与 OpenClaw 远端接入预期一致，开箱即用
- ✅ 可做状态管理：插件内部维护连接池/Sandbox 实例复用，agent 无需自管 sandbox_id
- ✅ 生态契合：ClawHub 分发，`openclaw plugins install clawhub:...` 一行安装；可挂 OpenSandbox 品牌与文档
- ✅ 与 OpenClaw 权限模型协同：受 tool policy 管控，行为可审计
- ❌ 需要开发维护 TS 插件（复用现成 JS SDK，工作量可控）
- 适用：正式产品化接入，OpenClaw 用户的首选安装路径

### 方式 C：Skill（SKILL.md + osb CLI/curl）

- ✅ 零代码、纯 markdown，可快速分发
- ❌ 仅是提示词：依赖 agent 的 exec/shell 工具，无结构化工具/参数校验，需在 OpenClaw 运行环境装 `osb` CLI，体验与可靠性差
- 适用：作为 B 的补充教程（教 agent 如何用 CLI），不作为主方案

### 方式 D：Sandbox Backend 插件（深度集成，战略方向）

实现 OpenClaw 沙箱后端接口（类比 docker/ssh/openshell），使 OpenClaw 的 `sandbox.mode` 开启后，agent 的 exec/terminal/文件工具直接运行在 OpenSandbox 沙箱内：

- ✅ 战略价值最高：OpenClaw 整个执行面迁移到 OpenSandbox，深度绑定
- ✅ 能力对齐：多租户、gVisor/Kata 安全运行时、egress 策略、Credential Vault、快照、pause/resume 全派上用场
- ✅ 差异化：对比 OpenShell（官方远程沙箱），OpenSandbox 提供的是企业级托管沙箱平台
- ❌ 工作量最大：需研究 OpenClaw 沙箱后端接口契约（生命周期 + 文件系统桥 + 执行语义），OpenSandbox execd 是 HTTP RPC 语义，与 OpenClaw 的 SSH/容器语义需适配层
- ❌ 依赖 OpenClaw 后端接口抽象能力上限，有被上游演进约束的风险
- 适用：中期战略方向，需先做最小 POC 验证接口可行性

## 5. 推荐结论

**分阶段路线，当前推荐 B（Tool Plugin）为主 + A（MCP）为验证入口：**

| 阶段 | 动作 | 目的 |
|---|---|---|
| 1（立即可做） | MCP 接入：文档补充 OpenClaw 的 `mcp.servers` 配置示例 | 零成本验证契合度，收集真实使用反馈 |
| 2（主方案） | 开发官方 Tool Plugin（`opensandbox-openclaw`），封装 JS SDK，发布 ClawHub | 正式产品化：全能力、类型安全、状态管理、品牌化分发 |
| 3（战略，评估后） | POC 调研 OpenClaw 沙箱后端接口，评估 Sandbox Backend 插件可行性 | 若可行，把 OpenClaw 执行面整体搬到 OpenSandbox，形成差异化绑定 |

## 6. 待验证点 / 风险

1. **OpenClaw 沙箱后端接口契约**：需读 OpenClaw 源码（`plugins` 目录中 sandbox backend 相关实现）确认接口形态，决定方式 D 工作量与可行性
2. **MCP server 的 env/认证传递**：OpenClaw `mcp.servers` stdio 模式是否支持 env 注入（文档示例未显式给出），若不支持需用 args 或全局环境变量
3. **MCP 工具缺口**：若用户明确需要代码解释器/隔离会话/Credential Vault，MCP 方式 A 不满足，应直接走方式 B
4. **插件版本耦合**：`@alibaba-group/opensandbox` JS SDK 与 OpenClaw Node 运行时版本兼容性（Node >= 20）
5. **双向场景**：若反向需求（OpenClaw 网关跑在 OpenSandbox 沙箱内）出现，可参考 Daytona 部署模式，另行评估
6. **MCP 代理模式参数**：`--use-server-proxy` 已补进 `opensandbox-mcp` CLI（透传 Python SDK `ConnectionConfig.use_server_proxy`）；OpenClaw 接入文档需明确要求开启，并验证代理模式下 execd/文件/endpoint 全链路（见设计文档附录 A.4）
