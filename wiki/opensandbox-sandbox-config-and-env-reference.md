# OpenSandbox 沙箱配置参数与环境变量参考（全链路）

- 日期：2026-08-07
- 覆盖链路：server 配置 → pod/容器 env 注入 → execd / task-executor / egress / Jupyter
- 依据：代码调研（`server/opensandbox_server/config.py`、`services/k8s/provider_common.py`、`components/execd`、`kubernetes/internal/task-executor`、`sandboxes/code-interpreter` 等）

## 0. 总体性发现（重要）

- **server 侧只固定注入一个 env：`EXECD=/opt/opensandbox/execd`**（K8s 运行时），其余 env 全部是 API 请求 `env` 字段透传
- `sandbox_id` 通过 **label** `opensandbox.io/id` 传递；egress/secure-access token 通过 **annotation** 传递
- Jupyter host/token **不**由 server 注入，由调用方经 `env` 传入（execd 读 `JUPYTER_HOST`/`JUPYTER_TOKEN`）
- 配置优先级（execd/task-executor）：默认值 → env → flag（**flag 覆盖 env**）

---

## 1. server 配置（`config.py`，pydantic 模型）

加载顺序：显式路径 → `SANDBOX_CONFIG_PATH` → 默认 `~/.sandbox.toml`（config.py:1024-1041）。唯一进程级 env override：`OPENSANDBOX_SERVER_API_KEY` 覆盖 `[server].api_key`。

### 直接影响沙箱创建的配置

| 配置 | 作用 | 默认 |
|---|---|---|
| `runtime.type` + `runtime.execd_image` | 运行时实现（docker/kubernetes）+ execd 分发镜像 | 必填 |
| `kubernetes.batchsandbox_template_file` | BatchSandbox CR 模板文件（`_merge_pod_spec_extras` 合并卷） | None |
| `kubernetes.execd_init_resources` | execd-installer init 容器资源 | None |
| `kubernetes.image_pull_policy` | 主容器镜像拉取策略 | `IfNotPresent` |
| `kubernetes.namespace` | workload 命名空间 | None |
| `kubernetes.read_qps/write_qps/burst` | K8s client 读写限速 | 0（不限） |
| `kubernetes.sandbox_create_timeout_seconds` / `sandbox_create_poll_interval_seconds` | 等待 IP 分配超时 / 就绪轮询间隔 | 60 / 1.0 |
| `ingress.mode`（direct/gateway）+ `gateway.address` | endpoint 构造方式 | direct |
| `ingress.secure_access` | OSEP-0011 签名 key（gateway 模式） | None |
| `egress.image` / `mode`（dns/dns+nft）/ `disable_ipv6` | egress sidecar 注入与 IPv6 关闭 | True |
| `storage.allowed_host_paths` / `volume_default_size` / `ossfs_mount_root` | hostPath 白名单 / PVC 默认大小 / OSSFS 根 | [] / 1Gi / /mnt/ossfs |
| `secure_runtime.type` / `k8s_runtime_class` / `docker_runtime` | gvisor/kata/firecracker 安全容器 | "" |
| `server.max_sandbox_timeout_seconds` | TTL 上限 | 不限 |
| `docker.port_range_min/max`、`pids_limit`、`drop_capabilities`、`no_new_privileges`、`seccomp_profile` | Docker 运行时安全与端口池 | 40000-60000 / 4096 / 9 caps / True |
| `[tenants]`（provider/endpoint/max_stale_seconds） | 租户鉴权 | file / 300s |
| `[renew_intent]`（enabled/min_interval_seconds/redis.*） | 访问续期意图 | False / 60 |
| `[otel]` | OpenTelemetry 导出 | False |

---

## 2. 注入到 pod/主容器的环境变量

### 主容器（`provider_common.py` `_build_main_container` :162-228）

| 变量 | 来源 | 值 |
|---|---|---|
| `EXECD` | **server 固定注入** | `/opt/opensandbox/execd` |
| 用户 `env` | API `request.env` 透传（`OPENSANDBOX_EGRESS_*` 前缀被拆分） | 原值 |
| `OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT=true` | credential proxy 启用时固定注入主容器 | true |

主容器启动命令：`command=["/opt/opensandbox/bootstrap.sh"] + entrypoint`。

### egress sidecar（`egress_helper.py` `apply_egress_to_spec` :75-131）

| 变量 | 值 |
|---|---|
| `OPENSANDBOX_EGRESS_RULES` | networkPolicy JSON |
| `OPENSANDBOX_EGRESS_MODE` | `dns`/`dns+nft`（来自 `[egress].mode`） |
| `OPENSANDBOX_EGRESS_TOKEN` | 随机生成（`secrets.token_urlsafe(24)`），经 annotation `opensandbox.io/egress-auth-token` 给 server 侧做鉴权 |
| `OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT` | credential proxy = true |
| 用户 `OPENSANDBOX_EGRESS_*` | 白名单透传（`ALLOWED_EGRESS_ENV_VARS`，constants.py:53-66） |

**egress env 拆分**（`helpers.py` `split_egress_env` :248-270）：`OPENSANDBOX_EGRESS_` 前缀 key 进 sidecar；不在白名单直接 ValueError；`MITMPROXY_TRANSPARENT` 同时进主容器；有 egress env 但无 networkPolicy 则丢弃并告警。sidecar 端口 18080（API）/ DNS 15353 / mitmproxy 18081。

### 特殊扩展 key（`extensions/keys.py`）

| Key | 作用 |
|---|---|
| `access.renew.extend.seconds` | 注解型：访问自动续期秒数（→ annotation `opensandbox.io/access-renew-extend-seconds`） |
| `bootstrap.execd.isolation=enable` | **非 env**：K8s 加 `CAP_SYS_ADMIN` + seccomp/appArmor=Unconfined + 挂 `isolation-upper` emptyDir 到 `/var/lib/execd/isolation`；Docker 加 SYS_ADMIN + tmpfs |
| `ISOLATION_UPPER_MOUNT_PATH` | 必须与 execd `UpperRoot` 一致 |
| `opensandbox.extensions.*` → `opensandbox.io/extensions.*` | 用户扩展 key 自动传播为 pod annotation |

### 其他注入

- **imagePullSecret**：`image.auth` → Secret `opensandbox-image-auth-{sandbox_id}` + `imagePullSecrets`
- **labels**（constants.py:19-27）：`opensandbox.io/id`、`expires-at`、`manual-cleanup`、`platform-os/arch`、`snapshot-id`
- **annotations**：`opensandbox.io/egress-auth-token`、`opensandbox.io/secure-access-token`
- **Windows profile**（platform.os=windows）：注入 `USER_PORTS`、`RAM_SIZE`、`CPU_CORES`、`DISK_SIZE`（windows_common.py:33-36，默认端口 44772/8080/3389/8006）

---

## 3. execd 组件（`components/execd/`）

### flag + env（`pkg/flag/parser.go`，env 设初值 → flag 覆盖）

| 参数 | env | 作用 | 默认 |
|---|---|---|---|
| `--port` | — | execd HTTP 监听端口 | **44772** |
| `--jupyter-host` | `JUPYTER_HOST` | Jupyter 服务地址 | 空 |
| `--jupyter-token` | `JUPYTER_TOKEN` | Jupyter 认证 token | 空 |
| `--log-level` | — | 日志级别 0-7 | 6（info） |
| `--access-token` | `EXECD_ACCESS_TOKEN` | API 访问 token（`X-EXECD-ACCESS-TOKEN` header 校验） | 空 |
| `--graceful-shutdown-timeout` | `EXECD_API_GRACE_SHUTDOWN` | SSE 优雅关闭等待 | 1s |
| `--jupyter-idle-poll-interval` | `EXECD_JUPYTER_IDLE_POLL_INTERVAL` | Jupyter idle 轮询 | 100ms |
| `--isolation-config` | `EXECD_ISOLATION_CONFIG` | 隔离 TOML 路径 | 空（内置默认） |

### 其他 execd env

| 变量 | 作用 | 默认 |
|---|---|---|
| `EXECD_ENVS` | 额外 env 文件（`key=value`，子进程合并注入） | bootstrap 默认 `/opt/opensandbox/.env` |
| `EXECD_LOG_FILE` | zap 日志文件路径 | stderr |
| `EXECD_CLONE3_COMPAT` | clone3 seccomp 兼容（`1/true/yes/on`=ENOSYS 过滤；`reexec`=重执行） | 空 |
| `OPENSANDBOX_ID` | telemetry sandbox_id 属性 | 空 |
| `OPENSANDBOX_EXECD_METRICS_EXTRA_ATTRS` | 额外指标属性 | 空 |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP 端点（metrics → 通用 → `HOST_IP:4318` → /etc/hostinfo） | 无 |
| `HOST_IP` | 自动上报节点 IP | 空 |

### isolation 默认值（`pkg/isolation/config.go`）

`upper_root=/var/lib/execd/isolation`、`upper_max_bytes=8GiB`、`diff_max_bytes=4GiB`、`allowed_writable=["/workspace","/mnt","/media","/data"]`（**替换**内置默认，不合并）、seccomp deny 列表（**完全替换**内置 denylist）。

### bootstrap.sh（`components/execd/bootstrap.sh`）

| 变量 | 作用 | 默认 |
|---|---|---|
| `OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT` | truthy 时等待/安装 mitm CA（≤300s），设 `NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE`/`OPENSANDBOX_MERGED_CA` 并导入 NSS/JDK 信任库 | 未设置 |
| `EXECD` | execd 二进制路径 | `/opt/opensandbox/execd` |
| `EXECD_ENVS` | env 文件路径（touch） | `/opt/opensandbox/.env` |
| `EXECD_BOOTSTRAP_PRE_SCRIPT` | 启动前 source 的用户脚本 | 空 |
| `BOOTSTRAP_CMD` / `-c "..."` / 位置参数 | 用户命令（先后台起 execd 再执行） | 无 |
| `BOOTSTRAP_SHELL` | 用户命令 shell | bash（无则 sh） |

---

## 4. task-executor（`kubernetes/internal/task-executor/config/config.go`）

优先级：默认 → env（`LoadFromEnv`）→ flag（`LoadFromFlags`，flag 覆盖 env）。

| 配置 | flag | env | 默认 |
|---|---|---|---|
| `DataDir` | `--data-dir` | `DATA_DIR` | `/var/lib/sandbox/tasks` |
| `ListenAddr` | `--listen-addr` | `LISTEN_ADDR` | `0.0.0.0:5758` |
| `CRISocket` | `--cri-socket` | `CRI_SOCKET` | `/var/run/containerd/containerd.sock` |
| `EnableSidecarMode` | `--enable-sidecar-mode` | `ENABLE_SIDECAR_MODE`（=="true"） | false |
| `MainContainerName` | `--main-container-name` | `MAIN_CONTAINER_NAME` | `main` |
| `ReadTimeout`/`WriteTimeout` | — | — | 30s/30s |
| `ReconcileInterval` | — | — | **500ms** |
| `LogMaxSize`/`MaxBackups`/`MaxAge`/`LogDir` | `--log-max-size` 等 | — | 100MB/10/7天/logs |

HTTP 路由：`POST /setTasks`、`GET /getTasks`、`POST /tasks`、`GET /tasks/{id}`、`DELETE /tasks/{id}`、`GET /health`。

---

## 5. operator/controller 环境变量（`kubernetes/` 全部 os.Getenv）

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `SYNC_SANDBOX_ALLOC_CONCURRENCY` | Pool 分配注解同步并发度 | 256 |
| `RECYCLE_POD_CONCURRENCY` | 回收 pod 并发度 | 64 |
| `POD_NAMESPACE` | controller 命名空间（poolassign ProfileStore ConfigMap watch） | 空 |
| `CONTAINERD_SOCKET` / `CONTAINERD_NAMESPACE` | image-committer 的 containerd socket/namespace | 空 |
| `SNAPSHOT_REGISTRY_INSECURE` | snapshot 允许 insecure registry | 空 |

controller 其余全走 flag（`cmd/controller/main.go:123-200`）：`--kube-client-qps=100`、`--kube-client-burst=200`、`--concurrency=batchsandbox=32;pool=16`、`--commit-job-timeout=10min`、`--snapshot-registry` 等。

---

## 6. code-interpreter 镜像侧（`sandboxes/code-interpreter/scripts/`）

### 语言版本选择

| 变量 | 作用 | 默认 |
|---|---|---|
| `PYTHON_VERSION` | Python 版本 | `3.13`（DEFAULT_PY_VERSION） |
| `JAVA_VERSION` | Java 版本 | `21` |
| `NODE_VERSION` | Node 版本（/opt/node/v*） | `22` |
| `GO_VERSION` | Go 版本（/opt/go/*） | `1.25` |
| `BASHRC_FILE` | 语言选择记录 | `/root/.bashrc` |
| `EXECD_ENVS` | 语言切换后把 PATH/JAVA_HOME/GOROOT 追加（供 execd 子进程继承） | `/opt/opensandbox/.env` |
| `EXECD_CLONE3_COMPAT` | 启动时 clone3-workaround 重执行 | 空 |

### Jupyter（code-interpreter.sh:170）

```sh
jupyter notebook --ip=127.0.0.1 --port="${JUPYTER_PORT:-44771}" --allow-root --no-browser --NotebookApp.token="${JUPYTER_TOKEN:-opensandboxcodeinterpreterjupyter}"
```

| 变量 | 作用 | 默认 |
|---|---|---|
| `JUPYTER_PORT` | Jupyter 监听端口（仅 127.0.0.1） | `44771` |
| `JUPYTER_TOKEN` | Jupyter 认证 token | `opensandboxcodeinterpreterjupyter` |

---

## 7. 分层总结：用户可控 vs 内部固定契约

### 用户/调用方可控（API 层 `CreateSandboxRequest`）

- `env`（任意 key，`OPENSANDBOX_EGRESS_*` 白名单约束）→ 主容器
- `OPENSANDBOX_EGRESS_*`（白名单 `ALLOWED_EGRESS_ENV_VARS`）→ egress sidecar；`MITMPROXY_TRANSPARENT` 同时进主容器
- `extensions`：`bootstrap.execd.isolation=enable`、`access.renew.extend.seconds`、`poolRef`、`opensandbox.extensions.*`
- `image.auth` → imagePullSecret / Docker auth
- `resourceLimits`/`resourceRequests`（`gpu` → `nvidia.com/gpu` 翻译）
- `networkPolicy` + server `egress.image` → egress sidecar 注入 + 随机 token
- `credential_proxy.enabled` → mitmproxy 透明代理
- `platform.os=windows` → USER_PORTS/RAM_SIZE/CPU_CORES/DISK_SIZE
- `JUPYTER_HOST`/`JUPYTER_TOKEN`（经 env，server 不注入）

### 内部固定契约（server/operator 硬编码）

| 契约 | 值 |
|---|---|
| 固定 env | `EXECD=/opt/opensandbox/execd`、`EXECD_ENVS=/opt/opensandbox/.env` |
| 端口 | execd `44772`、Jupyter `44771`、egress API `18080`/DNS `15353`/mitmproxy `18081`、task-executor `5758` |
| 挂载 | `opensandbox-bin` → `/opt/opensandbox`；isolation upper → `/var/lib/execd/isolation` |
| 命令 | 主容器 `command=["/opt/opensandbox/bootstrap.sh"] + entrypoint` |
| 认证 header | execd `X-EXECD-ACCESS-TOKEN`、egress `OPENSANDBOX-EGRESS-AUTH` |
| labels/annotations | `opensandbox.io/id`、`egress-auth-token`、`secure-access-token`、`alloc-status`/`alloc-release`/`endpoints`（scheduler 契约） |

---

## 8. 关联

- 配置权威来源：`server/opensandbox_server/examples/example.config.toml`、`example.config.k8s.toml`
- 组件文档：`docs/components/execd.md`、`kubernetes/README.md`、`sandboxes/code-interpreter/README.md`
- 缺陷/性能：`wiki/opensandbox-controller-defects-and-pitfalls.md`（`SYNC_SANDBOX_ALLOC_CONCURRENCY`=256 与注解 churn 的关系见 P1-1）
