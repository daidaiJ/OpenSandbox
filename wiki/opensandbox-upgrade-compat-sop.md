# OpenSandbox 升级与版本兼容 SOP

> 日期：2026-09-03 ｜ 适用：K8s 池化部署（controller helm + server 进程 + 池模板镜像）
> 核心原则：**先灰度池再全量、先升组件再升模板、server 永远最后动**。所有版本红线都来自实测踩坑，不是吓唬人。

---

## 1. 兼容矩阵（背下来）

| 组件 | 最低版本 | 低于它会怎样 |
|---|---|---|
| controller + task-executor 镜像 | 含 **PR #420** 的 latest | taskTemplate 里 lifecycle 等新字段**静默丢失**（不报错！），池模式钩子全失效 |
| execd（池模板 initContainer 安装） | **v1.1.0** | 没有 preStart/periodic 生命周期钩子 |
| egress 镜像（如启用） | v1.1.7 | 旧版出口管控行为差异 |
| server | **v0.2.3** | 与新 controller 的 CR 字段不匹配 |
| controller chart | 0.2.1（app 0.2.0） | — |
| Kubernetes | ≥ 1.21.1 | chart 约束 |
| 业务镜像 | 任意 | 需含 shell（bootstrap.sh 是 sh 脚本） |

组件怎么搭配（谁装到哪）：controller/task-executor/execd 的版本红线见[边车组件指导 §3.3](opensandbox-pool-sandbox-sidecar-components-guide.md)。

## 2. 升级顺序（照抄）

```
① 备份 server 元数据（store）          ← 出事能回头的保险
② 当前版本采集存档                     ← 出事后知道"原来是什么"
③ 升级 CRD + controller（helm）        ← 一次一个集群
④ 池模板滚动（execd/task-executor 镜像）← 灰度池先行
⑤ server 重启                          ← 最后，分钟级完成
```

每步的具体操作：

**① 备份**：server 是无状态的，元数据在 store 里。SQLite：停写窗口拷走 `~/.opensandbox/opensandbox.db`；PostgreSQL：常规快照/备份即可。

**② 版本采集**（贴进升级工单）：

```bash
helm list -n opensandbox-system
kubectl get deploy -n opensandbox-system opensandbox-controller-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
grep -E "version|type" ~/.sandbox.toml | grep -v "^#"
# 每个池模板里 execd/task-executor 镜像 tag
kubectl get pools -n opensandbox -o json | jq -r '.items[] | .metadata.name,
  (.spec.template.spec.initContainers[]?.image), (.spec.template.spec.containers[]?.image)'
```

**③ controller**：`helm upgrade ... --set controller.image.tag=latest`。升级是滚动替换单副本，期间池分配/回收会短暂停顿，**选业务低峰**，别在创建高峰做。

**④ 池模板**：改 Pool 里的 execd / task-executor 镜像 tag 后直接 apply。只会重建**空闲** Pod（默认 25% 一批），在用的等归还才换。看 `status.updated` 追到 `total` 就是滚完。

**⑤ server**：换进程/重启。池上的沙箱不受影响（server 不参与运行时），只有创建/查询/删除接口闪断。

## 3. 灰度验证（升级完先做这三件事再放流量）

1. **字段不丢冒烟**：手写一个带 lifecycle 的 BatchSandbox CR apply 上去，1 分钟后 `kubectl get batchsandbox <name> -o yaml | grep -A5 lifecycle`——字段还在才算 controller 合格（旧版会在这一步现原形）。
2. **周期钩子打点**：CR 里带 `periodic @every 30s` 写文件钩子，看五拍是否全中（2026-09-01 实测方法，见[lifecycle hooks 文档](opensandbox-lifecycle-hooks-osep0020-status-and-injection.md)）。
3. **全链路一条龙**：测试池上走一遍 create（带 env）→ GET 等 Running → 跑任务 → delete → Pool available 回升。四步都绿才升级生产池模板。

## 4. 老坑检测：新字段被"静默抹掉"

**现象**：create/apply 时没报错，但沙箱里钩子不跑、字段查不到。
**判定**：apply 前后 diff 一下 CR：

```bash
kubectl apply -f test-bsb.yaml
sleep 5
kubectl get batchsandbox test-bsb -o yaml | yq '.spec.taskTemplate' > after.yaml
diff <(yq '.spec.taskTemplate' test-bsb.yaml) after.yaml
```

diff 出来少了字段 = controller 版本不对，回 §1 红线升级。**这个坑最阴的地方是不报任何错**，所以灰度第 1 步必须做。

## 5. 回滚

| 场景 | 动作 | 注意 |
|---|---|---|
| controller 升完异常 | `helm rollback <release> -n opensandbox-system` | CRD **不会**跟着回滚（chart 里 keep 策略），一般无害；若新 CRD 字段被老 controller 误读，先停写再回 |
| 池模板镜像升完异常 | 模板 tag 改回旧版 apply，重新滚动 | 只影响新认领/重建的 Pod；在用 Pod 归还后才换，天然灰度 |
| server 升完异常 | 换回旧版本进程 | store 里多出来的字段旧版一般忽略；回滚前看 server 启动日志有无 schema 抱怨 |
| **带着新字段 CR 回滚 controller** | 先确认！ | 老 controller 会静默抹掉新字段（§4 的坑反过来）——回滚前把带 lifecycle 的池/CR 清理或确认业务可接受 |

## 6. 升级后验收

- [ ] 兼容矩阵 5 项版本全部达标（§1）
- [ ] 灰度三件事全绿（§3）
- [ ] Pool `updated == total`，available 回到 buffer 区间
- [ ] 观察一个完整高峰：create P95、429/504 无劣化（对照[监控 SOP](opensandbox-pool-monitoring-alerting-sop.md) 面板）
- [ ] 升级工单归档版本采集记录 + 冒烟结果
