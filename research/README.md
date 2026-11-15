# Research Notes

本目录存放**随仓库提交**的调研、选型与竞品分析长文，便于在远程仓库、PR 和代码评审中直接引用。

这里的文档是仓库内副本；`wiki/` 是外部 Obsidian 知识库的窗口，已被 `.gitignore` 排除，不作为远程可读来源。若同一主题需要长期维护，以本目录的版本为准，再按需同步到个人知识库。

## 索引

| 文档 | 主题 | 日期 |
|---|---|---|
| [cloudflare-rivet-sandbox-and-s3-survey.md](cloudflare-rivet-sandbox-and-s3-survey.md) | Cloudflare / Rivet 近期沙箱项目；Sandbox SDK 1.0、Computer、CI、ArtifactFS、Kitesurf；S3Mount / DirectoryBackup / 快照 / 懒加载；celld vs OpenOrange 的 S3 请求成本 benchmark；市面沙箱密度做法与厂商对照；S3Mount 的 FUSE 权限、CSI/PVC、E2B VM 快照与 PVC 的区别、池化模板限制、无 PVC 供应商时的 S3 同步/FUSE sidecar 备选、多轮/多会话的池化约束，以及对 OpenSandbox 的落地建议 | 2026-11-14 |
| [agentsubstrate-cubesandbox-k8s-density.md](agentsubstrate-cubesandbox-k8s-density.md) | Agent Substrate 与 CubeSandbox 如何在 K8s 上绕开调度器的串行限制实现毫秒级创建销毁；两者的容量模型与提交点（PG 行锁严格预占 vs quota 超卖 + 并发闸门）；worker Pod 在 K8s 视角的定位与和 Kata RuntimeClass 的区别；每沙箱唯一 IP / CIDR 对密度的硬约束；与 OpenSandbox Pool 模式（一沙箱一 Pod）的逐项对照与落地启示 | 2026-11-15 |
