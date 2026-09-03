# 池化模式容量规划与压测 SOP

> 日期：2026-09-03 ｜ 适用：K8s 池化部署
> 回答的问题：**一个节点能塞多少个沙箱？池子参数配多少？高峰扛不扛得住？**——"节点资源有限、服务更多用户"这条业务约束，靠这份实测数据说话。
> 本文是方法论 + 可复制的压测脚本；表格里的数值留白，跑完压测把实测填回去。

---

## 1. 一个沙箱到底吃多少资源（密度画像）

**别拍脑袋，实测一个**。跑一个典型业务任务的池化沙箱，观察两条线：

```bash
# 模板声明的量（这是"保底占用"，决定调度）
kubectl get pod <沙箱pod> -n opensandbox -o jsonpath='{.spec.containers[0].resources}'
# 实际用量（这是"真实消耗"，决定密度）
kubectl top pod <沙箱pod> -n opensandbox --containers
```

画像记录表（每个业务类型一行）：

| 业务类型 | 模板 requests | 实际 CPU 均值/峰值 | 实际内存 均值/峰值 | 生命周期 | 峰值并发 |
|---|---|---|---|---|---|
| 问答型短任务 | （填） | （填） | （填） | （填） | （填） |
| 长会话交互 | （填） | （填） | （填） | （填） | （填） |

三个经验提醒：

- 池化 Pod 里有**固定开销**：task-executor + execd 两个常驻进程，加上任务本身的量才算总账；
- 模板 requests 配"实际均值"、limits 配"实际峰值 × 1.5"，超卖上限控制在 2 倍以内——超卖狠了高峰就是 OOM 现场；
- 节点上能塞多少 = （节点可分配 - 系统预留）÷ 单 Pod requests，再留 20% 余量给补货风暴。

## 2. 分配延迟的账（用户感知的那几秒）

一次 create 的等待 = **池认领**（通常秒级，池里有货时）+ **Pod 就绪**（没有池就要现拉镜像，分钟级）+ server 轮询间隔（≤3 秒）。

池化的意义就是把第二项从账里抹掉——所以核心指标是：**池里有货比例（available > 0 的时间占比）** 和 **create P95**。观测口径见[监控 SOP](opensandbox-pool-monitoring-alerting-sop.md)。

## 3. 压测怎么做（三个场景）

压测前：监控面板开着（池水位 + create 耗时 + 429/504 计数）。

**脚本骨架**（并发 create → 等 Running → delete，纯 bash 即可）：

```bash
#!/bin/bash
# load.sh N=并发数 ROUND=轮数
SERVER=http://<server>:8080; KEY=<api_key>; POOL=my-pool
for i in $(seq 1 $ROUND); do
  for j in $(seq 1 $N); do
  (
    t0=$(date +%s%3N)
    id=$(curl -s -X POST $SERVER/sandboxes -H "Authorization: Bearer $KEY" \
      -H 'Content-Type: application/json' -d "{
        \"image\": {\"uri\": \"<业务镜像>\"},
        \"extensions\": {\"poolRef\": \"$POOL\"},
        \"env\": {\"LOADTEST\": \"1\"}, \"timeout\": 120
      }" | jq -r .id)
    # 等 Running
    for k in $(seq 1 60); do
      st=$(curl -s -H "Authorization: Bearer $KEY" $SERVER/sandboxes/$id | jq -r .status.state)
      [ "$st" = "Running" ] && break; sleep 1
    done
    t1=$(date +%s%3N)
    echo "$id $((t1-t0))ms $st" >> load-result.txt
    curl -s -X DELETE -H "Authorization: Bearer $KEY" $SERVER/sandboxes/$id > /dev/null
  ) &
  done; wait
done
```

| 场景 | 做法 | 看什么 |
|---|---|---|
| **A. 稳态吞吐** | 50 并发持续 10 分钟，create→Running→delete 循环 | create P50/P95；池 available 稳定区间；有无 429 |
| **B. 启动风暴** | 池子清空后瞬间打 100 并发 | 补货曲线（total 爬坡速度，受 maxUnavailable 25% 分批限制）；429 持续多久；节点资源是否打爆 |
| **C. 峰值超卖** | 并发数 = §1 算的节点容量 × 1.5 | OOM/驱逐情况；被压垮的是沙箱还是节点 |

**结果判读**：

- 429 频发但节点没满 → buffer 太小，调 `bufferMax`（注意补货是分批的，调大不会瞬间补齐）；
- create P95 > 10s 且 available 一直 > 0 → Pod 就绪慢（探针/entrypoint 优化），不是池的问题；
- 节点内存见顶 → 回 §1 重算密度，必要时缩 requests 或加节点。

## 4. 容量参数怎么配（压测反推）

四参数含义见[容量参数详解](opensandbox-pool-capacity-params.md)，扩缩容算法见[扩缩容机理](opensandbox-pool-scaling-mechanism-ops.md)。压测后的经验配法：

| 参数 | 怎么定 |
|---|---|
| `poolMax` | 节点总容量 ÷ 单 Pod requests × 0.8（硬顶，防打爆集群） |
| `bufferMax` | 峰值并发 × 1.2（风暴场景 B 实测微调） |
| `bufferMin` | 低谷期撑 5 分钟内的到达速率 × 平均租期 |
| `poolMin` | ≈ bufferMin（保底常驻） |
| `scaleStrategy.maxUnavailable` | 补货太快打爆镜像仓库/PMI 时调小；默认 25% 够用 |

## 5. 产出物（压测归档）

- [ ] 密度画像表（§1，每业务类型一行实测数）
- [ ] 场景 A/B/C 结果：P50/P95、429 曲线、节点水位曲线
- [ ] 最终 capacitySpec 数值 + 反推依据
- [ ] 结论一句话："当前 N 节点可稳定支撑 X 并发用户，池参数 Y"

> 换业务镜像、换节点规格、升级后（尤其 execd/模板变更）→ 重跑场景 A 即可，全套重跑只在架构变化时需要。
