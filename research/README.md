# Research Notes

本目录存放**随仓库提交**的调研、选型与竞品分析长文，便于在远程仓库、PR 和代码评审中直接引用。

这里的文档是仓库内副本；`wiki/` 是外部 Obsidian 知识库的窗口，已被 `.gitignore` 排除，不作为远程可读来源。若同一主题需要长期维护，以本目录的版本为准，再按需同步到个人知识库。

## 索引

| 文档 | 主题 | 日期 |
|---|---|---|
| [cloudflare-rivet-sandbox-and-s3-survey.md](cloudflare-rivet-sandbox-and-s3-survey.md) | Cloudflare / Rivet 近期沙箱项目；Sandbox SDK 1.0、Computer、CI、ArtifactFS、Kitesurf；S3Mount / DirectoryBackup / 快照 / 懒加载；celld vs OpenOrange 的 S3 请求成本 benchmark；市面沙箱密度做法与厂商对照；S3Mount 的 FUSE 权限、CSI/PVC、E2B VM 快照与 PVC 的区别、池化模板限制、无 PVC 供应商时的 S3 同步/FUSE sidecar 备选、多轮/多会话的池化约束，以及对 OpenSandbox 的落地建议 | 2026-11-14 |
| [agentsubstrate-cubesandbox-k8s-density.md](agentsubstrate-cubesandbox-k8s-density.md) | Agent Substrate 与 CubeSandbox 如何在 K8s 上绕开调度器的串行限制实现毫秒级创建销毁；两者的容量模型与提交点（PG 行锁严格预占 vs quota 超卖 + 并发闸门）；worker Pod 在 K8s 视角的定位与和 Kata RuntimeClass 的区别；每沙箱唯一 IP / CIDR 对密度的硬约束；与 OpenSandbox Pool 模式（一沙箱一 Pod）的逐项对照与落地启示 | 2026-11-15 |
| [sandbox-provider-routes-persistence-density.md](sandbox-provider-routes-persistence-density.md) | 基于 orble（705 家供应商、142 个 2c/4G 归一化价格）与 ComputeSDK（39 家、490 组公开压测）的沙箱方案盘点；六条隔离路线（runc/gVisor/Firecracker/Kata/整机/WASM）的启动、开销与代表厂商；P0–P5 持久化保证级别（PVC 目录、镜像快照、CRIU/gVisor checkpoint、microVM 快照、整机快照）的状态矩阵与可移植性；运行/空闲/快照三项成本模型与 20–100 倍落盘差价；128c/512G 节点的密度上限、K8s 编排限制与资源限制的交叉点（1.16 vCPU / 4.65 GiB 阈值）、1c/2G 与 2c/2G 的节点规格对照、分时复用判断与工业界五类绕开方案；主流路线蓝图与 OpenSandbox 能力映射 | 2026-11-15 |
| [just-bash-s3-vfs-persistence-vs-s3fs.md](just-bash-s3-vfs-persistence-vs-s3fs.md) | just-bash 的 `IFileSystem` 抽象与四种内置文件系统；S3 接入的三条路线（`s3-bun-cached-fs` 的 SQLite 元数据 + 内容寻址 blob/pack + 远端 WAL + head CAS；Archil 的 inode 协议 + delegation + 异步 S3 同步；s3fs 挂载 + `ReadWriteFs`）；InMemoryFs/ReadWriteFs/OverlayFs 的持久化边界；just-bash 的整文件读写、`grep -r` 逐文件请求、`getAllPaths` 同步接口等约束；与 s3fs 在部署、语义、性能、一致性、数据互操作和成熟度上的逐项对比；对 OpenSandbox artifact 层的可借鉴设计 | 2026-11-17 |
| [ankacloud-sandbox-density-and-persistence.md](ankacloud-sandbox-density-and-persistence.md) | AnkaCloud 的沙箱高密度与文件产物持久化设计；一条线程一个沙箱的租约模型、10 分钟空闲暂停/24 小时 paused kill、provider 能力矩阵与 TTL 兜底；E2B/Tenki/Runta 的 pause 成本与状态保留差异；会话快照的每轮备份、revision 比较与重建恢复；记忆/人格/技能的 tar 推送与 HTTP memory API；Git/PR 代码产物外部化；无通用 artifact store、session_backup 大字段、归档 resume、回收器启动后不重启等实现边界 | 2026-11-28 |
| [mcp-identity-credential-and-code-mode.md](mcp-identity-credential-and-code-mode.md) | MCP 2026-07-28 的三层身份链路（Client/Server OAuth、URL-mode Elicitation、EMA/ID-JAG）；Solo agentgateway 的 MCP Authentication、Connector、Token Exchange、OBO、STS Elicitation 与 pre-issuance entitlement；Higress 的 Consumer、MCP 服务/工具级授权、凭证透传与 KMS；Code Mode/Search Mode/Composition 的工具模式对照；对 OpenSandbox Credential Vault、MCP Resource Server 与沙箱化 Code Mode 的落地建议 | 2026-11-28 |
