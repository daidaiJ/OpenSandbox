# 池化沙箱日志与产物留存方案

> 日期：2026-09-03 ｜ 适用：K8s 池化部署
> **方向已定**（2026-09-03 决策，替代此前"方案对比"阶段的备选项）：
> - **日志**：hostPath 挂日志目录 + 内部**日志易**平台节点侧采集；
> - **产物**：沙箱内 **agent 调 CLI 工具直推远程 S3**。
> 本文只讲这两条路怎么落好、哪些坑要提前绕开。

---

## 1. 先分清四类数据各走各的路

| 数据 | 去向 | 说明 |
|---|---|---|
| **业务/任务日志**（排障用） | 写入日志目录 → hostPath → 日志易 | 本文 §2 |
| **任务产物**（结果文件，业务要拿走） | agent 调 CLI 推远程 S3 | 本文 §3 |
| **会话用户目录**（跨沙箱的用户工作区） | server 侧 S3 中间件静默恢复/回写 | 已实施方案，见[S3 中间件文档](opensandbox-pooled-session-s3-sync-middleware.md)，本文不动它 |
| **临时工作文件** | 容器可写层，用完即焚 | 回收策略 Delete 直接带走，什么都不用配 |

> 为什么不走别的路（记录备选项的取舍）：每 Pod 一个采集 sidecar 与"池化省内存"的决策冲突；postStop 钩子兜不住强杀场景；平台侧统一回传徒增 server 复杂度。日志易和 S3 都是现成设施，直接用。

## 2. 日志：hostPath 挂目录 + 日志易采集

### 2.1 Pool 模板加一段卷

```yaml
# Pool spec.template.spec 里追加
containers:
- name: sandbox
  ...
  volumeMounts:
  - name: sandbox-logs
    mountPath: /data/logs        # 沙箱内统一日志目录，业务往这里写
volumes:
- name: sandbox-logs
  hostPath:
    path: /data/sandbox-logs     # 节点上日志易盯的路径
    type: DirectoryOrCreate
```

日志易侧把采集路径配成 `/data/sandbox-logs/**`（节点上已装的采集器天然按节点收，无需感知 Pod）。

### 2.2 三个必须提前定的规矩

1. **目录命名带上下文**，否则采回来一堆没头没尾的日志。约定：任务入口把沙箱 id / 任务号拼进文件名（这些值创建时已通过 env 注入沙箱，直接引用）：

   ```bash
   # entrypoint 开头（或 agent 启动时）
   LOG_DIR=/data/logs/${OSB_SANDBOX_ID:-unknown}
   mkdir -p "$LOG_DIR"
   exec >> "$LOG_DIR/task.log" 2>&1    # 想收任务 stdout/stderr 就 tee 一份到这里
   ```

2. **节点磁盘会涨**：Delete 回收删的是 Pod，**hostPath 里的文件留在节点上**。让日志易采集时按策略归档，节点侧配一个 systemd timer / cron 清理超过 N 天的 `/data/sandbox-logs`（N 按排障需要定，一般 3~7 天够）。不配清理的池子，磁盘告警是迟早的事。
3. **hostPath 不经任何白名单**（池模板是原生写法）：固定用统一前缀 `/data/sandbox-logs`，别放开业务自选路径。

### 2.3 边界情况

- **Pod 漂到别的节点**：日志留在产生它的节点上，日志易按节点收，不影响；排障时按沙箱 id 全局搜即可。
- **强杀（OOM/节点故障）**：写进日志目录的部分都在，天然比 postStop 钩子可靠——这正是选 hostPath 的原因之一。
- **kubectl logs**（容器标准输出）依然可用，但只到 Pod 被删为止；要"事后能查"的内容必须写进 /data/logs。

## 3. 产物：agent 调 CLI 直推远程 S3

### 3.1 落地三件事

**① 凭据进得来**：创建沙箱时经 env 注入（业务已选的注入通道），凭据**限定到该用户/任务的目录前缀**，能临时就别长期：

```json
{
  "extensions": { "poolRef": "my-pool" },
  "env": {
    "OSB_USER_ID": "u-123",
    "S3_ENDPOINT": "https://s3.internal:9000",
    "S3_BUCKET": "sandbox-artifacts",
    "S3_PREFIX": "u-123/<task-id>/",
    "S3_ACCESS_KEY": "<限定 prefix 的临时凭据>",
    "S3_SECRET_KEY": "<…>"
  }
}
```

**② CLI 在镜像里**：业务镜像预装好推送工具（s3 兼容的 CLI 任选，如 s5cmd/aws-cli/mc；大文件优先选并发的 s5cmd）。CLI 只读挂载共享也行（复用 NAS 只读卷方案），但装进镜像最简单。

**③ agent 推得上去**：任务收尾时调用，对象名带沙箱 id + 任务号防覆盖，网络出口按[网络隔离 SOP](opensandbox-egress-netpol-vault-sop.md) 放行 S3 endpoint：

```bash
# agent 任务收尾（失败重试 3 次）
s3cmd put /workspace/result/* "s3://$S3_BUCKET/$S3_PREFIX"  # 以实际 CLI 为准
```

### 3.2 两个坑提前绕

- **推完再删沙箱**：业务编排要等"产物推送成功"信号后才删 CR，别靠 TTL 兜底——回收是即焚的，没推完就没了。失败重试用尽仍失败 → 把报错也写进日志目录（§2）再退，至少现场留痕。
- **凭据别落到产物里**：env 注入的密钥别 echo 进日志；日志易收走的日志默认按内部敏感数据对待。

## 4. 验收清单

- [ ] 测试沙箱往 `/data/logs/<沙箱id>/task.log` 写一条日志，日志易 5 分钟内能按沙箱 id 搜到
- [ ] 沙箱回收后，节点 `/data/sandbox-logs` 清理任务按期执行（配好 N 天策略）
- [ ] agent 直推 S3 成功；故意给错凭据时失败路径也在日志目录留痕
- [ ] 凭据是限定 prefix 的临时凭据，且未出现在任何日志内容里
- [ ] 编排层确认：删除沙箱发生在"产物推送成功"之后

## 5. 关联

- [池化故障排查 Runbook](opensandbox-pool-troubleshooting-runbook.md) —— 日志在手后的排障入口
- [卷类型实践](opensandbox-pool-mode-volumes-and-storage-practice.md) —— hostPath 副作用（节点绑定、不经白名单）
- [S3 会话同步中间件](opensandbox-pooled-session-s3-sync-middleware.md) —— 用户目录那条路，与本文产物路径互不影响
- [用户信息注入示例](opensandbox-task-template-user-info-injection-example.md) —— 沙箱 id/用户 id 如何进 env
