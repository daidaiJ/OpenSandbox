# Pool Pod 模板更新与 Pod 分配行为排查

> 日期:2026-08-18
> 场景:手动修改 Pool CRD 的 `spec.template` 后,发现控制器没有重建已有 pod,上游业务也一直拿不到新模板创建的沙箱 pod。

## 结论速览

1. **修改 `pool.spec.template` 后,控制器只重建"空闲(idle)"的 pod**——即当前没有被分配给任何 sandbox 的 pod。已分配的 pod 完全不受影响,直到被释放回池子。
2. **分配算法不区分 revision**:新 sandbox 从 idle 池里按列表顺序拿 pod,新旧 revision 混在一起先到先得。只要池子里还有旧 revision 的 idle pod,新沙箱就可能拿到旧 pod。
3. **pod 侧没有任何指向 BatchSandbox 的所有权注解/ownerReference**;分配关系是单向记录在 BatchSandbox 的注解上的。

## 更新机制(为什么只重建 idle pod)

- Pool watch 使用 `GenerationChangedPredicate`,spec 变更(bump generation)会触发 reconcile。
- `calculateRevision`(`pool_controller.go`)对 `pool.Spec.Template` 做 sha256,得到新 revision;新创建的 pod 打上 `sandbox.opensandbox.io/pool-revision` 标签(`createPoolPod`)。
- `recreateUpdateStrategy.Compute`(`pool_update.go`)的输入是 `idlePods`——即"Ready 且未被分配"的 pod(`scheduleSandbox` 中 `idlePods = pods - latestAllocation`)。
- **allocated pod 被完全忽略**(测试 `TestRecreateUpdateStrategy_Compute` 有 "allocated pods not in idle list are ignored" 用例)。
- 替换受 `UpdateStrategy.MaxUnavailable`(默认 25%)预算限制,idle pod 分批替换。
- 若所有 pod 都被分配,`updatePool` 的 `SupplyUpdateRevision = 0`,`scalePool` 不会创建新 pod,池子里全是旧 pod。

## 分配机制(为什么新沙箱可能拿到旧 pod)

- `PackedSchedule.Schedule`(`algorithm/packed.go`)按 `availablePods` 列表顺序分配,而 `availablePods` 只是"Ready 且未被分配"的 pod(`getAvailablePodsFromAlloc`),**不区分 revision**。
- 因此即使新 revision 的 pod 已创建,只要 idle 池里还有旧 pod,新 sandbox 仍可能先拿到旧的。

## 所有权关系(pod → BatchSandbox)

**不存在正向索引。** pod 上只有:

- Labels:`sandbox.opensandbox.io/pool-name`、`sandbox.opensandbox.io/pool-revision`
- OwnerReference:指向 **Pool**(`pool_controller.go` 的 `ctrl.SetControllerReference(pool, pod)`),不是 BatchSandbox

分配关系记录在 **BatchSandbox 注解**上(`apis.go`):

| 注解 | 含义 |
|---|---|
| `sandbox.opensandbox.io/alloc-status` | 当前分配的 pod 列表 `{"pods":["pod-a","pod-b"]}` |
| `sandbox.opensandbox.io/alloc-release` | 待释放的 pod 列表 |
| `sandbox.opensandbox.io/alloc-released` | 已完成释放的 pod 列表 |

控制器内存的 `InMemoryAllocationStore`(podName → sandboxName)也是从这些注解 `Recover` 出来的,无独立持久化。

查询"pod 属于哪个 sandbox"只能反向遍历 BatchSandbox 的 `alloc-status` 注解。

## 操作指南:让沙箱换成新模板的 pod

推荐顺序:

1. **清掉旧 revision 的 idle pod**,让池子只剩新 pod:

   ```bash
   # 确认新 revision 与替换进度
   kubectl get pool <name> -o jsonpath='{.status.revision} {.status.updated}/{.status.total}'

   # 列出各 pod 的 revision
   kubectl get pods -l sandbox.opensandbox.io/pool-name=<name> \
     -o custom-columns=NAME:.metadata.name,REV:.metadata.labels.sandbox\.opensandbox\.io/pool-revision

   # 删除旧 revision 的 idle pod(未分配的),控制器会立即补新 revision 的 pod
   kubectl delete pod <旧rev-idle-pod-1> <旧rev-idle-pod-2> ...
   ```

   ⚠️ 只删 **idle** 的 pod。已分配的 pod 删了会直接断沙箱,且 sandbox 的 `alloc-status` 仍记录该 pod 名,可能导致沙箱卡在缺 pod 状态。

2. **对已分配的沙箱,触发 release 换新 pod**:

   ```bash
   kubectl annotate batchsandbox <name> \
     'sandbox.opensandbox.io/alloc-release={"pods":["<旧pod名>"]}' --overwrite
   ```

   控制器 recycle 该 pod 回池子 → 变 idle → 更新策略替换成新 revision → 沙箱 supplement 重新分配新 pod。**前提是第 1 步已清干净旧 idle pod**,否则可能又拿到旧的。

3. **业务允许断的话,直接删 BatchSandbox 重建**(同样要求池子里没有旧 idle pod)。

加速替换:临时把 `pool.spec.updateStrategy.maxUnavailable` 调到 100%,但只影响 idle pod,已分配的仍要走 release。

## 相关代码位置

| 文件 | 关键点 |
|---|---|
| `kubernetes/internal/controller/pool_controller.go` | `reconcilePool` / `updatePool` / `calculateRevision` / `createPoolPod` / `scheduleSandbox` |
| `kubernetes/internal/controller/pool_update.go` | `recreateUpdateStrategy.Compute`(只处理 idle pod) |
| `kubernetes/internal/controller/allocator.go` | `getAvailablePodsFromAlloc`(availablePods 定义) |
| `kubernetes/internal/controller/algorithm/packed.go` | `PackedSchedule.Schedule`(不区分 revision) |
| `kubernetes/internal/controller/apis.go` | `AnnoAllocStatusKey` / `AnnoAllocReleaseKey` / `AnnoAllocReleasedKey` |