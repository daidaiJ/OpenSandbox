---
name: execd-init-rollout-guide
description: execd init 模式（OSEP-0018）实施指导——池模式视角：逐项能力收益判定、显式成本账、分步落地；附命令执行审查与网络审查指导
type: project
---

# execd init 模式实施指导（OSEP-0018）——池模式视角

> 调研日期：2026-09-11
> 版本基线：上游 `upstream/main`（OSEP-0018，status: **implementing**，Phase 1–5 + server 开关 + 测试已完成；**默认关闭**，R-f 留待生产验证后决定）。
> 🚧 上游功能仍在演进（R-e/R-f/R-g 未完结），需回访同步本文档。
> 关联文档：[池模式沙箱 Pod 边车组件介绍与实践指导](opensandbox-pool-sandbox-sidecar-components-guide.md)、[K8s NetworkPolicy vs Egress 边车方案对比](opensandbox-k8s-networkpolicy-vs-egress-sidecar.md)、[Egress 出口管控与 Credential Vault SOP](opensandbox-egress-netpol-vault-sop.md)、[隔离会话池化启用评估](opensandbox-isolated-sessions-pool-mode-enable-and-assessment.md)。

## 〇、业务前提（本文所有判定基于此）

- **池化是主路径**：Pool + BatchSandbox + taskTemplate，用完即焚、短 TTL、重建优于快照；**没有 pause/resume/snapshot**。
- **节点资源受限**：服务更多用户 > 单会话时长；质量稳定 > 密度。任何 per-sandbox 常驻开销都要过"值不值"这一关（与决策 D"池化不上 egress sidecar 省内存"同一标准）。
- **产物链路独立于退出路径**：S3 中间件的静默回写走**固定 postStop 钩子**，不依赖 entrypoint 自身优雅退出。
- **租户控制在业务层**，namespace 审批制、数量少；K8s 任务路径**不上报容器退出码**给业务层（task-executor 轮询 task 状态）。

---

## 一、模式机理速览

**默认模式**：`bootstrap.sh` 把 execd 后台化（`"$EXECD" &`），shell 当容器 PID 1——孤儿进程没人收割、退出码经脚本 wait 循环转手、用户代码继承容器全量 caps。

**Init 模式**：`bootstrap.sh` 末尾 `exec "$EXECD" --init -- <用户命令>`（`components/execd/bootstrap.sh:526`），execd 成为 PID 1：单一 reaper 收割全部子进程与孤儿（SIGCHLD + 200ms 兜底）；SIGTERM 转发给 entrypoint 进程组→停其余子进程→以 entrypoint 退出码退出容器；`kill -9 1` 因 PID 1 信号屏蔽无效；同时**激活 hardening 地板**——所有用户代码进程经同一条 launcher 启动（剥凭证 env→削 caps→`no_new_privs`→降 uid→Landlock→seccomp 最后装）。

非 PID 1 自动退化为 **subreaper**（只收割自己子树、无信号屏蔽），capabilities 端点如实上报 `pid1 | subreaper | none`。

## 二、池模式适用性：逐项能力收益判定（核心）

我们只有两条真实路径：**A = Pool task 沙箱（server 开关，subreaper 模式）**；**B = Pool pod template 改造（PID 1）**。Docker/BatchSandbox 路径与本文相关性低（附录 A 简述）。

| 能力 | 机制 | 路径 A（task/subreaper） | 路径 B（模板/PID 1） | 池模式收益判定 |
|---|---|---|---|---|
| 僵尸收割 | 单一 reaper + 孤儿收割 | ✅ task 子树 | ✅ 全容器 | **中**。短 TTL 单任务本身 fork 量小；但 agent 循环高频 `/command` 的沙箱会持续泄漏孤儿。进程表有界对共享节点是保护性收益（一台失控不拖垮整节点其他池） |
| 削 caps + seccomp 地板 | launcher 统一启动 | ✅ 全部用户代码进程 | ✅ | **高（最高优先）**。"AI 生成代码"与控制平面权限持平是当前最大缺口；纯启动路径改动，**零常驻内存开销** |
| Landlock FS 限制 | launcher 内 apply | ✅ | ✅ | **中高**。敏感数据内网场景的纵深防御；但有内核 ≥5.13 与镜像兼容性前提（§三） |
| 凭证 env 剥离 | launcher/entrypoint 启动时 unset | ✅ | ✅ | **高**。`EXECD_ACCESS_TOKEN` 等不再出现在用户代码环境，直接收窄"用户代码调控制平面 API"的攻击面 |
| `kill -9 1` 信号屏蔽 | PID 1 内核属性 | ❌ subreaper 无屏蔽 | ✅ | **中**。路径 A 拿不到；仅路径 B。对防用户代码打死沙箱有意义，但池化回收快、损失有限 |
| 优雅停机（SIGTERM 转发） | TERM→宽限→KILL→退出 | ⚠️ 仅 task 命令树 | ✅ | **低**。S3 回写走固定 postStop，不依赖 entrypoint 优雅退出；收益主要是长会话入口程序自身的 flush/reload，短任务用不上 |
| 容器退出码传播 | 128+signal 约定 | ❌ | ⚠️ Pod 层可见 | **≈0**。K8s BatchSandbox 不上报容器退出码，业务层判断任务成败走 task 状态，拿不到这个收益 |
| eBPF 审计（exec/connect/privilege） | cgroup 范围 JSONL | ✅（需 ebpf 变体） | ✅ | **按需**。敏感部门池的外连/exec 取证；有显式成本（§三），不作为默认项 |

**一句话结论**：池模式下的核心收益是**安全面收窄**（seccomp 地板 + 削 caps + 凭证剥离 + Landlock），而非生命周期管理（僵尸/退出码/优雅停机在短任务 + postStop 回写 + 退出码不上报的现实下收益有限）。这与上游把 init 模式当"安全基线"的定位一致，但**收益的兑现顺序和路径不同**。

## 三、成本账（显式列出，按我们的评判标准）

| 成本项 | 类型 | 量级/条件 | 影响路径 |
|---|---|---|---|
| hardening + reaper + Landlock 运行时开销 | 内存/CPU | **≈0 常驻内存**（纯启动路径改动，per-launch 微秒级 exec 链） | A、B |
| Landlock 内核门槛 | 环境预检 | 节点内核 ≥ **5.13**（我们内网节点需先盘点；5.10 节点上该层报 `unsupported` 跳过，fail-open 不报错） | A、B |
| 镜像兼容风险 | 业务回归 | Landlock 是纯 allowlist（系统路径+`/tmp`+workspace 可写），非常规工作负载（读非常见 `/proc`、特殊 `/dev`、非标路径缓存）可能被拒——用 `extra_writable/extra_readable` 补；fail-open 只覆盖**能力缺失**，不覆盖**策略过严** | A、B |
| `CAP_SETPCAP` 预检 | 环境预检 | bounding set 削减需要；缺失则降级（capabilities 端点可见） | A、B |
| PID 1 模板改造 | 运维 + 风险 | 改 Pool CR pod template（command/env）+ keepalive 逻辑 + 全池滚动重建；Restart 回收契约已验证兼容但需回归 | 仅 B |
| eBPF：权限面扩大 | 安全 | 容器需 `CAP_BPF`+`CAP_PERFMON`——**给沙箱容器提权本身与我们安全目标相悖**，需权衡（可考虑特权仅授予 ebpf 变体专用池模板） | A、B |
| eBPF：二进制选择未接线（R-e） | 工程 | 默认镜像含 `/execd-ebpf` 但 server 不选；需 env `EXECD=/execd-ebpf` 手工指定 | A、B |
| eBPF：常驻开销 | 内存/磁盘 | 每沙箱 1 个 ringbuf reader goroutine + 事件缓冲（单沙箱 MB 级以下）+ JSONL 轮转文件磁盘写——量级可接受，但**节点级文件增长要并入日志留存方案**（hostPath + 采集外送） | A、B |
| 灰度/回归成本 | 人力 | 双开关（server + TOML）联动、capabilities 端点验收、`/code`/PTY/egress MITM CA 回归 | A、B |
| SIGTERM 语义变化 | 运维 | 容器 SIGTERM 从"只关 HTTP"变为完整停机序列；依赖旧行为的脚本需回归 | A、B |

## 四、实施步骤（按收益/成本比排序）

### Step 1（默认做）：server 开关 + hardened TOML → 路径 A

服务端 `runtime.execd_run_as_init = true` + 最小 TOML（镜像不重打，经 `EXECD_ISOLATION_CONFIG` env / ConfigMap 挂载注入）：

```toml
[hardening]
enabled = true

[landlock]
enabled = true   # 内核 ≥5.13 才写这行；5.10 节点先不加
```

这一步拿到判定表里"高"的三项（seccomp 地板、削 caps、凭证剥离）+ task 子树收割，**零常驻内存成本**。Pool task 沙箱呈 subreaper 模式属预期（capabilities 端点 `init_mode: subreaper` 即正确）。

### Step 2（仅长会话池）：pod template 改造 → 路径 B

对长会话池（有信号转发、防 `kill -9 1`、全容器收割需求），在 Pool CR pod template：

```yaml
command: ["/bin/sh", "-c", "bootstrap.sh <keepalive/入口>"]
env:
  - { name: EXECD_INIT, value: "1" }
  - { name: EXECD, value: "/execd" }
```

保留 Restart 回收策略（上游 e2e 已验证 `kill 1` → 转发退出 → kubelet 重启容器的契约兼容）。**短任务池不做此步**——模板改造与滚动重建的运维成本换不来短场景收益。

### Step 3（按需）：eBPF 审计 → 敏感部门池

仅对有外连/exec 取证需求的池：ebpf 变体 + `CAP_BPF`/`CAP_PERFMON` 专用模板 + `[ebpf]` 段（`observe = ["exec","connect"]`），JSONL 落 hostPath 随日志采集外送（对齐[日志与产物留存方案](opensandbox-pool-log-artifact-retention.md)）。权限面扩大是反向安全成本，**不做全量铺开**。

### 验证与回滚（所有步骤通用）

- **验收凭据 = capabilities 端点** `GET /v1/isolated/capabilities`：`hardening.init_mode`（Step1 期望 `subreaper`、Step2 期望 `pid1`）、`signal_shield`、seccomp/landlock/ebpf 各层状态。init off + hardening on 会诚实报 degraded 并提示 EXECD_INIT（drift 检测上游 e2e 已覆盖）。
- **容器内速查**：`readlink /proc/1/exe`（路径 B 应指向 execd）。
- **回归重点**：Jupyter `/code`、PTY、egress MITM CA 安装（bootstrap 的 CA-trust 逻辑在 init 分支保留）、S3 中间件 postStop 回写全链路。
- **回滚** = 关 server 开关 + 摘 TOML（+ 还原模板），行为精确回到 background-and-wait；无需改镜像。
- **上游自带 e2e** 可直接借用：`tests/python/test_execd_init_e2e.py`、`test_execd_hardening_e2e.py`、`test_execd_k8s_restart_recycle_e2e.py`。

## 五、命令执行审查指导

init 模式把「execd 特权、子进程降权」推广到**所有**用户代码执行通道（entrypoint、`/command`、`/code`、PTY、隔离会话共用一条 launcher 原语——任何绕过路径都继承 execd 全量权限，这是审查要确认的不变量）。

| 手段 | 性质 | 成本 | 池模式用法 |
|---|---|---|---|
| seccomp denylist（内置 ~30 条：`mount`/`ptrace`/`bpf`/`unshare` 等） | 阻断 | 零（随地板生效） | 默认全量；注意 `[seccomp] deny` 是**替换不是合并**，自定义需从 example.toml 抄底；`execve` 被保留，写入即启动报错 |
| Landlock FS allowlist（系统路径 read+exec、`/proc/self`、`/tmp`、workspace） | 阻断 | 零；镜像兼容风险见 §三 | 默认全量（内核达标时）；不能"允许后排除"，额外路径走 `extra_writable/extra_readable` |
| eBPF exec 事件（filename/argv/ppid → JSONL） | 仅观测 | goroutine + 磁盘 + 提权 | 敏感池按需；argv 级记录满足"AI 生成代码跑了什么"的取证 |
| 隔离会话（bwrap overlay + diff 导出） | 强隔离 | 每会话 upper 目录 + 四前置 | 独立决策，见[隔离会话池化评估](opensandbox-isolated-sessions-pool-mode-enable-and-assessment.md)（结论：有条件可生产） |

边界认知：eBPF 只看不拦（拦截靠 seccomp + egress）；hardening 是运维/镜像级决策，**不是** `CreateSandboxRequest` 字段，业务层不能按请求开关。

## 六、网络审查指导

命令执行审查管"跑了什么"，网络审查管"连了哪里"。分层与决策 D 一致：

| 层 | 手段 | 审查能力 | 成本 | 池模式用法 |
|---|---|---|---|---|
| L3/L4 基线 | NetworkPolicy（池模板预置，podSelector 按 `sandbox.opensandbox.io/pool-name` label 圈定） | 只挡不审；入站默认拒+出站白名单 | 零 per-sandbox | **主力池默认**（k3s 实测 13/13，见[验证报告](opensandbox-egress-netpol-vault-verification.md)） |
| 轻量审计 | eBPF `connect` 事件 | JSONL 记录实际外连 IP:port | 同 Step 3 | 与 egress 互为印证：**egress 管允不允许，eBPF 管到底连了啥**；需要外连取证又不上边车的池 |
| L7 精控 | egress sidecar | FQDN 白名单、透明 MITM、策略 API、Vault | 每沙箱一份内存 | 仅敏感池（SOP-D 已实测池模板预置）；`deny.always/allow.always` 做平台级不可越过基线 |

要点：init 模式下 `bootstrap.sh` 仍保留 egress MITM CA 安装（系统/NSS/JDK trust store），开 init 不影响 HTTPS 内容审查链路——灰度回归清单应含一条 MITM 用例。同 ns 沙箱互隔离、Higress L7 路由前缀边界见[execd 命令执行 vs K8s exec 及 egress 隔离](opensandbox-execd-command-vs-k8s-exec-and-egress-isolation.md)。

## 七、坑清单（实施前必读）

1. **exec 语义硬约束**：`bootstrap.sh` 必须 `exec` 不能 `&`，任何路径误用后台启动都静默降级 subreaper——以 capabilities 端点为准，不猜。
2. **双开关 drift**：`[hardening] enabled=true` 但 `EXECD_INIT` 未注入 → 各层报 degraded；`runtime.execd_run_as_init` 与 TOML 必须同发同撤。
3. **K8s 任务路径拿不到退出码**：不要把任务成败判断押在容器退出码上（业务层本就不消费它）。
4. **Pool task 路径是 subreaper**：server 开关只给 task 级收割 + hardening；PID 1 必须改 Pod 模板，且仅长会话池值得。
5. **Landlock fail-open 的边界**：能力缺失才跳过；策略过严导致的拒绝是真实拒绝，灰度必须覆盖各语言运行时启动（Python/Node/Java 的 `/proc`、`/dev`、缓存路径依赖）。
6. **eBPF 三重前提**：内核 5.10+ BTF、`CAP_BPF`+`CAP_PERFMON`、`EXECD=/execd-ebpf` 手工指定（R-e 未接线）。
7. **seccomp deny 替换语义 + execve 保留**（§五已述，重复列出因其是启动硬失败）。
8. **回归盲区**：上游 Python e2e 覆盖 init/hardening 主面，但 `/code` Jupyter 内核在 init/hardening 下无专项 e2e（R-p declined）——灰度要自己加 `/code` 用例。

## 八、结论：推荐路线

1. **现在做**：Step 1（server 开关 + hardening + Landlock）全池灰度——高收益、零常驻成本、可精确回滚。这是本次评估唯一的"全量默认"项。
2. **长会话池做**：Step 2 模板 PID 1（信号屏蔽 + 全容器收割）；短任务池**明确不做**。
3. **敏感池按需**：Step 3 eBPF 审计 + egress sidecar；主力池保持 netpol 基线（决策 D 不变）。
4. **明确不追的收益**：容器退出码传播（业务层消费不到）、优雅停机对 S3 回写的加成（postStop 独立链路）、短任务池的僵尸治理（收益边际）。

---

## 附录 A：非池化路径速记（低相关）

Docker 与 K8s BatchSandbox/AgentSandbox 路径上 `bootstrap.sh` 即容器 entrypoint，server 开关直接使 execd 成为 PID 1（`agent_sandbox_provider.py:308`、`batchsandbox_provider.py:203` 注入 `EXECD_INIT=1`），全部收益表兑现，但退出码传播仍受 BatchSandbox 不上报容器退出码限制。这两个路径非我们主路径，仅在单机/调试场景用 Docker 时相关。
