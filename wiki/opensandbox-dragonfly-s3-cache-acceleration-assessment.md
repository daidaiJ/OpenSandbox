# Dragonfly 用于沙箱 S3 工件缓存加速的适用性评估

- 日期：2026-11-02
- 状态：评估结论（**未在本仓环境实测**；§9 给出可执行验证清单）
- 关联：`wiki/opensandbox-pooled-session-s3-sync-middleware.md`、`wiki/opensandbox-pool-mode-volumes-and-storage-practice.md`、`wiki/opensandbox-k8s-networkpolicy-vs-egress-sidecar.md`、`wiki/opensandbox-shared-storage-interpreter-minimal-image.md`、`wiki/opensandbox-ephemeral-sandbox-orchestration-pattern.md`、`wiki/opensandbox-vm-microvm-remote-storage-mount-forms.md`

---

## 1. 结论

Dragonfly（`dragonflyoss/dragonfly`，CNCF 毕业项目）是**分发加速器**：它把"同一份内容被多个节点重复拉取"变成 P2P 扇出。它**不是**按用户/按前缀的工件缓存服务。

| 链路 | 是否适合 | 判断依据 |
|---|---|---|
| ① Pool / 沙箱镜像拉取（containerd mirror） | ✅ 适合，性价比最高 | 同一镜像被多节点同时拉、内容按 digest 不可变、缓存身份天然安全 |
| ② 共享只读数据（模型 / 数据集 / 依赖包，多沙箱重复读同一份） | ✅ 适合，但先确认是否已"预烤进镜像" | 内容不变 + 多节点重复读，正是 P2P 的收益来源；若已预挂载/打进镜像，收益被 ① 覆盖 |
| ③ per-user 会话目录静默 restore / write-back（`[session_sync]` 路径） | ❌ 不适合 | 内容按用户唯一（无跨 peer 复用）、写一次读少数次、多为同节点同沙箱；冷路径有额外开销，缓存身份按 URL 且过滤签名参数 → 存在陈旧副本与跨租户读取风险 |

**一句话取舍**：把 Dragonfly 接在 ③ 上，付出的是"每节点常驻守护进程 + 500Gi 级节点盘 + 一套新控制面 + 租户数据落到别的节点"的成本，换到的是"节点本地缓存"级别的收益。这条链路的瓶颈用 `s5cmd` 并发、restore 后台化、或一层简单 HTTP 缓存就能吃掉大半（§8）。

若只做一件事：**先量出瓶颈在哪条链路**（§9 第 1 步）。三条链路的优化手段互不通用。

---

## 2. 我们的场景约束（评估前提）

来自 `AGENTS.md` / `MEMORY.md` 的既定约束：

- 内网 K8s、私有 registry、**离线部署**，不能依赖公网；
- 节点 CPU/内存有限，**密度优先于会话时长**；
- 租户控制在业务层（用户→部门→namespace 映射、配额、审计），namespace 是审批制的少量静态资源；
- **池化（Pool + BatchSandbox + taskTemplate）是主路径**，用完即焚、短 TTL、无 pause/resume；
- 池化路径**不挂 egress sidecar**（用 K8s NetworkPolicy 替代），目的是省每沙箱内存；
- 敏感企业数据要求**强隔离 + 审计**；
- 共享只读数据（模型/数据集）**静态预挂载在 Pool 模板**里。

三条与 S3/存储相关的链路：

| 链路 | 现状 | 触发时机 |
|---|---|---|
| ① 镜像拉取 | containerd 从私有 registry 拉 sandbox / task-executor / 解释器镜像 | Pool 扩容、模板更新重建 idle pod、节点新增 |
| ② 共享只读数据 | 打进镜像或池模板静态挂载（NAS 只读卷 / hostPath） | Pool 创建时一次 |
| ③ per-user 会话工件 | 中间层内部 exec 后台 `aws s3 sync` 恢复；固定 postStop 回写同一前缀（方案见 `pooled-session-s3-sync-middleware`） | 每次 create / delete，按 `tenants/<t>/users/<u>/sessions/<id>/` 前缀 |

> 注：③ 的实现代码在 `feat/session-sync-code`、`feature/pooled-session-s3-sync` 分支上，`dev` 分支只留下 `.pyc` 缓存（`changes/pooled-session-s3-sync.md` 标注的"已实施"指的是该特性分支）。

---

## 3. Dragonfly 能加速什么、机制边界

### 3.1 三条入口

| 入口 | 用法 | 适合内容 |
|---|---|---|
| containerd / docker mirror | 把 registry mirror 指向本节点 `127.0.0.1:65001`，加 `X-Dragonfly-Registry` 头 | OCI 镜像层（按 digest 不可变） |
| `dfget` / `dfcache` | 命令行在 P2P 网络内导入/导出文件；`dfcache export <id> -O <path>` | 单文件分发、持久缓存任务 |
| 对象存储（`dfstore` + proxy 规则） | `dfstore import <PATH> --url s3://<bucket>/<path>`；或在 dfdaemon 配 `proxy.rules` 正则把 S3 请求走本地代理 | S3/OSS/ABS 对象 |

### 3.2 关键机制（决定适配性）

| 机制 | 事实 | 对我们的含义 |
|---|---|---|
| 只有 GET 走 P2P | client 源码注释：`Only GET requests are routed to P2P; other methods (HEAD/PUT/POST/DELETE) fall through to direct proxy to avoid data loss` | 读可被加速；**写回天然直通源站**（不参与 P2P，也不会被异步写回语义坑） |
| 任务身份由 URL 生成 | `proxy.rules[].filteredQueryParams` 默认过滤 s3/gcs/oss/obs/cos 的签名类参数；`X-Dragonfly-Use-P2P` 头可强制任意 URL 走 P2P | 同一 key 的不同签名 URL 会命中同一缓存；**缓存命中不走源站鉴权** |
| 未见复验机制 | dfdaemon 配置参考与 `dragonfly-client/src/proxy/mod.rs` 中未见 ETag / `If-None-Match` / 过期复验选项；`gc.taskTTL` 只决定**未访问缓存**何时回收 | 源站对象被覆盖后，旧副本仍可能被命中 → **可变 key 有陈旧读风险** |
| 收益前提 | 同一份内容 × 多节点 × 同时/重复拉取；单机单次拉取只有切分与做种开销 | ② 类内容收益真实，③ 类内容收益≈节点本地缓存 |
| 冷路径开销 | 第三方实测（JuiceFS + Dragonfly，2024-01）：首次读 31 MiB/s vs 直连 84 MiB/s；命中缓存读 1463 MiB/s；小文件读 IOPS 14406 vs 11527 | 冷缓存下**比直连更慢**；收益要靠命中率摊平 |

---

## 4. 插入点 ① / ②：镜像与共享只读数据（推荐）

**形态**：官方支持**轻量部署**——只部署 Scheduler + Seed Client + Client，**不要 Manager、MySQL、Redis**，动态配置走本地 `dynconfig.yaml`（ConfigMap），客户端通过 scheduler headless service 发现调度器。预热走 `dfctl`（轻量模式支持）。

对我们有利的点：

- 完全自建、可离线（私有 registry + 自建 Dragonfly 集群，无公网依赖）；
- 内容不可变（镜像按 digest、共享数据集按版本），天然规避 §3.2 的陈旧读问题；
- 不进入池化沙箱的卷/请求路径（`volumes` 在池化请求里本就被拒），只在**节点层**接管镜像拉取与文件分发，与"池模板静态预挂载"的既定做法不冲突，是它的加速版。

**成本**：见 §7 的容量表——每节点一个常驻 peer（官方建议 4C/8G/500Gi 起），外加 3 副本 scheduler。

**判定**：值得试点，前提是量出"Pool 扩容时镜像拉取/共享数据读取确实是瓶颈"。若共享数据现在就是打进镜像的，那么 ② 的收益已经被 ① 覆盖，不必单独设计。

---

## 5. 插入点 ③：per-user 会话工件（不推荐）

逐条对照 `[session_sync]` 路径的实际形态：

| 维度 | ③ 链路的实际形态 | Dragonfly 的收益 |
|---|---|---|
| 内容唯一性 | 每用户每会话前缀独立（`.../users/<uid>/sessions/<sid>/`） | 跨 peer 无复用，P2P 退化为单节点缓存 |
| 访问次数 | 创建时恢复一次、销毁前回写一次，中间极少重读 | 命中率低，冷路径开销（切分/做种）反而净负 |
| 节点亲和 | 同一 Pod 恢复同一份数据（池化 Pod 复用/同节点） | 节点本地磁盘缓存即可达到同样效果 |
| 写入路径 | `aws s3 sync` PUT | 源码层面非 GET 直通源站 → **Dragonfly 不参与写回**，也不提速 |
| 缓存身份 | URL（签名参数被过滤） | 回写覆盖同 key 后，下次恢复可能命中**陈旧副本** → 恢复语义被破坏 |
| 隔离 | 每用户前缀 + 前缀级 IAM | 缓存字节落到节点盘并被其他 peer 提供，**鉴权在缓存命中路径上不生效** |

**结论**：③ 链路不要接 Dragonfly。若确实需要缓存层：

1. 先做无新增组件的事——`s5cmd` 并发替代 `aws s3 sync`、恢复继续后台化（方案里已经是后台启动）；
2. 需要缓存时，用一层**简单 HTTP 缓存**（Nginx / nginx-s3-gateway 之类）替代 P2P，单节点磁盘缓存、无 DaemonSet、无跨节点数据面；
3. 若最终仍要引入任何缓存，工件 key 必须**不可变/带版本**（内容寻址），否则恢复正确性没有保障。

---

## 6. 隔离与合规（本场景最硬的一条约束）

| 风险 | 机制 | 影响 |
|---|---|---|
| 跨租户数据面暴露 | P2P 要求 peer 之间互通；缓存对象由**别的节点**提供；缓存身份是 URL 且签名/过期参数被过滤 | 用户 A 的工件字节会落到其他节点磁盘，并在缓存命中路径上被提供，源站 IAM 不参与鉴权 |
| 鉴权粒度 | dfdaemon 代理只有全局 `basic_auth`，没有按租户/按前缀的授权模型 | 无法表达"只有该用户能取该前缀" |
| 审计 | P2P 取件不经过 S3，S3 侧访问日志缺失 | 与"敏感数据需审计"冲突 |
| 组件漏洞 | pkg.go.dev 收录三条近期公告：Manager Job API 未鉴权访问、OAuth `client_secret` 经未鉴权 GET 泄露、scheduler gRPC 经攻击者可控 `PeerHost` 的 SSRF | 轻量部署可避开前两条（不部署 Manager）；scheduler 仍需补丁版本，内网同样要跟 |

缓解路径（若坚持用）：**只让共享只读、非敏感内容进 P2P 缓存**；per-user 私有数据保持直连 S3。若要 P2P 覆盖私有数据，只能按租户拆 Dragonfly 集群/网络域，收益随之消失——这正是"不该用"的判断依据。

---

## 7. 成本账

官方容量规划（文档给出的规划值，非实测）：

| 角色 | 建议规格 | 备注 |
|---|---|---|
| Peer（每节点 DaemonSet） | 4C / 8G / 500Gi 磁盘；500 RPS 场景 8C / 16G / 500Gi | 磁盘按缓存容量算，是硬占用 |
| Seed Peer | 8C / 16G / 1Ti ×3（500 peers）～ 3Ti/5Ti/10Ti | 需 ≥3 副本 |
| Scheduler | 8C / 16G / 200Gi ×3 | 轻量部署也建议 3 副本 |
| Manager | 8C / 16G / 200Gi ×3 + MySQL + Redis | 轻量部署可省（代价：无 console / Open API / preheat API / 持久缓存任务） |

对我们的约束意味着：

1. **节点盘是稀缺资源**：节点上已经有 hostPath 沙箱日志（`pool-log-artifact-retention`）、`isolation-upper` emptyDir、池内 emptyDir 工作区，再加 500Gi 级 P2P 缓存需要重新做磁盘预算与告警；
2. **常驻内存**：密度优先的场景下，每节点再多一个常驻进程的 8G 建议值需要实测确认（官方数值按 RPS 规划，空闲占用会低得多，但磁盘/并发参数仍要按峰值配）；
3. **多一套控制面**：即使轻量部署，也要维护 scheduler 3 副本 + `dynconfig` ConfigMap，以及离线环境的版本/补丁流程；
4. **数据面网络**：peer 互通与 `k8s-networkpolicy-vs-egress-sidecar` 的"按 namespace 隔离"模型需要重新对齐（P2P 需要跨节点横向通路）。

---

## 8. 替代方案对照

| 方案 | 解决什么 | 新增组件 | 适配我们的理由 |
|---|---|---|---|
| 池模板预烤（共享数据打进镜像 / 节点预热） | ② 共享数据首读 | 无 | 零新增组件，收益最确定；代价是镜像变大、更新要重推 |
| `s5cmd` / `rclone` 并发 + 本地磁盘缓存 | ③ 单次同步吞吐 | 无（改中间层脚本） | 大目录/小文件吞吐提升明显，不动架构 |
| Nginx / nginx-s3-gateway 一层 HTTP 缓存 | ③ 同节点/同 key 重复读 | 一个 Deployment | 单节点缓存、无 P2P、无每节点守护进程；语义接近"够用" |
| JuiceFS / Fluid / Alluxio | ② 当文件系统挂共享数据集 | 存储控制面 + 客户端 | Fluid 是 K8s 原生 dataset 编排；但池化拒绝请求卷 → 只能写进池模板（静态），收益与"预挂载"接近 |
| **Dragonfly** | ① 镜像 + ② 多节点重复大文件 | scheduler + 每节点 peer（+可选 manager/Redis/MySQL） | 只在"多节点同时拉同一份不可变大内容、且源站是瓶颈"时明显胜出 |

---

## 9. 验证清单（建议按序执行）

1. **量瓶颈**（先做这一步，决定后面做什么）：
   - ① Pool 扩容 20 个 pod 的镜像拉取耗时分布、私有 registry 出流量与带宽水位；
   - ② 共享数据读取的字节量、耗时、来源（镜像内 vs 运行时拉取）；
   - ③ per-user restore / write-back 的字节量、耗时、失败率，S3 源站带宽/IOPS 水位。
2. **若 ①/② 是瓶颈**：在 k3s 试点**轻量部署**（scheduler + client，无 manager/MySQL/Redis），containerd mirror 指向 `127.0.0.1:65001`；对比同样 20 pod 扩容的 pull 时间、源站出流量、节点磁盘占用与常驻内存。
3. **若 ③ 是瓶颈**：先试 `s5cmd` 并发 + 恢复后台化；再试 Nginx 缓存前置；**不上 P2P**。
4. **若坚持用 P2P 覆盖 ③**，先在测试集群验证三件事：
   - (a) 覆盖同一 key 后 GET 是否返回陈旧副本（缓存复验语义）；
   - (b) 未持 S3 凭证的另一沙箱能否通过 peer 拿到缓存对象（鉴权边界）；
   - (c) 节点 dfdaemon 空闲/峰值内存 CPU 与磁盘缓存上限，对池密度与磁盘告警的实际影响。

---

## 10. 未实测 / 未核实项

- 本仓环境**未部署或实测**任何 Dragonfly 组件；结论基于官方文档、client 源码（`dragonfly-client/src/proxy/mod.rs`）、第三方基准数据与本仓约束。
- 推断而非验证：(a) 缓存命中路径完全跳过源站鉴权（依据：任务身份过滤签名参数 + 代理代码未见复验逻辑）；(b) 覆盖 key 后返回陈旧副本（同上）；(c) 我们 S3 后端与 `backendStorage=s3` / `dfstore` 的兼容性（HTTPS + 自签 CA 场景未验）。
- HTTPS 场景需在沙箱内信任 Dragonfly 的 CA；本仓已有同构先例（egress mitm CA 导出到 `/opt/opensandbox/mitmproxy-ca-cert.pem` 并设置 `NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE`，见 `opensandbox-sandbox-config-and-env-reference.md`），但池化路径默认不挂 egress sidecar，CA 分发方式需另行确认。
- 官方容量数值是**规划建议**，不是实测；实际空闲占用需在目标节点上量。

---

## 11. 参考来源

- Dragonfly 部署形态与功能矩阵：`https://d7y.io/docs/next/operations/deployment/deployment-models/`
- 容量规划与调优建议：`https://d7y.io/docs/next/operations/deployment/deployment-best-practices/`
- dfdaemon 配置参考（proxy rules / filteredQueryParams / gc / backend put 参数）：`https://d7y.io/docs/next/reference/configuration/client/dfdaemon/`
- `dfstore` 命令参考（`import`/`export`、持久副本与 TTL）：`https://d7y.io/docs/next/reference/commands/client/dfstore/`
- 持久缓存任务概念：`https://d7y.io/docs/next/concepts/persistent-cache-task/`
- 仅 GET 走 P2P 的源码依据：`https://raw.githubusercontent.com/dragonflyoss/client/main/dragonfly-client/src/proxy/mod.rs`
- 第三方基准（JuiceFS ± Dragonfly，单机）：`https://www.chenshaowen.com/blog/performance-testing-and-comparison-of-juicefs-ce-ee-and-dragonfly.html`
- 组件漏洞列表：`https://pkg.go.dev/d7y.io/dragonfly/v2/client/daemon/objectstorage`
- 本仓相关：`wiki/opensandbox-pooled-session-s3-sync-middleware.md`、`changes/pooled-session-s3-sync.md`、`wiki/opensandbox-pool-mode-volumes-and-storage-practice.md`、`wiki/opensandbox-k8s-networkpolicy-vs-egress-sidecar.md`
