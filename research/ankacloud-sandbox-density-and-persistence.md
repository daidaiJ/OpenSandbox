# AnkaCloud：沙箱高密度与文件产物持久化设计

> 调研对象：`github.com/tao12345666333/ankacloud`，`main` @ `052c04f`（2026-11-28）。
> 方法：阅读源码、单元测试与 `docs/`；仓库多处引用未提交的 `docs/DESIGN.md`，本文不以该文档为依据。
> 术语：AnkaCloud 是控制面；AnkaLoop 是沙箱内运行的 agent 运行时，二者是不同的项目。

## 结论

1. **AnkaCloud 的“高密度”落在控制面生命周期层**：它让沙箱按 turn 存活、空闲即回收、丢失可重建；单台主机能放多少沙箱由 E2B/Tenki/Runta 决定。仓库内没有自研的 microVM 调度器、内存超分或主机级装箱逻辑。
2. **密度来自“租约 + 回收 + 可重建”**：沙箱创建时带 TTL，运行中的 turn 续租；空闲后暂停或杀死；paused 超过 24 小时也杀死；下一轮从控制面的 session backup 重建。provider 自身的 TTL 是控制面失联时的兜底。
3. **能力矩阵替代 E2B 假设**：provider 显式声明 `pause`、`files`、`sizing`、`network_rules` 等能力；没有 `pause` 的 runtime 走 kill + restore，不会因为缺少某项能力而不可用。
4. **持久化边界分为四层**：会话快照、记忆/人格/技能、事件日志、Git 代码产物。普通工作区文件不在自动持久化范围内；它们随沙箱 `pause` 暂时保留，随 `kill` 丢失。
5. **没有通用 artifact store**：文件读取 API 只在沙箱 `running` 时从 live sandbox 读取文本；没有上传、列表、二进制或长期保留能力。需要保留的代码产物必须 commit/push 到 Git。

---

## 1. 密度模型：线程是持久身份，沙箱是临时算力

一条 thread 对应一个云沙箱，沙箱内运行 `anka serve`；控制面只负责线程注册、沙箱生命周期、消息中继、事件分发和记忆持久化。Home agent 常驻控制面且没有沙箱，只有需要 shell 的工作才进入沙箱（[docs/architecture.md:26-51](https://github.com/tao12345666333/ankacloud/blob/052c04f/docs/architecture.md#L26-L51)）。

沙箱状态机是：

```text
none -> creating -> running -> paused -> killed
```

线程的 `agent_state` 是 `idle | running | cancelling | error`（[threads.py:1-7](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/threads.py#L1-L7)）。两个状态分开，使“线程存在”与“沙箱活着”解耦。

按密度层次拆分：

| 密度层次 | 实现方 | 机制 |
|---|---|---|
| 线程 / 控制面密度 | AnkaCloud | 单进程、SQLite、异步事件循环、按 thread 串行 turn、事件合并 |
| 计费沙箱密度 | AnkaCloud | 空闲 pause/kill、paused 超时 kill、turn 续租、孤儿清理 |
| 单机沙箱密度 | E2B / Tenki / Runta | microVM / VM 的隔离、快照、资源超卖与宿主调度 |

AnkaCloud 优化前两类；第三类由 provider 提供。

## 2. 回收器：密度的核心

`Reconciler` 每 60 秒扫描一次线程（[reconciler.py:39-48](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/reconciler.py#L39-L48)、[reconciler.py:82-148](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/reconciler.py#L82-L148)）：

| 场景 | 动作 | 默认参数 |
|---|---|---|
| turn 正在运行 | 调用 `extend_timeout` 续租，避免被 provider 回收 | 每 tick |
| 空闲 running | 有 `pause` 能力则暂停；否则直接 kill | 空闲 10 分钟 |
| paused | 用 `kill_id` 直接杀，不先 resume | 暂停 24 小时 |
| sandbox 丢失 | 下一条消息重建，并从控制面恢复会话 | connect 失败即标记 killed |
| archived | 杀掉归档后泄漏的沙箱 | 尽力而为 |
| 孤儿沙箱 | 账户级扫描，终止没有线程引用的沙箱 | 每 10 分钟，15 分钟宽限 |

参数来自 `sandbox/settings.py:17-25`：`SANDBOX_TIMEOUT_SECONDS=600`、`IDLE_PAUSE_MINUTES=10`、`PAUSED_KILL_HOURS=24`。这些值可以在 Web UI 覆盖。

这里的关键是**租约**：沙箱创建时带 TTL，运行中的 turn 每个 tick 续租；空闲后停止续租并暂停/杀死。provider 自身的 TTL 是控制面失联时的兜底：

- E2B：`create(timeout=...)`，运行中由 `set_timeout` 延长（[e2b.py:270-278](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/e2b.py#L270-L278)）。
- Tenki：`max_duration = max(timeout, 900) * 6`，并且**永不 sticky**，控制面挂掉后平台也能回收；运行中 `extend`（[tenki.py:43-49](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/tenki.py#L43-L49)、[tenki.py:240-259](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/tenki.py#L240-L259)）。
- Runta：`auto_shutdown_after_secs`，运行中更新 timeout policy（[runta.py:205-218](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/runta.py#L205-L218)、[runta.py:248-260](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/runta.py#L248-L260)）。

孤儿清理只对能枚举账户沙箱的 provider 生效：Tenki 实现了 `list_unreferenced`，会列出 `CREATING/RUNNING/PAUSED/PAUSING/RESUMING` 状态并排除仍被线程引用的会话（[tenki.py:53-60](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/tenki.py#L53-L60)、[tenki.py:270-301](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/tenki.py#L270-L301)）。E2B 和 Runta 没有实现这个接口，分别依赖自身 TTL 和 `auto_shutdown`。

## 3. Provider 能力与密度经济学

`catalog.py` 为每个 provider 声明能力：`pause`、`files`、`fs_home`、`ports`、`shell_sudo`、`exec_env`、`resize`、`sizing`、`templates`、`network_rules`（[catalog.py:25-38](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/catalog.py#L25-L38)）。控制面先查能力，再决定降级路径。

| Provider | pause | 空闲策略 | 状态保留 | 关键限制 |
|---|---|---|---|---|
| E2B | 支持 | 暂停，24 小时后 kill | 文件系统 + 内存快照 | 暂停快照仍计费；机器尺寸在模板构建时固定 |
| Tenki | 不支持 | 直接 kill | 只靠控制面 session backup | 暂停会保留内存 checkpoint，成本不低，因此不声明 pause |
| Runta | 支持 | 暂停 | 进程和文件系统都保留，connect 时自动 resume | exec 在 paused 状态返回 409，所以 connect 先 resume |

Tenki 的取舍很典型：它宁可在空闲时 kill，也不愿为每个空闲线程保留内存 checkpoint（[catalog.py:167-177](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/catalog.py#L167-L177)、[tenki.py:11-15](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/tenki.py#L11-L15)）。这牺牲了热启动，换取了更低的空闲内存占用。

E2B 的 `pause` 保留文件系统和内存，但暂停快照仍然收费；所以回收器不会无限保留 paused 沙箱，24 小时后杀掉，下一轮从 session backup 重建（[reconciler.py:1-12](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/reconciler.py#L1-L12)）。

Runta 的 pause 会保留进程和文件系统，适合需要热状态的短间隔复用；但 exec 在 paused 状态返回 409，所以 `connect` 会先 resume 再返回可用 handle（[runta.py:10-25](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/runta.py#L10-L25)、[runta.py:236-245](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/runta.py#L236-L245)）。

## 4. 冷启动、镜像与控制面

### 4.1 E2B 模板只解决工具链

E2B 的机器尺寸在模板构建时固定，create 请求没有 CPU/内存字段。仓库的模板默认是 2 vCPU / 4 GiB，预装 git、gh、Go、Python、Node、uv 和 C 工具链；E2B 官方基础镜像是 2 vCPU / 512 MiB（[deploy/template/build.py:1-19](https://github.com/tao12345666333/ankacloud/blob/052c04f/deploy/template/build.py#L1-L19)、[catalog.py:151-154](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/catalog.py#L151-L154)）。

但模板**不预装 AnkaLoop**。每次 create 后，bootstrap 脚本会在沙箱里用 `uv` 安装 `ankaloop` 并启动 `anka serve`（[e2b.py:39-52](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/e2b.py#L39-L52)、[e2b.py:239-266](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/e2b.py#L239-L266)）。原因是 E2B 模板的 start command 拿不到 create 时注入的 `ANKA_API_KEY`，预启动的 server 会没有认证。这个选择保证了鉴权正确性，代价是每次冷启动都有一次 PyPI 安装；当前代码没有 warm pool 或预创建逻辑。

Tenki 和 Runta 的运行时脚本也走类似的“启动时安装/启动”路径，只是各自处理了用户、home 目录和进程 detach 的差异（[tenki.py:61-80](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/tenki.py#L61-L80)、[runta.py:38-55](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/sandbox/runta.py#L38-L55)）。

### 4.2 控制面密度

控制面是单 FastAPI 进程：Web API、memory API、reconciler、Telegram、home agent、dreamer 都在同一个事件循环里，没有 Redis 或消息队列（[docs/architecture.md:26-33](https://github.com/tao12345666333/ankacloud/blob/052c04f/docs/architecture.md#L26-L33)）。它用 SQLite WAL + `synchronous=NORMAL` 承受流式写入（[store.py:138-149](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/store.py#L138-L149)），并对事件做了两层削减：

- `chunk` 从不入库，只保留 turn 结束时的完整 `assistant.message`；
- `reasoning` 按 4 KiB 或 250 ms 合并成一行，避免每个 token 一次 commit（[events.py:1-16](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/events.py#L1-L16)、[events.py:29-50](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/events.py#L29-L50)）。

这套设计支撑的是“一个用户、很多线程”的密度，而不是多租户集群。它的上限也很明确：

- `Reconciler.tick` 每 60 秒拉取最多 10 万条线程并顺序处理，provider 调用是串行的；
- Store 是单连接 + 单写锁，所有写事务串行；
- SQLite 和记忆文件都在本地卷，没有水平扩展或 HA；
- 没有主机级 bin-packing、内存超分或快照去重；这些由 E2B/Tenki/Runta 提供。

## 5. 文件产物持久化：四层边界

先区分“文件”的几种含义：

| 对象 | 是否自动持久化 | 位置 | 丢失后果 |
|---|---|---|---|
| 工作区普通文件 | 否 | 沙箱磁盘 | 未 commit 的改动丢失 |
| Agent 会话快照 | 是 | 沙箱 JSON + SQLite `session_backup` | 对话上下文重新开始 |
| 对话 / 工具事件 | 是 | SQLite `events` | UI 历史缺失，agent 上下文不受影响 |
| 记忆 / 人格 / 技能 | 是 | 控制面 `ANKACLOUD_CONFIG_DIR` | 跨线程记忆和人格丢失 |
| 代码产物 | 通过 Git | GitHub 分支 / PR | 未 push 的提交丢失 |
| 凭据 | 部分 | 控制面 SQLite / E2B egress | 不影响文件产物 |

### 5.1 会话快照：唯一自动从沙箱回传的文件级状态

AnkaLoop 的会话文件路径是：

```text
/home/user/.config/ankaloop/sessions/{thread_id}.json
```

（[runner.py:33-35](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L33-L35)）

备份流程：

1. 每轮 turn 结束，`ThreadService._run_turn_inner` 调用 `runner.backup_session(thread)`；恢复出来的 turn 和归档也会调用（[threads.py:543-558](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/threads.py#L543-L558)、[threads.py:756-761](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/threads.py#L756-L761)、[threads.py:828-836](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/threads.py#L828-L836)）。
2. `backup_session` 连接沙箱，执行 `cat` 读取该 JSON，写入 SQLite 的 `threads.session_backup` 字段（[runner.py:834-851](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L834-L851)）。
3. 沙箱重建时，`_ensure_session` 先 `GET /sessions/{id}`；404 则把备份写回文件，再 `POST /sessions`，AnkaLoop 会按同一个 `session_id` 加载该 JSON（[runner.py:663-692](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L663-L692)）。
4. 恢复前比较 `revision`，避免旧备份覆盖沙箱里更新的会话；磁盘文件缺失或不可读时，备份优先（[runner.py:693-712](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L693-L712)）。
5. paused 沙箱恢复时，`_restore_missing_session` 会在 `ensure_ready` 重建 session 之前把备份放回去（[runner.py:311-330](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L311-L330)）。

这个设计的优点是：**沙箱可以从零重建，而 agent 的对话上下文不丢**。会话快照与 provider 无关，所以 E2B、Tenki、Runta 都能用同一套恢复路径。

它的边界也很明确：

- 备份粒度是“每轮结束”，不是“每步”或“实时”。如果沙箱在 turn 执行中被 pause/kill，当前 turn 的 session 文件可能还没写入；代码会在恢复时明确提示 “session file missing and no backup; the conversation starts over”（[runner.py:333-357](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L333-L357)）。
- 备份是 best-effort，失败只记日志，不阻塞 turn 完成。
- `backup_session` 直接保存 `cat` 的 stdout，没有 JSON 校验、大小限制或哈希校验。
- `session_backup` 存在 `threads` 主表里，`get_thread` 会读取 `t.*`；而 `ensure_ready` 每轮都会 `get_thread` 刷新沙箱字段，所以高频路径会反复加载这个可能达到数百 KB 的 blob。列表视图专门排除了它（[store.py:297-309](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/store.py#L297-L309)），但单线程热路径仍在读。

### 5.2 记忆、人格、技能：控制面是唯一源，沙箱只拿只读副本

控制面的 `ANKACLOUD_CONFIG_DIR`（默认 `~/.config/ankaloop`）保存：

- `MEMORY.md`：全局长期记忆；
- `SOUL.md` / `IDENTITY.md`：人格；
- `skills/`、`commands/`、`hooks/`、`agents/`、`AGENTS.md`：能力定义；
- `memory.db`：facts 和可搜索的事件日志。

沙箱创建时，`push_profile` 把这些内容打成 tar.gz 写进沙箱，并写入该 thread 的 `config.toml`；`config.toml` 包含 LLM provider、memory token 和 MCP server 配置，权限设为 0600（[memory/profile.py:19-29](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/memory/profile.py#L19-L29)、[memory/profile.py:89-122](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/memory/profile.py#L89-L122)）。

沙箱内的 memory 不直接写本地文件，而是通过 HTTP memory API 回到控制面：

- 每个 thread 只拿到 `HMAC(token, thread_id)`，只能访问自己的 thread 作用域；
- `MEMORY.md` 写入落到 `memory/threads/<thread_id>/MEMORY.md`，不会直接改全局 `MEMORY.md`；
- facts 是全局的，但 thread 只能写 `<key>@<thread_id>` 命名空间；
- persona 对沙箱只读；
- thread 归档后 token 失效（[memory/api.py:1-55](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/memory/api.py#L1-L55)、[memory/api.py:106-112](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/memory/api.py#L106-L112)、[memory/api.py:196-217](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/memory/api.py#L196-L217)）。

Dreamer 定时或归档时把 thread 的结论折叠回全局 `MEMORY.md`。它会过滤掉沙箱写入的原始事件，避免某个沙箱把自己的文本直接提升为全局记忆（[memory/dreamer.py:1-36](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/memory/dreamer.py#L1-L36)、[memory/dreamer.py:190-209](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/memory/dreamer.py#L190-L209)）。

这里有一个重要的一致性取舍：**profile 只在沙箱创建时推送，resume 不会重新推送**。因此运行中的沙箱会继续使用它创建时的 skills、config.toml 和 MCP server；在 Web UI 修改 skills 或 MCP，只对之后新建的沙箱生效。如果 thread 绑定了一个新 skill，下一轮 prompt 前缀可能已经带上它，但旧沙箱磁盘上并没有这个文件（[runner.py:190-199](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L190-L199)、[threads.py:313-321](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/threads.py#L313-L321)）。

### 5.3 代码产物：通过 Git 外部化

需要写代码的 thread 会把仓库 clone 到 `/home/user/workspace/repo`，创建 `anka/<thread>-<slug>` 分支，执行 `.agents/setup`；pause 恢复后执行 `.agents/resume`（[runner.py:602-626](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L602-L626)、[threads.py:163-166](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/threads.py#L163-L166)）。

真正的持久化发生在 GitHub：

- GitHub token 通过 E2B egress proxy 注入，沙箱里只有占位符；
- commit identity 和 `Ankacloud-Thread` trailer 由控制面写入 `.gitconfig` 和 hook；
- agent 自己执行 `git commit` / `git push` / `gh pr create`。

因此代码产物的持久性取决于**是否 push 到远端**。普通工作区文件没有 snapshot 或 tar 回传逻辑；沙箱被 kill 后，新沙箱只会重新 clone，未提交的改动会丢失。会话快照能恢复 agent 的对话上下文，但不会恢复工作区文件。

### 5.4 事件日志：可回放，但不是 agent 上下文

SQLite 的 `events` 表保存用户消息、assistant 完整回复、turn 状态、tool 调用元数据等；`chunk` 不入库，`reasoning` 合并后入库。Web UI 的 SSE 可以从 `after_seq` 回放历史（[store.py:79-105](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/store.py#L79-L105)、[events.py:1-16](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/events.py#L1-L16)）。

当 prompt 流中断时，控制面会从沙箱的 timeline 回填丢失的 tool 事件（[threads.py:705-754](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/threads.py#L705-L754)）。这让 UI 在断流后仍能显示完整 turn，但事件日志不是重建 agent 会话的来源；agent 上下文只认 `sessions/<id>.json`。

### 5.5 备份模型

真正需要备份的只有两个东西：

```text
ankacloud.db              # threads, events, settings, providers, session_backup
.config/ankaloop/         # memory, persona, skills, config
```

（[docs/deployment.md:110-129](https://github.com/tao12345666333/ankacloud/blob/052c04f/docs/deployment.md#L110-L129)）

沙箱本身不在备份范围内，因为它们被设计成可丢弃、可重建。控制面也没有对象存储；所有持久化状态都在本地 SQLite 和本地文件系统。

## 6. 设计取舍与风险

### 6.1 做得好的地方

- 用能力矩阵而不是 E2B 专属接口，provider 可以替换；没有 `pause` 的 runtime 也能通过 kill + session restore 工作。
- 回收器和 provider TTL 形成双层兜底：控制面挂了，平台仍会回收沙箱。
- 会话快照与 provider 解耦，使“沙箱可丢弃”成为可执行的约束。
- memory API 做了 thread 级隔离、归档失效、facts 命名空间和 persona 只读，权限边界清楚。
- 事件层对 chunk/reasoning 做了削减，避免流式 token 把 SQLite 写爆。

### 6.2 边界与实现风险

1. **没有通用文件产物存储。** `/api/threads/{id}/files/{path}` 只在沙箱 `running` 时从 live sandbox 读取文本，没有上传、列表、二进制或持久化能力（[web/routes.py:663-677](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/web/routes.py#L663-L677)）。如果 agent 产出二进制、构建物、截图或数据集，这套架构不会保留它们。
2. **会话快照的粒度是每轮结束。** 中途被 kill 的 turn 可能没有快照；备份失败只记日志；备份内容是 `cat` 的原始 stdout，没有完整性校验。
3. **`session_backup` 放在 threads 主表里。** 高频的 `get_thread` 会读取大字段；线程数多、会话大时，这会成为 SQLite I/O 和内存的瓶颈。更合适的是独立 blob 表或对象存储。
4. **归档暂停中的沙箱可能先 resume 再 kill。** `ThreadService.archive` 先 `backup_session` 再 `runner.kill`，两者都会 `connect`；对 E2B/Runta 的 paused sandbox，这等于先恢复再销毁。代码已有 `kill_id` 可以避免 resume，但归档路径没有使用它（[threads.py:828-836](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/threads.py#L828-L836)、[runner.py:895-901](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L895-L901)、[runner.py:881-889](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/runner.py#L881-L889)）。
5. **启动时没有 provider key，回收器会永久退出。** `Reconciler.run_forever` 在启动时检查一次 provider 可用性；如果首次安装还没有配置 key，它直接 return。之后在 Web UI 添加 provider 不会重新启动回收器，必须重启进程，空闲沙箱也就不会被暂停/清理（[reconciler.py:73-77](https://github.com/tao12345666333/ankacloud/blob/052c04f/ankacloud/reconciler.py#L73-L77)）。
6. **profile 漂移。** resume 不重新推送 skills/config/MCP，暂停中的沙箱可能继续使用旧配置，最长到 `PAUSED_KILL_HOURS`。这是有意的成本取舍，但会让“控制面是唯一源”在运行中的沙箱上出现时间窗口。
7. **单节点上限。** SQLite 单写锁、本地记忆文件、O(N) 的 reconciler tick，决定了它适合单用户/小团队，不适合多租户高并发控制面。

## 7. 对 OpenSandbox 的可借鉴点

1. **能力矩阵 + 回收器**：把 `pause`、`files`、`sizing`、`network_rules` 等能力显式声明，回收器按能力选择 pause 或 kill，而不是假设所有 runtime 一样。
2. **会话快照与沙箱解耦**：沙箱可以随时销毁，下一轮从控制面恢复 agent 会话；恢复时做 revision 比较，避免旧备份覆盖新状态。
3. **控制面持有记忆，沙箱只做读写客户端**：thread 级 token、per-thread notes、全局 facts、归档失效，形成清晰的权限边界。
4. **代码产物外部化**：把 Git 远端/PR 当作 durable artifact store，沙箱只负责计算，不承担长期存储。

需要补足的是**通用文件产物层**：如果 agent 会产出非代码文件，建议在 turn 结束时生成 workspace manifest，把新增/修改文件按内容寻址写入对象存储，并在 thread 记录里保存 manifest 引用；同时把 `session_backup` 从 threads 主表拆到独立 blob 表，避免热路径读取大字段。
