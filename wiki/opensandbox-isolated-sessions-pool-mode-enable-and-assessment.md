---
title: 池模式启用隔离会话：配置配方、场景边界、与普通执行的得失比对及生产评估
description: ubuntu k3s 实测：池化路径启用 execd /v1/isolated 的完整池模板配方（bwrap/session-gate/SYS_ADMIN/NET_ADMIN/upper 四前置）、与 /command 与 native /session 及文件上传通道的横向比对、得失分析与生产就绪结论（有条件可生产）
---

# 池模式启用隔离会话：配置配方、场景边界、得失比对与生产评估

> 日期：2026-09-08。环境：ubuntu k3s 双节点（10.254.254.105 master / 103 worker，k3s v1.30.5，内核 6.17.0-14），server `latest`（NodePort 30809，batchsandbox provider），execd `v1.1.0` 与 `latest`（2026-09-06 构建）双版本实测。全部结论均有实测证据，测试方法与完整证据见 §8。

## 0. TL;DR

1. **池模式可以启用隔离会话**，但 server 的 `bootstrap.execd.isolation=enable` 扩展**只对直连创建路径生效**；池化 Pod 由池模板预热，**必须把隔离能力静态写进池模板**（§2.1）。配方 = 四个前置：bwrap 二进制 + session-gate + SYS_ADMIN/NET_ADMIN + upper 目录（§2.2/§2.3）。
2. **适用场景**：不可信/半可信代码执行、同一沙箱多会话文件互隔离（CoW 可丢弃工作区）、防误伤（rm 级破坏不伤沙箱本体）。**不改变租户间隔离**——那是"每租户一沙箱 Pod"的职责（§3）。
3. **得失**：得到 Pod 内命名空间级隔离 + overlay 快丢工作区 + 秘密黑名单兜底；付出 Pod 安全基线下调（SYS_ADMIN/NET_ADMIN + seccomp/apparmor unconfined）、会话生命周期脆弱（`exit`/超时都会杀会话）、`binds` 不可用、非 root uid 写入受限、配额半残、运维复杂度（§5）。
4. **生产评估：有条件可生产**。核心功能面（overlay 工作区、profile、env 三层、allowlist 防逃逸、网络隔离、后台 run、fs proxy 读）实测可用；但必须执行规避集（不用 `binds`/非 root uid/diff-commit/写时配额），且**隔离池独立建池**。给出发布前 checklist（§6）。

---

## 1. 默认池不支持隔离：fail-closed 已验证

默认池模板（debian:bookworm-slim + execd v1.1.0 安装器）下：

```
GET /v1/isolated/capabilities
→ {"available":false,"message":"bwrap not found: bwrap not found
   (searched: $PATH, /opt/opensandbox/bwrap, /usr/bin/bwrap, /usr/local/bin/bwrap)", ...}
```

隔离特性是**可选能力**，execd 启动时探测，缺任一前置则 `available:false`，创建请求被拒（fail-closed），不影响池内普通执行。这是第一层安全设计：没配好不会"半开"。

## 2. 池模式启用隔离会话：配置配方

### 2.1 关键结论：池化路径必须改池模板

server 侧确有创建时注入逻辑：`extensions["bootstrap.execd.isolation"]="enable"` 时给沙箱容器追加 `SYS_ADMIN` + seccomp/apparmor Unconfined + `isolation-upper` emptyDir（`server/opensandbox_server/services/docker/docker_service.py:899`、`services/k8s/batchsandbox_provider.py:213`、`agent_sandbox_provider.py:270`，注入内容见 `provider_common.py:_build_main_container`）。

但该注入发生在**构造新 Pod spec 时**（直连创建路径）。池化分配认领的是**已预热的 Pod**，securityContext 已定型，无法回补。实测也证实：池化沙箱带该 extension 创建后 capabilities 仍为 false，池模板补齐后才变 true。

> **业务规则：池模式启用隔离 = 池模板静态声明，`bootstrap.execd.isolation` 扩展对 poolRef 路径无效。**

### 2.2 四个硬前置（缺一 fail-closed）

| # | 前置 | 来源 | 说明 |
|---|---|---|---|
| 1 | `bwrap` 二进制 | **execd 镜像自带** `/usr/local/bin/bwrap`（静态编译，v0.11.2） | execd 搜索顺序含 `/opt/opensandbox/bwrap`，拷到安装目录即可 |
| 2 | `opensandbox-session-gate` | execd 镜像自带 `/usr/local/libexec/` 与 `/opt/opensandbox/` 两份 | **必填**。`bwrapImpl.Available()` 打不开 gate 直接 false（`bwrap_linux.go:119`）。校验极严：regular file、可执行、**不可 group/world-writable**、属主 root 或 execd euid（`lifecycle_linux.go:744`） |
| 3 | 容器 caps：`SYS_ADMIN`（必）+ `NET_ADMIN`（仅 `share_net:false` 需要） | 池模板 securityContext | 实测：只有 SYS_ADMIN 时 `share_net:false` 创建即失败（bwrap 新 netns 配 loopback 需 NET_ADMIN：`Failed RTM_NEWADDR`） |
| 4 | `seccompProfile/appArmorProfile: Unconfined` + upper 目录 | 池模板 | upper 必须 emptyDir（或其它非 overlayfs）挂 `/var/lib/execd/isolation`；apparmor Unconfined 是 bwrap 运行前提 |

镜像/版本要求：execd ≥ v1.0.20（建议直接用 `latest` 滚动构建；v1.1.0 已含全部所需二进制）。userns 模式（`uid_mode:"userns"`）在 Ubuntu 24.04（apparmor 限制非特权 userns）下不可用，`userns_available:false`——**setpriv 模式为主**。

### 2.3 池模板完整配方（实测可用）

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: Pool
metadata:
  name: iso-test-pool            # 建议独立隔离池，不复用普通池
  namespace: opensandbox
spec:
  capacitySpec: {bufferMin: 1, bufferMax: 1, poolMin: 1, poolMax: 2}
  recycleStrategy: {type: Delete}
  template:
    metadata:
      labels: {app: iso-test-pool}
    spec:
      volumes:
        - {name: sandbox-storage, emptyDir: {}}
        - {name: opensandbox-bin, emptyDir: {}}     # 组件安装目录
        - {name: isolation-upper, emptyDir: {}}     # overlay upper，必须非 overlayfs
      initContainers:
        - name: task-executor-installer
          image: sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/task-executor:latest
          command: ["/bin/sh", "-c"]
          args: ["cp /workspace/server /opt/opensandbox/task-executor && chmod +x /opt/opensandbox/task-executor"]
          volumeMounts: [{name: opensandbox-bin, mountPath: /opt/opensandbox}]
        - name: execd-installer
          image: sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/execd:v1.1.0  # 或 latest
          command: ["/bin/sh", "-c"]
          args:
            - |
              cp ./execd /opt/opensandbox/execd &&
              cp ./bootstrap.sh /opt/opensandbox/bootstrap.sh &&
              cp /usr/local/bin/bwrap /opt/opensandbox/bwrap &&
              cp /usr/local/libexec/opensandbox-session-gate /opt/opensandbox/opensandbox-session-gate &&
              cp /usr/local/libexec/opensandbox-launcher /opt/opensandbox/opensandbox-launcher &&
              chmod 0755 /opt/opensandbox/execd /opt/opensandbox/bootstrap.sh /opt/opensandbox/bwrap \
                        /opt/opensandbox/opensandbox-session-gate /opt/opensandbox/opensandbox-launcher &&
              printf '%s\n' 'upper_root = "/var/lib/execd/isolation"' \
                            'upper_max_bytes = 33554432' \
                            'allowed_writable = ["/workspace", "/mnt", "/media", "/data", "/tmp/osb-extra"]' \
                            > /opt/opensandbox/isolation.toml
          volumeMounts: [{name: opensandbox-bin, mountPath: /opt/opensandbox}]
      containers:
        - name: sandbox
          image: debian:bookworm-slim
          command: ["/bin/sh", "-c"]
          args: |
            mkdir -p /workspace /mnt /media /data /tmp/osb-extra &&
            exec /opt/opensandbox/task-executor -listen-addr=0.0.0.0:5758 -log-dir=/tmp
          env:
            - {name: SANDBOX_MAIN_CONTAINER, value: sandbox}
            - {name: EXECD_ENVS, value: /opt/opensandbox/.env}
            - {name: EXECD, value: /opt/opensandbox/execd}
            - {name: EXECD_ISOLATION_CONFIG, value: /opt/opensandbox/isolation.toml}  # 不配则用内置默认
          securityContext:
            capabilities: {add: ["SYS_ADMIN", "NET_ADMIN"]}   # NET_ADMIN 仅 share_net:false 需要
            seccompProfile: {type: Unconfined}
            appArmorProfile: {type: Unconfined}
          volumeMounts:
            - {name: sandbox-storage, mountPath: /var/lib/sandbox}
            - {name: opensandbox-bin, mountPath: /opt/opensandbox}
            - {name: isolation-upper, mountPath: /var/lib/execd/isolation}
      tolerations: [{operator: Exists}]
```

`isolation.toml` 可选字段（顶层键）：`upper_root`（默认 `/var/lib/execd/isolation`）、`upper_max_bytes`（默认 8GiB）、`allowed_writable`（默认 `/workspace /mnt /media /data`）、以及 hardening/landlock/ebpf 等进阶节（`components/execd/pkg/isolation/config.go`）。

### 2.4 三个已踩过的坑

1. **volume mount shadowing**：installer 容器把 `opensandbox-bin` 挂在 `/opt/opensandbox`，**遮住了 execd 镜像自带的 `/opt/opensandbox/*`**。从该路径 cp session-gate 会报 No such file——必须从 `/usr/local/libexec/` 拷。
2. **模板变更只滚动空闲 Pod**：改镜像 tag/securityContext 后只影响新预热 Pod；已分配沙箱不重建。隔离能力变更后要等旧 Pod 自然回收或重建池。
3. **gate 权限位**：installer `chmod 0755` 不能放宽到 0775/0777（group/world-writable 会被 gate 校验拒绝，capabilities 直接 false）。

---

## 3. 应用场景与能力边界

### 3.1 隔离会话是什么

`/v1/isolated/session` 在**沙箱 Pod 内部**用 bubblewrap 为每个会话拉起独立的 mount/PID（可选 network）命名空间：根文件系统只读绑定，`/workspace` 以 overlay（CoW）方式挂载，写入落在会话专属 upper 目录；会话销毁或 idle 回收时 upper 一起释放，沙箱本体不受影响。

### 3.2 适用场景

| 场景 | 为什么隔离会话合适 | 实测支撑 |
|---|---|---|
| 不可信/半可信代码执行（用户提交脚本、AI 生成代码） | 代码只能写 `/workspace`（CoW）与白名单目录，删改系统目录直接 EROFS；跑完即弃 | `rm /etc/hostname` → `Read-only file system`；40MB dd 不留痕 |
| 同沙箱多会话文件互隔离 + 可丢弃工作区 | 每会话独立 upper，互相不可见；会话结束即回收 | 会话 A 写 `/workspace/a.txt`，主容器与其它会话不可见 |
| 防"误伤"型破坏 | 脚本级 rm/chmod/覆盖不影响沙箱本体与其它会话 | 白名单外全部 EROFS |
| 秘密防泄漏兜底 | env 内置黑名单自动剥除 `*_API_KEY/*_TOKEN` 等模式 | 注入 `FOO_API_KEY/TEST_TOKEN` 后隔离会话内均 UNSET |
| 网络出口收口（可选） | `share_net:false` 私有 netns，仅 lo | 实测 DNS/eth0 全部不可见 |

### 3.3 不适用 / 反场景

- **租户间隔离**：隔离会话在同一个 Pod 里，不是跨 Pod 边界。多租户强隔离仍然必须"每租户独立沙箱 Pod + NetworkPolicy"，隔离会话只是**沙箱内部**的纵深。
- **可信固定负载**（预装环境的常规任务）：没有收益，只付成本，直接用普通执行通道。
- **需要宿主目录双向同步**：`binds` 当前不可用（§4）。
- **非 root 运行工作负载**：setpriv 切 uid 后 overlay 工作区不可写（§4）。

### 4. 能力边界实测矩阵

环境：k3s v1.30.5 / 内核 6.17 / execd v1.1.0（部分项在 `latest` 复测）。✅=符合预期，⚠️=有条件/需规避，❌=不可用。

| 测项 | 结果 | 实测证据 |
|---|---|---|
| capabilities 探测（缺前置） | ✅ fail-closed | `available:false` + 明确 message；创建被拒 |
| capabilities 探测（配齐） | ✅ | `available:true, isolator:bwrap, version:0.11.2, setpriv_available:true` |
| overlay 工作区 CoW | ✅ | 会话内写 `/workspace` 可读；主容器不可见；跨 run 持久 |
| 根文件系统只读 | ✅ | `rm /etc/hostname` → `Read-only file system`（是硬只读绑定，**非可白out的 overlay**） |
| profile strict（默认） | ✅ | `/tmp` 为私有 tmpfs，主容器不可见会话内写入 |
| profile balanced | ✅ | `/tmp` 与主容器共享（marker 双向可见） |
| workspace mode rw | ✅ | 直写主容器 fs，主容器立即可见 |
| workspace mode ro | ✅ | 运行时 `Read-only file system`（创建不拒，写时拒） |
| **`exit` 杀会话** | ⚠️ | run 代码里 `exit 42` → "session process exited without end marker"，会话立即 404；必须 `bash -c "exit 42"` 包装（rc 正常回传且会话存活） |
| **前台超时杀会话** | ⚠️ | `timeout_seconds:1` + `sleep 4` → `context deadline exceeded`，**会话随即 404**（不是"仅取消本次运行"）；业务侧需按"重建会话"处理 |
| 同会话并发 run | ✅ 串行化 | 两个并发 run 实测 wall 4033ms、间隔 2s（A 完才跑 B），无交错 |
| 后台 run | ✅ | `background:true` → 202 + run_id；status running/exit_code/finished_at；logs 可查 |
| 后台日志 16MiB 上限 | ✅ | 生成 20MB，logs 精确 16777216 字节截断，exit_code=0 |
| idle GC | ⚠️ 惰性 | `idle_timeout_seconds:12` 到期后 `idle_remaining:0` 但仍 active，数分钟后才 404（清扫周期）；沙箱本体不受影响（ping 200） |
| 显式 DELETE 会话 | ✅ | 200 → GET 404 |
| env deny（默认） | ✅ | 继承容器 env（OSB_TEST/HOME/PATH 可见，27 个）；`*_API_KEY/*_TOKEN` 黑名单剥除（FOO_API_KEY/TEST_TOKEN 实测 UNSET） |
| env deny+keys | ✅ | `keys:["HOME"]` → 仅 HOME 被 unset，其余保留 |
| env allow | ⚠️ | `--clearenv` 后仅 PWD/SHLVL/_ 3 个变量，**PATH 也被清掉**；run 级 `envs` 正常注入；allow 模式必须手动传 PATH |
| uid setpriv（uid 1000） | ⚠️ | `id` 生效；但 **overlay 工作区写 Permission denied**（upper 属主 root）；非 root uid 需镜像内预 chown 或放弃 overlay |
| share_net 默认（不传） | ✅ | 共享沙箱网络（eth0/DNS 可见），与指南一致 |
| share_net:false（仅 SYS_ADMIN） | ❌→✅ | 创建即 `gate: unixpacket EOF`；根因 bwrap 新 netns 配 lo 需 `CAP_NET_ADMIN`；**池模板加 NET_ADMIN 后完全可用**（仅 lo、DNS 失败） |
| extra_writable 白名单 | ✅ | 白名单外（/etc）创建即拒 `not in allowlist`；白名单内可写且**真实回写主容器**（wb.txt 主容器可见） |
| **symlink 逃逸防护** | ✅ | `extra_writable:["/tmp/osb-extra/escape"]`（→/etc 的软链）创建即拒；binds 同样被拦（先 EvalSymlinks 再校验） |
| **binds（显式 bind 挂载）** | ❌ | v1.1.0 与 latest 均复现：创建即 `wait for isolated workload identity: read unixpacket EOF`（gate 握手断裂，非环境问题）；源不存在时有干净的校验报错。**规避：用 extra_writable（已验证回写）** |
| upper_max_bytes 配额 | ⚠️ 语义特殊 | **分配时**对 upper 根目录总量检查（upper 满 → 所有新会话创建失败 `total usage exceeds configured limit`）；**写入时不强制**（45MB dd 进 32MiB 上限的 upper 成功）——写时 ENOSPC 依赖 fs project quota（本节点 ext4 `rw,relatime` 无 prjquota，静默失效） |
| fs proxy 文件面 | ✅/⚠️ | `files/info`、`files/download` 实测穿透 upper 层取到会话文件；`files/upload` 代码确认需 `metadata`（JSON）+ `file` 双 part（与 execd /files 同 schema），运行时未跑通用例 |
| diff/commit | ❌ | 503 `NOT_SUPPORTED (phase 2)`；capabilities `commit_supported/diff_supported:false`（Phase 2 未落地） |
| native /session 共存 | ✅ | 隔离配置就绪后原生 bash 会话创建正常 |
| userns 模式 | ❌（本环境） | Ubuntu 24.04 apparmor 限制非特权 userns，`userns_available:false` |

## 5. 开启隔离会话的得失

### 5.1 三种执行通道横向比对

| 维度 | `/command`（单发执行） | native `/session`（bash 会话） | isolated `/v1/isolated`（隔离会话） |
|---|---|---|---|
| 隔离级别 | 无（主容器） | 无（主容器） | Pod 内 mount/PID(/net) ns + 只读根 + CoW |
| 文件破坏半径 | **整个沙箱** | **整个沙箱** | 会话 upper + 白名单目录，会话回收即消失 |
| shell 状态持久 | 无（每次冷启） | 有（cwd/env/函数跨调用） | 文件状态跨 run 持久；env 每次显式传 |
| env 可控性 | 继承容器 env | 继承容器 env | **三层语义**（deny 默认+黑名单 / deny+keys / allow 白名单） |
| uid 可控 | 支持参数 | 否 | setpriv/userns（userns 本环境不可用） |
| 网络可控 | 继承 | 继承 | `share_net:false` 私有 netns（需 NET_ADMIN） |
| 会话 GC | 无会话概念 | **无 GC**（伪永久，需业务显式删） | idle_timeout 自动回收（惰性清扫） |
| 并发模型 | 可并发（各自进程） | 单 shell 串行 | 同会话 run 严格串行；后台 run 异步 |
| 长任务 | 有超时，无日志游标 | 可后台 | 后台 run + 状态/日志 API（16MiB 截断） |
| 典型事故面 | rm -rf 毁沙箱 | 同左 | `exit`/超时杀会话（业务需重建语义） |

### 5.2 文件操作通道比对

| 维度 | execd `/files`（普通） | isolated fs proxy（`/v1/isolated/session/<id>/files/*`） |
|---|---|---|
| 作用域 | 主容器真实 fs | 会话命名空间内的 fs 视图（经 upper 层），会话删除后不可访问 |
| 上传 | multipart `metadata`+`file` | 同 schema（代码确认），需先建会话 |
| 下载 | 直接 | 实测穿透 upper 取到 CoW 文件（工件回收路径） |
| 目录语义 | 真实目录 | overlay 视图；`mode:rw` 时与真实 fs 一致 |

### 5.3 得失总表

| 得 | 失 |
|---|---|
| 不可信代码执行成为可能（只读根 + CoW 工作区 + 防逃逸白名单） | **Pod 安全基线下调**：SYS_ADMIN + NET_ADMIN + seccomp/apparmor Unconfined——隔离会话保护的是"会话不伤沙箱"，代价是沙箱 Pod 自身暴露面变大 |
| 秘密黑名单兜底（`*_API_KEY/*_TOKEN` 自动剥除） | 会话生命周期脆弱：`exit`、前台超时都会销毁会话，业务必须有重建语义 |
| 多会话互隔离 + 会话级工件回收（upper 随会话生灭） | `binds` 不可用；非 root uid 写 overlay 受限；diff/commit（增量工件导出）未实现 |
| 网络可选收口（share_net:false） | 配额仅"分配时"检查，写时硬限依赖节点 fs prjquota；upper 打满会阻塞新会话 |
| fail-closed：没配好就明确拒绝，不会半开 | 运维面增加：独立池、镜像内二进制拷贝、upper 用量监控、NET_ADMIN 的安全评估 |

## 6. 生产就绪评估：有条件可生产

### 6.1 分级结论

- **✅ 可直接生产**（实测通过）：overlay/rw/ro 工作区、strict/balanced profile、env 三层+黑名单、allowlist+symlink 防逃逸、share_net 网络隔离（配 NET_ADMIN）、后台 run 全生命周期、同会话串行化、capabilities fail-closed、fs proxy 读/下载、native 会话共存、idle GC、会话显式删除。
- **⚠️ 规避后可用**：`exit`/超时杀会话 → 业务侧一律 `bash -c` 包装 + 超时即重建；uid≠0 → 镜像内预 chown 工作区或保持 uid 0；`binds` → 用 `extra_writable`（已验证回写）替代；配额 → 当作"分配闸门"而非"写入硬限"，配监控。
- **❌ 当前缺失，不要依赖**：diff/commit（Phase 2）、userns uid 模式（内核限制）、写时 ENOSPC 硬限（需 fs prjquota）、后台日志超 16MiB 保留。

### 6.2 上生产前的 checklist

1. **独立隔离池**：不与普通池混部（securityContext 差异 + 故障/容量隔离）；隔离池镜像纳入最小镜像矩阵管理。
2. **版本**：execd 用 `latest`（或 ≥1.1.0）；server 与 controller 为当前部署版即可；升级池模板只滚动空闲 Pod，安排低峰。
3. **NET_ADMIN 按需**：只有需要 `share_net:false` 的池才加；加之前过安全评审（caps 是双向的）。
4. **upper 监控**：对 `/var/lib/execd/isolation` 做用量告警——upper 打满 = 池内所有新隔离会话创建失败（P0 级故障面）。`recycleStrategy: Delete` 保证 Pod 回收即清零。
5. **isolation.toml 基线**：生产用默认 8GiB 或按镜像实际容量设定；`allowed_writable` 保持最小集；不要复用本报告 32MiB 测试值。
6. **业务侧超时/退出语义**：run 一律 `bash -c "..."` 包装；任何 run 错误（尤其 `context deadline exceeded`、`exited without end marker`）按"会话已死"处理，重建会话而非重试 run。
7. **秘密管理**：黑名单是兜底不是设计——敏感凭据走 Credential Vault/egress 代理，不要依赖 env 剥除。
8. **租户隔离不受影响**：隔离会话不替代"每租户一沙箱"，租户配额/审计仍在上层业务与池粒度。

### 6.3 建议跟进（上游）

1. `binds` gate 握手 EOF（v1.1.0 与 latest 均复现）——向上游报 issue，附最小复现（本报告 §8 环境可复现）。
2. 写时配额依赖 fs prjquota 的**静默失效**建议上游文档化/启动时探测告警。
3. idle GC 清扫周期与可观测性（`idle_remaining:0` 与实际回收之间的窗口缺指标）。
4. fs proxy upload 运行时用例补齐（当前仅代码层确认）。

## 7. 验证环境与方法（复现用）

- 部署：`/home/extvdiadmin/osb-deploy/`（server helm + pool 清单）；测试池 `/tmp/osb-iso-test/pool-iso-test.yaml`（即 §2.3）。
- 关键探测：`GET /v1/isolated/capabilities`（经 `http://10.254.254.105:30809/v1/sandboxes/<id>/proxy/44772/...`）。
- 测试脚本：`/tmp/osb-iso-test/phaseA.sh ~ phaseD.sh`、`latest-test.sh`（覆盖 §4 全部条目；输出含逐条 JSON 证据）。
- 期间确认的旁支事实：server proxy 自动续约持续生效（长期测试中 expiresAt 单调延长）；池容量打满时 poolRef 创建等待 60s（`pool_acquisition_timeout_seconds`）后失败；`/v1/isolated` 前台 run 响应为 SSE 事件流（stdout/execution_complete/error）。

## 8. 参考

- 指南：`docs/guides/isolation-sessions.md`（边界模型、背景 run 语义、部署要求——与实测一致，含默认 share_net 语义）
- 设计：`oseps/0013-isolated-execution-api.md`
- 代码：`components/execd/pkg/isolation/{bwrap_linux.go,lifecycle_linux.go,config.go}`、`components/execd/pkg/runtime/isolated_session_ctrl.go`（normalize 默认值）、`server/opensandbox_server/services/k8s/provider_common.py`（直连注入内容）
- 关联 wiki：`opensandbox-pool-sandbox-sidecar-components-guide.md`（Pod 装配）、`opensandbox-k8s-networkpolicy-vs-egress-sidecar.md`（网络隔离选型）、`opensandbox-egress-netpol-vault-verification.md`（同类实测方法学）
