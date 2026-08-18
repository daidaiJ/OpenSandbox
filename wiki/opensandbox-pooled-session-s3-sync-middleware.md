# 池化沙箱业务会话：S3 用户目录静默同步（中间层方案）

- 日期：2026-08-17
- 状态：部分实施（lifecycle server 中间层已落地；Pool 模板 / executor 镜像仍为运维前提）
- 实施说明：`changes/pooled-session-s3-sync.md`
- 关联：`wiki/opensandbox-ephemeral-sandbox-orchestration-pattern.md`、`wiki/opensandbox-shared-storage-interpreter-minimal-image.md`、`kubernetes/test/e2e` host-copy lifecycle、#954 runtime 感知

---

## 1. 目标与约束

### 1.1 目标

池化（`extensions.poolRef`）模式下，为**业务会话**提供：

1. **分配后**：按用户/会话从指定 S3 前缀恢复目录到容器工作区  
2. **销毁前**：将工作区同步回同一 S3 前缀，并清理本地，避免 Pod 回池串数据  

### 1.2 对上层的约束（产品要求）

- **不**向终端用户 / 业务 SDK 暴露 `prepare`、`runtime/exec`、S3 sync 等能力  
- 业务侧仍是普通生命周期：`create` → 使用 → `delete`  
- 身份最多以薄字段传入（`metadata` / `extensions`），或由中间层从鉴权上下文推导  
- 恢复与回写由 **lifecycle server / 编排 BFF** 静默完成，不放在 ingress gateway  

### 1.3 非目标

- 不使用 pause/resume / rootfs snapshot 做目录级会话（过重、语义不符）  
- 不在 ingress gateway 请求路径上做 S3 sync（gateway 只做流量反代）  
- 不要求业务在 delete 前主动回写（到期销毁必须也能回写）  

---

## 2. 现状与缺口

| 能力 | 现状 | 影响 |
|---|---|---|
| 池化动态 `env` | create 的 `env` → `taskTemplate.process.env` | 主任务进程可读 |
| Local lifecycle 钩子 env | 仅 `os.Environ()`（task-executor），**不继承** `process.env` | 不能单靠「固定钩子 + 用户 env」区分多用户 |
| server `_build_task_template` | 只组 `command` + `env`，无 lifecycle | API 池化路径默认无 preStart/postStop |
| 池化 `volumes` | API 拒绝 | 不能按会话挂 OSSFS；卷只能写在 Pool 模板 |
| host-copy e2e | Pool 共享 emptyDir + BatchSandbox preStart/postStop `cp` | 证明「钩子 + 共享盘」可行；路径写死在 CR，非上层动态 |
| ingress / server proxy | 转发访问流量 | 不适合承担 create 期同步 |
| server pods/exec | 无对外 API；内部有 `CoreV1Api` | 可做**内部**静默 exec |

**结论：** 「上层动态用户信息 + 不暴露 exec」必须由中间层在 create/delete 语义内完成；推荐 **固定 postStop + 内部 exec 注入会话脚本**，而不是让业务拼钩子 YAML。

---

## 3. 总体架构

```
业务 / SDK
  │  create(poolRef, metadata.user_id 可选)
  │  正常读写沙箱 / delete
  ▼
┌──────────────────────────────────────────────────────────┐
│ 中间层（lifecycle server 或自建 BFF，对业务不可见细节）      │
│  create：等 Ready → 内部 exec 恢复 + 写 sync-out 脚本      │
│  delete：删 CR → finalizer → 固定 postStop 跑注入脚本      │
└──────────────────────────────────────────────────────────┘
  │
  ▼
Pool 预热 Pod
  sandbox + task-executor 共享 emptyDir /shared-workspace
  task-executor：S3 CLI + 凭证（IRSA/Secret）
  BatchSandbox：固定 postStop（与用户无关）
```

**不放 ingress gateway：** `components/ingress` 只做 Host/URI 路由与反代，没有沙箱创建/销毁语义，也不应持有按会话的 S3 编排状态。

---

## 4. 目录与身份约定

### 4.1 S3 前缀（示例）

```text
s3://<bucket>/tenants/<tenantId>/users/<userId>/sessions/<sessionId>/
```

| 键 | 建议来源 |
|---|---|
| `tenantId` / `userId` | 鉴权上下文，或 `metadata.user_id` / `extensions["session.user"]` |
| `sessionId` | 可用 `sandboxId`（create 返回的 id），减少业务再传一层 |

中间层拼出 `S3_USER_PREFIX`；**不对业务文档化**该拼接规则以外的实现细节。

### 4.2 容器落点

| 路径 | 用途 |
|---|---|
| `/shared-workspace` | 业务与钩子共用工作区（emptyDir，Pool 模板固定） |
| `/shared-workspace/.osb-sync-out.sh` | 中间层注入的销毁回写脚本（可执行） |

业务进程只感知工作区内容，不感知脚本与 sync 命令。

---

## 5. Pool 侧（静态，一次配置）

```yaml
# 要点：共享 workspace；凭证与 CLI 只给 task-executor
spec:
  template:
    spec:
      serviceAccountName: sandbox-s3-sync
      containers:
      - name: task-executor
        image: <task-executor-with-awscli-or-rclone>
        volumeMounts:
        - name: workspace
          mountPath: /shared-workspace
      - name: sandbox
        image: <sandbox-image>
        volumeMounts:
        - name: workspace
          mountPath: /shared-workspace
      volumes:
      - name: workspace
        emptyDir: {}
  recycleStrategy:
    type: Noop   # 复用 Pod：依赖 postStop 清盘；也可用 Delete 简化清盘
```

对照样板：`kubernetes/test/e2e/testdata/pool-with-host-copy.yaml`（hostPath 换成「executor 侧 S3 能力 + 共享 workspace」）。

---

## 6. 固定 postStop（与用户无关）

创建 BatchSandbox（或 server 池化建 CR）时**始终**带上固定钩子；用户前缀**不**写进 CR 模板，而由中间层稍后注入脚本内容。

```yaml
lifecycle:
  postStop:
    execMode: Local          # 在 task-executor 执行
    timeoutSeconds: 180
    exec:
      command: ["/bin/sh", "-c"]
      args:
      - |
        set -eu
        HOOK=/shared-workspace/.osb-sync-out.sh
        if [ -x "$HOOK" ]; then "$HOOK"; fi
        find /shared-workspace -mindepth 1 -delete
```

销毁链路：`删 BatchSandbox` → `FinalizerTaskCleanup` → `StopTask` → **postStop** → Pod 回池。

必须有 `taskTemplate`（否则可能不走任务 finalizer，postStop 不跑）。池化 create 若无自定义 entrypoint/env，中间层仍需注入带上述 lifecycle 的 taskTemplate。

---

## 7. 中间层静默流程

### 7.1 Create（对外仍是一次 create）

```text
1. 解析身份 → S3_USER_PREFIX
2. 创建 BatchSandbox（poolRef + 固定 postStop 的 taskTemplate）
3. 等待 allocated Pod Ready
4. 内部 K8s pods/exec → 容器 task-executor：
     a. 写入并 chmod +x /shared-workspace/.osb-sync-out.sh
     b. **后台**启动 inbound restore（`aws s3 sync ... || true`），不等 CLI 结束
     exec 若遇到 Pod 已消失（404 / NotFound）：`409 KUBERNETES::POD_NOT_FOUND` 并回滚 CR，不当成泛化 500。
5. 标记会话已 prepare（launcher 已注入；restore 可能仍在跑）
6. 对调用方返回 create 成功
```

注入脚本示例内容（由中间层渲染，业务不可见）：

```sh
#!/bin/sh
set -eu
aws s3 sync /shared-workspace/ "s3://bucket/tenants/t1/users/u123/sessions/<sandboxId>/"
```

### 7.2 Delete

```text
调用方 delete / expireTime 到期
  → 删 CR
  → postStop：停掉进行中的 inbound restore → 执行 .osb-sync-out.sh（若存在）+ 清盘
  → 回池
```

中间层**不必**再暴露 syncOut；主动删与到期删同一路径。

### 7.3 可选访问闸门（仍不暴露能力）

server proxy 若发现「已 Ready 但未注入 prepare」：返回 `409`（内部错误码）。闸门覆盖的是 launcher 尚未返回的窗口；inbound restore 可能仍在后台进行。实现细节，不进入 SDK 公开能力面。

---

## 8. 为何用「内部 exec + 注入脚本」

| 方案 | 上层动态用户 | 不暴露 exec | 到期也能回写 | 说明 |
|---|---|---|---|---|
| 业务拼 BatchSandbox 钩子 YAML | 需编排暴露 CR | ❌ | ✅ | 不符合「中间层消化」 |
| 固定钩子读 `process.env` | ✅（改 executor 后） | ✅ | ✅ | 需改 task-executor 钩子继承 env + server 注入 sync 钩子；可选后续演进 |
| **中间层静默 exec + 固定 postStop** | ✅ | ✅ | ✅ | **本方案推荐**；不依赖钩子读 env |
| 仅 delete 前业务/中间层再 sync | ✅ | ✅ | ❌ 到期易漏 | 不推荐作为唯一回写 |

Local 钩子当前不继承 `process.env`，因此「创建时只设 env、指望固定 sync 脚本读 `$S3_USER_PREFIX`」在未改 executor 前不可用。注入脚本把前缀写进文件，绕开该限制。

---

## 9. 对业务的 API 面

**可见：**

```text
Sandbox.create(extensions={poolRef}, metadata={user_id?})
# 使用沙箱（文件系统 / 命令）
Sandbox.delete() / 到期自动删
```

**不可见（中间层内部）：**

- `pods/exec`
- `session/prepare`
- S3 前缀拼接、sync 命令、`.osb-sync-out.sh`

身份可选三种（均可对业务更薄）：

1. `metadata.user_id`  
2. 从 API Key / JWT 推导，业务零字段  
3. `sessionId = sandboxId`  

---

## 10. 失败与运维语义

| 场景 | 建议 |
|---|---|
| pre-sync launcher 失败 | create 对调用方失败；不返回「可用」沙箱（或立即删 CR） |
| 空 S3 前缀（首启） | 后台 sync 容忍失败 / NoSuchKey |
| 后台 inbound 失败 | 不回滚已返回的 create；依赖观测 / 下次会话 |
| postStop / 回写失败 | 记 `taskLastErrorMessage`；是否阻塞回池需产品决策（建议告警 + 仍清盘防串台，或失败则 Delete 该 Pod） |
| 大目录 | inbound 不占用 create 超时；postStop `timeoutSeconds` 按回写体量配置 |
| #954 Pod 替换 | 本地目录清空；中间层可在 `RUNTIME_REPLACED` 后再次静默 prepare，或要求业务重建会话 |
| 凭证 | IRSA/Secret 仅挂 task-executor；禁止把 AK/SK 打进 exec 命令行日志 |
| IAM | 前缀级隔离：`.../users/<uid>/*` |

---

## 11. 实施步骤（建议）

1. **Pool 模板**：共享 `/shared-workspace`；executor 镜像含 sync 工具 + SA 凭证  
2. **建 CR 模板**：池化 create 始终带固定 postStop（server `_build_task_template` 或 BFF 直建 CR）  
3. **中间层模块**（server 内部或 BFF）：`prepare_session(sandbox_id, prefix)` — 仅内部调用  
4. **接入 create**：Ready 后调用 prepare，成功再返回  
5. **观测**：sync 耗时、失败率、postStop 失败；可选 prepare 注解  
6. **（可选演进）** task-executor Local 钩子继承 `process.env`，改为纯钩子方案，去掉 exec 注入  

不新增 public OpenAPI / SDK 方法。

---

## 12. 验收要点

- 同一用户再次 create（或同 session 前缀）：工作区恢复上次内容  
- 用户 A 销毁后，用户 B 分到同一 Pod：看不到 A 的本地文件；S3 上 A/B 前缀隔离  
- 业务集成无需调用任何 sync/exec API  
- expireTime 到期删除仍会回写（有注入脚本的前提下）  
- ingress 无会话同步逻辑  

---

## 13. 参考代码位置

| 路径 | 说明 |
|---|---|
| `server/opensandbox_server/services/k8s/batchsandbox_provider.py` | 池化 create / `_build_task_template` |
| `kubernetes/internal/task-executor/runtime/process.go` | preStart/postStop；Local 钩子 env |
| `kubernetes/test/e2e/testdata/pool-with-host-copy.yaml` | 共享盘 Pool 样板 |
| `kubernetes/test/e2e/testdata/batchsandbox-with-host-copy-lifecycle.yaml` | lifecycle 拷入/拷出样板 |
| `components/ingress/` | 流量网关（本方案不扩展） |
| `server/opensandbox_server/api/proxy.py` | 访问代理（可选未 prepare 闸门） |
