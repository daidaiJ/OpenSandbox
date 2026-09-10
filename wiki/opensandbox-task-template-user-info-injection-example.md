# 示例：动态传递用户信息（user_id + user_auth_token）给 task 模板

- 日期：2026-08-19
- 关联：`wiki/opensandbox-pool-allocation-time-injection.md`、`wiki/opensandbox-pooled-session-s3-sync-middleware.md`、`wiki/opensandbox-create-sandbox-params-reference.md`
- 代码位置：`server/opensandbox_server/services/k8s/batchsandbox_provider.py`

---

## 目标

下游业务侧在 **create 时传参**（`user_id` + `user_auth_token`），**server 在分配时自动注入**（业务侧不直接调 exec），把这些信息动态注入进 task 模板，最终写进沙箱（env 或文件），供业务进程 / 脚本使用。**只要分配时注入一次**，不需要运行中任意时刻注入。

> **结论**：本场景下 **taskTemplate 命令注入即可，无需 k8s exec 接口**——用户信息在 create 时已知，taskTemplate 是 server 每次分配时生成的，天然在分配后执行。详见 `wiki/opensandbox-pool-allocation-time-injection.md` §5.1c。

> **创建沙箱参数说明书**（池化模式参数、extensions、续约）见 `wiki/opensandbox-create-sandbox-params-reference.md`。

## 注入方式

| 方式 | 说明 |
|---|---|
| **A. env 注入** | 用户信息作为 env 传给 task 进程（推荐，token 不进命令行日志） |
| **B. 文件注入 + 调用** | 渲染用户信息到文件，再调用脚本（需改 `_build_task_template`） |
| **C. BatchSandbox YAML** | 上述两种方式的最终 CR 形态（含 lifecycle） |
| **D. 从现有池化 CR 改造** | 现有池化 BatchSandbox（无 taskTemplate）→ 加 taskTemplate 注入 |

---

## 方式 A：env 注入（推荐）

### 1. 请求侧：用户信息经 `env` 传入

```python
# 调用方（kubernetes_service.py 或 BFF）在构造 env 时合并用户信息
env = {
    **request_env,                       # 业务 env
    "OSB_USER_ID": user_id,              # 用户 ID
    "OSB_USER_AUTH_TOKEN": user_token,   # 用户授权 token（敏感）
}
```

### 2. `_build_task_template` 已支持 env 注入（零改动）

`_create_workload_from_pool` 把 `env` 透传给 `_build_task_template`，后者已把 `env` 转成 `env_list` 并注入 `OPENSANDBOX_ID`：

```python
def _build_task_template(self, entrypoint, env, sandbox_id):
    ...
    env_list = [{"name": k, "value": v} for k, v in env.items()] if env else []
    env_list.append({"name": "OPENSANDBOX_ID", "value": sandbox_id})
    return {
        "spec": {
            "process": {
                "command": wrapped_command,
                "env": env_list,   # 已包含 OSB_USER_ID / OSB_USER_AUTH_TOKEN
            }
        }
    }
```

### 3. 沙箱内读取

```sh
# 沙箱内
echo "user=$OSB_USER_ID"
curl -H "Authorization: Bearer $OSB_USER_AUTH_TOKEN" https://api.example.com/...
```

**优点**：零改动、token 不进命令行日志、符合现有机制。
**局限**：只注入 env，不落盘文件；若需供 postStop 回写脚本用，需方式 B。

---

## 方式 B：文件注入 + 调用（渲染用户信息到文件）

在 `_build_task_template` 里，把用户信息渲染成一段脚本内容，通过命令写入文件并调用：

```python
def _build_task_template(self, entrypoint, env, sandbox_id):
    # 1. 从 env 提取用户信息
    user_id = env.get("OSB_USER_ID", "")
    user_token = env.get("OSB_USER_AUTH_TOKEN", "")

    # 2. 渲染用户信息脚本（写入 /shared-workspace/.osb-user-info.sh）
    #    注意：token 用单引号 heredoc 避免 shell 展开；文件 chmod 600 防同 pod 其他进程读
    user_info_script = f"""#!/bin/sh
set -eu
cat > /shared-workspace/.osb-user-info.env <<'EOF'
OSB_USER_ID={user_id}
OSB_USER_AUTH_TOKEN={user_token}
EOF
chmod 600 /shared-workspace/.osb-user-info.env
"""

    # 3. 把"写文件 + 调用"作为 task 命令的一部分
    #    先写用户信息文件，再执行原 entrypoint
    escaped_entrypoint = ' '.join(shlex.quote(arg) for arg in entrypoint)
    if self.execd_run_as_init:
        user_process_cmd = (
            f"{user_info_script} && "
            f"exec /opt/opensandbox/bootstrap.sh {escaped_entrypoint}"
        )
    else:
        user_process_cmd = (
            f"{user_info_script} && "
            f"/opt/opensandbox/bootstrap.sh {escaped_entrypoint} &"
        )

    wrapped_command = ["/bin/sh", "-c", user_process_cmd]

    # 4. env 仍可注入（供业务进程直接读）
    env_list = [{"name": k, "value": v} for k, v in env.items()] if env else []
    env_list.append({"name": "OPENSANDBOX_ID", "value": sandbox_id})

    return {
        "spec": {
            "process": {
                "command": wrapped_command,
                "env": env_list,
            }
        }
    }
```

沙箱内读取：

```sh
# 沙箱内：source 用户信息文件
. /shared-workspace/.osb-user-info.env
echo "user=$OSB_USER_ID"
curl -H "Authorization: Bearer $OSB_USER_AUTH_TOKEN" https://api.example.com/...
```

**优点**：用户信息落盘成文件，可供 postStop 回写脚本等复用。
**局限**：token 会出现在 task 命令里（`_build_task_template` 生成的命令），**可能进 task-executor 日志**——需确认日志脱敏，或改用方式 A（env 注入）承载 token。

---

## 方式 C：BatchSandbox YAML 示例（task 模板注入用户配置 + 执行脚本）

> 这是 `_build_task_template()` 最终生成的 **BatchSandbox CR** 形态。CRD 结构见 `kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go`：`spec.taskTemplate.spec.process.{command, env, lifecycle}`。

### C.1 完整示例（env 注入 + 文件注入 + 调用脚本 + postStop 回写）

```yaml
apiVersion: sandbox.alibaba.com/v1alpha1
kind: BatchSandbox
metadata:
  name: sandbox-abc123
  namespace: default
  labels:
    opensandbox.io/pool: my-pool          # 关联池
spec:
  replicas: 1
  poolRef: my-pool                          # 引用预热池（复用已建 pod）
  expireTime: "2026-08-19T12:00:00Z"        # 可选：到期自动销毁
  taskTemplate:
    spec:
      process:
        # 主命令：先写用户信息文件，再调用脚本，最后启动业务 entrypoint
        # 注意：command 是 []string，整段 shell 用 /bin/sh -c 包裹
        command:
          - /bin/sh
          - -c
          - |
            set -eu
            # 1) 注入用户配置：把 user_id 写进文件（token 走 env，不进文件/命令行）
            cat > /shared-workspace/.osb-user-info.env <<'EOF'
            OSB_USER_ID=user-12345
            EOF
            chmod 600 /shared-workspace/.osb-user-info.env
            # 2) 调用脚本：执行用户初始化脚本（脚本内容由 server 渲染进命令）
            /bin/sh /shared-workspace/.osb-init.sh
            # 3) 启动业务 entrypoint（execd bootstrap）
            exec /opt/opensandbox/bootstrap.sh /bin/bash
        # 环境变量注入（方式 A：token 走 env，避免进命令行日志）
        env:
          - name: OSB_USER_ID
            value: "user-12345"
          - name: OSB_USER_AUTH_TOKEN
            value: "eyJhbGciOiJIUzI1NiIs..."   # 敏感 token，走 env 不落盘
          - name: OPENSANDBOX_ID
            value: "sandbox-abc123"
        # 执行位置：Remote = 进主容器（nsenter）；Local = task-executor 容器
        execMode: Remote
        # 生命周期钩子（可选）：postStop 在任务停止后执行（如回写/清盘）
        lifecycle:
          postStop:
            execMode: Local
            timeoutSeconds: 180
            exec:
              command:
                - /bin/sh
                - -c
                - |
                  set -eu
                  HOOK=/shared-workspace/.osb-sync-out.sh
                  if [ -x "$HOOK" ]; then "$HOOK"; fi
                  find /shared-workspace -mindepth 1 -delete
      timeoutSeconds: 3600                    # 可选：任务超时
```

### C.2 只注入 env（方式 A，最简）

```yaml
apiVersion: sandbox.alibaba.com/v1alpha1
kind: BatchSandbox
metadata:
  name: sandbox-abc123
  namespace: default
spec:
  replicas: 1
  poolRef: my-pool
  taskTemplate:
    spec:
      process:
        command:
          - /bin/sh
          - -c
          - exec /opt/opensandbox/bootstrap.sh /bin/bash
        env:
          - name: OSB_USER_ID
            value: "user-12345"
          - name: OSB_USER_AUTH_TOKEN
            value: "eyJhbGciOiJIUzI1NiIs..."
          - name: OPENSANDBOX_ID
            value: "sandbox-abc123"
        execMode: Remote
```

### C.3 字段说明

| 字段 | 说明 |
|---|---|
| `spec.poolRef` | 引用预热池，**复用已建 pod**（不重建） |
| `spec.taskTemplate.spec.process.command` | 主命令（`[]string`，必填）。整段 shell 用 `/bin/sh -c` 包裹，命令内可 `cat > file <<'EOF'` 写文件 + `sh file` 调用脚本 |
| `spec.taskTemplate.spec.process.env` | 环境变量（`corev1.EnvVar` 列表）。**token 走这里**，避免进命令行日志 |
| `spec.taskTemplate.spec.process.execMode` | `Remote` = 进主容器（nsenter）；`Local` = task-executor 容器。默认跟随 sidecar 配置 |
| `spec.taskTemplate.spec.process.lifecycle` | `preStart` / `postStop` 钩子，`exec.command` + `execMode` + `timeoutSeconds` |
| `spec.taskTemplate.spec.timeoutSeconds` | 任务超时（可选） |

> **注意**：`command` 里的 heredoc（`<<'EOF'`）在 YAML 中要用 `|` 块标量保留换行。token 若写进 `command` 会进 task-executor 日志，**应放 `env`**。

---

## 方式 D：从现有池化 BatchSandbox 改造（加 task 模板注入）

> 现有池化样例：`kubernetes/config/samples/sandbox_v1alpha1_pooled_batchsandbox.yaml`。它**没有 `taskTemplate`**（走快路径，池 pod 继续跑自己的 warm entrypoint），所以**无法注入任何用户信息**。改造 = 加一个 `taskTemplate`。

### D.1 改造前（现有池化 BatchSandbox，无注入）

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: BatchSandbox
metadata:
  labels:
    app.kubernetes.io/name: opensandbox
    app.kubernetes.io/managed-by: kustomize
  name: batchsandbox-pool-sample
  namespace: opensandbox
spec:
  poolRef: pool-sample
  replicas: 2
  expireTime: "2026-12-03T12:55:41Z"
```

**问题**：没有 `taskTemplate` → `_create_workload_from_pool()` 走快路径（`needs_task_template` 为 False），池 pod 继续跑 warm entrypoint，**user_id / token 注入不进去**（连 `OPENSANDBOX_ID` 都注入不了）。

### D.2 改造后（加 taskTemplate + taskResourcePolicyWhenCompleted）

在 D.1 基础上新增 `taskTemplate`（结构同方式 C.1，`command` 写文件 + 调用脚本 + 启动业务，`env` 放 token，`execMode: Remote`，可选 `lifecycle.postStop`），并显式加 `taskResourcePolicyWhenCompleted: Retain`：

```yaml
spec:
  poolRef: pool-sample
  replicas: 2
  expireTime: "2026-12-03T12:55:41Z"
  taskTemplate:                      # ← 新增：触发注入（结构见方式 C.1）
    spec:
      process:
        command:                     # 写用户信息文件 + 调用脚本 + 启动业务
          - /bin/sh
          - -c
          - |
            set -eu
            cat > /shared-workspace/.osb-user-info.env <<'EOF'
            OSB_USER_ID=user-12345
            EOF
            chmod 600 /shared-workspace/.osb-user-info.env
            /bin/sh /shared-workspace/.osb-init.sh
            exec /opt/opensandbox/bootstrap.sh /bin/bash
        env:                         # ← 新增：token 走 env
          - name: OSB_USER_ID
            value: "user-12345"
          - name: OSB_USER_AUTH_TOKEN
            value: "eyJhbGciOiJIUzI1NiIs..."
          - name: OPENSANDBOX_ID
            value: "batchsandbox-pool-sample"
        execMode: Remote
  taskResourcePolicyWhenCompleted: Retain   # ← 关键：注入完成后保留沙箱（默认即 Retain）
```

### D.3 改造要点

| 改动 | 说明 |
|---|---|
| **加 `spec.taskTemplate`** | 关键。没有它走快路径，注入不进去。只要加了 `taskTemplate`，`needs_task_template` 为 True，server 就会下发任务 |
| **`command` 里写文件 + 调用脚本** | 用 `/bin/sh -c` 包裹，`cat > file <<'EOF'` 写用户配置 + `sh file` 调用脚本 |
| **`env` 里放 token** | `user_auth_token` 走 env，避免进命令行日志 |
| **`execMode: Remote`** | 进主容器（nsenter）执行，业务进程能读到注入内容 |
| **`lifecycle.postStop`** | 可选，任务停止后回写/清盘（复用已建 pod 时防串数据） |
| **`taskResourcePolicyWhenCompleted: Retain`** | **关键**。注入是一次性 task，执行完就 SUCCEEDED。`Retain`（默认）保留沙箱供用户使用；若设 `Release`，task 一完成就释放资源、pod 回池，**注入完沙箱就没了**，用户无法使用 |

> **注意**：`apiVersion` 以实际样例为准（`sandbox.opensandbox.io/v1alpha1`）。`_create_workload_from_pool()` 里 `needs_task_template = env or entrypoint != DEFAULT_ENTRYPOINT or execd_run_as_init`——只要传了 env 或自定义 entrypoint，server 就会自动生成 taskTemplate，**无需手写 YAML**；手写 YAML 适用于直接建 CR 的场景。

---

## 安全要点与推荐组合

1. **token 优先用 env 注入（方式 A）**，避免出现在 task 命令 / 日志里。
2. 若必须落盘（方式 B），文件 `chmod 600`，且确认 task-executor 日志对命令脱敏。
3. 区分"用户 token"与 execd 的 `EXECD_ACCESS_TOKEN`（沙箱 API 访问凭证），不要混用。
4. Pool 模式无法用 K8s Secret 挂载（需预挂载），分配时注入 token 只能用 env / 文件。
5. **`user_id`**：env 注入（方式 A）即可，非敏感。
6. **`user_auth_token`**：**env 注入（方式 A）**，避免进命令行日志。
7. 若业务需要用户信息**落盘成文件**（如供 postStop 回写），用方式 B，但 token 建议仍走 env，文件里只写非敏感信息（如 `user_id`、`session_id`），token 由业务进程从 env 读取。

---

## 参考代码位置

| 路径 | 说明 |
|---|---|
| `server/opensandbox_server/services/k8s/batchsandbox_provider.py` | `_create_workload_from_pool` / `_build_task_template` |
| `server/opensandbox_server/services/k8s/kubernetes_service.py` | 池化 create 入口，构造 env / extensions |
| `kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go` | BatchSandbox CRD：`TaskTemplateSpec` / `ProcessTask` / `ProcessLifecycle` |
| `kubernetes/config/samples/sandbox_v1alpha1_pooled_batchsandbox.yaml` | 现有池化 BatchSandbox 样例（无 taskTemplate，改造起点） |
| `kubernetes/config/samples/sandbox_v1alpha1_batchsandbox-with-task.yaml` | 带 taskTemplate 的 BatchSandbox 样例（含 shardTaskPatches） |
| `wiki/opensandbox-pool-allocation-time-injection.md` | 注入技术对比与推荐方案 |
| `wiki/opensandbox-pooled-session-s3-sync-middleware.md` | S3 同步中间件方案（postStop 回写） |
| `wiki/opensandbox-create-sandbox-params-reference.md` | 创建沙箱参数说明书（池化参数 / extensions / 续约） |
