# Cloudflare / Rivet 近期沙箱项目梳理（含 S3 成本与访问优化）

> 调研时间：2026-11-14。范围：`github.com/rivet-dev` 与 `github.com/cloudflare` 近两周有推送的仓库，以及 Cloudflare 官方文档和 Changelog。星标、推送时间取自 GitHub API 当日快照；厂商自测的性能与成本数字均标注来源，只作方向参考。

## 1. 结论

- **Cloudflare 的沙箱栈已经成形**：Containers 提供每个实例独立内核和网络的 microVM，Dynamic Workers 提供 JS/Python/WASM isolate，Durable Object 负责生命周期与状态。2026-09-30 的 Sandbox SDK 1.0 把镜像、规格、网络、生命周期和快照的控制权交给用户自己的 DO；近期仓库重心明显上移到 coding agent、CI、浏览器和工作区。
- **Rivet 走两条线**：一条用 Rivet Actors / agentOS 替代“每个 agent 一个重型沙箱”；另一条用 OpenOrange 把 Cloudflare Workers/DO 原样跑在自有机器上，状态放 S3。两条线共用同一套 S3 分层存储。
- **S3 优化是两种范式**：Cloudflare 侧重“凭证不进沙箱、单对象语义、容器快照分层、按需水合”；Rivet 侧重“SSD 热层 + 后台批量写 S3 + 读缓存回退”，并用 celld 对照证明朴素的频繁上传在规模化后请求成本会失控。

## 2. Rivet（rivet-dev）

### 2.1 项目清单

| 仓库 | 最近动态（2026-11） | 定位 | 与沙箱 / S3 的关系 |
|---|---|---|---|
| [agentos](https://github.com/rivet-dev/agentos) | v0.4.8（11-12），4.9k★ | WASM + V8 的 Linux 兼容轻量 VM | 用进程内 VM 替代 microVM 的沙箱路线；SQLite 持久化、外部沙箱挂载 |
| [rivet](https://github.com/rivet-dev/rivet) | v3.1.1 / v3.1.2-rc.1（11-11/12），6.9k★ | Actor 编排器 | 托管 agentOS、OpenOrange 的控制面；SQLite 状态最终落 S3 |
| [open-orange](https://github.com/rivet-dev/open-orange) | 11-12 创建、11-13 推送，440★ | 把 Workers/DO 原样跑在 AWS、GCP、Azure 或自有机器 | 状态放 S3；R2 binding 可落到自有 S3 兼容存储 |
| [celld-vs-openorange-bench](https://github.com/rivet-dev/celld-vs-openorange-bench) | 11-14 推送 | S3 请求成本 benchmark | 8～25k 并发 agent 的请求成本对照，见 4.2 |
| [agents](https://github.com/rivet-dev/agents) | 11-12，1.6k★ | 沙箱内跑 coding agent 的 HTTP/SSE 服务 | Sandbox Agent 统一 Claude Code、Codex、OpenCode、Cursor、Amp、Pi |
| [flue](https://github.com/rivet-dev/flue) | 7 月创建，仍活跃，4★ | Agent harness 框架 | `local()` / Daytona / agentOS 等沙箱适配 |
| [dynamic-apps](https://github.com/rivet-dev/dynamic-apps) | 11-08，1.0k★ | 用户生成后端跑在沙箱化部署 VM | 仅支持 Rivet 2.x；缓存命中走本地 V8 |
| [bench-rivet-actors-vs-durable-objects](https://github.com/rivet-dev/bench-rivet-actors-vs-durable-objects) | 11-05 | Actor 与 Durable Objects 的对照 benchmark | 冷启动、持久写、读延迟的原始数据 |
| [latency-numbers-every-programmer-should-know](https://github.com/rivet-dev/latency-numbers-every-programmer-should-know) | 4 月，低活跃 | Lambda 视角的沙箱 provider 延迟 benchmark | 冷启动 / exec / health 的测量方法参考 |
| [linux-package-manager-bench](https://github.com/rivet-dev/linux-package-manager-bench) | 7 月 | 各包管理器安装 git 的耗时 | 镜像构建与冷启动优化参考 |
| [secure-exec-curl](https://github.com/rivet-dev/secure-exec-curl) | 3 月 | 带 WASI 补丁的 libcurl | agentOS WasmVM 的支撑件 |
| [durable-object-migrator](https://github.com/rivet-dev/durable-object-migrator) | 11-12，45★ | 把 DO SQLite 数据迁到 Postgres、文件系统或 Rivet Actors | 降低 Cloudflare 锁定 |

仓库里还有 `daytona`、`e2b-cookbook`、`wasmer`、`deno` 等 fork，属于研究或 vendored 依赖，不是 Rivet 自家产品。

### 2.2 agentOS：用 WASM 做“进程内沙箱”

agentOS 是 Rivet 当前最激进的路线，README 的定位是“Tiny, fast, Linux-compatible sandboxes”，技术上是 WebAssembly + V8 isolate，而不是 microVM。

- **运行形态**：`@rivet-dev/agentos-core` 跑在可信的 Node.js 进程里；可信侧的原生 sidecar 持有 kernel、VFS、进程/套接字表、权限、资源策略、软件包获取和语言执行器；不可信的 JS、Python、WASM 和第三方包跑在 guest 侧。
- **能力**：POSIX 文件、进程、网络，shell，宿主函数（host functions）直接调用后端；可以把外部沙箱文件系统挂到 `/mnt/sandbox`，guest 像读写本地文件一样读写。
- **持久化**：默认根文件系统是内存 overlay，VM 重建即丢；把根放进 SQLite（`chunked_sqlite`）后，用相同配置新建的 VM 能看到同一份文件。进程、终端、语言上下文和流不持久。
- **厂商自测**：冷启动 p50 4.8 ms、p95 5.6 ms、p99 6.1 ms；shell 工作负载内存约 22 MB；对比“sandbox baseline”的 92× / 47× / 254×。这些是 README 数字，适合作为量级参考，不宜直接当生产结论。
- **边界**：浏览器、桌面自动化、重型编译、dev server、GUI/VNC 仍然需要真实 Linux 内核，agentOS 的官方建议是与外部沙箱组合使用。

对 OpenSandbox 的意义：如果业务里存在大量“短任务、只跑脚本/CLI/文件操作”的 agent，agentOS 这类进程内 VM 是 microVM 之外的另一种密度选择；但它不覆盖需要真实内核的负载，不能替代池化沙箱主路径。

### 2.3 Rivet Actors + OpenOrange：把状态放到 S3

Rivet 的核心叙事是“每个 agent 一个轻量 actor，而不是一个重型沙箱”：

- Actor 有长生命周期进程、内存状态、WebSocket、SQLite 持久存储，空闲可休眠。
- Rivet 官方 benchmark（2026-11-05，Rivet 3.0.3）给出冷启动 p50 4.30 ms / p99 4.99 ms，单 actor 常驻内存约 72.4 KB；对照组 E2B 的数字来自第三方 benchmark，不是同机实测。
- 存储架构是两层：写入先由 2/3 可用区的 SSD 确认，然后在后台批量上传 S3；读优先命中 SSD 缓存，未命中再回 S3。S3 不在写路径上。官方给出的 p99 是持久写 1.07 ms、休眠后点读 1.36 ms、对象存储读 138 ms；长期存储成本约为三副本 EBS gp3 的 1/10.4。
- OpenOrange 把这套能力包装成“Cloudflare Workers/DO 兼容运行时”：代码打成标准 Docker 镜像，DO 映射为 Rivet Actor，状态放 S3；`orange dev` / `orange deploy` 对应 `wrangler` 的工作流。它同时提供从 Cloudflare 迁出的数据通道，属于典型的“反锁定”产品。

这条线对 OpenSandbox 的直接价值不在运行时，而在**存储分层**：把 S3 从热路径挪走，用节点本地 SSD/内存承接写入，再异步、批量、压缩地落对象存储。

## 3. Cloudflare

### 3.1 项目清单

| 仓库 / 产品 | 最近动态（2026-11） | 定位 | 与沙箱的关系 |
|---|---|---|---|
| [sandbox-sdk](https://github.com/cloudflare/sandbox-sdk) | `@cloudflare/sandbox@1.0.3`（10-22），1.2k★ | 托管沙箱 SDK | 沙箱 = Durable Object + Container；提供 Files、S3Mount、DirectoryBackup |
| [computer](https://github.com/cloudflare/computer) | `@cloudflare/computer@0.11.2`（11-12），9.9k★ | DO 内的虚拟文件系统 + 可插拔执行后端 | container FUSE、isolate shell、codemode 三种后端 |
| [ci](https://github.com/cloudflare/ci) | 11-13 推送，618★ | Workflows + Sandbox 的 CI 引擎 | 沙箱作为 CI runner，命令在可重试的 Workflow step 中执行 |
| [artifact-fs](https://github.com/cloudflare/artifact-fs) | 11-13 推送，1.2k★ | Git 仓库 FUSE 驱动，按需水合 | 大仓库/数据集不必等完整 clone |
| [cloudflare-os](https://github.com/cloudflare/cloudflare-os) | 11-14 推送，11.8k★ | 企业内部 AI 生产力工作台 | 每个用户的 “gadget” 跑在独立沙箱；Gatekeepers 做能力授权 |
| [kitesurf](https://github.com/cloudflare/kitesurf) | 11-12 开源，584★ | 跑在 Workers 上的浏览器引擎 | 用 Workers + Dynamic Workers 替代 Chrome 容器 |
| [browser-run](https://github.com/cloudflare/browser-run) | 11-13 推送，381★ | Puppeteer / Playwright / MCP 的 Cloudflare 移植 | 浏览器自动化沙箱 |
| [serverless-registry](https://github.com/cloudflare/serverless-registry) | 11-03 推送，1.6k★ | Workers + R2 的容器镜像仓库 | R2 作为 registry 后端，支持 push/pull |
| [containers](https://github.com/cloudflare/containers) | 8 月，279★ | Container 生命周期封装 | 沙箱底层：HTTP/WebSocket 代理、出站拦截、sleepAfter |
| [agents](https://github.com/cloudflare/agents) | 11-14 推送，6.0k★ | Agents SDK | 内置 sandbox tool，把命令执行接进 agent |
| [skills](https://github.com/cloudflare/skills) | 11-10 推送，3.4k★ | 教 agent 使用 Cloudflare 的 skill 集 | 不是运行时，但反映 agent 生态投入 |

产品层面还有 **Artifacts**（Git 兼容的版本化文件系统，2026-10-01 open beta）和 **Basin**（原 Cloudflare Data Platform，含 Basin Pipelines / Catalog / SQL，底层 R2 + Iceberg）。二者不是沙箱运行时，但与沙箱的数据面直接相关。

### 3.2 Sandbox SDK 1.0：沙箱的边界从“容器”变成“你的 DO”

2026-09-30 发布的 1.0 是这一轮的分水岭：

- 用户自己的 Durable Object 直接通过 `this.ctx.container` 控制沙箱容器，可以选择镜像、实例规格、网络访问和停止时机。
- 一个 DO 类可以跑不同镜像的沙箱；部署不会重启正在运行的沙箱。
- 支持把沙箱文件系统保存为 Container snapshot（public beta），并在 `start()` 时恢复，或交接给另一个 DO。
- 支持流式 stdin/stdout、信号、浏览器终端、预览 URL、按 hostname 拦截出站请求。
- 官方文档已经把 Claude Code、Codex、OpenCode、Pi、Devin、Cursor、Claude Managed Agents、OpenAI Agents API 列为“在沙箱里跑 coding agent”的教程，说明 Cloudflare 把 coding agent 当成沙箱的头号场景。

沙箱有两种环境：

| 环境 | 隔离单位 | 能力 | 适用 |
|---|---|---|---|
| Containers | 每个实例一个 microVM，独立内核和网络 | 完整 Linux、任意语言、常驻进程 | 编译、dev server、浏览器、需要真实内核的任务 |
| Dynamic Workers | 运行时创建的 Worker isolate | JS / Python / WASM，只能通过 Worker 暴露的方法访问外部 | 轻量代码解释器、工具调用、短任务 |

### 3.3 Cloudflare Computer：比沙箱更高一层的“工作区”

`@cloudflare/computer` 把“文件系统”放在 Durable Object 的 SQLite 里，作为权威状态，再挂不同的执行后端：

- **Container backend**：把 SQLite 状态通过 FUSE 投影到沙箱容器，容器内的 `computerd` 负责挂载，变更通过 capnweb RPC 同步回 DO。完整 Linux userland、真实二进制、真实网络。
- **Isolate shell**：在 Dynamic Worker 里跑 `just-bash`，通过 Workers RPC 直接访问 Workspace，没有第二份存储和同步往返。
- **Codemode**：在全新的 Dynamic Worker 里执行 ECMAScript 模块，提供结构化的输入/输出、持久的相对导入、`node:fs/promises`，以及 `codemode:git`、`codemode:artifacts`、`codemode:container` 等宿主模块。
- **持久化执行**：从 v0.7.0 起，`onInterrupt: "replay"` 可以让 agent 代码在部署或崩溃后恢复，也可以在等待外部审批时暂停。

它的意义是把“沙箱”抽象成可替换的后端：同一份 Workspace 可以在容器、isolate 或纯 ESM 之间切换，文件系统始终是 DO 里的权威状态。对 OpenSandbox 的启示是“工作区状态”和“执行环境”可以解耦，不必让每个执行后端各自持有权威副本。

### 3.4 CI、ArtifactFS、Cloudflare OS、Kitesurf

- **Cloudflare CI**（`@cloudflare/ci`）：CI 引擎直接建在 Workflows 和 Sandbox 上。runner 命令在可重试的 Workflow step 里执行，因此有外部副作用的命令必须幂等；日志原样返回，只有通知预览和失败消息做脱敏。示例包含一个消费 runner 失败诊断的“自愈 agent”。这说明沙箱正在从“代码解释器”扩展到“CI runner”。
- **ArtifactFS**：Go 写的 FUSE 驱动，挂载 Git 仓库后立即暴露完整目录树，文件内容按需拉取，优先 package manifest、依赖清单和源码，再拉大 blob。它是 Cloudflare Artifacts 的可选组件，但也能挂任意 Git 仓库。对“沙箱启动要等 clone”的场景是直接解法。
- **Cloudflare OS**：Cloudflare 内部在用的 AI 生产力环境，2026-08 发布 v2，11-14 仍在高频推送。每个用户创建 slide deck 或小应用时，系统为该用户启动一个私有 “gadget” 实例，跑在独立沙箱里；Gatekeepers 作为能力层管理 agent/gadget 对外部服务的访问。它是“每用户一个沙箱应用”的产品级样例。
- **Kitesurf**：11-12 开源的实验性浏览器引擎，跑在 Workers 上，解析 HTML、应用 CSS、执行页面 JS、渲染截图，支持 CDP，可接 Puppeteer。它需要 Dynamic Workers（Workers Paid），仍然是 experimental。它的价值在于把“浏览器”从沙箱里的 Chrome 容器变成 Workers 内的执行，减少一个重依赖；但渲染保真度和标准覆盖仍在早期。

## 4. S3 / 对象存储优化专题

### 4.1 Cloudflare 的四种做法

| 需求 | 机制 | 关键设计 |
|---|---|---|
| 沙箱读共享 bucket | `S3Mount` | 容器内跑 `s3fs`，请求发给 Worker 里的 `S3Gateway`；Worker 逐请求校验并签名，凭证不进入容器；支持 prefix 和 read-only |
| 保存工作目录 | `DirectoryBackup` | 一个目录打包成一个 R2 对象；可恢复到任意容器，包括新镜像；gateway 只放行本次操作需要的那个对象，容器无需公网和 R2 凭证 |
| 快速恢复整机 | Container snapshot | 全量文件系统时点快照，`start()` 恢复，可跨 DO 交接；public beta；可用 DO alarm 在空闲/检查点时自动保存 |
| 大仓库 / 数据集启动 | `ArtifactFS` | FUSE 先暴露目录树，blob 按需水合；优先 manifest 和源码，避免全量 clone |
| 镜像分发 | `serverless-registry` | Workers + R2 实现容器 registry，支持 push/pull、用户名密码和 JWT 认证 |

这组设计的共同点是**把对象存储的访问收敛到一个受控的 Worker 边界**：沙箱只看到挂载点或一个对象，签名、鉴权、范围限制都在 Worker 侧完成。`S3Mount` 和 `DirectoryBackup` 都要求主模块 re-export 对应的 Gateway，且不要把 HTTP 请求路由到 Gateway。

### 4.2 Rivet 的 S3 成本 benchmark

Rivet 在 2026-11-14 推送了 `celld-vs-openorange-bench`，用同一批机器、同一套 SQLite 工作负载对比 OpenOrange（Rivet 存储引擎）和 celld（Deno 的自托管 Durable Objects，长期状态放 S3/GCS/Azure Blob）。

工作负载：

- 每个 agent 存活 60 秒，每 10 秒写一次 SQLite（±20% 抖动），在 16 行之间轮转，然后休眠，数据保留；新 agent 补位，保持并发数恒定。
- 每加一批 agent 后静置 2 分钟，再测完整的 5 个 UTC 分钟；校验实际连接数、完成的 1 分钟生命周期、已确认写入和零客户端错误。
- 6 台节点测到 10k agent，12 台测 15k/20k，24 台测 25k；每台 16 vCPU / 64 GB / 1 TiB Premium SSD。
- 成本是**实际 Azure Blob 请求数按 S3 价格重算**：GET/HEAD $0.0004/1k，PUT/LIST $0.005/1k，删除免费；按 730 小时投影；不含计算、内存、出网。

| 并发 agent | OpenOrange / Rivet（美元/月） | celld（美元/月） | 倍率 |
|---:|---:|---:|---:|
| 8 | 74.64 | 64.32 | celld 略低 |
| 32 | 105.26 | 105.09 | 基本持平 |
| 1,024 | 227.05 | 1,000.61 | 4.4× |
| 5,000 | 231.80 | 4,547.44 | 19.6× |
| 10,000 | 259.18 | 9,006.65 | 34.8× |
| 25,000 | 457.14 | 22,653.80 | 49.6× |

关键不是“谁更便宜”，而是**曲线的形状**：Rivet 在 1k 之后请求成本基本压平，celld 随并发线性上升。原因是 celld 把每个 cell 的长期状态放在 bucket，短生命周期 agent 的频繁驱逐和换主会放大对象存储请求；Rivet 用 SSD 热层承接写入，再后台批量上传，S3 不在写路径上。这个结论对任何“每个沙箱/会话一个 S3 目录、频繁写小对象”的设计都成立。

需要注意 benchmark 的边界：厂商自测、硬件成本不计、Azure Blob 按 S3 价重算、负载是合成工作负载；它适合用来判断量级和曲线形状，不适合直接当采购报价。

### 4.3 两种 S3 分层对照

| 维度 | Rivet / OpenOrange | celld |
|---|---|---|
| 写入确认 | 2/3 可用区 SSD 确认，后台批量上传 S3 | 单节点写入需等 bucket；多节点先复制到 1～2 个 peer，再上传 |
| S3 是否在写路径 | 否 | 单节点场景在；fleet 场景延后 |
| 读路径 | SSD 缓存优先，未命中回 S3 | 接管时从 bucket 恢复 cell |
| 长期状态 | bucket | bucket |
| 规模化成本 | 1k 后近似平坦 | 随并发线性增长 |
| 适合 | 长会话、状态多、写入频繁 | 自托管、想用现成 S3、规模可控 |

## 5. 对 OpenSandbox 的可借鉴点

结合本仓库现有的 S3 中间件、池化共享文件分发和非池节点本地卷方案，下面几点可以直接对照：

1. **给 S3 请求成本单独建模**。按 10k 沙箱、每 10 秒一次小写入估算，请求数会到亿级/月；PUT/LIST 单价是 GET/HEAD 的 12.5 倍。先算清“每沙箱每分钟写几次、每次几个对象”，再决定同步还是异步。
2. **S3 不放在热路径**。节点本地热层承接写入，按时间/大小/空闲触发批量上传；上传前做打包和压缩，减少对象数和请求数。Rivet 的“SSD 确认 + 后台批量”是这条路的成熟实现。
3. **凭证与权限收敛到网关**。Cloudflare 的 `S3Mount` / `DirectoryBackup` 都把签名放在 Worker，沙箱只看到挂载点或单个对象；OpenSandbox 的 S3 中间件也是同一思路，可以进一步把“单次操作只放行单个对象/前缀”做成默认语义。
4. **共享只读内容与用户产物分流**。模型、数据集、skill 这类共享只读内容走预置、节点缓存或 P2P；用户产物才走 S3 回写。知识库里已有的“池化共享文件 S3 分发优化”和“产物本地热层”两份调研就是这条线。
5. **快照分层**。容器/本地快照负责快速恢复，S3 对象负责跨节点、跨镜像和长期归档，每次文件写入由本地热层承接。Cloudflare 的 Container snapshot 与 `DirectoryBackup` 是“快”和“可移植”两种语义的清晰拆分。
6. **大仓库/数据集用懒加载**。ArtifactFS 的“先暴露目录树、按需拉 blob、优先 manifest/source”适合沙箱启动阶段；比“先完整 clone 再启动”更容易把冷启动压下来。

## 6. 参考链接

**Rivet**

- https://github.com/rivet-dev/agentos
- https://github.com/rivet-dev/rivet
- https://github.com/rivet-dev/open-orange
- https://github.com/rivet-dev/celld-vs-openorange-bench
- https://github.com/rivet-dev/agents
- https://github.com/rivet-dev/flue
- https://rivet.dev/docs/benchmarking/

**Cloudflare**

- https://github.com/cloudflare/sandbox-sdk
- https://developers.cloudflare.com/sandbox/
- https://developers.cloudflare.com/sandbox/reference/s3-mounts/
- https://developers.cloudflare.com/sandbox/reference/directory-backups/
- https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/
- https://github.com/cloudflare/computer
- https://github.com/cloudflare/ci
- https://github.com/cloudflare/artifact-fs
- https://github.com/cloudflare/cloudflare-os
- https://github.com/cloudflare/kitesurf
- https://github.com/cloudflare/serverless-registry
- https://developers.cloudflare.com/artifacts/
