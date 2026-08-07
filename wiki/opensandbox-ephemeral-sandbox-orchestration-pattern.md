# 用完即焚（Ephemeral）沙箱编排最佳模式 —— 全流程资源生命周期流转

- 日期：2026-08-07
- 场景限定：**只提供用完即焚**（无状态、任务执行型、跑完即销毁，不保留会话状态）
- 基础：基于 `wiki/opensandbox-crd-controller-reconcile-analysis.md`（调谐与性能）与 `wiki/opensandbox-controller-defects-and-pitfalls.md`（缺陷/坑）的结论设计
- 状态：方案设计（未实施）

---

## 1. 场景约束与设计目标

| 约束 | 含义 |
|---|---|
| 无状态 | 任务结果必须落外部（对象存储/日志/消息），沙箱进程状态可随时丢弃 |
| 高吞吐创建/销毁 | 批量任务 = 批量创建/删除 sandbox，秒级交付 |
| 峰值波动 | 任务潮汐式到达，池容量需自适应 |
| 成本敏感 | 空闲资源不空转，镜像越小越好 |

设计目标（对照缺陷文档逐条规避）：
1. **启动快**：预热池 + 瘦身镜像 + 共享解释器卷（`wiki/opensandbox-shared-storage-interpreter-minimal-image.md`）
2. **销毁快**：BatchSandbox 不拥有 Pod 生命周期，销毁只删 CR + 注解
3. **不引入状态保留成本**：**完全不走 pause/resume/快照**（commit Job 10min 超时、registry push/pull 全是净开销，见"重建优于快照"结论）
4. **避免 F-3/F-4 死锁**：单副本（replicas=1）+ 无缩容依赖
5. **防泄漏**：expireTime 兜底 + finalizer 保证 Pod 归还

---

## 2. 总体架构（资源模型）

```
┌────────────────────────────────────────────────────────────────────┐
│  编排层（CR）                                                        │
│  Pool（常驻，池容量 = bufferMin~bufferMax, poolMin~poolMax）          │
│  BatchSandbox（用完即焚：poolRef + replicas=1 + taskTemplate +      │
│              expireTime + policy=Release）                           │
├────────────────────────────────────────────────────────────────────┤
│  实际资源层                                                          │
│  Pool 预热 Pod（瘦身镜像 + 共享解释器卷，label: pool-name/pool-revision）│
│  pod 内：execd(:44772) + task-executor(:5758) + Jupyter(:44771 可选)  │
│  PVC：共享解释器卷（只读挂载，/opt/{python,node,go,jvm}）              │
├────────────────────────────────────────────────────────────────────┤
│  状态通道（注解 = 真相源）                                             │
│  alloc-status（分配）→ alloc-release（请求归还）→ alloc-released（已归还）│
│  endpoints（可选，交互型任务才用）                                     │
└────────────────────────────────────────────────────────────────────┘
```

**为什么是这个组合**（决策依据）：
- 非池模式（BatchSandbox 自建 Pod）不满足高吞吐——每次冷拉镜像，且销毁要删 Pod；池化交付实测 0.92s/100 sandbox（`docs/kubernetes/index.md`）
- Pool 模式天然把"Pod 生命周期"与"任务生命周期"解耦：任务结束 Pod 归还回池复用，销毁 sandbox 只删 CR
- 任务型（`taskTemplate`）走 task-executor 通道，任务状态自动回写 `status.task*`，无需交互式会话
- 共享解释器卷让池内 Pod 全部共用解释器，镜像从 GB 级降到数百 MB（见共享存储方案）

---

## 3. 全流程资源生命周期流转（核心）

### Phase 0：池初始化（一次性）

```
用户 ──创建 Pool CR──► PoolReconciler（GenerationChanged 触发）
                        ├─ scalePool：按 capacitySpec 创建预热 Pod
                        │    （瘦身镜像 + 解释器卷，GenerateName "<pool>-"）
                        ├─ PoolScaleExpectations 防重复创建
                        └─ Pod Ready → status.available++（未分配且 Ready 计入）
```

资源流转：`Pool CR →(ownerRef)→ Pool 预热 Pod →(Ready)→ 可用池`

### Phase 1：任务分配（秒级）

```
用户 ──创建 BatchSandbox CR──► BatchSandboxReconciler
   spec: { poolRef: ephemeral-pool, replicas: 1, taskTemplate, expireTime, policy: Release }
   │  PoolRef≠"" → Pool 控制器 watch（filterBatchSandbox 放行 Create）
   ▼
PoolReconciler → allocator.Schedule（PackedSchedule 选可用 pod）
   ├─ 内存 store：pod→sandbox 绑定
   ├─ 写 alloc-status 注解（整表覆盖 MergePatch）+ 首次加 FinalizerPoolAllocation
   ▼
注解 patch → BatchSandbox watch → BatchSandboxReconciler 入队
   ├─ getTaskScheduler（首次：recover 反推 / 新任务直接注册）
   └─ reconcileTasks → POST http://<podIP>:5758/setTasks 下发任务
```

资源流转：`BatchSandbox CR →(alloc-status 注解)→ 已分配 Pod`；**Pod 所有权始终在 Pool**

### Phase 2：任务执行

```
task-executor（pod 内）：
   ├─ maxConcurrentTasks=1（每 pod 串行 1 任务）
   ├─ shim 脚本 / nsenter 进主容器执行 → exit code 落文件
   └─ 500ms reconcileLoop Inspect 进程推进状态
BatchSandboxReconciler：
   ├─ 3s requeue 轮询 GET /getTasks 收集状态
   └─ 写 status.taskRunning/taskSucceed/taskFailed/taskLastErrorMessage
```

资源流转：`Pod(已分配) →(任务执行)→ 状态回写 status.task*`；结果由任务自身落外部存储

### Phase 3：释放与回收（任务完成自动归还）

```
任务完成 + policy=Release → BatchSandboxReconciler
   └─ releasePods：写 alloc-release 注解（请求归还）
Pool 控制器 watch（UpdateFunc 放行 alloc-release 变化）
   └─ Schedule → ToRelease → recycle.TryRecycle（并发 64，清理环境）
        └─ 成功 → 写 alloc-released 注解 → 内存 store 释放
             → Pod 回到可用池（status.available++）
```

资源流转：`已分配 Pod →(alloc-release/alloc-released 注解)→ 可用池`（**Pod 不销毁，循环复用**）

### Phase 4：销毁（用完即焚 CR）

```
删除 BatchSandbox（用户显式删 或 expireTime 到期自动删）
   └─ FinalizerTaskCleanup：停任务、等 task 资源 release
   └─ FinalizerPoolAllocation：等全部 Pod 归还（Phase 3 已完成时立即移除）
        → CR 消失（GC 完成）
```

资源流转：`BatchSandbox CR →(finalizer 拆除)→ 消失`；**无 Pod 删除动作**（Pod 已归还或正被归还）

### Phase 5：池维护（持续）

| 事件 | 触发 | 行为 |
|---|---|---|
| 任务高峰缺 pod | SupplyCnt>0 | 5s requeue → scalePool 扩容（受 poolMax + maxUnavailable 25% 约束） |
| 空闲过多 | 超出 bufferMax | pickPodsToDelete 按旧到新删 idle pod |
| 模板升级 | Pool spec 变化 | revision=sha256(template) → 滚动替换 idle pod（不打扰占用中 pod） |
| 主动驱逐 | evict label | 硬删空闲 pod（绕过 Eviction API） |

---

## 4. 全流程时序图

```
用户/API    PoolReconciler        BatchSandboxReconciler      task-executor(Pod内)
  │             │                          │                       │
  │──创建Pool──>│                          │                       │
  │             │──scalePool 建预热Pod──────┼──────────────────────>│
  │             │<─────────────────────────┼───────────────────────│ Pod Ready
  │             │ status.available++       │                       │
  │──创建Bsbx───┼─────────────────────────>│                       │
  │  (poolRef,  │                          │                       │
  │   task,     │<──watch Bsbx──┐          │                       │
  │   expire,   │ allocator.Schedule       │                       │
  │   Release)  │──写alloc-status注解─────>│                       │
  │             │                          │<──注解patch──watch────┘
  │             │                          │──POST :5758/setTasks──>│ 执行
  │             │                          │<──GET :5758/getTasks───│(3s轮询)
  │             │                          │ status.task* 更新      │
  │──查状态─────┼─────────────────────────>│                       │
  │             │                          │  任务完成+Release       │
  │             │<──写alloc-release────────│                       │
  │             │──watch→recycle→写alloc-released                   │
  │             │ Pod回池(status.available++)                       │
  │──删除Bsbx───┼─────────────────────────>│                       │
  │             │                          │ 等Pod归还→移finalizer   │
  │             │                          │ CR 消失                │
```

---

## 5. 推荐配置模板

### 5.1 Pool（预热池）

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: Pool
metadata:
  name: ephemeral-pool
spec:
  capacitySpec:
    bufferMin: 5        # 常驻温缓冲下限
    bufferMax: 20       # 温缓冲上限（目标 (min+max)/2）
    poolMin: 5          # 池规模下限
    poolMax: 200        # 硬上限（防峰值失控）
  scaleStrategy:
    maxUnavailable: 25% # 扩容步长
  updateStrategy:
    maxUnavailable: 25% # 滚动替换步长
  recycleStrategy: Delete
  template:              # Schemaless：可直接写卷（Pool 模式 API volumes 被拒的绕行路径）
    spec:
      initContainers:    # 复制 execd/task-executor 二进制（同官方样例）
      - name: task-executor-installer
        ...
      containers:
      - name: main
        image: opensandbox/code-interpreter-mini:v1   # 瘦身镜像（解释器在卷上）
        command: ["/opt/opensandbox/bootstrap.sh"]
        volumeMounts:
        - name: interpreters
          mountPath: /opt/python/versions   # 共享解释器（只读）
        - name: interpreters
          mountPath: /opt/node
        - name: interpreters
          mountPath: /opt/go
        - name: interpreters
          mountPath: /usr/lib/jvm
      volumes:
      - name: interpreters
        persistentVolumeClaim:
          claimName: shared-interpreters   # RWX NAS，只读挂载
```

### 5.2 BatchSandbox（用完即焚任务单元）

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: BatchSandbox
metadata:
  name: task-<jobid>
spec:
  replicas: 1                    # 单副本：规避 F-3/F-4（pause 单副本限制 + 缩容未实现）
  poolRef: ephemeral-pool        # 从池分配，不自己建 Pod
  expireTime: "2026-08-07T12:00:00Z"  # 兜底销毁（防泄漏），任务最大时长 + 余量
  taskTemplate:                  # 任务型：结果回写 status.task*
    process:
      exec:
        command: ["/bin/sh", "-c", "python /work/run.py && upload-result"]
  taskResourcePolicyWhenCompleted: Release  # 完成即归还 Pod 回池
```

**编排层使用建议**（server/API 之上的一层）：
- 一个任务 = 一个 BatchSandbox；批量任务 = 批量创建 CR（并发受注解写入 256 并发限制）
- 任务结果读取：轮询 `status.taskSucceed/taskFailed/taskLastErrorMessage`，**不依赖 sandbox 存活**
- 清理策略：任务完成（成功/失败）后编排层立即删除 CR；expireTime 作为异常兜底

---

## 6. 闲置发现机制现状与缺口（2026-08-07 补充）

**结论：平台当前没有任何保活 API，也没有时间维度的闲置判定——闲置回收是"空间/容量驱动"而非"时间驱动"。**

### 现状（证据）
| 层面 | 机制 | 证据 |
|---|---|---|
| keepalive API | **不存在**（kubernetes 全仓搜 keepalive/heartbeat 0 命中；server 的 keep-alive 仅是 uvicorn HTTP 连接参数 `config.py:475-480`） | — |
| idle 定义 | **未分配**（allocator 内存 store 无 pod→sandbox 绑定），非"多久没用" | `pool_controller.go:695-696` 注释 |
| 空闲 Pod 回收 | 纯容量/事件驱动：缩容（超出 bufferMax/poolMin 目标，按 CreationTimestamp 旧→新 `pool_controller.go:852-853`）、滚动更新（旧 revision）、外部 evict label——**均无时间门槛** | `pickPodsToDelete`、`eviction_default.go:22-27` |
| 唯一时间兜底 | ① `spec.expireTime`：绝对到期时间（非 idle timeout，`batchsandbox_controller.go:115-130`）；② task `TimeoutSeconds`：单任务进程超时；③ execd/Jupyter 会话**无 TTL** | — |

### 对用完即焚模式的要求
```
任务完成 ─► 编排层主动删 CR ─► finalizer 归还 Pod（推荐路径，必须做到）
任务完成 ─► 编排层漏删 ─► expireTime 到点自动删（唯一保险，必须设置）
任务完成 ─► 都漏了 ─► 空闲 Pod 永久空转（等容量超限/滚动/手动 evict 才回收）
```
- **硬性规则**：编排层"任务终态 → 立即删 CR" + 每个 BatchSandbox 强制设 `expireTime`
- **缺口**：若产品需要"会话型 sandbox 长时间不调用自动回收"，需新增能力——lastActivity 跟踪 + 保活 API（或 idle timeout 判定），当前平台不支持

---

## 7. 本模式下避坑对照表

### 已规避的坑（设计即避开）

| 缺陷 | 规避方式 |
|---|---|
| F-3 pause 单副本限制 + F-4 缩容未实现 | replicas=1，不 pause、不缩容；销毁 = 删 CR |
| 快照/commit 开销（10min 超时、registry 往返） | 完全不启用 pause/resume |
| 非池模式冷启动慢 | 预热池 + 瘦身镜像 + 共享解释器卷 |
| 池化删除 finalizer 阻塞 | policy=Release 保证任务完成即归还，删除时无悬挂；Pool 健康是前提 |
| 池化 listPods 逐 Pod Get（P2-3） | replicas=1 → 每轮 1 次 Get，可接受 |

### 仍需注意的坑（本模式下依然存在）

| 缺陷 | 影响与对策 |
|---|---|
| F-2 任务 at-least-once（重启可能重复执行） | 任务必须幂等；结果落外部存储时带唯一键 |
| P0-1 任务型 3s 轮询风暴 | 规模化前先落地：首轮启动 jitter（3~8s 分桶）+ 事件驱动改造；量级评估：N sandbox → N/3 reconcile/s |
| P1-1 注解 churn（alloc-release 批量写） | 大批量完成时 256 并发 Patch 触发双 controller；编排层削峰（分批创建/删除） |
| F-5 Pool 控制器故障 → 删除悬挂 | 监控 Pool controller 健康；恢复前不批量删 sandbox |
| F-9 任务 HTTP 无认证（:5758） | 必须配 NetworkPolicy，任务内容按不可信输入处理 |
| F-10 驱逐硬删 | 驱逐前由 recycle 完成环境清理；避免驱逐 busy pod |
| 共享卷被污染 | 解释器卷只读挂载 + 卷内容签名校验（见共享存储方案） |

---

## 8. 容量与性能模型（量化估算）

| 指标 | 估算 | 依据 |
|---|---|---|
| 单任务交付时间 | ~1s（池化命中时） | `docs/kubernetes/index.md`：100 sandbox 池化交付 0.92s |
| 分配吞吐上限 | ~100 sandbox/s 写注解 | 256 并发 Patch vs kube-client QPS 100（`main.go:197-198`）——**写通道是瓶颈** |
| 稳态调谐开销 | N/3 reconcile/s（N=活跃任务 sandbox） | 3s 轮询（`batchsandbox_controller.go:274`） |
| 池 Pod 规模 | `allocated + (bufferMin+bufferMax)/2`，受 poolMax 约束 | `scalePool` 算法（`pool_controller.go:712`） |
| 镜像拉取 | 瘦身 200~500MB（vs 全量 GB 级） | 共享存储方案估算 |

**瓶颈提示**：用完即焚高吞吐场景，最终瓶颈不是 Pod 启动而是**注解写入 QPS**（分配/释放各写 1 次 BatchSandbox）——峰值设计时按 100/s 起算，必要时优化 `alloc-status` 增量写与去重。

---

## 9. 落地建议

1. **POC**：先建 1 个 Pool（瘦身镜像 + host 卷解释器）+ 批量创建 50 个任务型 BatchSandbox，实测：交付耗时、Pod 复用率、注解写入 QPS、3s 轮询实际开销
2. **必做前置**：3s 轮询启动 jitter；任务结果落外部存储；NetworkPolicy
3. **演进**：规模 >1000 并发任务时，落地缺陷文档 P0/P1 治理项（事件驱动轮询、Pod predicate、informer 收敛）后再放量
4. **不做**：本模式不引入 pause/resume/快照、不做 Pool 持久化分配聚合（无 `PersistPoolAllocation`）、不依赖 BatchSandbox 缩容

---

## 10. 关联文档

- `wiki/opensandbox-crd-controller-reconcile-analysis.md` — 调谐逻辑与性能风险
- `wiki/opensandbox-controller-defects-and-pitfalls.md` — 缺陷与坑（F-* / P0-P3 编号出处）
- `wiki/opensandbox-shared-storage-interpreter-minimal-image.md` — 共享解释器卷方案
- `docs/guides/client-pool.md`、`docs/kubernetes/index.md` — Pool 使用与交付指标
- `kubernetes/config/samples/sandbox_v1alpha1_pool.yaml` — Pool 模板（卷 + initContainers）官方样例
