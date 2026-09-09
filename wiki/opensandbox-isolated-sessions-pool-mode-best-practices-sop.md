---
title: 隔离会话池化落地最佳实践 SOP：决策、部署、接入、编码与运维
description: 基于 ubuntu k3s 实测的隔离会话（execd /v1/isolated）落地 SOP：场景决策表、隔离池部署验收清单、业务接入与会话生命周期规范（Python SDK 示例）、run 编码规范、监控告警与故障 runbook、反模式清单与推荐基线
---

# 隔离会话池化落地最佳实践 SOP

> 日期：2026-09-08。配套文档：[实测验证与生产评估](opensandbox-isolated-sessions-pool-mode-enable-and-assessment.md)（边界矩阵与证据、得失分析、生产结论）。本 SOP 只写"怎么做"，所有结论均有实测支撑。

## 0. 决策：要不要用隔离会话

| 判断 | 结论 |
|---|---|
| 要在沙箱里跑**用户提交/AI 生成的代码** | ✅ 用隔离会话（只读根 + CoW 工作区 + 白名单） |
| 怕脚本**误伤沙箱本体**（rm/覆盖系统目录） | ✅ 用隔离会话，破坏半径锁定在会话 upper |
| 需要**同沙箱多会话文件互隔离**、可丢弃工作区 | ✅ 用隔离会话 |
| 需要**写时磁盘硬限额**或**bind 挂载宿主目录** | ❌ 当前不可用（配额仅分配时检查、binds 损坏），先规避 |
| 只是可信的固定任务（预装环境跑作业） | ❌ 用普通 `/command`，不值得付成本 |
| 想**替代每租户一沙箱**做租户隔离 | ❌ 隔离会话是 Pod 内纵深，不改变租户边界 |
| 沙箱 Pod 需要维持最小攻击面（不能加 SYS_ADMIN） | ❌ 隔离池会下调 Pod 基线，评估后再开 |

## SOP-A：隔离池部署（从零到验收）

**A1 独立建池。** 隔离池与普通池分开（securityContext 不同、故障域不同、容量独立）。不要给普通池加 caps。

**A2 池模板四前置**（完整 YAML 见验证报告 §2.3）：

| 前置 | 落点 | 验收方法 |
|---|---|---|
| `bwrap` 拷到 `/opt/opensandbox/bwrap` | execd-installer init 容器（源：镜像内 `/usr/local/bin/bwrap`） | 进 Pod `ls -l` |
| `session-gate`/`launcher` 拷到 `/opt/opensandbox/`，**权限 0755、root 属主** | 同上，**源必须是 `/usr/local/libexec/`**（`/opt/opensandbox` 会被 emptyDir 遮蔽） | 进 Pod 校验 mode |
| caps：`SYS_ADMIN`（+`NET_ADMIN` 仅当要 `share_net:false`）；`seccompProfile/appArmorProfile: Unconfined` | sandbox 容器 securityContext | `kubectl get pod -o jsonpath='{.spec.containers[0].securityContext}'` |
| `isolation-upper` emptyDir 挂 `/var/lib/execd/isolation` | volumes + volumeMounts | 同上 |

**A3 isolation.toml 基线**：`upper_max_bytes` 用默认 8GiB 或按镜像实际容量设定（**不要把测试值 32MiB 带上生产**）；`allowed_writable` 保持 `/workspace /mnt /media /data` 最小集，业务确实要共享目录再加；通过 `EXECD_ISOLATION_CONFIG` env 注入路径。

**A4 版本**：execd 用 `latest`（或 ≥v1.1.0）；升级模板只滚动空闲 Pod，安排低峰，升级后重跑 A6 验收。

**A5 部署验收（一分钟 smoke）**：

```bash
# 1) 认领沙箱（poolRef）→ 2) 探测 → 3) 写读删闭环
CAPS=$(curl -s $B/v1/isolated/capabilities)          # 期望 available:true, isolator:bwrap
SID=$(curl -s -X POST $B/v1/isolated/session -d '{"workspace":{"path":"/workspace","mode":"overlay"}}' | jq -r .session_id)
curl -s -X POST $B/v1/isolated/session/$SID/run -d '{"code":"bash -c \"echo ok > /workspace/t.txt && cat /workspace/t.txt\""}'
curl -s -X DELETE $B/v1/isolated/session/$SID -o /dev/null -w '%{http_code}\n'   # 期望 200
```

**A6 明确不做**：不依赖 `binds`（当前版本 gate EOF，用 `extra_writable` 替代，已验证回写）；不启用 `uid_mode:"userns"`（Ubuntu 24.04 userns 受限）；不指望写时 ENOSPC 硬限（依赖节点 fs prjquota）。

## SOP-B：业务接入与会话生命周期

**B1 生命周期模型：create → run×N → delete。** 会话是贵资源（upper 磁盘 + 命名空间），任务结束显式 `delete`；`idle_timeout_seconds` 只作兜底（回收是分钟级惰性清扫，不可当精确计时器）。

**B2 推荐节奏**：一个业务任务 = 一个会话；任务内多步骤复用同一会话（文件状态跨 run 持久）；并行步骤**开多个会话**（同会话 run 严格串行，实测 2 个 2s run 串行成 4s）。

**B3 错误语义表（业务代码必须照此处理）**：

| 现象 | 根因（实测） | 处置 |
|---|---|---|
| `context deadline exceeded` | 前台 run 超时 | **会话已销毁**，重建会话，不要重试 run |
| `session process exited without end marker` | run 代码里裸 `exit` | 会话已销毁，重建；代码按 SOP-C C1 改写 |
| `SESSION_NOT_FOUND` (404) | 会话死/被 idle 回收/被删 | 按"无此会话"重建；attach 前先探 |
| `total usage exceeds configured limit` | upper 全局配额打满（分配时检查语义，见 [#1773](https://github.com/opensandbox-group/OpenSandbox/issues/1773)） | 告警级故障：重建池 Pod 清 upper，见 SOP-D |
| `... not in allowlist` | extra_writable 越界（含 symlink 解析后） | 修正路径，不要绕 |
| `gate: unixpacket EOF` | **binds dest 不存在的已知缺陷**（[#1772](https://github.com/opensandbox-group/OpenSandbox/issues/1772)：根只读后 bwrap mkdir 失败）或缺 NET_ADMIN | 弃用 binds；查 caps |

**B4 Python SDK 接入模板**（模型齐全，`sandbox.isolation` 入口）：

```python
from opensandbox import Sandbox
from opensandbox.models.isolated import (
    CreateIsolatedSessionRequest, IsolatedWorkspaceSpec,
    EnvPassthroughSpec, IsolatedRunOpts,
)

sandbox = await Sandbox.create(...)  # poolRef 池化沙箱

# 创建（会话参数在 create 时锁定，之后不可改）
session = await sandbox.isolation.create(CreateIsolatedSessionRequest(
    profile="strict",                                   # /tmp 私有 tmpfs；balanced 则共享
    workspace=IsolatedWorkspaceSpec(path="/workspace", mode="overlay"),
    extra_writable=["/data/outputs"],                   # 需要回写主容器的目录（binds 替代）
    idle_timeout_seconds=300,                           # 兜底 GC
))

# 执行：一律 bash -c 包装；前台超时 < 业务等待
result = await session.run(
    "bash -c 'python3 job.py > out.log 2>&1; exit $?'",
    opts=IsolatedRunOpts(envs={"PATH": "/usr/local/bin:/usr/bin:/bin"}, timeout_seconds=60),
)

# 长任务走后台 + 轮询（日志超 16MiB 会被截断，大输出落文件再取）
bg = await session.run_background("bash -c 'train.sh > train.log 2>&1'")
status = await session.run_status(bg.run_id)
logs = await session.run_logs(bg.run_id, cursor=0)

# 工件回收：fs proxy 读 upper 层（diff/commit 未实现，不要用）
content = await session.files.download_file("/workspace/out.parquet")

# 结束：显式删
await session.delete()
```

**B5 无状态恢复**：客户端重启后 `sandbox.isolation.attach(session_id)` 可重挂（服务端回显创建参数）；会话不保证活，attach 后先 `session.get()` 确认 status。

## SOP-C：run 编码规范

- **C1 永不裸 `exit`**：`exit` 会杀死整个会话 shell。需要退出码：`bash -c '... ; exit $?'`；需要中断控制流用 `return` 或子 shell。这是本特性最易踩的 P0 坑。
- **C2 超时即重建**：`timeout_seconds` 到期会话必死。设为"业务最大可等待"，触发后走重建；绝不在超时错误后重试同会话。
- **C3 env 三层选型**：默认 `deny`（继承容器 env，黑名单自动剥 `*_API_KEY/*_TOKEN`）即可满足多数场景；只给极少数变量开 `deny+keys`；`allow` 白名单模式会清空全部 env——**必须自带 PATH**（实测 allow 后 env 仅剩 PWD/SHLVL/_）。
- **C4 秘密纪律**：黑名单是兜底不是设计。凭据走 Credential Vault / egress 代理；业务数据经 run 级 `envs` 按需注入（deny 模式下创建沙箱时的 env 会透传进隔离会话——不要把敏感值放那里）。
- **C5 非 root uid**：`uid:1000` 等会因 upper 属主 root 导致 overlay 工作区不可写。要么保持 uid 0，要么镜像里预 `chown` 工作区目录。
- **C6 网络隔离按池选**：需要 `share_net:false` 的池才加 `NET_ADMIN`；默认（不传）共享沙箱网络。
- **C7 大输出落盘**：后台日志 16MiB 硬截断（实测精确 16777216 字节）。产物写文件，走 fs proxy 取，不要刷 stdout。

## SOP-D：运维与监控

**D1 监控项**：

| 指标 | 采集 | 告警阈值建议 |
|---|---|---|
| `/var/lib/execd/isolation` 用量 | Pod 内 du / emptyDir 用量 | >70% 预警（打满 = 池内新会话全挂，P0） |
| `capabilities.available` | 定时探活（每池一探） | false 立即告警（前置漂移，如模板被改） |
| 会话 404 率 / `limit exceeded` 错误率 | execd 响应码 | 突增告警 |
| 隔离池 Pod 重启数 | k8s | >0（私有 netns 会话不可跨 execd 重启恢复） |

**D2 故障 runbook**：

| 症状 | 排查顺序 |
|---|---|
| `available:false` "bwrap not found" | installer 是否拷贝 → Pod 是否旧模板（模板变更只滚空闲 Pod）→ 重建池 |
| `available:false` 无 message 但 bwrap 在 | session-gate 缺失或权限漂移（0755/root）→ 校验 `/opt/opensandbox/opensandbox-session-gate` |
| 新会话批量失败 `limit exceeded` | upper 满 → 重建池 Pod（`recycleStrategy: Delete` 下删沙箱/等回收即可清零），同时查异常大 upper |
| `share_net:false` 全部失败 | 池模板缺 `NET_ADMIN` → 加 caps 重滚 |
| 会话频繁秒死 | 业务代码裸 `exit`/超时过短 → 按错误语义表回溯 |

**D3 容量**：upper 在 emptyDir（节点盘）上，池密度按"峰值并发会话 × 单会话 upper 预算"留余量；隔离池 `poolMax` 别照抄普通池（caps + 磁盘更贵）。

## 反模式清单（全部有实测教训）

1. ❌ 普通池加 caps 混用隔离（基线拉低面扩大，应独立池）
2. ❌ run 代码裸 `exit`（杀会话 P0）
3. ❌ 超时后重试 run（会话已死，重建才是对的）
4. ❌ 依赖 `binds`/`diff`/`commit`/`userns`/写时配额（当前全部不可用）
5. ❌ 凭据放容器 env 指望黑名单（兜底当设计）
6. ❌ allow 模式不传 PATH（会话内命令全瞎）
7. ❌ 大日志刷 stdout（16MiB 截断丢数据）
8. ❌ 把 idle_timeout 当精确定时器（惰性清扫，分钟级窗口）
9. ❌ 把隔离会话当租户隔离（Pod 内纵深 ≠ 租户边界）
10. ❌ 测试值（32MiB 配额、15s 续约冷却等）直接上生产

## 基线速查

| 项 | 推荐值 |
|---|---|
| workspace | `{"path":"/workspace","mode":"overlay"}`，镜像内预建目录 |
| profile | 默认 strict；需要共享 /tmp 时才 balanced |
| env | deny（默认）；allow 必带 PATH |
| run 包装 | `bash -c '...; exit $?'` |
| 前台 timeout | < 业务可等待值；长任务 background |
| idle_timeout | 业务会话间隙上限 + 余量；delete 为主 |
| execd | latest（≥v1.1.0） |
| upper_max_bytes | 默认 8GiB 或按盘定，配监控 |

## 参考

- 实测证据与边界矩阵：[隔离会话验证与生产评估](opensandbox-isolated-sessions-pool-mode-enable-and-assessment.md)
- 官方指南：`docs/guides/isolation-sessions.md`；设计：`oseps/0013-isolated-execution-api.md`
- 池化装配：[池模式沙箱 Pod 边车组件介绍与实践指导](opensandbox-pool-sandbox-sidecar-components-guide.md)
- SDK 面：`sdks/sandbox/python/src/opensandbox/adapters/isolated_adapter.py`（create/attach/run/run_background/files/delete），e2e 用例 `tests/python/tests/test_isolated_session_e2e.py`
