# OpenSandbox BatchSandbox 3s 轮询 Task 执行机制调研

> 日期：2026-08-07
> 方式：子智能体 + codegraph 代码检索
> 范围：`kubernetes/`（controller / scheduler / task-executor / CRD / e2e）与 `docs/architecture`

## 1. 结论：3s 轮询承载的业务功能

`BatchSandbox` 控制器每 3 秒轮询一次，持续执行"**推任务 → 拉状态 → 回收资源**"的批量任务调度闭环：

- 为每个 sandbox pod 分发一条命令式任务（`spec.taskTemplate`，可配合 `shardTaskPatches` 按副本下标差异化）；
- 跟踪任务执行状态（Running/Succeed/Failed/Unknown/Pending），聚合写入 `BatchSandbox.status.taskRunning/taskSucceed/taskFailed/...`（CRD printcolumn 直接展示）；
- 按 `spec.taskResourcePolicyWhenCompleted`（Retain 默认 / Release）决定任务完成后是否把 pod 释放回 Pool（`sandbox.opensandbox.io/alloc-release` 注解）。

对应文档定位：`docs/architecture/index.md` 4.3 节 —— "optional task orchestration for batch and RL-style workloads"，即**批量作业与 RL/评估类工作负载的批量 sandbox 任务编排**。

## 2. 完整数据流

```
用户声明 CRD
  spec.replicas / taskTemplate / shardTaskPatches
  / taskResourcePolicyWhenCompleted / poolRef
        │
        ▼
strategy.GenerateTaskSpecs()                    策略层
  （每下标 i 生成 api.Task{Name: bsName-i}，      task_scheduling_strategy_default.go
    ShardTaskPatches 做 strategic merge patch）
        │
        ▼
defaultTaskScheduler（控制器进程内纯内存）         调度层
  taskNode 状态机：
    pending ─分配pod→ assigned ─task完成且policy=Release→ releasing ─endpoint返回nil→ released
  每轮 Schedule()：
    1. refreshFreePods()          重建空闲 pod 列表（一个 pod 只跑一个 task）
    2. collectTaskStatus()        并发 GET http://<podIP>:5758/getTasks
    3. scheduleTaskNodes()        分配空闲 pod + POST /setTasks 下发/释放
        │
        ▼
pod 内 task-executor（:5758 HTTP server）         执行层
  taskManager（maxConcurrentTasks=1）
    Sync() 对账 desired 列表（softDelete / create）
    Create → executor.Start（process/container 两类 runtime）
    内部 500ms reconcileLoop：Inspect 进程状态、
      超时终止、preStart/postStop 生命周期钩子、Stop(SIGTERM→SIGKILL)
    本地落盘 /var/lib/sandbox/tasks/<name>/{pid,exit,stdout,stderr}
        │
        ▼
controller 聚合（每 3s 轮询驱动）                 状态层
  scheduleTasks() 统计 → runtimeView → patch CR status
  IsResourceReleased() 的 pod → releasePods() 归还 Pool
  DeletionTimestamp → StopTask → releasing→released → 移除 FinalizerTaskCleanup
```

## 3. 为什么选轮询而不是事件驱动（pull vs push）

代码内直接依据（`batchsandbox_controller.go` `reconcileTasks`）：**"Because tasks are in-memory and there is no event mechanism, periodic reconciliation is required."**

1. **task 是控制器进程内纯内存对象**（`taskNode`），不存在 CRD，K8s informer 不会产生任何 task 事件。
2. **执行结果的唯一来源是 pod 内 HTTP 服务**（pid/exit 文件 + `/getTasks`）；task-executor 不是 K8s API 客户端，不写事件/CR status，控制器只能主动拉。
3. **push 侧动作同样需要周期驱动**：新任务下发、Releasing 停止通知、删除回收都依赖周期性 Reconcile 推进状态机。
4. **3s 是"可感知粒度"的妥协**：HTTP 默认超时同为 3s；DurationStore 取所有 requeue 来源的最小非零值，延迟不会叠加放大。e2e 中秒级任务（`sleep 2`）恰好在一个周期内完成"下发→执行→回传→status 更新"。

### 改为 exporter 式上报（push）的可行性分析

理论上可行（消除 3s 延迟、避免每轮全量 GET），但有三个硬约束：

| 约束 | 说明 |
|---|---|
| 归属路由 | `taskScheduler` 在 controller 内存（`r.taskSchedulers` sync.Map），多副本时只有负责该 BatchSandbox 的 reconciler 持有它。pull 方向天然正确；push 时 pod 内 task-executor 无法感知上报给哪个实例（leader 还会切换）。 |
| 可靠性 | 上报会丢（controller 重启/leader 切换/网络抖动），需 ack/重试/补偿；轮询天然幂等、最终一致。task-executor 不知 scheduler 恢复进度（`recovery.go` 依赖全量状态）。 |
| 调度动作仍需驱动 | `Schedule()` 还做 UpdatePods / AddTasks（scale-out）/ Set(nil) 释放，输入来自 watch/List pod，状态上报替代不了。 |

**可行路径**：task-executor 在任务终态把结果写回 CR status（或自定义 task CR），controller 用 watch 触发 reconcile，保留低频兜底轮询防丢。代价是 API server 写放大 + status 字段扩展——正是当前"纯内存 + pull"设计刻意规避的。

## 4. 真实业务场景（e2e 用例佐证）

- **场景 A 批量任务 + 资源回收**：`test/e2e/e2e_test.go` Context("Task") —— Pool + `replicas:2` BatchSandbox + `echo` taskTemplate，断言 `taskSucceed==2`；删除后 pod 归还 Pool。
- **场景 B 生命周期钩子**：`preStart`（环境准备）/`postStop`（清理），失败原因（如 `PreStartHookFailed`）进入 `taskFailed` 与 `taskLastErrorMessage`；超时钩子用例。
- **场景 C 批量作业数据进出**（最贴近真实业务）：宿主机目录仅挂载给 task-executor，`preStart` 把输入 `cp` 进共享工作区，沙箱产出结果，删除触发 `postStop` 把结果 `cp` 回宿主机输出目录。
- **场景 D task-executor 单机行为**：`test/e2e_task/` 覆盖成功/超时(exit 137/143)/环境继承(nsenter)/钩子顺序。

## 5. 关键文件清单

- 控制器：`kubernetes/internal/controller/batchsandbox_controller.go`（reconcileTasks 3s Push / scheduleTasks / getTaskScheduler / releasePods）、`batchsandbox_status.go`、`utils/requeueduration/duration.go`
- 策略：`kubernetes/internal/controller/strategy/task_scheduling_strategy{,_default,_factory}.go`
- 调度：`kubernetes/internal/scheduler/{interface,types,default_scheduler,status_collector,recovery}.go`（5758 端口、taskNode FSM、defaultSchConcurrency=10）
- CRD：`kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go`
- task-executor：`kubernetes/pkg/task-executor/{client,types}.go`、`kubernetes/internal/task-executor/{server,manager,runtime,types,config,storage}/`（ReconcileInterval=500ms、maxConcurrentTasks=1）
- 文档/示例：`docs/architecture/index.md` 4.3 节、`kubernetes/config/samples/sandbox_v1alpha1_batchsandbox-{with-task,lifecycle}.yaml`
- E2E：`kubernetes/test/e2e/e2e_test.go`（1398 行起 Context("Task")）、`kubernetes/test/e2e_task/task_e2e_test.go`

## 6. 补充观察

- 3s 周期实际瓶颈：HTTP 默认超时 3s，pod 无 IP / endpoint 不可达会拖长单次 Reconcile；`maxConcurrentTasks=1` 意味着并发靠多 pod（replicas）实现。
- `TaskResourcePolicyWhenCompleted=Release` 时任务完成即归还 pod；Retain（默认）保留到 BatchSandbox 删除。
- Paused 阶段跳过 task 调度并销毁内存 scheduler，resume 后重建并靠 recovery 从 pod endpoint 恢复——3s 轮询与 pause/resume 交互的唯一例外路径。
