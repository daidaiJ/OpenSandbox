# OpenSandbox 实操 Cookbook 索引（exporter）

本目录集中存放池化 K8s 部署下的实操 Cookbook（用户约定），与 `wiki/`（调研/方案文档）配套：wiki 讲"为什么"，本目录讲"怎么做"。

> **维护规则**：新增/删除/重命名 cookbook 时，必须同步更新本 README 索引，避免内容碎片化。

## Cookbook 列表

| 文档 | 主题 | 关联 wiki |
|---|---|---|
| [沙箱创建与管理 API Cookbook](sandbox-management-cookbook.md) | 创建、注入、续约、查询、删除、池管理、流量路径（proxy vs lifecycle API） | `opensandbox-sandbox-management-api-reference.md` |
| [池化模式 Pod 模板定制 Cookbook](pool-pod-template-cookbook.md) | Pool 模板预设资源/卷/initContainer、分配时动态注入、更新池、参数边界 | `opensandbox-pool-template-update-and-allocation.md` |
| [Pod 生命周期钩子 Cookbook](pod-lifecycle-hooks-cookbook.md) | preStart / postStop 钩子机制与配置 | `opensandbox-pool-allocation-time-injection.md` |
| [池化模式统一出向管控 Cookbook](egress-network-policy-cookbook.md) | egress 预置、定向阻断/放行、平台组件隔离、Higress L7 分层、验证与故障排查 | `opensandbox-egress-pool-higress-architecture.md`（附录：`opensandbox-egress-internals-reference.md`） |

## 关联关系速览

```
sandbox-management-cookbook ──┬── pool-pod-template-cookbook ──┬── pod-lifecycle-hooks-cookbook
                              │                                └── egress-network-policy-cookbook
                              └── wiki/opensandbox-egress-pool-higress-architecture
                                   └── wiki/opensandbox-egress-internals-reference（附录）
```