# Cloudflare / Rivet 沙箱项目与执行密度、存储架构调研

> 调研时间：2026-11-14。范围：`github.com/rivet-dev` 与 `github.com/cloudflare` 近两周有推送的仓库，Cloudflare 官方文档与 Changelog，以及市面主要沙箱服务商的公开架构资料。星标、推送时间取自 GitHub API 当日快照；厂商自测的性能、密度和成本数字均标注来源，只作方向参考。
>
> 本文把“项目梳理”和“架构判断”分开：第 3～4 节是 Rivet / Cloudflare 的事实；第 5～6 节是市面密度做法与存储路径的横向综合；第 7 节是结合本仓库业务约束的落地建议。

## 1. 结论

- **Cloudflare 的沙箱栈已经成形**：Containers 提供每个实例独立内核和网络的 microVM，Dynamic Workers 提供 JS/Python/WASM isolate，Durable Object 负责生命周期与状态。2026-09-30 的 Sandbox SDK 1.0 把镜像、规格、网络、生命周期和快照的控制权交给用户自己的 DO；近期仓库重心明显上移到 coding agent、CI、浏览器和工作区。
- **Rivet 走两条线**：一条用 Rivet Actors / agentOS 替代“每个 agent 一个重型沙箱”；另一条用 OpenOrange 把 Cloudflare Workers/DO 原样跑在自有机器上，状态放 S3。两条线共用同一套 S3 分层存储。Rivet 的 actor 模型针对 agent 运行时，本仓库的沙箱是代码执行环境，直接可借的是存储分层和“把 agent 留在沙箱外”的边界，不是 actor 本身。
- **密度不是单一技术**：市面做法可以归为状态外置、执行环境做薄、池化与快速启动、隔离分级、调度与超卖、时间复用六类。对代码执行沙箱，稳态密度主要由“单沙箱常驻内存/CPU 份额”决定；启动速度影响 warm pool 大小和体验，不直接决定稳态密度。内存快照、整机休眠、actor 这些“保 agent 现场”的技术，适用对象是长会话 agent，不是短任务代码执行。
- **S3Mount 的容器内 FUSE 有权限前提**：Cloudflare 的 `S3Mount` 在容器里跑 `s3fs`，请求发给 Worker 里的 `S3Gateway` 逐请求签名，凭证不进容器。Cloudflare 的 sandbox 安全模型给容器内进程 root 级 capabilities，所以它能挂；普通 Kubernetes Pod 默认没有 `/dev/fuse` 和 `SYS_ADMIN`，照搬需要 privileged 或放宽 Pod Security Standards。K8s 上的安全路径是 CSI 驱动的 PVC：特权留在 node plugin，业务 Pod 只拿 bind mount。没有 CSI/PVC 供应商时，退到任务边界 S3 同步，或把 FUSE 放进专用 sidecar，应用容器保持无特权。
- **E2B 不是 S3 CSI PVC**：E2B 的公开架构是“沙箱 = 恢复一个预启动的 Firecracker VM 快照”，快照包含内存、磁盘和 VM 状态，存对象存储；恢复时内存页用 `userfaultfd` 懒加载，rootfs 是 CoW overlay。它恢复的是进程现场。PVC 给的是文件级持久化。两者语义不同。
- **池化适合单轮短任务，多轮/多会话需要另加一层**：Pool 的 `Template` 是固定的 `PodTemplateSpec`，Pod 预创建，claim 只做分配，不能在 claim 时换卷或换 `subPath`。单轮短任务用共享 RWX PVC 根加每会话子目录即可；多轮/多会话要么走非池化的会话平面（稳定 ID + 每会话工作区 + TTL），要么给 Pool 加 lease/reserved 状态，让 Pod 在会话期间不被回收。
- **持久化契约决定架构**：如果业务只要求保留特定工作区文件和产物，rootfs 可以完全临时，内存快照和整机快照都不需要；工作区用 CSI PVC（块/文件或 RWX）或对象存储前缀，任务结束上传产物即可。Wasm 的轻量只在 WASI 能力面内成立，适合窄场景工具调用，不适合作为通用业务运行时。

## 2. 调研范围与方法

- 仓库范围：`rivet-dev` 与 `cloudflare` 组织下近两周有推送的仓库，按 GitHub API 的 `pushed_at` 排序；只保留与沙箱运行时、工作区、对象存储、镜像分发相关的项目。
- 文档范围：Cloudflare Sandbox / Containers / R2 官方文档与 Changelog；Rivet README、benchmark 仓库与 HN 讨论；E2B Runtime 的 `docs/ARCHITECTURE.md`；Modal、Daytona、Vercel、AWS Lambda MicroVMs、Fly.io、Blaxel、Runloop、Kubernetes Agent Sandbox 的公开资料。
- 口径：厂商自测数字只用于判断量级和曲线形状；密度对比必须同 workload、同隔离级别、同 SLA，否则不可直接横比。

## 3. Rivet（rivet-dev）

### 3.1 项目清单

| 仓库 | 最近动态（2026-11） | 定位 | 与沙箱 / S3 的关系 |
|---|---|---|---|
| [agentos](https://github.com/rivet-dev/agentos) | v0.4.8（11-12），4.9k★ | WASM + V8 的 Linux 兼容轻量 VM | 用进程内 VM 替代 microVM 的沙箱路线；SQLite 持久化、外部沙箱挂载 |
| [rivet](https://github.com/rivet-dev/rivet) | v3.1.1 / v3.1.2-rc.1（11-11/12），6.9k★ | Actor 编排器 | 托管 agentOS、OpenOrange 的控制面；SQLite 状态最终落 S3 |
| [open-orange](https://github.com/rivet-dev/open-orange) | 11-12 创建、11-13 推送，440★ | 把 Workers/DO 原样跑在 AWS、GCP、Azure 或自有机器 | 状态放 S3；R2 binding 可落到自有 S3 兼容存储 |
| [celld-vs-openorange-bench](https://github.com/rivet-dev/celld-vs-openorange-bench) | 11-14 推送 | S3 请求成本 benchmark | 8～25k 并发 agent 的请求成本对照，见 6.3 |
| [agents](https://github.com/rivet-dev/agents) | 11-12，1.6k★ | 沙箱内跑 coding agent 的 HTTP/SSE 服务 | Sandbox Agent 统一 Claude Code、Codex、OpenCode、Cursor、Amp、Pi |
| [flue](https://github.com/rivet-dev/flue) | 7 月创建，仍活跃，4★ | Agent harness 框架 | `local()` / Daytona / agentOS 等沙箱适配 |
| [dynamic-apps](https://github.com/rivet-dev/dynamic-apps) | 11-08，1.0k★ | 用户生成后端跑在沙箱化部署 VM | 仅支持 Rivet 2.x；缓存命中走本地 V8 |
| [bench-rivet-actors-vs-durable-objects](https://github.com/rivet-dev/bench-rivet-actors-vs-durable-objects) | 11-05 | Actor 与 Durable Objects 的对照 benchmark | 冷启动、持久写、读延迟的原始数据 |
| [latency-numbers-every-programmer-should-know](https://github.com/rivet-dev/latency-numbers-every-programmer-should-know) | 4 月，低活跃 | Lambda 视角的沙箱 provider 延迟 benchmark | 冷启动 / exec / health 的测量方法参考 |
| [linux-package-manager-bench](https://github.com/rivet-dev/linux-package-manager-bench) | 7 月 | 各包管理器安装 git 的耗时 | 镜像构建与冷启动优化参考 |
| [secure-exec-curl](https://github.com/rivet-dev/secure-exec-curl) | 3 月 | 带 WASI 补丁的 libcurl | agentOS WasmVM 的支撑件 |
| [durable-object-migrator](https://github.com/rivet-dev/durable-object-migrator) | 11-12，45★ | 把 DO SQLite 数据迁到 Postgres、文件系统或 Rivet Actors | 降低 Cloudflare 锁定 |

仓库里还有 `daytona`、`e2b-cookbook`、`wasmer`、`deno` 等 fork，属于研究或 vendored 依赖，不是 Rivet 自家产品。

### 3.2 agentOS：用 WASM 做“进程内沙箱”

agentOS 是 Rivet 当前最激进的路线，README 的定位是“Tiny, fast, Linux-compatible sandboxes”，技术上是 WebAssembly + V8 isolate，而不是 microVM。

- **运行形态**：`@rivet-dev/agentos-core` 跑在可信的 Node.js 进程里；可信侧的原生 sidecar 持有 kernel、VFS、进程/套接字表、权限、资源策略、软件包获取和语言执行器；不可信的 JS、Python、WASM 和第三方包跑在 guest 侧。
- **能力**：POSIX 文件、进程、网络，shell，宿主函数（host functions）直接调用后端；可以把外部沙箱文件系统挂到 `/mnt/sandbox`，guest 像读写本地文件一样读写。
- **持久化**：默认根文件系统是内存 overlay，VM 重建即丢；把根放进 SQLite（`chunked_sqlite`）后，用相同配置新建的 VM 能看到同一份文件。进程、终端、语言上下文和流不持久。
- **厂商自测**：冷启动 p50 4.8 ms、p95 5.6 ms、p99 6.1 ms；shell 工作负载内存约 22 MB；对比“sandbox baseline”的 92× / 47× / 254×。这些是 README 数字，适合作为量级参考，不宜直接当生产结论。
- **边界**：浏览器、桌面自动化、重型编译、dev server、GUI/VNC 仍然需要真实 Linux 内核，agentOS 的官方建议是与外部沙箱组合使用。

对 OpenSandbox 的意义：如果业务里存在大量“短任务、只跑脚本/CLI/文件操作”的 agent，agentOS 这类进程内 VM 是 microVM 之外的另一种密度选择；但它不覆盖需要真实内核的负载，不能替代池化沙箱主路径。

### 3.3 Rivet Actors + OpenOrange：把状态放到 S3

Rivet 的核心叙事是“每个 agent 一个轻量 actor，而不是一个重型沙箱”：

- Actor 有长生命周期进程、内存状态、WebSocket、SQLite 持久存储，空闲可休眠。
- Rivet 官方 benchmark（2026-11-05，Rivet 3.0.3）给出冷启动 p50 4.30 ms / p99 4.99 ms，单 actor 常驻内存约 72.4 KB；HN 讨论里给出的对照是“最小沙箱约 512 MB、启动 p99 约 1.7 s”。对照组数字来自第三方 benchmark，不是同机实测。
- 存储架构是两层：写入先由 2/3 可用区的 SSD 确认，然后在后台批量上传 S3；读优先命中 SSD 缓存，未命中再回 S3。S3 不在写路径上。官方给出的 p99 是持久写 1.07 ms、休眠后点读 1.36 ms、对象存储读 138 ms；长期存储成本约为三副本 EBS gp3 的 1/10.4。
- OpenOrange 把这套能力包装成“Cloudflare Workers/DO 兼容运行时”：代码打成标准 Docker 镜像，DO 映射为 Rivet Actor，状态放 S3；`orange dev` / `orange deploy` 对应 `wrangler` 的工作流。它同时提供从 Cloudflare 迁出的数据通道，属于典型的“反锁定”产品。

这条线对 OpenSandbox 的直接价值不在运行时，而在**存储分层**：把 S3 从热路径挪走，用节点本地 SSD/内存承接写入，再异步、批量、压缩地落对象存储。Actor 本身适合 agent 运行时；本仓库的沙箱是代码执行环境，agent 循环和会话状态在业务层，不能直接套用“每个 agent 一个 actor”的模型。

## 4. Cloudflare

### 4.1 项目清单

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

### 4.2 Sandbox SDK 1.0：沙箱的边界从“容器”变成“你的 DO”

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

### 4.3 Cloudflare Computer：把“工作区”和“执行环境”拆开

`@cloudflare/computer` 把“文件系统”放在 Durable Object 的 SQLite 里，作为权威状态，再挂不同的执行后端：

- **Container backend**：把 SQLite 状态通过 FUSE 投影到沙箱容器，容器内的 `computerd` 负责挂载，变更通过 capnweb RPC 同步回 DO。完整 Linux userland、真实二进制、真实网络。
- **Isolate shell**：在 Dynamic Worker 里跑 `just-bash`，通过 Workers RPC 直接访问 Workspace，没有第二份存储和同步往返。
- **Codemode**：在全新的 Dynamic Worker 里执行 ECMAScript 模块，提供结构化的输入/输出、持久的相对导入、`node:fs/promises`，以及 `codemode:git`、`codemode:artifacts`、`codemode:container` 等宿主模块。
- **持久化执行**：从 v0.7.0 起，`onInterrupt: "replay"` 可以让 agent 代码在部署或崩溃后恢复，也可以在等待外部审批时暂停。

它的意义是把“沙箱”抽象成可替换的后端：同一份 Workspace 可以在容器、isolate 或纯 ESM 之间切换，文件系统始终是 DO 里的权威状态。对 OpenSandbox 的启示是“工作区状态”和“执行环境”可以解耦，不必让每个执行后端各自持有权威副本。

### 4.4 CI、ArtifactFS、Cloudflare OS、Kitesurf

- **Cloudflare CI**（`@cloudflare/ci`）：CI 引擎直接建在 Workflows 和 Sandbox 上。runner 命令在可重试的 Workflow step 里执行，因此有外部副作用的命令必须幂等；日志原样返回，只有通知预览和失败消息做脱敏。示例包含一个消费 runner 失败诊断的“自愈 agent”。这说明沙箱正在从“代码解释器”扩展到“CI runner”。
- **ArtifactFS**：Go 写的 FUSE 驱动，挂载 Git 仓库后立即暴露完整目录树，文件内容按需拉取，优先 package manifest、依赖清单和源码，再拉大 blob。它是 Cloudflare Artifacts 的可选组件，但也能挂任意 Git 仓库。对“沙箱启动要等 clone”的场景是直接解法。
- **Cloudflare OS**：Cloudflare 内部在用的 AI 生产力环境，2026-08 发布 v2，11-14 仍在高频推送。每个用户创建 slide deck 或小应用时，系统为该用户启动一个私有 “gadget” 实例，跑在独立沙箱里；Gatekeepers 作为能力层管理 agent/gadget 对外部服务的访问。它是“每用户一个沙箱应用”的产品级样例。
- **Kitesurf**：11-12 开源的实验性浏览器引擎，跑在 Workers 上，解析 HTML、应用 CSS、执行页面 JS、渲染截图，支持 CDP，可接 Puppeteer。它需要 Dynamic Workers（Workers Paid），仍然是 experimental。它的价值在于把“浏览器”从沙箱里的 Chrome 容器变成 Workers 内的执行，减少一个重依赖；但渲染保真度和标准覆盖仍在早期。

## 5. 沙箱密度：市面做法与关键技术

### 5.1 密度由什么决定

单节点能放多少沙箱，取下面几项的最小值：

```text
密度 ≈ min(
  可用内存 / 单沙箱常驻内存,
  可用 CPU / 单沙箱 CPU 份额,
  可用磁盘与 IOPS / 单沙箱 IO,
  Kubernetes max-pods 与网络端口等硬上限
)
```

单沙箱常驻内存可以拆成：

| 组成 | 典型量级 | 说明 |
|---|---|---|
| 基础运行时（Python/Node/JVM） | 50–300 MiB | 语言解释器、标准库、动态链接库 |
| 用户进程工作集 | 100 MiB–1 GiB | 实际执行的代码、数据、临时对象 |
| 页缓存与共享库 | 50–200 MiB | 同镜像、同只读数据可在节点内复用 |
| 隔离层开销 | 容器约 0；gVisor 20–100 MiB；microVM 32–128 MiB + guest 内核 | 隔离越硬，固定成本越高 |
| sidecar | 每个 20–100 MiB | egress、日志、监控等 |
| agent runtime | 200 MiB–1 GiB+ | 如果 agent 循环、会话、WebSocket 在沙箱里 |

关键点：**密度首先由“每个沙箱的基线”决定**。Rivet 公开对比过 72 KB 的 actor 和 512 MB 的最小沙箱，E2B 常见默认规格在 1 GiB 量级，差距主要就在基线，不在快照。Kubernetes 还有一个硬上限：默认每节点最多 110 个 Pod；一沙箱一 Pod 时，内存再省也超不过这个数。集群资源真正紧张时，`request` 超配、空闲池、碎片往往比隔离技术更早成为瓶颈。

### 5.2 六类做法

**（1）状态外置：PVC、共享存储、对象存储。** 让计算单元无状态，工作区、依赖、产物放在外部存储；容器随时可以杀掉重建，数据不跟着容器走。Cloudflare 的 `DirectoryBackup`、`S3Mount`，Vercel 的停止自动保存，E2B 的 pause 到对象存储，Runloop 的磁盘级 suspend，都是这条线。对代码执行沙箱，这是最贴合的一条。

**（2）把执行环境做薄。** 同一份固定资源下，镜像里少一个 agent runtime、少一个浏览器、少一个 sidecar，可能就多出几十到几百 MiB 的密度空间。Cloudflare 用 Dynamic Workers isolate 承载轻量 JS/Python/WASM，只有需要完整 Linux 时才落到 Container microVM；Rivet 的 agentOS 用 WASM + V8 做 Linux 兼容的轻量 VM；E2B 用模板把依赖预装进快照；Lambda MicroVMs 把 Dockerfile 构建成预初始化镜像。对代码执行沙箱，按语言/任务拆镜像比做一个胖镜像更有效。

**（3）池化与快速启动。** E2B 从预启动快照恢复 Firecracker microVM，内存页用 `userfaultfd` 懒加载，rootfs 用 CoW overlay；Modal 用 gVisor 的 checkpoint/restore 做内存快照，公开数据是恢复比标准容器启动快约 2.5 倍；Lambda MicroVMs 每次启动都从预初始化快照恢复，支持 suspend/resume；Daytona 的 pause 冻结整机状态，恢复在 1 秒内。这些技术提高的是“冷启动速度”和“可用密度”，但 warm pool 本身占内存，快照本身占存储。对几秒到几十秒的代码执行任务，池子按并发建、任务结束立即回收通常比快照更划算。

**（4）隔离分级。** 容器固定成本最低，适合同租户、内网、代码来源可控的场景；gVisor 的用户态内核介于容器和 microVM 之间；microVM 硬件边界最强、固定成本最高；Wasm/isolate 实例化和空闲成本最低，适合纯函数、工具调用、MCP server。Kubernetes Agent Sandbox 把隔离交给 `RuntimeClass`，上层只定义 `Sandbox`、`SandboxTemplate`、`SandboxWarmPool`；Cloudflare 则是 isolate 和 Container 两层并存。不要给所有代码都付 microVM 的固定内存和启动成本。

**（5）调度、右尺寸与超卖。** Modal 为了避免 Kubernetes 的 `O(n×p)` 调度和 etcd 写放大，重建了控制面：调度服务器用内存中的 worker 状态做负载均衡，worker 自己发布状态到 Redis stream，创建路径没有中心数据库。Kubernetes 侧则是 request/limit 右尺寸、bin packing、节点亲和、避免碎片；对延迟敏感的执行环境要留 headroom。内存超卖可以用 KSM、zram/swap、virtio-mem、ballooning、free page reporting，但代码执行对尾延迟敏感，超卖过度会换来 OOM 和 p95 抖动。

**（6）时间复用。** Blaxel 空闲进 standby、约 25 ms 恢复；Daytona 支持 pause/fork；Vercel 停止后自动保存；Runloop 只保留磁盘。时间复用对“长会话 agent”很有效，对短任务代码执行收益有限；短任务真正的做法是短 TTL、任务结束立即回收、池子按并发补充。

### 5.3 厂商对照

| 厂商/项目 | 隔离单元 | 密度相关手段 | 对“代码执行沙箱”的参考价值 |
|---|---|---|---|
| E2B | Firecracker microVM | 预启动快照、`userfaultfd` 懒加载内存、CoW rootfs、只取访问页 | 高：快速拿到干净执行环境；内存快照主要服务长会话 |
| Modal | gVisor `runsc` | 内存快照/恢复、OverlayFS 懒加载 lower、无中心控制面 | 中高：gVisor 是中间隔离层；快照对重运行时才有明显 ROI |
| Daytona | microVM | pause 整机状态、fork 克隆、默认 1 GiB 级规格 | 中：fork 适合并行分支；整机状态超出普通代码执行需要 |
| Cloudflare Sandbox | DO + Container microVM；Dynamic Workers isolate | 分层隔离、Container snapshot、DirectoryBackup、S3Mount | 高：最接近“执行环境 + 状态外置”的形态 |
| Vercel Sandbox | Firecracker microVM | 停止自动保存、恢复现场、空闲按内存计费 | 高：持久化语义清晰；托管形态不可自建 |
| AWS Lambda MicroVMs | Firecracker | 预初始化快照、suspend/resume、最高 16 vCPU/32 GB | 高：启动和生命周期设计成熟；隔离偏重 |
| Fly.io | Firecracker | 独占物理机、尽量把物理核固定给一个 microVM | 低：优化的是性能隔离，不是密度 |
| Blaxel | microVM | 空闲 standby、约 25 ms 恢复、scale to zero | 低：偏 agent runtime |
| Runloop | microVM + 容器层 | suspend 只保留磁盘、快照用于分支 | 中：磁盘级持久化更贴近代码执行 |
| Rivet | Actor（WASM/V8） | 72 KB actor vs 512 MB 最小沙箱；4.9 ms vs 1.7 s p99 | 高（作为边界）：agent 不该住在沙箱里 |
| K8s Agent Sandbox | 委托给 gVisor/Kata | `Sandbox` CRD、`SandboxWarmPool`、`RuntimeClass` | 中：架构参考，不直接给密度数字 |

表中的默认规格和延迟来自厂商公开资料或二手对比，workload 不同不可直接横向比较；真正要比，得用同一份任务、同一隔离级别、同一 SLA 去压测。

### 5.4 关键结论

- **代码执行环境和 agent 运行时是两种负载。** 代码执行沙箱只负责跑代码，agent 循环、会话记忆、WebSocket、编排都在业务层；因此内存快照、整机休眠、actor 这些“保 agent 现场”的技术不是主线。主线是薄执行环境、工作区外置、池化按并发、隔离分级。
- **warm pool 提升的是体验，不是稳态密度。** warm pool 里的空闲 Pod 占着真实内存；池子大小要按并发曲线和突发 headroom 定，不按注册用户数定。
- **Wasm 的轻量有边界。** 它只在 WASI 能力面内成立；企业业务一旦要求 Python C 扩展、native 二进制、Node addon、JVM/.NET、shell、编译器、浏览器、长驻服务，就得回到 Linux 容器。Wasm 适合纯函数、MCP 工具、数据变换、策略过滤这类窄场景，不适合作为通用业务运行时。
- **数据路径可能比执行单元更早成为瓶颈。** 每 turn 全量 S3 保存、重建全量拉取的成本是 O(workspace)，Wasm 只缩小执行单元，不改变这条路径；如果数据路径是瓶颈，Wasm 的收益会被吞掉。双路径还会拆池、加 headroom，实际密度可能不升反降。

## 6. S3 / 对象存储与卷挂载

### 6.1 Cloudflare S3Mount：机制与权限前提

`S3Mount` 的设计是：容器镜像里装 FUSE 3 和 `s3fs`；`s3fs` 在容器内发存储请求；请求被容器网络拦截，送到 Worker 里的 `S3Gateway`；`S3Gateway` 校验请求是否落在 bucket/prefix/access mode 内，然后用真实凭证签名，转发到 R2 或其他 S3 兼容存储。凭证不进容器，支持 prefix 和 read-only/read-write。

这套机制在 Cloudflare 上成立，是因为它的 sandbox 安全模型给容器内进程 root 级 capabilities；官方安全文档明确说“部署后的 sandbox 里每个进程都有与 root 相同的 Linux capabilities”。普通 Kubernetes Pod 默认没有 `/dev/fuse` 和 `SYS_ADMIN`：

- 要挂 `s3fs`，通常需要 `securityContext.capabilities.add: ["SYS_ADMIN"]` 加 `/dev/fuse` 的 `hostPath`，或者直接 `privileged: true`；
- Pod Security Standards 的 baseline/restricted 会拒绝 `SYS_ADMIN` 和 privileged；
- 非特权 FUSE 需要 user namespace、setuid `fusermount`、内核参数和运行时配置同时满足，跨集群不可移植。

Kubernetes 上的安全路径是 **CSI 驱动的 PVC**：CSI node plugin 通常以特权或高权限 DaemonSet 运行，挂载在宿主机完成，业务 Pod 只拿 bind mount，容器内不需要 FUSE 权限。Mountpoint for S3、s3fs CSI、JuiceFS CSI、OSS CSI 都属于这个模式。注意对象存储 FUSE 的 POSIX 语义有限：rename、append、锁、元数据操作都和本地盘不一样；工作区用块/文件 PVC 更稳，对象存储放最终产物。

### 6.2 DirectoryBackup、Container snapshot、ArtifactFS、serverless-registry

| 需求 | 机制 | 关键设计 |
|---|---|---|
| 沙箱读共享 bucket | `S3Mount` | 容器内跑 `s3fs`，请求发给 Worker 里的 `S3Gateway`；Worker 逐请求校验并签名，凭证不进入容器；支持 prefix 和 read-only |
| 保存工作目录 | `DirectoryBackup` | 一个目录打包成一个 R2 对象；可恢复到任意容器，包括新镜像；gateway 只放行本次操作需要的那个对象，容器无需公网和 R2 凭证 |
| 快速恢复整机 | Container snapshot | 全量文件系统时点快照，`start()` 恢复，可跨 DO 交接；public beta；可用 DO alarm 在空闲/检查点时自动保存 |
| 大仓库 / 数据集启动 | `ArtifactFS` | FUSE 先暴露目录树，blob 按需水合；优先 manifest 和源码，避免全量 clone |
| 镜像分发 | `serverless-registry` | Workers + R2 实现容器 registry，支持 push/pull、用户名密码和 JWT 认证 |

这组设计的共同点是**把对象存储的访问收敛到一个受控的 Worker 边界**：沙箱只看到挂载点或一个对象，签名、鉴权、范围限制都在 Worker 侧完成。`S3Mount` 和 `DirectoryBackup` 都要求主模块 re-export 对应的 Gateway，且不要把 HTTP 请求路由到 Gateway。

### 6.3 Rivet 的 S3 成本 benchmark

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

### 6.4 两种 S3 分层对照

| 维度 | Rivet / OpenOrange | celld |
|---|---|---|
| 写入确认 | 2/3 可用区 SSD 确认，后台批量上传 S3 | 单节点写入需等 bucket；多节点先复制到 1～2 个 peer，再上传 |
| S3 是否在写路径 | 否 | 单节点场景在；fleet 场景延后 |
| 读路径 | SSD 缓存优先，未命中回 S3 | 接管时从 bucket 恢复 cell |
| 长期状态 | bucket | bucket |
| 规模化成本 | 1k 后近似平坦 | 随并发线性增长 |
| 适合 | 长会话、状态多、写入频繁 | 自托管、想用现成 S3、规模可控 |

### 6.5 E2B：VM 快照，不是 S3 CSI PVC

E2B 的公开架构把“沙箱 = 恢复一个预启动的 Firecracker VM 快照”作为核心：

- 模板是预启动的 VM 快照（内存 + 磁盘 + VM 状态），存在对象存储；创建沙箱就是恢复快照，不是冷启动内核。
- 内存页按 page fault 用 `userfaultfd` 懒加载，rootfs 是只读镜像上的 CoW overlay，只有真正访问的数据才会被取回。
- pause 会把内存和磁盘相对模板的 diff 写到对象存储；resume 优先回到仍有缓存的节点；fork 可以从一个运行中的沙箱克隆出多个新沙箱。

这套机制的恢复单位是**进程现场**，不是文件系统挂载。PVC 给的是文件级持久化：容器看到的是一个目录，进程重启后需要重新拉起。两者语义不同：

- 需要“下一轮继续跑同一个进程、保留内存里的状态”，才需要 E2B 这种 VM/内存快照；
- 只需要“下一轮还能看到上次写的工作区文件和产物”，PVC/CSI 或对象存储前缀就够了，而且更简单、更可移植。

本仓库的业务契约是后者，所以 E2B 的内存快照机制属于过度设计；可借的是它的模板/薄镜像/快速恢复思路，不是快照本身。

### 6.6 PVC / CSI 的形态与池化限制

Kubernetes 里“安全的 CSI 挂载”最终就是 PVC（严格说还有 CSI inline ephemeral volume 和 generic ephemeral volume，生命周期跟 Pod 走，机制相同）：

| 形态 | 是否有独立 PVC 对象 | 典型用途 |
|---|---|---|
| 静态 PV + PVC | 有 | 预置的桶、文件系统、本地卷 |
| StorageClass 动态 PVC | 有 | 按需创建 |
| CSI inline ephemeral | 无，Pod 内 `csi` 卷 | 生命周期跟 Pod |
| generic ephemeral | 有，自动创建/删除 | 临时卷 |

“安全”来自 CSI node plugin 以特权运行、业务 Pod 保持无特权；PVC 对象本身不授予权限。PVC 也不等于多租户隔离：RWX 共享卷加子目录是路径级隔离，跨租户要么每会话 PVC，要么每会话对象前缀加受限凭证。

池化的限制在 `PodTemplate`：Pool 的 `Template` 是 `corev1.PodTemplateSpec`，Pod 预创建，claim 只做分配，不能在 claim 时换卷或换 `subPath`。所以：

- 每会话独立 PVC：只能走非池化，Pod 创建时挂载；
- 池化里可用：共享 RWX PVC 根 + 每会话子目录，或者对象存储前缀；
- CSI 解决的是“怎么安全挂”，解决不了“claim 时换卷”。

### 6.7 无 PVC/CSI 供应商时的 FUSE/S3 备选方案

如果集群没有可用的 CSI/PVC 供应商，`S3Mount` 那套“容器内 `s3fs` + 网关签名”仍然可以工作，但要把权限放在正确的位置。按推荐顺序：

| 方案 | 做法 | 权限 | 适用 | 代价 |
|---|---|---|---|---|
| S3 同步 init/sidecar | 任务开始 `aws s3 sync`/`rclone`/`ossutil` 拉工作区，结束回写；或用 init container 只拉只读数据 | 无 FUSE、无特权 | 短任务、无 POSIX 强依赖、跨租户 | 传输/请求成本；不是实时文件系统；并发写要按前缀隔离 |
| FUSE sidecar | sidecar 挂 `/dev/fuse`、以 privileged 运行，用 `mountPropagation: Bidirectional` 把 `s3fs`/`ossfs` 挂载传播到 `hostPath` 工作区；应用容器用 `HostToContainer` 看到挂载 | Pod 内有特权 sidecar，应用容器无特权 | 需要透明 POSIX、能接受 PSA 例外 | `Bidirectional` 要求 privileged，建议用 `hostPath`；s3fs 元数据延迟、rename/append/锁语义限制；sidecar 要常驻 |
| 应用容器内 FUSE | 直接在业务容器跑 `s3fs` | `SYS_ADMIN`/privileged | 可信代码、临时验证 | 权限面最大；不建议用于不可信代码 |
| 静态 local PV / hostPath + S3 同步 | 用节点本地盘做工作区，任务边界同步到 S3 | 无 FUSE；需要 node 亲和 | 有本地盘、能接受节点钉死 | 节点故障会丢本地数据；需要额外同步 |
| 自建 CSI 驱动 | 部署 JuiceFS/Ceph/NFS/S3 CSI，特权留在 node plugin | 应用 Pod 无特权 | 长期方案、平台团队可维护 | 运维成本；需要存储后端 |

**推荐**：

- 单轮短任务、没有 PVC：用 S3 同步 init/sidecar。拉取时只取本次任务需要的前缀，回写时只传变更文件；凭证用 IRSA/Workload Identity 或网关，作用域限制到单前缀，不把 key 打进镜像。
- 多轮/多会话、没有 PVC：每会话一个 S3 前缀，turn 边界同步；需要透明 POSIX 时再用 FUSE sidecar。不要把应用容器变成特权容器。
- 不可信代码：优先 S3 同步；FUSE 只放在专用 sidecar，并给这个 namespace 单独的 PSA 例外；应用容器保持无特权。
- 只读共享数据（模型/数据集/技能包）：init container 预拉，或任务内直接用对象存储 SDK；不要每个沙箱复制一份。

FUSE sidecar 的最小形态：

```yaml
volumes:
  - name: fuse
    hostPath: { path: /dev/fuse, type: CharDevice }
  - name: workspace
    hostPath: { path: /var/lib/opensandbox/workspaces, type: DirectoryOrCreate }
containers:
  - name: s3fs
    image: your-image-with-s3fs
    securityContext:
      privileged: true
    volumeMounts:
      - { name: fuse, mountPath: /dev/fuse }
      - { name: workspace, mountPath: /workspace, mountPropagation: Bidirectional }
    command: ["s3fs", "bucket:/prefix", "/workspace", "-o", "passwd_file=/etc/s3fs/passwd", "-o", "allow_other"]
  - name: app
    image: your-runtime
    volumeMounts:
      - { name: workspace, mountPath: /workspace, mountPropagation: HostToContainer }
```

这个形态依赖 `hostPath` 和 privileged sidecar，Pod Security Standards 会拦；没有这些条件时用 S3 同步。实际路径要按 Pod UID 或 sandbox ID 分目录，并在回收时清理。`passwd_file` 由 Secret 挂载，不要把凭证写进镜像；R2/OSS 还要按供应商加 `-o url=...`。注意 `allow_other` 需要 `user_allow_other`；sidecar 要保活并做 readiness/liveness，退出前要 unmount，避免 hostPath 上留下悬挂挂载；`s3fs` 的元数据操作和 rename 语义与本地盘不同，写多的工作区更适合 S3 同步而不是 FUSE。同步方案要明确冲突策略：单写者、按会话前缀隔离、避免 `--delete` 误删，必要时用版本化 bucket 兜底。

### 6.8 多轮 / 多会话下的池化限制

池化适合单轮短任务；多轮/多会话会把它的三个前提打破：

| 池化假设 | 多轮/多会话下的问题 | 后果 |
|---|---|---|
| 固定 `PodTemplate` | claim 时不能换卷、换 `subPath` | 每会话独立 PVC 挂不进去 |
| Pod 用完回收 | 任务结束就清空、归还 | 下一轮可能落到另一个 Pod，工作区丢了 |
| Pod 名是生成的 | 分配是临时的 | 会话到 Pod/卷的映射不稳定 |
| 池子按短任务周转 | 长会话占着 Pod | 短任务被挤掉，池子有效容量下降 |

两条可行路线：

**路线 A：双平面。** 短任务平面继续用 Pool + 无状态执行；会话平面用非池化 `BatchSandbox` 或长驻 Sandbox，稳定 sandbox ID + 每会话工作区（PVC 或对象前缀）+ TTL。第一轮可以借 Pool 的预热 Pod，之后转为会话 Pod，不再回收。代价是会话 Pod 启动比 Pool 慢。

**路线 B：池化 + 租约/提升。** 第一轮从 Pool 拿 Pod，claim 后标记为 `reserved`，池控制器跳过它，不回收；会话结束跑清理钩子，再归还。模板挂共享 RWX PVC 根，按 session 建子目录。需要控制器补三件事：`reserved`/lease 状态和 TTL；回收策略识别“会话占用”；会话结束时的工作区清理/归档。这条路只适用于共享 RWX PVC + 子目录或对象存储前缀；每会话 RWO PVC 在预创建 Pod 里挂不进去。

会话工作区的三种形态：

| 形态 | 池化兼容 | 隔离 | 代价 |
|---|---|---|---|
| 共享 RWX PVC + 每会话子目录 | 是 | 路径级，不是安全边界 | 目录清理、并发写、元数据 IOPS |
| 每会话 RWO PVC | 否，需非池化 | 卷级 | PVC/PV 数量、CSI attach、节点钉死 |
| 对象存储前缀 + 任务边界同步 | 是 | 前缀 + 业务鉴权 | 每轮再水合成本；大工作区不适合 |

容量和生命周期：

- 会话 Pod 和短任务 Pod 分池或分 quota，避免长会话把短任务池占满。
- 间隔短、工作区大，就保留 Pod；间隔长、工作区小，就释放并在下一轮再水合。可以用一个简单成本模型判断：

```text
保留成本 = 空闲内存 × 间隔时间
重建成本 = 再水合时间 × 用户等待成本 + 传输/请求成本
```

- 工作区在本地盘，就在 turn 边界落一次；工作区在共享 PVC，写入本身已经持久化，不需要每 turn 全量上传。
- 如果平台支持 pause，只保留磁盘/工作区、不保留内存，对“代码执行环境”够用；下一轮重新起进程，从 PVC 恢复工作区。

## 7. 对 OpenSandbox 的建议

### 7.1 定位与持久化契约

先把业务定位写清楚：**沙箱只承载代码执行，agent 循环和会话状态留在业务层；持久化只到特定工作区文件和产物，rootfs 重启或释放即清空，不需要内存快照或整机快照。** 这个契约决定了：

- E2B/Modal/Daytona 的内存快照、整机休眠、fork 不是核心参考；
- 工作区用 CSI PVC/共享存储或对象存储前缀，rootfs 保持只读镜像 + writable overlay/`emptyDir`；
- 每次任务结束立即回收计算，数据留在外部存储；
- 密度主线是“薄执行环境 + 状态外置 + 池化按并发 + 隔离分级”。

如果业务只要求任务结束有产物，按 turn 全量 S3 保存可以退化成任务结束一次上传；如果要求 turn 级崩溃恢复，才需要本地热层 + 增量 checkpoint。这个契约比选 PVC 还是 S3 更重要。

### 7.2 目标架构

- **执行**：无特权容器或 gVisor + 薄镜像 + execd；不放 agent runtime、不放 sidecar、不在沙箱里跑 FUSE。
- **状态**：共享只读 PVC/CSI 放模型、数据集、技能包；每沙箱工作区用共享 RWX PVC 加子目录，或 S3/OSS 前缀；本地 `emptyDir` 做 scratch；任务结束上传产物。没有 CSI/PVC 供应商时，用 S3 同步 init/sidecar 做任务边界同步；需要透明 POSIX 时用专用 FUSE sidecar，应用容器保持无特权。
- **池化**：PodTemplate 挂共享 PVC 根，claim 时建子目录；需要独立卷的任务走非池化。
- **会话**：多轮/多会话走非池化 Sandbox + 稳定 ID + 每会话 PVC/对象前缀 + TTL；第一轮可借 Pool 预热；如果一定要池化，做 lease/reserved + 共享 RWX PVC。
- **权限**：应用 Pod 保持无特权；CSI node plugin 持有挂载权限；不在沙箱里给 `SYS_ADMIN` 或 `/dev/fuse`。

### 7.3 密度动作

1. **把 agent runtime 移出沙箱。** 沙箱里只留 execd 和用户代码，agent 循环、会话记忆、WebSocket、编排都留在业务层。这一刀通常能把单沙箱基线从 1 GiB 级降到几百 MiB 级，是最大的密度杠杆。
2. **把工作区移出容器。** 容器无状态化，重建不用全量拉 S3；共享只读层让模型、数据集、技能包只存一份；每沙箱 `subPath` 承担写。PVC 在这里的作用是“让计算可以随便死”，密度收益来自更小的临时盘、更快的重建和节点内页缓存复用。
3. **把多余运行时移出镜像。** 按语言/任务拆池，去掉浏览器、桌面、dev server、不必要的 sidecar；egress 用 NetworkPolicy 替代 sidecar。
4. **把空闲沙箱移出池子。** Pool 按并发而不是注册用户数建；短 TTL、任务结束立即回收；warm buffer 只留突发 headroom。
5. **隔离分级。** 内网可信代码用容器或 gVisor；不可信代码再上 microVM；纯函数工具走 Wasm/isolate。
6. **调度右尺寸。** request/limit 按实测 p95 工作集定；bin packing 减少碎片；注意 `max-pods`、etcd 写放大、CNI 端口和 PID 上限，这些可能比内存更早成为瓶颈。
7. **共享只读层和页缓存。** 同节点多个沙箱共享基础镜像层、共享只读 PVC；避免每个沙箱复制一份大数据集。
8. **快照只给重运行时。** 短任务代码执行优先 warm pool + 快速镜像加载；内存快照留给 torch、浏览器、编译器等启动成本高的场景，而且要与“只保工作区文件/产物”的契约分开评估。

先盘一次每个 pool 的 `requests` vs p95 usage、OOM/驱逐率、CPU throttling、空闲沙箱占比；大概率最大的密度倍数来自 request 右尺寸、空闲回收和降基线，而不是换隔离技术。

### 7.4 Wasm 的边界

- Wasm 的轻量只在 WASI 能力面内成立。企业业务会要 Python C 扩展、native 二进制、Node addon、JVM/.NET、shell、编译器、浏览器、长驻服务；这些一出现就得回到 Linux 容器。
- Wasm 适合纯函数、MCP 工具、数据变换、策略过滤这类稳定窄场景；主路径保持容器/gVisor，Wasm 只做特定工具调用的旁路。
- 每 turn 的 S3 快照和 turn 内保活是数据/生命周期成本，Wasm 只缩小执行单元；如果数据路径是瓶颈，Wasm 的收益会被吞掉。双路径还会拆池、加 headroom，实际密度可能不升反降。

### 7.5 落地顺序

| 阶段 | 动作 | 验收 |
|---|---|---|
| P0 | 盘 requests vs p95 usage、OOM/驱逐、CPU throttling、空闲沙箱占比；把 agent runtime、sidecar、无关运行时从沙箱镜像里拿掉 | 单沙箱基线下降；同节点可调度沙箱数上升；p95 尾延迟不退化 |
| P1 | 工作区迁到 CSI PVC 或共享 RWX PVC + 子目录；共享只读 PVC 放模型/数据/技能；本地 scratch + 任务结束产物上传 | 重建不再全量拉 S3；工作区在 Pod 重建后可见；PVC/CSI 权限不进入应用容器 |
| P2 | 短任务 Pool 与会话平面分开；会话用稳定 ID + 每会话工作区 + TTL；需要时做 Pool lease/reserved + 共享 RWX PVC | 长会话不挤占短任务池；会话跨 turn 可见；池子有效容量可预测 |
| P3 | 按信任级别引入 gVisor/microVM；Wasm 只在窄工具场景试点 | 隔离级别与代码来源匹配；Wasm 不引入第二套通用运行时 |

## 8. 参考链接

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
- https://developers.cloudflare.com/sandbox/files/mount-an-r2-bucket/
- https://developers.cloudflare.com/sandbox/concepts/security/
- https://developers.cloudflare.com/sandbox/reference/directory-backups/
- https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/
- https://github.com/cloudflare/computer
- https://github.com/cloudflare/ci
- https://github.com/cloudflare/artifact-fs
- https://github.com/cloudflare/cloudflare-os
- https://github.com/cloudflare/kitesurf
- https://github.com/cloudflare/serverless-registry
- https://developers.cloudflare.com/artifacts/

**市面沙箱与密度参考**

- https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md
- https://modal.com/blog/mem-snapshots
- https://modal.com/blog/scaling-to-1-million-concurrent-sandboxes-in-seconds
- https://www.daytona.io/dotfiles/vms-pause-and-fork
- https://vercel.com/docs/vercel-sandbox
- https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/
- https://fly.io/docs/machines/
- https://blaxel.ai/
- https://docs.runloop.ai/
- https://github.com/kubernetes-sigs/agent-sandbox
