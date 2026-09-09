# Issues —— 生产/压测问题排查记录

本目录沉淀定位到代码级的线上问题诊断：现象、证据链、根因、修复提案与验证判据。与 `changes/`（已落地改动）的区别：这里是"问题侧"记录，修复实施后再在对应文档标注状态。

## 索引

| 文档 | 主题 | 日期 / 状态 |
|---|---|---|
| [2026-09-10-pool-pending-scalein-churn.md](2026-09-10-pool-pending-scalein-churn.md) | Pool 压测销毁风暴：Pending → scale-in 自噬循环（buffer 口径含未 Ready pod + trim 无就绪门控最老优先）；终态 293 销毁 / 193 Running 峰值与模型吻合 | 2026-09-10 / 删除侧已闭环，待收口调度侧 message 与修复实施 |
| [2026-09-10-recycle-strategy-comparison.md](2026-09-10-recycle-strategy-comparison.md) | recycleStrategy 对比：默认 Delete 的周转删除流、Restart 的隔离缺口（emptyDir/IP）与切换前置 | 2026-09-10 / 结论固化 |
