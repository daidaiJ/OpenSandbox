# 池化模式监控告警与容量水位 SOP

> 日期：2026-09-03 ｜ 适用：K8s 池化部署
> 目标：值班能回答三个问题——**池子还够不够用？有没有沙箱在异常？平台自身健不健康？**
> 前置：组件内部的 OTel 指标/日志（OSEP-0010，已实现）和 egress 审计事件的采集方法见 `exporter/node-agent-observability-cookbook.md`，本文不重复，只讲"搭监控体系 + 定告警规则 + 出事找 Runbook"这一层。

---

## 1. 监控什么：一张分层清单

| 层 | 看什么 | 从哪拿 |
|---|---|---|
| **池水位**（最重要） | Pool 的 total / allocated / available / updated / revision | `kubectl get pool -o json`（没有现成 Prometheus 指标，见 §2 采集方案） |
| **创建链路健康** | create 429（池没货）、504（就绪超时）、400（参数/调度）出现频次与 P95 耗时 | server 访问日志（日志易已收的话直接配统计规则）或业务侧埋点 |
| **沙箱 Pod 健康** | 重启次数、CPU/内存用量、Pending 数 | kubelet/cAdvisor（kubectl top、Prometheus node/kubelet 指标） |
| **controller 健康** | 存活、leader、reconcile 积压、对 apiserver 限流 | helm `controller.metrics.enabled=true` 暴露 controller-runtime 标准 /metrics（workqueue、REST client 速率） |
| **server 健康** | 进程存活、apiserver 429、PostgreSQL 连接 | 进程探活 + 日志（访问日志进日志易） |
| **节点水位** | 可分配 CPU/内存、Pod 数 | node_exporter / kubectl top nodes |

> 注意：目前**没有现成的"Pool status" Prometheus 指标**（上游 #1650 在讨论池容量指标，落地后可替代自建采集）。过渡期用下面 §2 的脚本方案。

## 2. 怎么采：两步走

**第一步（当天可上线）：定时脚本 + 推送网关。** 一台能 kubectl 的机器跑 cron，把池水位推给 Prometheus Pushgateway：

```bash
#!/bin/bash
# pool-metrics.sh — 每 30s 推一次池水位
NS=opensandbox
kubectl get pools -n $NS -o json | jq -c '.items[] |
  {name: .metadata.name,
   total: .status.total, allocated: .status.allocated,
   available: .status.available, updated: .status.updated,
   revision: .status.revision, gen: .metadata.generation,
   obs: .status.observedGeneration}' |
while read -r row; do
  name=$(jq -r .name <<<"$row")
  for m in total allocated available updated; do
    echo "opensandbox_pool_$m{pool=\"$name\"} $(jq -r .$m <<<"$row")"
  done
  # CR 改了但 controller 还没 reconcile 到 → 积压信号
  echo "opensandbox_pool_reconcile_lag{pool=\"$name\"} $(( $(jq -r .gen <<<"$row") - $(jq -r .obs <<<"$row") ))"
done | curl -s --data-binary @- http://pushgateway:9091/metrics/job/opensandbox-pools
```

**第二步（有精力再升级）：** 写个小型 exporter 暴露 /metrics 供 Prometheus 抓，或等上游池容量指标。

**controller metrics 开启**（helm）：

```bash
helm upgrade opensandbox-controller <chart> -n opensandbox-system \
  --reuse-values \
  --set controller.metrics.enabled=true \
  --set controller.metrics.secure=false   # 内网裸抓取；有 PodMonitor 体系可保持 true 走 HTTPS
```

抓取后可看：workqueue 深度/延迟、REST client 请求速率与限流次数（判断要不要调 kubeClient.qps/burst）。

## 3. 告警规则建议（Prometheus 语法，阈值按实测调）

| 告警 | 表达式思路 | 阈值建议 | 出了事看哪 |
|---|---|---|---|
| **池子快见底** | `opensandbox_pool_available < bufferMin` | 持续 5 分钟 | Runbook §1.2（扩池） |
| **池子持续打满** | create 429 频次（日志统计） | >3 次/分钟持续 10 分钟 | 同上 + 容量 SOP |
| **池子没补上货** | `pool_total < poolMin` | 持续 10 分钟 | Runbook §3.1/3.2（controller 挂没挂） |
| **模板滚动卡住** | `updated < total` 且 revision 变更已超 X 小时 | 2 小时 | Runbook §4.3 |
| **CR 积压** | `pool_reconcile_lag > 0` | 持续 15 分钟 | controller 日志 |
| **controller 掉线** | deployment ready 副本 = 0 | 即时 | Runbook §3.1 |
| **create 超时变多** | 504 频次 | >5 次/10 分钟 | Runbook §2（镜像/探针/initContainer） |
| **沙箱 Pod 重启** | `restarts > 3`（30 分钟内） | 即时 | kubectl describe，区分 OOM/业务崩 |
| **节点内存水位** | 节点可用内存 < 10% | 持续 5 分钟 | 密度过高，容量 SOP 复盘 |

> 429/504 这类"业务信号"告警先靠 server 访问日志在日志易里配统计（日志已在平台上，最省事），不必强等指标化。

## 4. 联动处置

- 池水位告警 → 先看 `available` 与 429 是否同时发生 → 是：扩池（`PUT /pools/{name}`，只改 capacitySpec）→ 观察补货速率；不是：查 controller。
- 所有告警的处置动作都落到[故障排查 Runbook](opensandbox-pool-troubleshooting-runbook.md) 对应条目，值班手册直接互链。

## 5. 上线验收清单

- [ ] Pushgateway 能收到各池 5 个指标（total/allocated/available/updated/reconcile_lag）
- [ ] 手工把某池 bufferMax 临时调小制造"打满"，429 告警触发并收到通知
- [ ] 手工停 controller 副本，"controller 掉线"告警触发
- [ ] Grafana 面板能同时看到池水位曲线 + create 延迟 P95
- [ ] 值班手册里每个告警都链到 Runbook 具体条目
