# 客户端池预热与分配延迟 Cookbook（OSEP-0005 / OSEP-0021）

server 端 Pool `bufferMin=0`（D-9：不常驻预热）时，每次分配都走按需扩容，存在冷启动延迟。SDK 层 **client-side SandboxPool** 可在业务进程内维护少量 idle 沙箱缓冲，让 `acquire` 降到毫秒级；空了就退化为直建（`DIRECT_CREATE`），**不会比现状更差**。OSEP-0005 已实现；OSEP-0021（异步预热管线）draft，Kotlin 已先行落地。

**前提**

| 项 | 约定 |
|---|---|
| 部署 | 池化主路径（server Pool）之上叠加 client pool；两者正交 |
| server 交互 | 仅标准 lifecycle API（无私有扩展头）；quota/容量仍由 server/K8s 裁决 |
| 沙箱语义 | kill-only：借出的沙箱用完即焚，**不归还复用** |
| SDK | Python ✅（线程模型）/ Kotlin ✅（异步模型，含 Redis store）/ JavaScript ❌ 无实现 |

## 目录

- [1. 两种"池"的关系](#1-两种池的关系)
- [2. 核心语义](#2-核心语义)
- [3. Python 用法](#3-python-用法)
- [4. Kotlin 用法（异步预热）](#4-kotlin-用法异步预热)
- [5. 参数怎么给（bufferMin=0 场景）](#5-参数怎么给buffermin0-场景)
- [6. 坑清单](#6-坑清单)
- [参考](#参考)

---

## 1. 两种"池"的关系

| | server Pool（K8s） | client SandboxPool（SDK） |
|---|---|---|
| 位置 | 集群内，controller 管理预热 Pod | 业务进程内，管理 idle 沙箱句柄 |
| 缓冲物 | 预热 Pod（未分配） | 已 create、已就绪的沙箱（真实 Pod 在跑） |
| 容量参数 | poolMin/poolMax/bufferMin/bufferMax（滞回伸缩） | maxIdle（**软目标**，非保证） |
| 资源谁付 | server 侧常驻（D-9 已设为 0） | caller 自付（每个 idle 沙箱占真实资源） |
| 可否叠加 | ✅ client warmup 的 create 驱动 BatchSandbox 按需分配；quota 由 server 裁决 | 同左 |

**结论**：client pool 是"把预热成本从 server 常驻换成业务侧小缓冲"，与 D-9（bufferMin=0）兼容；是否值得用，取决于分配延迟 P99 是否伤体验。

## 2. 核心语义（两 SDK 一致，OSEP-0005）

| 机制 | 行为 |
|---|---|
| `maxIdle` | 尽力而为目标："standby target/cap (not strict guarantee)"；burst 打空后退化直建 |
| `acquire` | 原子取 idle → connect 校验（失败清 stale id 降级直建）→ 空时按 `AcquirePolicy`：`DIRECT_CREATE`（默认）或 `FAIL_FAST`（抛 POOL_EMPTY） |
| 后台补货 | 周期 reconcile，仅 leader（primary lock 持有者）执行；每轮补 `min(deficit, warmup并发)` 个 |
| 故障退化 | 连续失败超阈值 → `DEGRADED` 退避；恢复后回 `HEALTHY` |
| idle 过期 | idle 沙箱有 TTL（OSEP 固定 24h；Python SDK 已暴露 `idle_timeout` 可调，默认 24h） |
| 健康快照 | `snapshot()`：state / idle_count / failure_count / backoff_active / last_error / in_flight |

生命周期 API：`start()` → `acquire()` → `resize(maxIdle)` / `snapshot()` → `shutdown(graceful)`（graceful 走 DRAINING，借出的沙箱归 caller）。

## 3. Python 用法

签名核对自 `sdks/sandbox/python/src/opensandbox/sync/pool.py` `SandboxPoolSync.__init__`（异步版 `pool_async.py SandboxPoolAsync` 参数一致）：

```python
from datetime import timedelta
# from opensandbox import SandboxPoolSync, InMemoryPoolStateStore, ...  # 按实际导出面 import

pool = SandboxPoolSync(
    pool_name="dept-a-pool",
    max_idle=8,                                # 小缓冲；burst 靠 DIRECT_CREATE 兜底
    state_store=InMemoryPoolStateStore(),      # 多进程需共享 store，见 §6.2
    connection_config=conn_cfg,                # 连接自部署 server（proxy 模式）
    creation_spec=PoolCreationSpec(...),       # create 请求模板：poolRef/env/entrypoint/timeout
    owner_id="worker-1",                       # 分布式多进程必填（leader 锁）
    idle_timeout=timedelta(minutes=15),        # ⚠️ 默认 24h，短 TTL 业务必须调小
    acquire_min_remaining_ttl=timedelta(minutes=5),  # 不借即将过期的沙箱
    warmup_concurrency=None,                   # 缺省 max(1, ceil(max_idle*0.2))
)
pool.start()
sbx = pool.acquire(sandbox_timeout=600)        # 空 idle 时 DIRECT_CREATE 同步兜底
...                                            # 用完即焚（业务释放/到期回收）
pool.shutdown()
```

预热是 **thread-per-warmup**（`ThreadPoolExecutor`，`warmup_concurrency` 同时是在途与线程上限）：大 maxIdle 预热既慢又耗线程，这是 Python 与 Kotlin 的最大差异。

## 4. Kotlin 用法（异步预热）

Kotlin SDK 已落地 OSEP-0021 的配置面（`PoolConfig.kt`）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `warmupCreateQps` | 10 | 每 1s reconcile 窗口准入的预热 create 数（固定准入限速，**无指数退避**） |
| `warmupPostPrepareHealthCheck` | — | prepare 后可选健康检查 |
| `warmupConcurrency` | 128 | post-create 执行器（prepare/renew/提交）有界并发 |

机制差异：预热 create 强制 `skipHealthCheck=true`、单次传输尝试；就绪等待放 `DelayQueue` 不占线程；不变量 `idle + inflight ≤ maxIdle`。分布式 store 用官方 `sandbox-pool-redis`（`RedisPoolStateStore`）。

**冷启动爬坡提示**：`warmupCreateQps=10` 意味着补 100 个缓冲要 ~10s——对 bufferMin=0 的池要显式调大，并确认 server Pool 的扩容/配额能吸收这个 create 尖峰。

## 5. 参数怎么给（bufferMin=0 场景）

| 参数 | 建议 | 理由 |
|---|---|---|
| `maxIdle` | **小**（≈峰值前几分钟的并发，个位数~几十） | 每个 idle 沙箱都是真实资源；密度优先（D-3/D-10） |
| 空池行为 | 保持默认 `DIRECT_CREATE` | 兜底退化为现状延迟，不会更差 |
| `idle_timeout` | **必须调小**（分钟级） | OSEP 默认 24h，与"用完即焚 + 短 TTL"直接冲突；闲置沙箱靠 server TTL 回收属常态，模型已覆盖（acquire 时 stale 清理兜底） |
| `creation_spec.timeout` | 设业务短 TTL | 预热沙箱的超时从 create 起算，别用长超时 |
| `owner_id` + `state_store` | 多进程部署必配 | 否则各进程各自预热，N 倍缓冲 |
| `acquire_min_remaining_ttl` | 配置 | 避免借到临期沙箱，任务做一半被回收 |

## 6. 坑清单

1. **资源与密度矛盾**：预热 idle 沙箱占真实 Pod 资源，maxIdle 是 caller 自付成本。先量化"分配延迟 P99 是否真伤体验"，再决定要不要缓冲；默认答案可能是"不用，直建就好"。
2. **多进程放大**：client pool 是进程级的。横向扩业务 worker 时要么接共享 store（现成实现仅 Kotlin Redis），要么接受 N 倍缓冲；Python 远端 store 需自研。
3. **语言能力不对齐**：异步预热只有 Kotlin；Python 线程模型（大 maxIdle 慢且耗线程）；JS 无实现。跨语言业务按语言分别给参数。
4. **预热风暴**：client warmup 的 create 尖峰直接变成 server Pool 的分配请求；1s 脉冲（Kotlin）+ 池按需扩容叠加时，确认 poolMax/quota 能吸收。
5. **短 TTL 语义**：见 §5 的 `idle_timeout` / `creation_spec.timeout`，不调就是 24h 闲置占用。
6. **Running ≠ 任务成功**：上游 issue **#1662**——池模式沙箱任务失败仍可能报 Running。client pool 的健康检查（`acquire_health_check`/`warmup_health_check`）只验沙箱可达性，**业务任务结果必须业务层自验**，别把 acquire 成功当任务成功。

## 参考

- 提案：`oseps/0005-client-side-sandbox-pool.md`（implemented）、`oseps/0021-scalable-asynchronous-client-side-pool-warmup.md`（draft，Kotlin 先行）
- 实现：`sdks/sandbox/python/src/opensandbox/sync/pool.py`（`SandboxPoolSync`）、`pool_async.py`；Kotlin `.../sandbox/pool/`（`SandboxPool.kt`、`PoolConfig.kt`）、`sandbox-pool-redis/`
- 官方指南：`docs/guides/client-pool.md`
- 姊妹篇：`pool-pod-template-cookbook.md`（server 池模板与容量参数）、`sandbox-management-cookbook.md`（create/续约）
- 相关 wiki：`opensandbox-pool-capacity-params.md`、`opensandbox-pool-scaling-mechanism-ops.md`（分配/扩容延迟公式）
