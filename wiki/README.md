# OpenSandbox 调研 / 方案文档索引（wiki）

本目录集中存放针对 OpenSandbox 的调研报告、技术方案与优化方案文档（用户约定）。

已落地 / 拟合入上游的二次开发改动说明见 [`changes/`](../changes/README.md)（勿与本 wiki 混放）。

> **维护规则**：新增 wiki 文档时，提交前必须同步更新本 README 索引；删除/重命名文档时同样需要同步。详见根目录 `AGENTS.md`。

## 调研与分析

| 文档 | 主题 | 日期 |
|---|---|---|
| [CRD 控制器调谐逻辑与规模化性能风险分析](opensandbox-crd-controller-reconcile-analysis.md) | BatchSandbox/Pool 调谐逻辑、调度器与注解流、规模化性能风险 | 2026-08-07 |
| [Kubernetes 算子缺陷与坑总结（性能 & 规模化）](opensandbox-controller-defects-and-pitfalls.md) | 控制器缺陷、性能瓶颈、规模化陷阱（数百~数千 BatchSandbox/Pool） | 2026-08-07 |
| [BatchSandbox 3s 轮询 Task 执行机制调研](batchsandbox-task-3s-polling-exploration.md) | controller/scheduler/task-executor/CRD 轮询执行机制 | 2026-08-07 |
| [接入 OpenClaw 方式分析](opensandbox-openclaw-integration-analysis.md) | OpenSandbox 与 OpenClaw 集成方式对比与推荐方案 | 2026-08-12 |
| [上游 Open Issues 风险调研（禁止暂停/恢复场景）](opensandbox-open-issues-risk-review-no-pause-resume.md) | 无状态沙箱下未修复缺陷与规模化风险（gh 拉取上游 open issues） | 2026-08-13 |

## 方案设计

| 文档 | 主题 | 状态 |
|---|---|---|
| [用完即焚沙箱编排最佳模式](opensandbox-ephemeral-sandbox-orchestration-pattern.md) | 无状态/任务型沙箱全流程资源生命周期流转 | 方案设计（未实施） |
| [共享存储挂载解释器镜像最小化与快速启动](opensandbox-shared-storage-interpreter-minimal-image.md) | 解释器镜像瘦身与共享存储加速启动可行性 | 可行性评估（未实施） |
| [OpenClaw Tool Plugin 设计方案](opensandbox-openclaw-tool-plugin-design.md) | 方式 B：官方 Tool Plugin 封装 JS SDK | 方案设计 |
| [OpenClaw 插件对接自部署 Server 配置指南](opensandbox-openclaw-plugin-selfdeployed-server.md) | 代理模式下插件对接自部署 OpenSandbox Server | 配置指南 |
| [池化沙箱业务会话 S3 用户目录静默同步](opensandbox-pooled-session-s3-sync-middleware.md) | 中间层静默恢复/回写；不向业务暴露 exec；固定 postStop + 内部注入脚本 | 方案设计（未实施） |

## 参考

| 文档 | 主题 |
|---|---|
| [沙箱配置参数与环境变量参考（全链路）](opensandbox-sandbox-config-and-env-reference.md) | server 配置 → pod/容器 env 注入 → execd / task-executor / egress / Jupyter |

## 关联关系速览

```
crd-controller-reconcile-analysis ──┬── controller-defects-and-pitfalls ──┬── ephemeral-sandbox-orchestration-pattern
                                   │                                      │         └── pooled-session-s3-sync-middleware
                                   │                                      └── shared-storage-interpreter-minimal-image
                                   └── sandbox-config-and-env-reference
openclaw-integration-analysis ──┬── openclaw-tool-plugin-design ──┬── openclaw-plugin-selfdeployed-server
                                └── open-issues-risk-review-no-pause-resume
```
