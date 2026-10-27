---
name: opensandbox-dhi-hardening-gap-and-seccomp-impact
description: 逐条对照 Docker Hardened Images（使用指南与 OpenShift SCC 指南）的加固主张与 OpenSandbox 现有实现，给出隔离会话之外的 P0–P2 加固措施，并量化 seccomp / Landlock / cap drop 三层对常规 agent 执行场景的影响边界与缓解配方
type: project
---

# Docker Hardened Images 加固建议对照与剩余加固面

> 日期：2026-10-27
> 来源：<https://docs.docker.com/dhi/how-to/use/>、<https://docs.docker.com/guides/dhi-openshift/>
> 口径：本仓结论均基于代码核对（附 file:line）；DHI 侧为官方文档主张；带"未实测"标记的为机制推导，需按第五节灰度验证。

## 〇、结论

1. DHI 两篇讲的是**镜像与 Pod 身份**的加固（最小化镜像、非 root、只读根、cap drop、SCC/PSS、签名与 SBOM）；OpenSandbox 的隔离会话讲的是**代码行为**的加固（bwrap + overlay + 只读根 + 路径白名单）。两者正交。
2. 隔离会话之外，本仓**已有**的能力是 execd init 模式的 hardening floor（cap drop + `no_new_privs` + seccomp denylist + Landlock + 凭证 env 剥离）、安全运行时（gVisor/Kata/Firecracker）、NetworkPolicy / egress 边车 / Credential Vault / Secure Access，以及 release 产物的 cosign + attestation。
3. **最大的现成缺口是"默认关闭"**：hardening 与 Landlock 均为 opt-in（`hardening_linux.go:344`），Pod 级 `securityContext` 无平台默认值，沙箱镜像以 root 运行（`components/execd/Dockerfile` 无 `USER`）。
4. **真正的空白在供应链与身份**：沙箱镜像无 SBOM、无漏洞扫描、无签名准入；`security_context.py` 只透传 4 个字段，`runAsNonRoot`/`readOnlyRootFilesystem` 无法按请求表达。
5. seccomp 本身对主流 agent 执行路径基本无感（deny 动作为 `EACCES`，不杀进程），但同批开启的 **Landlock 与 cap drop 会打断一批日常动作**（系统级安装、home 缓存、`ps`/`free`/`ss` 类工具、`ping`/`sudo`/低端口），落地必须按池补授权列表。

## 一、DHI 的加固主张

| # | 主张 | 出处 | 性质 |
|---|---|---|---|
| 1 | 运行镜像最小化，distroless、无 shell/包管理器 | use | 镜像 |
| 2 | 默认非 root（UID 65532） | use | 身份 |
| 3 | `-dev` 变体只用于构建，生产用 runtime / `static` | use | 镜像分层 |
| 4 | `static` 镜像跑编译产物，含 `ca-certificates` | use | 镜像 |
| 5 | 构建期依赖防火墙（Socket Firewall 变体） | use | 供应链 |
| 6 | 签名 attestation、SBOM、provenance，可用 ORAS 发现 | use | 供应链 |
| 7 | K8s 部署必须配 imagePullSecret（PAT/OAT） | use | 部署 |
| 8 | 合规变体：FIPS / STIG / ELS | use | 架构成熟度 |
| 9 | 任意 UID + GID 0 可写目录（`chgrp 0` + `chmod g=u`） | openshift | 身份 |
| 10 | `restricted-v2`/PSS：drop ALL caps、`allowPrivilegeEscalation:false`、`runAsNonRoot:true`、`seccompProfile: RuntimeDefault` | openshift | Pod |
| 11 | 非特权端口（>1024） | openshift | 镜像 |
| 12 | 不给 `anyuid`；需要固定 UID 时用 `nonroot` SCC + 数字 USER | openshift | Pod |
| 13 | 调试走 `oc debug` / ephemeral containers，不部署 dev 变体 | openshift | 运维 |
| 14 | `/etc/passwd` 无当前 UID 条目时的三种处理 | openshift | 身份 |

## 二、与 OpenSandbox 现状对照

| DHI 主张 | 本仓现状（证据） | 判定 |
|---|---|---|
| 最小化 / distroless / 无 shell | execd 镜像 alpine，无 `USER`；`/command`、`/code` 依赖 `bash`/`sh`（`components/execd/pkg/runtime/command.go:39`）；隔离会话依赖 bwrap | **部分可做**：去编译器/包管理器，shell 必须保留 |
| 默认非 root | 沙箱容器 root；隔离会话 SOP 要求保持 uid 0，否则 upper 属主 root 不可写 | **缺口** |
| dev / runtime 变体分离 | 无变体概念，沙箱镜像由使用方构建 | 规范缺口 |
| `static` 镜像 | 沙箱要跑任意语言运行时 | 不适用 |
| 构建期依赖防火墙 | 无 | 可做（优先级低于 SBOM） |
| SBOM / provenance / 签名 | **release 产物**有 cosign keyless + GitHub attestation（`docs/community/release-verification.md`）；镜像本身的 SBOM 生成与漏洞扫描不在 CI | **缺口** |
| imagePullSecret | server 按 sandbox 自动建 secret（`services/k8s/image_pull_secret_helper.py`） | 已有 |
| GID 0 可写目录 | 无；`/var/lib/execd/isolation` 为 root 属主 emptyDir | **缺口**（OpenShift 上必踩） |
| Pod 级 restricted 基线 | 池模板示例的 sandbox 容器 `securityContext` 为空；hardening 只在进程级做且默认关闭（`hardening_linux.go:340-344`） | **部分已有，默认未开** |
| 只读根 | 无 | **缺口** |
| 非特权端口 | 池示例应用容器 `containerPort: 80` | 小问题，镜像规范 |
| 不用 anyuid | 隔离池要求 `SYS_ADMIN` + seccomp/apparmor `Unconfined`（隔离会话 SOP A2） | **能力冲突**，靠独立 namespace/节点池隔离 |
| 调试规范 | 无；现状靠 `kubectl exec` 进沙箱 | 规范缺口 |
| imagePullSecret / 私有 registry | 已有 pull secret 机制；无 registry 前缀准入 | 部分 |

### 2.1 与 DHI 不能照搬的两点

- **distroless 与本仓产品模型冲突**：execd 的五条执行通道（entrypoint、`/command`、`/code`、PTY、隔离会话）都依赖 shell，隔离会话还需要 bwrap 与 `SYS_ADMIN`。可行的折中是"最小化 + 只读根 + 非 root"，而非"无 shell"。
- **`anyuid` 等价物不可避免**：隔离池建命名空间需要 `SYS_ADMIN`，bwrap 在装 seccomp 前需要 `unshare`/`mount`/`pivot_root`。DHI 的答案是禁止这类镜像上生产；本仓的答案是独立池 + 独立 namespace + 准入策略禁止普通池申请。

## 三、隔离会话之外可做的加固措施

### P0：纯配置，零常驻内存

1. **全池打开 `[hardening] enabled=true` + `[landlock] enabled=true`**，配合 `runtime.execd_run_as_init=true`。等价于 DHI 的 cap drop + `no_new_privs` + seccomp + 路径白名单，收益最高且实现已存在（`wiki/opensandbox-execd-init-rollout-guide.md`）。
2. **Pool pod template 补 Pod 级基线**：`allowPrivilegeEscalation:false`、`seccompProfile: RuntimeDefault`（非隔离池）、非隔离池 `capabilities.drop: ["ALL"]`。进程级加固管不到 entrypoint 与边车。
3. **命名空间准入分层**：普通池 namespace 打 `pod-security.kubernetes.io/enforce=restricted`；需要 `SYS_ADMIN` 的隔离池放独立 namespace + 独立节点池。对应 DHI 文档里"不要给任何生产负载 `anyuid`"。
4. **镜像 digest 固定**（`image@sha256:...`）+ 私有 registry。池化短生命周期场景下 tag 漂移是最容易被忽略的供应链风险。

### P1：小改造（代码或流水线）

5. **只读根 + 显式可写挂载**：`readOnlyRootFilesystem:true`，只挂 `/tmp`、`/workspace`、`/var/lib/execd/isolation`、`/var/log/opensandbox`。需先枚举 execd 写入路径。
6. **非 root 运行**：镜像建固定 UID，预 `chown` 工作区，可写目录给 GID 0（兼容 OpenShift 任意 UID）；应用端口改到 >1024；回归隔离会话 overlay 写权限。
7. **镜像 SBOM + 漏洞扫描 + cosign 签名进 CI**（syft/trivy/cosign），再接 Kyverno/Gatekeeper 做准入：只允许私有 registry 前缀、必须已签名、禁止 `:latest`。
8. **扩展 server 的 securityContext 透传**：`services/k8s/security_context.py` 目前只处理 `capabilities`/`privileged`/`seccompProfile`/`appArmorProfile`，`runAsNonRoot`、`runAsUser`、`readOnlyRootFilesystem` 会被丢弃。

### P2：按需

9. 敏感池开 eBPF 审计（`execd-ebpf` + `CAP_BPF`/`CAP_PERFMON`）。
10. emptyDir `sizeLimit`、Pod `pids limit`、`/tmp` 挂 `noexec,nosuid,nodev`。
11. 基础镜像月度重建 + 漏洞修复 SLA（对应 DHI 的 ELS 思路）。
12. 运维规范：禁止 `kubectl exec` 进沙箱做临时调试，改用 ephemeral containers。

## 四、seccomp 对常规 agent 执行场景的影响

### 4.1 三条独立路径

| 路径 | 生效范围 | 默认 | 证据 |
|---|---|---|---|
| 隔离会话内 bwrap 的 seccomp | 每个隔离会话 | **常开** | `pkg/isolation/bwrap_linux.go:98` 启动时预生成 |
| hardening floor | 全部执行通道 | **关闭** | `pkg/runtime/hardening_linux.go:344` |
| Pod 级 `seccompProfile` | 池模板 securityContext | 未设 | 池模板示例中为空 |

两处内置 denylist 是同一份（`pkg/isolation/seccomp_gen.go:27`），动作为 `ActionErrno | EACCES`（`:107`）：**返回 "Permission denied"，不杀进程**。工具通常降级或报一个形似文件权限的错误。

### 4.2 denylist 分组影响

| 被禁 syscall | 实际影响 | 严重度 |
|---|---|---|
| `mount` `umount2` `pivot_root` `chroot` | FUSE（s3fs/sshfs/gcsfuse）、loop、overlayfs、docker 存储驱动全部失败 | 高（设计意图） |
| `unshare` `setns` | 嵌套容器（docker/kind/k3d）、`nsenter`、会话内再套 bwrap 失败 | 高（设计意图） |
| `ptrace` `process_vm_readv/writev` `kcmp` | gdb、strace、perf、py-spy、rr 失败 | 高（体验代价） |
| `bpf` | bpftrace、bcc、Cilium 工具失败 | 中 |
| `seccomp` | 用户代码不能自装 filter；libseccomp 走 `prctl` 不受影响 | 中（设计意图） |
| `userfaultfd` | CRIU、部分按需分页实现失败 | 低 |
| `personality` | `setarch`、`linux32`、Wine 失败 | 低 |
| `add_key` `request_key` `keyctl` | keyutils、部分 Kerberos/NFS 场景失败 | 低 |
| `syslog` `iopl` `ioperm` | `dmesg`、DOSBox 类工具失败 | 低 |
| `swapon` `reboot` `init_module` `kexec_*` `acct` `open_by_handle_at` | 正常 agent 不用 | 无 |

### 4.3 三层边界：seccomp 之外的破坏源

`[hardening]` 是 seccomp + Landlock + cap drop 同批生效，Landlock 的默认 allowlist 只覆盖 `/usr` `/bin` `/lib` `/lib64` `/etc` `/opt`、`/proc/self`、`/proc/sys`、`/dev` 六个设备与 `/dev/pts`、`/tmp`、`/run`、`allowed_writable`（`hardening_linux.go:99` `buildLandlockRules`），其余读取一律拒绝。

| 场景 | seccomp | Landlock | cap drop + no_new_privs |
|---|---|---|---|
| `bash -c`、python/node/java/go 解释执行 | 无影响 | workspace 内无影响 | 无影响 |
| workspace 内 `venv` + `pip install`、`npm install` | 无影响 | 无影响 | 无影响 |
| `gcc` 编 native 模块、git | 无影响 | 无影响 | 无影响 |
| `pip install --user`、`npm install -g` | 无影响 | **失败**（`~/.local`、`/usr/lib/node_modules` 不在 allowlist） | 可能失败 |
| `apt-get install` | 无影响 | **必然失败**（写 `/usr`、`/var/lib/dpkg`、`/var/cache/apt`） | 建用户/设 setuid 位失败 |
| Jupyter kernel 启动 | 无影响 | **有风险**（runtime dir 默认 `~/.local/share/jupyter/runtime`） | 无影响 |
| 读 HF/torch/pip 缓存（`~/.cache`） | 无影响 | **失败** | 无影响 |
| `ps aux`、`top`、`free`、`uptime`、`ss` | 无影响 | **失败**（只放行 `/proc/self` 与 `/proc/sys`） | 部分指标正常 |
| `lscpu`、`lsblk`、`nvidia-smi` | 无影响 | **失败**（`/sys` 不在 allowlist） | 设备访问仍可用 |
| `ping`、绑定 80、`sudo`、`chown` 给别人 | 无影响 | 无影响 | **失败**（`NET_RAW`/`NET_BIND_SERVICE`/`CAP_CHOWN` 被丢，setuid 被 `no_new_privs` 挡住） |

结论：**"不受影响"只在 workspace 以内成立**。跨出 workspace 的常见动作（装到系统目录、写 home 缓存、读 `/proc/<pid>` 与 `/sys`）会被 Landlock 拒绝，报 `EACCES`。

### 4.4 缓解配方

Landlock 只能追加授权（规则只 grant 不 deny），按池显式列：

```toml
[landlock]
enabled = true
extra_writable = ["/home/agent", "/var/cache", "/var/tmp"]
extra_readable = ["/var/log", "/sys/class/dmi", "/proc/cpuinfo"]
```

```yaml
env:
  - { name: HOME, value: /workspace }
  - { name: XDG_CACHE_HOME, value: /workspace/.cache }
  - { name: PIP_CACHE_DIR, value: /workspace/.cache/pip }
  - { name: HF_HOME, value: /workspace/.cache/huggingface }
  - { name: MPLCONFIGDIR, value: /workspace/.cache/mpl }
  - { name: JUPYTER_RUNTIME_DIR, value: /tmp/jupyter }
```

需要 `ping` 的池用 `[hardening] keep_capabilities = ["CAP_NET_RAW"]`；包管理需求进镜像，不在运行时装。

### 4.5 覆盖缺口

1. **新 mount API 未覆盖**：`fsopen`、`fsconfig`、`fsmount`、`move_mount`、`open_tree`、`fspick` 不在 denylist，而隔离池容器本来就是 root + `SYS_ADMIN`，这几条可绕过 `mount` 封锁。Docker 默认 profile 已覆盖该组。
2. **`clone`/`clone3` 未按 flag 过滤**：`unshare` 禁了，但 `clone(CLONE_NEWUSER)` 仍可建 userns。彻底封需要 flag-aware filter 或直接使用 `RuntimeDefault`。
3. **`RuntimeDefault` 与隔离池冲突**：containerd 默认 profile 禁 `unshare`/`mount`/`pivot_root`，bwrap 建命名空间阶段即失败。隔离池必须 `Unconfined`，这也是它要独立 namespace 的原因。
4. **`execve` 是 launcher 保留项**，自定义 `[seccomp] deny` 写入即启动硬失败；`execveat` 允许。
5. **`[seccomp] deny` 是替换不是合并**，自定义必须从 `configs/isolation.example.toml` 抄底。
6. **架构差异静默跳过**（`filterKnownSyscalls`），arm64 上没有 `iopl`/`ioperm`，端到端以 `/v1/isolated/capabilities` 的层状态为准。

### 4.6 错误形态

`EACCES` 会被业务误判为文件权限问题去 `chmod`。建议 agent 框架把 syscall 级 `Permission denied` 归类为"沙箱策略拒绝"，并在灰度期在日志里显式标注当前 hardening 层状态。

## 五、灰度验证清单

| 项 | 方法 | 期望 |
|---|---|---|
| hardening 层状态 | `GET /v1/isolated/capabilities` | seccomp/landlock/capDrop 均 `active`（内核不足时 `unsupported` 需记录） |
| 解释器启动 | python/node/java 各跑一次 `-V` + 简单 IO | 通过 |
| 包安装 | workspace 内 `pip install` wheel、`npm install` | 通过 |
| 系统安装 | `apt-get install -y jq` | **预期失败**，确认报错可读（决定是否改走镜像） |
| 缓存路径 | 加载 HF/torch 缓存、起 Jupyter kernel | 通过（配合 4.4 环境变量） |
| 进程可见性 | `ps aux`、`free`、`ss -lntp` | 记录实际行为，决定是否补 `extra_readable` |
| 浏览器 | Playwright 启动 Chromium | 需 `--no-sandbox`，确认业务模板已内置 |
| 隔离会话回归 | 会话 create/run/delete + bwrap 可用 | `available:true, isolator:bwrap` |
| egress MITM | 开 init 后跑一条 HTTPS 经边车用例 | 通过（CA 安装链路回归） |

## 六、未验证与待确认

- Landlock 对 `nvidia-smi`、CUDA 初始化路径的实际拒绝点未在本仓实测（`/proc/driver/nvidia`、`/sys` 均不在 allowlist）。
- Pod 级 `RuntimeDefault` 与 isolation 池 `Unconfined` 的边界已由机制推导，未在集群做 A/B。
- `readOnlyRootFilesystem` 下 execd 的完整写入路径未枚举，需按第 5 节逐项跑。
- DHI 的 ELS / STIG 变体依赖商业订阅，本仓私有 registry 的替代路径（月度重建 + 漏洞 SLA）未定 SLA 数值。

## 参考

- Docker Hardened Images 使用指南：<https://docs.docker.com/dhi/how-to/use/>
- Docker Hardened Images on OpenShift：<https://docs.docker.com/guides/dhi-openshift/>
- [execd init 模式实施指导](opensandbox-execd-init-rollout-guide.md)
- [隔离会话池化落地 SOP](opensandbox-isolated-sessions-pool-mode-best-practices-sop.md)
- [K8s NetworkPolicy vs Egress 边车](opensandbox-k8s-networkpolicy-vs-egress-sidecar.md)
- [加固容器 vs 微虚机内存账本](opensandbox-hardened-container-vs-microvm-memory-density.md)
- 本仓实现：`components/execd/pkg/isolation/seccomp_gen.go`、`components/execd/pkg/runtime/hardening_linux.go`、`components/execd/configs/isolation.example.toml`、`server/opensandbox_server/services/k8s/security_context.py`
