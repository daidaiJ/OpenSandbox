# Downstream / 二次开发改动文档

本目录记录相对上游 OpenSandbox 的二次开发与 fork 改动，便于合入上游时对照差异、评估冲突与回归范围。

调研与方案类长文仍放在 [`wiki/`](../wiki/README.md)；这里只放**已落地或拟合入**的改动说明。

## 索引

| 文档 | 主题 | 日期 / 状态 |
|---|---|---|
| [954-runtime-perception-proxy.md](954-runtime-perception-proxy.md) | #954 静默重建感知：runtime-id 注解 + proxy 闸门 + fail-closed | 2026-08-13 / 已实施 |
| [pooled-session-s3-sync.md](pooled-session-s3-sync.md) | 池化会话 S3 静默恢复/回写：固定 postStop + 内部 exec prepare | 2026-08-18 / 已实施（server） |
