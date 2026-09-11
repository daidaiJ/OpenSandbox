---
name: pool-tuning-and-assign-guide
description: 池模式调谐与运行时优化指导：自动分配机制（谓词/打分/Profile）、多池与均衡策略配置、回收策略选型、业务方申请契约与坑清单
type: project
---

# 池模式调谐与运行时优化指导：多池、均衡策略、谓词匹配、业务方申请

> 调研日期：2026-09-11
> 版本基线：上游 `upstream/main`（池自动分配 poolassign、回收策略 Delete/Restart/Noop、Profile ConfigMap 热加载均已实现）。
> 关联文档（本文不重复其内容，只引用结论）：[池容量四参数](opensandbox-pool-capacity-params.md)、[池模式扩缩容机理与延迟](opensandbox-pool-scaling-mechanism-ops.md)、[Pool 部署核心配置](opensandbox-pool-deploy-core-config-guide.md)、[池模板更新与分配行为](opensandbox-pool-template-update-and-allocation.md)、[控制器多副本调优](opensandbox-controller-multi-replica-tuning.md)、[scale-in 自噬证据链](opensandbox-pool-scalein-trigger-evidence-chain.md)、[池模式监控告警 SOP](opensandbox-pool-monitoring-alerting-sop.md)、[沙箱管理高阶 API 参考](opensandbox-sandbox-management-api-reference.md)。

## 〇、全景：一次池化申请经过的所有"调谐"环节

```
业务层 create sandbox (extensions.poolRef)
  └─ server: 校验池模式限制 → 建 BatchSandbox(spec.poolRef=<业务传值>, template 含 entrypoint/env/TTL)
       └─ BatchSandbox 控制器:
            poolRef="*" → assignPool()：谓词过滤候选池 → 加权打分选最优 → patch 回 spec.poolRef
            容量不足 → 等待（poolCapacityExhausted 事件）→ Pool 调谐扩容后重试
            绑定: 从池取 idle pod → 分配账本(按池细粒度锁) → taskTemplate 注入 entrypoint/env
       └─ Pool 控制器:
            滞回伸缩: Available 维持在 [bufferMin, bufferMax]；总规模约束 [poolMin, poolMax]
            回收: 释放的 pod 按 RecycleStrategy(Delete/Restart/Noop) 处理
            模板更新: revision 变化 → 只重建 idle pod（分配不分 revision）
```

优化要分层看：**分配准不准**（谓词/打分，§一~三）、**形态合不合理**（多池，§四）、**池内沙箱跑得好不好**（运行时，§五）、**申请姿势对不对**（§六）。

## 一、池选择机制：poolRef 三种取值与自动分配算法

| `extensions.poolRef` 取值 | 行为 | 适用 |
|---|---|---|
| 具体池名 | 直接绑定该池，**不走任何谓词/打分** | 特殊池定向（长会话池、隔离会话池）；池名不存在则失败 |
| `"*"` | 自动分配，**固定使用 default profile**（`pool_strategy_default.go:37`） | 同类池负载均衡；业务方无需感知池名 |
| 空/不传 | 非池模式（模板模式），本指导不覆盖 | 传统按需建沙箱 |

**自动分配算法**（`poolassign/default.go`，两阶段）：

1. **谓词过滤（硬性，一票否决）**：遍历同 namespace 全部 Pool CR，任一谓词不过即剔除；全部被拒 → `NoEligiblePoolError` 事件（含每个池的拒绝原因与 failureCode），沙箱**快速失败**。
2. **加权打分（软性，择优）**：对候选池求 `Σ(score_i × weight_i)`，取最高分（同分按池名字典序稳定选择）。当前仅内置 `resbalance` 一个打分器。

关键现状限制：**`poolRef="*"` 只会用名为 `default` 的 profile**——自定义 profile 虽然可以在 ConfigMap 里定义多个，但目前没有从 BatchSandbox spec 指定 profile 的入口。想改分配行为 = 编辑 default profile。

## 二、谓词匹配详解（业务方申请必须满足的硬条件）

五个谓词注册于 `poolassign/register.go`；**default profile 只启用 4 个**（capacity/image/resource/nodeselector），`labelselector` 未启用。

| 谓词 | 匹配逻辑 | 业务方申请姿势 | 被拒时事件里看到的 |
|---|---|---|---|
| `capacity` | `poolMax - Allocated >= replicas`（BatchSandbox 的 replicas，池化沙箱恒 1） | 无需动作；靠 Pool 容量预算保证 headroom | `capacity exhausted: poolMax=N, allocated=M, desired=1` |
| `image` | sandbox 模板里的**容器镜像字符串**必须精确出现在 pool 模板镜像集合中（集合包含判定，非前缀/tag 匹配） | `entrypoint` 不含镜像——**池模式下 sandbox 模板镜像来自哪里取决于 server 组装**；定向模板模式才需自查。同池多镜像 = pool 模板多容器 | `pool images [...] do not contain any sandbox images [...]` |
| `resource` | sandbox 各容器 requests 聚合后 **≤** pool 模板对应资源（逐项比较，缺项视为 0） | 业务传的 `resource_requests` 不得超池模板规格；需要更大规格 = 换池 | `insufficient resources: cpu (pool: 2, sandbox: 4)` |
| `nodeselector` | sandbox 的 `nodeSelector`/nodeAffinity（required）必须被 **pool 的 labels + pool 模板 nodeSelector 合并集**满足 | 池模式下业务传不了 nodeSelector，实际由池模板决定；跨节点域调度 = 按节点域拆池 | `nodeSelector key "topology" not found in pool` |
| `labelselector`（**默认未启用**） | 对配置的每个 label key，**BatchSandbox 与 Pool 的 label 值必须相等**（都存在且相等） | 启用后：业务侧给沙箱打 label（如 `tier=long-session`），池打同 key label，实现"业务标签路由到对应池" | `label key "tier" missing on sandbox` / 值不等 |

**给我们的启示**：当前默认配置下，异构池路由实际靠 `image`（不同模板镜像天然分流）+ `resource` + `nodeselector`；要按"部门/会话类型"这类业务语义路由，必须启用 `labelselector` 谓词（§三的 Profile 配置），这是把"业务方申请语义"接进自动分配的唯一通用钩子。

## 三、均衡策略配置

### 3.1 内置打分器 resbalance

`score = 1 - Allocated/Total`（LeastAllocated，默认）或 `= Allocated/Total`（MostAllocated），default profile 权重 100（唯一打分器，权重无实际竞争）。

两者的调谐影响方向相反，选型要跟池形态绑定：

| 维度 | LeastAllocated（默认，摊开） | MostAllocated（装填） |
|---|---|---|
| 分配压力 | 摊到所有池，单池 reconcile/账本压力小 | 集中在前几个池 |
| 缩容友好度 | **差**：所有池都挂着已分配 pod，谁也缩不到底 | **好**：装满的池继续接活，空池可整体回收到 poolMin |
| 池抖动 | 每次分配都可能换池 | 倾向粘住同一池 |
| 适用 | 池数少、要求负载均匀、几乎不缩容 | **池数多、密度优先、有 scale-in 需求**（与我们约束一致） |

### 3.2 配置载体：ConfigMap `pool-assign-profiles`（热生效）

控制器 watch 同 namespace 下名为 `pool-assign-profiles` 的 ConfigMap（`profile_loader.go:35`），informer 热更新、改完即生效，不用重启。default profile 的出厂值：

```yaml
apiVersion: v1
kind: ConfigMap
metadata: {name: pool-assign-profiles, namespace: <controller 所在 ns>}
data:
  profiles.json: |-
    [{
      "name": "default",
      "plugins": {
        "predicate": ["capacity", "image", "resource", "nodeselector"],
        "score": [{"name": "resbalance", "weight": 100}]
      },
      "pluginConf": [{"name": "resbalance", "args": {"strategy": "LeastAllocated"}}]
    }]
```

常用改法：

```json
// 例 1：切 MostAllocated（多池 + 要缩容能力）
"pluginConf": [{"name": "resbalance", "args": {"strategy": "MostAllocated"}}]

// 例 2：启用 labelselector 业务标签路由（键列表）
"predicate": ["capacity", "image", "resource", "nodeselector", "labelselector"],
"pluginConf": [
  {"name": "resbalance", "args": {"strategy": "MostAllocated"}},
  {"name": "labelselector", "args": {"keys": ["opensandbox.io/pool-tier"]}}
]
```

注意：`plugins.predicate` 里写了但未注册的名字会被**静默跳过**（`factory.go` 的 `if ok` 分支不报错）——配置拼错谓词名不会失败，只会"看起来没生效"，排障先查控制器日志 `detected assign profiles ConfigMap` 的 data 内容。

## 四、多池形态设计：收益与成本评估（业务背景视角）

评估前提（与 [execd init 指导](opensandbox-execd-init-rollout-guide.md) §〇 同一业务基线）：池化主路径、用完即焚、节点资源受限（密度优先）、namespace 审批制数量少、业务层管租户、netpol 按 `pool-name` label 圈隔离域。

### 4.1 收益判定（逐项，按对我们的价值排序）

| 收益项 | 机制 | 业务价值 | 判定 |
|---|---|---|---|
| 部门隔离与配额落点 | 一池一部门，容量四参数按部门预算独立设定，配额超了只拖累自己的池 | 与"租户控制在业务层、namespace 审批制"模型天然对齐——**namespace 稀缺，池是业务层想要的配额粒度**；netpol/监控/告警全部按池名对号 | **高（拆池第一理由）** |
| 模板差异的物理边界 | 一池一模板（镜像/资源规格/节点域/预置卷与网络策略），差异部门本来就不能共池 | 我们多部门场景下这部分池**无论何时都必须存在**，不是新增成本 | **高（被动成立）** |
| 蓝绿升级 | 新池接管流量（labelselector tier 换值）→ 旧池衰减回收；绕开"模板更新只重建 idle、分配不分 revision"的混版问题 | 把池模板升级从"赌 idle 重建窗口"变成确定性操作；大版本变更（基础镜像换代）时价值最大 | **高（运维红利）** |
| 故障半径隔离 | 自噬（#1425 前池控制器冻结）、回收异常、坏模板都限制在单池 | 单池故障不再全量；配合蓝绿可灰度验证模板 | **中高** |
| 分配吞吐/锁竞争 | poolRef="*" 分配时遍历全池打分；分配账本按池细粒度锁（`poolEntry` RWMutex），多池降低单锁争用；Pool CR 多 key 并行 reconcile | 真实存在但**是第二梯队**：我们的分配瓶颈主要在控制器并发/QPS 与突发行为（自噬类），先调 [多副本参数](opensandbox-controller-multi-replica-tuning.md) 再看 | **中低（不为它拆池）** |
| 均衡抗热点 | 同 tier 多池 + LeastAllocated 分摊分配压力 | 单池已经在池内分摊 pod，多池只是在池间再分摊一层；池数个位数时增益有限 | **中低** |

### 4.2 成本账（显式列出）

| 成本项 | 类型 | 量级 | 缓解 |
|---|---|---|---|
| buffer 底座碎片化 | **资源（最重）** | `bufferMin` 是 per-pool 常驻 idle：拆 N 个池 = N×bufferMin 聚合底座。1 池 bufferMin=5 vs 4 池各 5 = idle 从 5 变 20，直接吃密度预算 | 池数量纪律（部门级、个位数）；每池 bufferMin 单独过账，小部门复用共享池而不是独立建池 |
| capacity headroom 重复预留 | 资源 | 每池 poolMax 都要留峰值余量，池越多聚合浪费越大；全部池贴顶时 `NoEligiblePoolError` 快速失败 | 容量预算集中评审；按部门流量画像设 poolMax，不按部门要价 |
| 运维对象 ×N | 运维 | 监控告警（[池水位 SOP](opensandbox-pool-monitoring-alerting-sop.md) 按池采集）、netpol 策略、Restart 回收参数、蓝绿流水线全部按池数翻倍 | 部门级拆池本身限制了 N；模板化建池（CR 生成脚本） |
| 路由复杂度 | 工程 | 自动分配域靠 labelselector tier 圈定（需启用谓词 + 业务侧打标）；pin 池名的特殊池游离在均衡域外 | SDK 统一封装 `poolRef: "*"`，tier 标签由业务层注册时声明、平台映射 |
| 均衡策略副作用 | 运维 | LeastAllocated 让所有池都挂已分配 pod，**scale-in 时谁也缩不到底**；MostAllocated 保留缩容但引入池粘性 | 策略选型随池形态定（§3.1）；监控加"池空置率"视角 |

### 4.3 结论：拆/不拆的判定规则

1. **必拆**：模板不同的部门（镜像/资源/节点域差异）——这不叫优化，叫正确性。
2. **值得拆**：流量体量足以独立承担 buffer 底座的部门；需要蓝绿升级窗口的大版本变更期。
3. **不拆**：小流量部门（共享池 + labelselector tier 做软隔离）；单纯为了"分配更快/更均衡"——先调控制器参数，多池是第二梯队手段。
4. **拆后验收指标**：同 tier 各池 `Allocated/Total` 偏差（LeastAllocated 下应 <10% 量级）；聚合 idle pod 数 vs 预算（bufferMin×N 的账）；`NoEligiblePoolError` 计数归零。

## 五、运行时模式优化（池内沙箱生命周期）

### 5.1 容量四参数与伸缩（要点）

机制与公式详见[扩缩容机理 doc](opensandbox-pool-scaling-mechanism-ops.md)，优化视角三个要点：

1. `bufferMin` 决定冷启动兜底下限、`bufferMax` 决定突发吸收上限；滞回窗口宽度（bufferMax−bufferMin）决定伸缩频率——窗口太窄会来回抖（频繁建/删 pod，放大调谐压力）。
2. 扩容延迟 ≈ pod 就绪时间（镜像拉取占大头），poolMin 底座要覆盖"扩容窗口期内的到达量"。
3. 观测就绪后用[监控告警 SOP](opensandbox-pool-monitoring-alerting-sop.md)的水位脚本盯 `Available < bufferMin` 的持续时间——长期贴 min 说明 bufferMin 低估。

### 5.2 回收策略选型（RecycleStrategy）

| Type | 释放时动作 | 优点 | 风险/成本 | 适用 |
|---|---|---|---|---|
| `Delete`（默认） | 删 pod 重建 | 状态彻底归零、无残留 | 冷启动成本回满池（pod 重建 + execd/Jupyter 预热） | 短任务、强无状态、安全敏感 |
| `Restart` | 容器内 `kill 1`（`restart_default.go`，30s 间隔/3 次重试/10s 超时，blacklist 可排除 sidecar） | 保住 page cache 与镜像热度，回收快 | **数据残留**：容器文件系统不重置（我们已踩过泄漏坑，见[卷与残留 doc](opensandbox-pool-mode-volumes-and-storage-practice.md)）；与 execd init 模式兼容性已验证（`kill 1` → 转发退出 → kubelet 重启） | 同模板高频复用、追求回收速度、能接受清态校验 |
| `Noop` | 不做任何事 | 最快 | 残留最重，只适合自证清理的场景 | 调试 |

选型原则与我们业务对齐：**主力短任务池用默认 Delete**；若实测回收耗时占比显著（release→ready 延迟账），对同构高频池试点 Restart，但必须配套"敏感目录清态校验"（回收时校验 workspace/临时目录），并注意 Restart 的 exec 需要的 RBAC/权限。

### 5.3 模板更新与蓝绿

上游行为：模板变更 → revision 更新 → **只重建 idle pod**，已分配 pod 继续用旧 revision，分配不区分 revision → 池内混版。优化路径：

- 小修小补（env、镜像 tag 内小版本）：接受混版，靠 `UpdateStrategy.maxUnavailable`（默认 25%）控制重建风暴；观测 `status.updated` 追平 `total` 的进度。
- 大变更（基础镜像换代、模板结构变化）：**蓝绿**——建新池（新模板）→ 切自动分配域（labelselector tier 标签换值）→ 旧池流量自然衰减后缩到 0 删除。这也是多池形态的核心运维红利。

### 5.4 其他运行时开关

- **TTL/续约**：池化沙箱 `expires_at` 到期回收，业务可 renew（OSEP-0009 自动续约上游在推进）；业务层按"会话时长分布"设 TTL，避免长会话被误回收（详见[续约机制 doc](opensandbox-sandbox-lease-and-manual-cleanup.md)）。
- **ScaleStrategy.maxUnavailable**：缩容时最多可不可用比例，默认 25%——池很小时（如 poolMin=4）25% 只护 1 个 pod，缩容风暴期用绝对数更可控。

## 六、业务方申请契约（申请姿势速查）

**沙箱申请（业务层 → server）**，池模式相关字段：

| 请求字段 | 池模式行为 |
|---|---|
| `extensions.poolRef` | 池名 / `"*"`（自动分配）；**互斥限制**：池模式下 `volumes`、`networkPolicy`（egress settings）、`platform` 传了直接报错（`batchsandbox_provider.py:158-170`）——卷与网络管控都在池模板层面预置，业务请求带不动 |
| `entrypoint` / `env` | 经 taskTemplate 在**分配时**注入绑定的 pod（用户信息注入走这条路，见[分配时注入 doc](opensandbox-pool-allocation-time-injection.md)） |
| `expires_at` | TTL，到期回收，可续约 |
| `labels` | 若启用 labelselector 谓词，则参与池路由；同时也是 netpol `pool-name` 类策略的匹配面 |
| `resource_requests` | 必须 ≤ 所在池模板 requests，否则 capacity 分配阶段被拒 |

**池管理（平台管理员 → server pool API 或直接 Pool CR）**：`POST/GET/PATCH/DELETE /pools`（`pool_service.py`），manifest 即 `template + capacitySpec` 四参数；回收/伸缩/更新策略目前 server pool API **不透出**（只建 template+capacity），要配 `recycleStrategy` 等需直接写 Pool CR——管理 SOP 里应固定"CR 是策略源，API 是容量源"的分工。

**业务方接入检查清单**（分配失败排障顺序）：

1. create 响应/事件里看 `NoEligiblePoolError` 的逐池拒绝原因（谓词表 §二对照）。
2. capacity exhausted → 查池水位与扩容（不是 bug，是预算）。
3. 长时间 `waiting for Pool capacity` → Pool 控制器是否在扩、buffer 是否触顶。
4. 分配成功但行为异常 → 查混版（`status.updated < total`）与模板。

## 七、坑清单

1. **谓词名拼错静默跳过**：profile 里未注册的插件名不报错不生效，改 ConfigMap 后先看控制器日志确认加载内容。
2. **`"*"` 只认 default profile**：定义了再多个自定义 profile 也没有选择入口，改行为=改 default。
3. **image 谓词是精确字符串匹配**：池模板镜像和沙箱请求镜像差一个 registry 前缀/tag 就拒；换镜像源时同步改池模板。
4. **池模式三拒绝**：volumes/networkPolicy/platform 传了即报错——业务 SDK 封装里要把这三个字段在池模式分支剔除，否则白屏式 4xx。
5. **Restart 回收的残留**：容器 fs 不重置，敏感数据池禁用；execd init 模式下 Restart 的 `kill 1` 契约已验证兼容，但需保持 Restart 重试参数默认值（30s/3 次）不要压小。
6. **labelselector 是唯一业务语义路由钩子**：不启用它，自动分配对"部门/会话类型"完全无感，只会按镜像/资源/节点分流。
7. **MostAllocated 换缩容**：切换策略后空池才能回收，监控要加"池空置率"视角，否则缩容收益静默丢失。
8. **混版是常态不是事故**：任何"必须全池同版本"的假设（如按池统一升级 egress 配置）都要改成蓝绿池模式执行。

## 八、推荐落地路线

1. **先立分配域语义**：启用 labelselector 谓词 + 池/沙箱打 `tier` 标签，业务层 SDK 统一 `poolRef: "*"`——这是后续所有形态调整的地基。
2. **按部门拆池（个位数）**，每池容量四参数过 buffer 底座账；同 tier 多池默认 LeastAllocated 起步，实测缩容占比后再评估 MostAllocated。
3. **主力池维持 Delete 回收**，高频同构池试点 Restart + 清态校验；池模板升级一律走蓝绿。
4. **观测先行**：接入池水位监控（既有 SOP）+ 分配失败事件告警（NoEligiblePoolError/capacity exhausted 计数），再谈参数调优——没有水位数据，bufferMin/bufferMax 的每次调整都是猜测。
