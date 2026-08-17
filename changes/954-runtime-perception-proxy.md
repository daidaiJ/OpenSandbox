# #954 静默重建感知（Runtime Identity / Proxy）

| 项 | 内容 |
|---|---|
| 上游议题 | [#954](https://github.com/alibaba/OpenSandbox/issues/954) silent rebuild / pool Pod 丢失后同 ID 换皮 |
| 日期 | 2026-08-13 |
| 状态 | 已实施（controller 注解 + server proxy 闸门 + fail-closed） |

## 目标

Pool 模式下 allocated Pod 被删或替换后，**重建/重启之后的第一次**经 `use_server_proxy` 的调用必须收到明确告警（`RUNTIME_REPLACED` / `RUNTIME_LOST`），让上层 agent 获知沙箱已重启或重建；禁止静默打到全新空运行时却毫无感知。

感知是 lazy 的：不推送、不轮询；只在下一次真实调用时告警。N 次重建 → 上层按新 `runtime_id` 去重后感知次数 ≤N。

## 设计要点

1. **Controller 事件驱动写身份**  
   BatchSandbox reconcile（informer）在已有 Pod list 上取首个 Ready Pod 的 **UID**，写入注解 `sandbox.opensandbox.io/runtime-id`；Failed / 无 Ready 时清空。不另起 poller。

2. **Proxy 只读注解、不做 Pod Get**  
   `get_endpoint` 已加载 BatchSandbox；附带 `OpenSandbox-Runtime-Id` 到 `Endpoint.headers`。Proxy 闸门仅比较请求头与该值，**热路径无 Pod Get/List**。

3. **Lazy 感知（N 次重建 → 上层 ≤N 次感知）**  
   - 有调用方 header、无当前 runtime → `409 SANDBOX::RUNTIME_LOST`（`runtime_id: null`）→ 运行时已没了，需**重建沙箱**  
   - header 与当前不一致 → `409 SANDBOX::RUNTIME_REPLACED`（响应体顶层 `runtime_id` = **当前** Pod UID；HTTPException 经 server flatten 后无嵌套 `detail`）  
   - `server.runtime_id_required=true` 且缺 header → `409 SANDBOX::INVALID_PARAMETER`  
   - **REPLACED 感知方式**：告警提示上层将请求头换成响应体 `runtime_id`；**换新 id = 确认已感知到沙箱重启/重建**（并按全新空环境处理）。同一 `runtime_id` 去重 → ≤N。  
   - 调用前已发生 A→B→C 时，首次观察到的是 C → 切到 C **一次**（合并，仍 ≤N）。  
   - 服务端对旧 header 可反复 409，直到调用方 header 换成新 UUID。

4. **Fail-closed（不自动补位）**  
   已 Ready 过的 pooled sandbox 发现 allocated Pod NotFound：GC `alloc-status`、标 Failed（`AllocatedPodMissing`）、Event；allocator 对 Failed 强制 `PodSupplement=0`，禁止 #954 静默换皮。

## 暴露面

- Lifecycle create/get_info：`extensions["runtime.id"]`
- Endpoint headers：`OpenSandbox-Runtime-Id`（SDK 经 `execd_endpoint.headers` 自动带上）
- 配置：`[server] runtime_id_required`（默认 `false`；proxy 部署建议 `true`）

## 主要改动文件（合入上游时对照）

### Controller / annotations

| 路径 | 作用 |
|---|---|
| `kubernetes/pkg/utils/endpoints.go` | `AnnotationRuntimeID` 常量 |
| `kubernetes/internal/controller/apis.go` | 别名导出 |
| `kubernetes/internal/controller/events.go` | `AllocatedPodMissing` |
| `kubernetes/internal/controller/batchsandbox_status.go` | Ready Pod UID → runtime-id patch；Failed/无 Ready 清空 |
| `kubernetes/internal/controller/batchsandbox_controller.go` | allocated Pod 缺失时 fail-closed |
| `kubernetes/internal/controller/allocator.go` | Failed → `PodSupplement=0` |
| `kubernetes/internal/controller/*_test.go` | runtime-id / fail-closed / no-supplement 回归 |

### Server / proxy

| 路径 | 作用 |
|---|---|
| `server/opensandbox_server/services/constants.py` | header / annotation / error codes |
| `server/opensandbox_server/services/endpoint_auth.py` | `build_runtime_id_headers` |
| `server/opensandbox_server/services/k8s/endpoint_resolver.py` | `_attach_runtime_id_headers`（piggyback，无额外 Get） |
| `server/opensandbox_server/services/k8s/kubernetes_service.py` | `get_endpoint` 附带 runtime-id |
| `server/opensandbox_server/services/k8s/workload_mapper.py` | `extensions["runtime.id"]`（create/get_info） |
| `server/opensandbox_server/api/proxy.py` | `_verify_runtime_id` 闸门 |
| `server/opensandbox_server/config.py` | `runtime_id_required` |
| `server/tests/test_routes_proxy.py` | match / replaced / lost / required |

### SDK

| 路径 | 作用 |
|---|---|
| `sdks/sandbox/python/tests/test_converters_and_error_handling.py` | `RUNTIME_LOST` / `RUNTIME_REPLACED` 错误映射 |

## 验证建议

```bash
# Server proxy gate
cd server && uv run pytest tests/test_routes_proxy.py -k runtime_id -q

# Controller / allocator
cd kubernetes
go test ./internal/controller/ -run 'Test(BuildRuntimeView_SetsRuntimeID|FailClosedOnMissingAllocatedPods|GetSandboxRequest_FailedPhaseNoSupplement)' -v

# SDK error mapping
cd sdks/sandbox/python && uv run pytest tests/test_converters_and_error_handling.py -k runtime_lost -q
```

本机落地时：proxy / controller / SDK 单测已写入；若环境缺 `uv` 或 Go module 需拉网，按上表在可用环境复跑。

## 合入注意

- 注解键 `sandbox.opensandbox.io/runtime-id` 与 header `OpenSandbox-Runtime-Id` 为稳定性契约；改名需同步 controller、server、SDK。
- 默认 `runtime_id_required=false` 保持上游兼容；生产 proxy 建议显式打开。
- Fail-closed 改变了「allocated Pod 丢失后自动补位」的旧行为，合入时需与上游 #954 讨论对齐。
