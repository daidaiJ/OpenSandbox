# 池化模式 Pod 模板定制 Cookbook

在池化模式下，通过 `POST /pools` 或 Pool CRD 预设镜像、资源、卷与 initContainer；分配时用 `env` / `entrypoint` 做动态注入。

**前提**

| 项 | 约定 |
|---|---|
| 部署 | 池化（`extensions.poolRef`）；分配复用已运行 pod，不重建 |
| 访问 | `use_server_proxy=true` |
| 生命周期 | 创建 → 使用 → 删除/到期；不使用 pause/resume |

分配时不能改 pod spec。资源、卷、initContainer 必须写在 Pool 模板；create 上的 `resourceLimits` / `volumes` 等会被忽略或拒绝。

Pool **不**携带 task 钩子。`preStart` / `postStop` 写在每个 BatchSandbox 的 `taskTemplate` 上，经 API 创建当前写不进 lifecycle（见 §5.2）。

## 目录

- [1. 创建池](#1-创建池)
- [2. 预设资源](#2-预设资源)
- [3. 卷](#3-卷)
- [4. initContainer](#4-initcontainer)
- [5. 分配时动态注入](#5-分配时动态注入)
- [6. 更新池](#6-更新池)
- [7. 池化 create 参数边界](#7-池化-create-参数边界)
- [参考](#参考)

---

## 1. 创建池

### 1.1 `POST /pools`

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | K8s 资源名：`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`，≤253 |
| `template` | object | PodTemplateSpec，与 Deployment `spec.template` 同构 |
| `capacitySpec` | object | 容量 |

**capacitySpec**

| 字段 | 说明 |
|---|---|
| `bufferMax` / `bufferMin` | 预热缓冲上下限 |
| `poolMax` / `poolMin` | 池总规模上下限 |

```json
POST /pools
{
  "name": "my-pool",
  "template": {
    "metadata": { "labels": { "app": "example" } },
    "spec": {
      "volumes": [
        { "name": "opensandbox-bin", "emptyDir": {} },
        { "name": "sandbox-storage", "emptyDir": {} },
        { "name": "sandbox-logs", "emptyDir": {} }
      ],
      "containers": [
        {
          "name": "sandbox",
          "image": "registry/opensandbox/code-interpreter:v1.1.0",
          "command": ["/bin/sh", "-c", "/opt/opensandbox/task-executor -listen-addr=0.0.0.0:5758 -log-dir=/tmp"],
          "env": [
            { "name": "SANDBOX_MAIN_CONTAINER", "value": "main" },
            { "name": "EXECD", "value": "/opt/opensandbox/execd" },
            { "name": "EXECD_ENVS", "value": "/opt/opensandbox/.env" }
          ],
          "volumeMounts": [
            { "name": "opensandbox-bin", "mountPath": "/opt/opensandbox" },
            { "name": "sandbox-storage", "mountPath": "/var/lib/sandbox" },
            { "name": "sandbox-logs", "mountPath": "/workspace/logs" }
          ]
        }
      ]
    }
  },
  "capacitySpec": { "bufferMax": 3, "bufferMin": 1, "poolMax": 5, "poolMin": 0 }
}
```

`SANDBOX_MAIN_CONTAINER`：主容器内跑 lifecycle 钩子（`execMode: Remote`）时必填，否则 nsenter 找不到目标进程。完整 initContainer 安装样板：`kubernetes/config/samples/sandbox_v1alpha1_pool.yaml`。

### 1.2 Pool CRD

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: Pool
metadata:
  name: my-pool
  namespace: opensandbox
spec:
  template:
    metadata:
      labels:
        app: example
    spec:
      # 见 §2–§4
  capacitySpec:
    bufferMax: 3
    bufferMin: 1
    poolMax: 5
    poolMin: 0
```

`POST /pools` 的 `template` 与 CRD `spec.template` 等价。

---

## 2. 预设资源

```json
{
  "name": "my-pool",
  "template": {
    "spec": {
      "containers": [
        {
          "name": "sandbox",
          "image": "registry/opensandbox/code-interpreter:v1.1.0",
          "resources": {
            "requests": { "cpu": "1", "memory": "2Gi" },
            "limits": { "cpu": "2", "memory": "4Gi", "nvidia.com/gpu": "1" }
          }
        }
      ]
    }
  },
  "capacitySpec": { "bufferMax": 3, "bufferMin": 1, "poolMax": 5, "poolMin": 0 }
}
```

等价 YAML：

```yaml
spec:
  template:
    spec:
      containers:
        - name: sandbox
          image: registry/opensandbox/code-interpreter:v1.1.0
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "2"
              memory: 4Gi
              nvidia.com/gpu: "1"
```

create 时的 `resourceLimits` / `resourceRequests` 不生效。

---

## 3. 卷

### 3.1 emptyDir

```yaml
spec:
  template:
    spec:
      volumes:
        - name: sandbox-storage
          emptyDir: {}
        - name: sandbox-logs
          emptyDir: {}
      containers:
        - name: sandbox
          image: registry/opensandbox/code-interpreter:v1.1.0
          volumeMounts:
            - name: sandbox-storage
              mountPath: /var/lib/sandbox
            - name: sandbox-logs
              mountPath: /workspace/logs
```

emptyDir 随 pod 生命周期，适合日志与临时文件。

### 3.2 PVC

```yaml
spec:
  template:
    spec:
      volumes:
        - name: shared-workspace
          persistentVolumeClaim:
            claimName: my-shared-pvc
      containers:
        - name: sandbox
          image: registry/opensandbox/code-interpreter:v1.1.0
          volumeMounts:
            - name: shared-workspace
              mountPath: /workspace
```

create 传 `volumes` → **400**。PVC 用于共享数据 / 跨会话工作区（本场景替代 snapshot）。

---

## 4. initContainer

用 initContainer 把二进制、脚本、配置拷进共享卷，供主容器使用。样板：

`kubernetes/config/samples/sandbox_v1alpha1_pool.yaml`

initContainer 仅在 **pod 创建时**执行一次，不是每次分配。按会话动态内容见 §5。

---

## 5. 分配时动态注入

分配时不能改 pod spec。动态内容只能通过容器内动作，或读写已挂载的卷。

| 需求 | 做法 | 经 `POST /sandboxes` |
|---|---|---|
| 注入 env / 启动命令 | `env` + `entrypoint` → taskTemplate | 支持 |
| 写文件再启动 | `entrypoint` 内 `cat > file && ...` | 支持 |
| 启停钩子 | BatchSandbox `taskTemplate.lifecycle` | 无字段；手写 CR 或扩展 API |
| 静态配置 / 二进制 | ConfigMap / initContainer / PVC | 配在 Pool 模板 |

### 5.1 entrypoint（推荐）

参数在 create 时已知：

```json
POST /sandboxes
{
  "extensions": { "poolRef": "my-pool" },
  "env": { "OSB_USER_ID": "user-12345" },
  "entrypoint": [
    "/bin/sh", "-c",
    "cat > /workspace/.osb-user-info.sh <<'EOF'\nexport OSB_USER_ID=user-12345\nEOF\nchmod 600 /workspace/.osb-user-info.sh && . /workspace/.osb-user-info.sh && exec sleep infinity"
  ]
}
```

生成 taskTemplate 的条件：`env` 非空，或 `entrypoint` 非默认，或 `execd_run_as_init`。否则走快路径，注入无效。

执行时机在分配后（控制器轮询下发）。长会话用常驻命令（业务服务或 `sleep infinity`）。

### 5.2 lifecycle 钩子

写在 `taskTemplate.spec.process.lifecycle`，由控制器 → task-executor 在启停时执行，与 proxy 无关。

- 主容器内操作：`execMode: Remote`，Pool 需 `SANDBOX_MAIN_CONTAINER`
- 无 Pool 级缺省钩子；每个 BatchSandbox 自行配置
- 经 `POST /sandboxes` 当前写不进 lifecycle；需手写 CR，或等 API 扩展（规划中）

### 5.3 运行中 k8s exec

适合「分配后才知道」或任意时刻注入；需自建接口。一般优先 §5.1。

---

## 6. 更新池

### 6.1 改容量 — `PUT /pools/{name}`

```json
{ "capacitySpec": { "bufferMax": 5, "bufferMin": 2, "poolMax": 10, "poolMin": 1 } }
```

仅更新 `capacitySpec`。

### 6.2 改模板

| 途径 | 行为 |
|---|---|
| HTTP `PUT /pools` | 不能改 template |
| 改 Pool CRD `spec.template` | 重建 idle pod；已分配不动 |
| 删池再建 | 全量换新 |

分配不区分 revision：idle 列表里新旧 revision 都可能被分出。要保证新沙箱用新模板，需清掉旧 revision 的 idle pod，或对已分配沙箱释放/重建。

`recycleStrategy` 默认多为 **Delete**：释放后删 pod 再补预热。

---

## 7. 池化 create 参数边界

池化 create 时，部分 create 参数被忽略或拒绝：

- **忽略**：`image`、`resourceLimits` / `resourceRequests`（取自 Pool 模板）
- **拒绝**：`snapshotId`、`networkPolicy`、`credentialProxy.enabled`、`volumes`、`platform`
- 具名池不存在 → create **404**

凭证放 `env` 或文件（`chmod 600`）；区分业务 token 与 `EXECD_ACCESS_TOKEN`。

---

## 参考

| 路径 | 说明 |
|---|---|
| `server/opensandbox_server/api/schema.py` | `CreatePoolRequest` / `PoolCapacitySpec` / `UpdatePoolRequest` |
| `server/opensandbox_server/api/pool.py` | 池管理 API |
| `kubernetes/config/samples/sandbox_v1alpha1_pool.yaml` | 官方 Pool 样板 |
| `kubernetes/apis/sandbox/v1alpha1/pool_types.go` | capacity / recycle / update |
| `kubernetes/internal/controller/pool_update.go` | idle 重建 |
| `server/opensandbox_server/services/k8s/batchsandbox_provider.py` | 池化 create / `_build_task_template` |
