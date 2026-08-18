# 池化会话 S3 静默同步（lifecycle server）

| 项 | 内容 |
|---|---|
| 方案 | [wiki/opensandbox-pooled-session-s3-sync-middleware.md](../wiki/opensandbox-pooled-session-s3-sync-middleware.md) |
| 日期 | 2026-08-18 |
| 状态 | 已实施（server 中间层）；Pool 模板 / executor 镜像仍为运维前提 |

## 目标

池化（`extensions.poolRef`）create/delete 对业务仍是普通生命周期。server 在 Ready 之后注入回写脚本，并**后台启动** `aws s3 sync`（或 rclone）恢复用户前缀；create **不等待** CLI 结束。销毁走固定 Local `postStop`：停掉进行中的 inbound、回写同一前缀后清空 `/shared-workspace`。不新增 public OpenAPI / SDK 方法。

## 设计要点

1. **`[session_sync]`** 默认关闭。打开后仅 Kubernetes BatchSandbox。
2. 池化建 CR **始终**带固定 `postStop`（与用户无关）+ 注解 `sandbox.opensandbox.io/session-sync=pending`。
3. Ready 后内部 `pods/exec` 进 `task-executor`：写入 `.osb-sync-out.sh` 并 **后台** 拉起 inbound restore；launcher 返回即注解改为 `prepared`。launcher 失败则删 CR。exec 遇到 Pod 404 时返回 `409 KUBERNETES::POD_NOT_FOUND`（并回滚 CR），不与其它 500 prepare 失败混在一起。S3 CLI 本身不阻塞 create。
4. 身份：`metadata.user_id`（可配）→ `extensions["session.user"]`；`session_id` = sandbox id；tenant 来自鉴权上下文或 `default_tenant_id`。
5. Proxy / `get_endpoint`：仍为 pending 时 `409 SANDBOX::SESSION_NOT_PREPARED`（`proxy_gate_unprepared`，默认 true）。

## 主要改动文件

| 路径 | 作用 |
|---|---|
| `server/opensandbox_server/config.py` | `[session_sync]` |
| `server/opensandbox_server/services/k8s/session_sync.py` | 身份 / 前缀 / 钩子脚本 / prepare / 闸门 |
| `server/opensandbox_server/services/k8s/batchsandbox_provider.py` | 固定 postStop + pending 注解 |
| `server/opensandbox_server/services/k8s/client.py` | 内部 `exec_in_pod` |
| `server/opensandbox_server/services/k8s/kubernetes_service.py` | create 接入 prepare；get_endpoint 闸门 |
| `server/configuration.md` | 配置说明与 Pool 前提 |

## 验证建议

```bash
cd server
uv run pytest tests/k8s/test_session_sync.py tests/k8s/test_k8s_client.py tests/k8s/test_batchsandbox_provider.py tests/k8s/test_kubernetes_service.py tests/test_config.py -q
```

## 运维前提（本改动不部署）

- Pool：sandbox 与 task-executor 共享 `emptyDir` `/shared-workspace`
- task-executor 镜像含 sync CLI；凭证用 IRSA/Secret，禁止把 AK/SK 打进 exec
- 回收策略依赖 postStop 清盘（`Noop`）或删 Pod（`Delete`）
