---
title: gVisor 快照保真度实测：MEMORY / ROOTFS / VOLUMES（WSL2 ptrace，复刻 Agent Substrate MVP）
description: 在 WSL2、无 KVM 的环境下用 runsc ptrace 复刻 Agent Substrate 的 golden 模板快照与不保留内存快照，实测制作耗时、快照体积、恢复到可用状态的时间，并对照历史 runsc 冷启动与 Firecracker/Cloud Hypervisor 数据
---

# gVisor 快照保真度实测：MEMORY / ROOTFS / VOLUMES

> 结论先行：在这台 WSL2（无嵌套虚拟化）上，`runsc` ptrace 平台可以完整跑通 Agent Substrate 的三种快照语义。**MEMORY 快照**保存 256 MiB 已触碰内存 + 进程现场，制作约 **407 ms / 257.6 MiB**，恢复到可执行约 **173 ms**；**ROOTFS / VOLUMES** 只保存文件状态，制作约 **12–14 ms / 0.1 MiB 以内**，但恢复要重新启动进程并重新预热，约 **2.85 s**。差距几乎全部来自被 MEMORY 快照跳过的 2 s 应用预热；对短进程，冷启动 `runsc`（约 76 ms）反而比内存快照恢复更快。

## 1. 实验环境与口径

| 项 | 值 |
|---|---|
| 宿主 | Windows 11 + WSL2 Ubuntu 22.04，内核 6.18.40.1-microsoft-standard-WSL2 |
| 虚拟化 | WSL 不支持嵌套虚拟化，`/dev/kvm` 存在但不能用于 runsc KVM；使用 **ptrace** 平台 |
| runsc | release-20261109.0，OCI spec 1.2.1 |
| 运行方式 | 一个 `--privileged --cgroupns=host` 的 Docker 驱动容器，在容器内以 root 调 `runsc create/start/checkpoint/restore` |
| 网络 | `--network=none`，未验证网络状态恢复 |
| 工作负载 | Alpine 3.22 根文件系统 + 静态 Go 程序；启动时触碰 **256 MiB** 内存，写 `/rootfs-marker`、`/rootfs-state` 和 `/data` volume，2 s 后进入 ready，之后每 100 ms 更新 `/tmp/state.json` |
| 取样 | 每种保真度 3 次独立快照制作 + 3 次恢复，表中给中位数；冷启动取同批 3 次 |

启动、执行和就绪探测都通过 `docker exec` 进入驱动容器，再用 `runsc exec` 读取容器内 `/tmp/state.json`。因此**恢复耗时包含探测命令和 WSL 调度开销**，绝对值不要和裸金属微基准直接比较，重点看量级和相对差异。

## 2. 复刻的 Agent Substrate MVP 流程

Agent Substrate 的 gVisor worker 把“一个 sandbox + 若干 app 容器”作为一个快照单元，用三种 fidelity 表达“保存什么”：

| fidelity | 保存内容 | 恢复后的进程 |
|---|---|---|
| `MEMORY` | 进程/内存现场 + rootfs 可写层 + 声明的卷 | 从快照点继续执行 |
| `FILESYSTEM`（本文记为 ROOTFS） | rootfs 可写层 + 声明的卷 | 重新启动，文件状态回到快照点 |
| `VOLUMES` | 只保存声明的卷 | 重新启动，rootfs 为干净模板 |

关键命令序列：

```sh
# 1) 创建 sandbox（不创建 root container）并启动
runsc --platform=ptrace --network=none --root=$STATE \
  create -no-root-container -bundle $B/sandbox _sandbox
runsc ... start _sandbox

# 2) 在同一 sandbox 内创建并启动 app 容器
runsc ... create -bundle $B/app app
runsc ... start app

# 3) MEMORY 快照：内存 + rootfs 可写层 + volume
runsc ... checkpoint -image-path $B/ckpt \
  -fs-checkpoint-paths rootfs/=app:/ \
  -fs-checkpoint-paths fs/=app:/data _sandbox

# 3') ROOTFS 快照：rootfs 可写层 + volume
runsc ... fscheckpoint -image-path $B/ckpt \
  -path rootfs/=app:/ -path fs/=app:/data _sandbox

# 3'') VOLUMES 快照：只保存 volume
runsc ... fscheckpoint -image-path $B/ckpt -path fs/=app:/data _sandbox

# 4) MEMORY 恢复：先恢复 sandbox，再恢复 app
runsc ... create -no-root-container -bundle $B/sandbox \
  -fs-restore-image-path $B/ckpt/rootfs \
  -fs-restore-image-path $B/ckpt/fs _sandbox
runsc ... restore -background -detach -bundle $B/sandbox -image-path $B/ckpt _sandbox
runsc ... create -bundle $B/app app
runsc ... restore -background -detach -bundle $B/app -image-path $B/ckpt app
runsc ... wait -restore _sandbox

# 4') ROOTFS / VOLUMES 恢复：只做文件系统恢复，再冷启动 app
runsc ... create -no-root-container -bundle $B/sandbox \
  -fs-restore-image-path $B/ckpt/rootfs \
  -fs-restore-image-path $B/ckpt/fs _sandbox
runsc ... start _sandbox
runsc ... create -bundle $B/app app
runsc ... start app
runsc ... wait -fsrestore app
```

`_sandbox` 必须先用 `-no-root-container` 创建并 `start`，app 容器才能启动；`runsc` 的 overlay 优化不允许同一个 bundle rootfs 被重复挂载，因此每次恢复前都要用干净模板重建 app rootfs。

## 3. 结果

### 3.1 总表

| 模式 | 快照制作（中位数） | 快照体积 | 恢复到 ready（中位数） | 相对冷启动 |
|---|---:|---:|---:|---:|
| 冷启动（无快照） | — | — | **~2.85 s**（进程启动 **76 ms**） | 1× |
| MEMORY | **407 ms**（347–727 ms） | **257.6 MiB** | **173 ms**（159–176 ms） | 约 **16× 更快** |
| ROOTFS | **14 ms** | **~0.1 MiB**（可写层 delta） | **2.85 s** | 约 1× |
| VOLUMES | **12 ms** | **<0.1 MiB** | **2.86 s** | 约 1× |

“恢复到 ready”是容器内工作负载重新进入 ready 状态的时间。ROOTFS/VOLUMES 的约 2.85 s 与冷启动几乎相同，因为进程仍然要重新启动并重新执行 2 s 预热；MEMORY 直接恢复进程现场，跳过了这段预热。

### 3.2 分阶段耗时（中位数，ms）

| 阶段 | MEMORY | ROOTFS | VOLUMES |
|---|---:|---:|---:|
| sandbox create | 14 | 14 | 14 |
| sandbox restore / start | 29 | 30 | 27 |
| app create | 9 | 8 | 8 |
| app restore / start | 50 | 32 | 29 |
| `wait -restore` / `wait -fsrestore` | 37 | 8 | 8 |
| 到 ready 总计 | **173** | **2852** | **2863** |

MEMORY 的恢复命令本身约 100 ms，加上后台页加载等待约 37 ms，再加一次 `runsc exec` 就绪探测，合计约 173 ms。ROOTFS/VOLUMES 的 `wait -fsrestore` 只有 8 ms，文件恢复不是瓶颈，瓶颈是 app 进程的冷启动与预热。

### 3.3 快照体积构成

| 模式 | 主要文件 | 大小 |
|---|---|---:|
| MEMORY | `pages.img` + `pages_meta.img` + `checkpoint.img` + `rootfs/` + `fs/` | 约 257.6 MiB；其中 `checkpoint.img` 约 60 KiB，rootfs/volume 的 multitar 各约 3.5 KiB |
| ROOTFS | `rootfs/multitar.img` + `rootfs/pages.img` + `fs/` | `multitar.img` 3584 B，`pages.img` 8192 B，合计约 0.1 MiB |
| VOLUMES | `fs/multitar.img` + `fs/pages.img` | 3584 B + 8192 B，`du` 显示 <0.1 MiB |

ROOTFS 的 0.1 MiB 是**可写层增量**，不是完整根文件系统。基础 Alpine rootfs（约 12 MiB）由镜像缓存单独提供；恢复时先把干净模板铺好，再叠加这份 delta。MEMORY 的体积主要由 256 MiB 已触碰内存决定，和负载内存近似线性。

### 3.4 状态语义验证

| 模式 | boot id | counter | `/rootfs-marker` | `/data/vol-state` |
|---|---|---|---|---|
| MEMORY | 与快照点一致 | 从快照点继续（示例为 2） | 快照点的旧 boot | 快照点的旧 boot |
| ROOTFS | 新 boot | 从 0 重新开始 | 快照点的旧 boot（可写层被恢复） | 旧 boot + 新 boot（卷被恢复后再追加） |
| VOLUMES | 新 boot | 从 0 重新开始 | 新 boot（rootfs 为干净模板） | 旧 boot + 新 boot（只恢复卷） |

这组对照确认了三种 fidelity 的边界：MEMORY 连进程计数器和内存都保留；ROOTFS 保留 rootfs 写层但进程重启；VOLUMES 只保留卷，rootfs 回到模板。

## 4. 与历史 runsc / KVM 数据对比

历史数据来自本仓 `wiki/opensandbox-microvm-kernel-and-sandbox-metrics-comparison.md`（同一台 WSL2，2026-11-15，runsc release-20261109.0）：

| 运行时 / 操作 | 历史数据 | 本次数据 |
|---|---:|---:|
| runsc 原生冷启动（到进程启动） | 77 ms | 76 ms |
| gVisor KVM 300 MiB checkpoint | 390 ms | 256 MiB：407 ms（ptrace） |
| gVisor KVM 300 MiB eager restore | 152 ms | 256 MiB：173 ms（ptrace） |
| gVisor KVM 300 MiB async restore | 95 ms | 未单独测，`-background` 恢复路径 |
| Firecracker 冷启动 | 1.10 s | 未复测 |
| Firecracker 512 MiB 快照制作 | 2.22 s | 未复测 |
| Firecracker 快照 restore（API 返回） | 19 ms | 未复测 |
| Cloud Hypervisor 冷启动 | 0.95 s | 未复测 |
| Cloud Hypervisor 快照制作 | 0.70 s | 未复测 |
| Cloud Hypervisor eager restore | 367 ms | 未复测 |
| 裸 runc 热启动 | 48 ms | 未复测 |

### 4.1 预热进程快照恢复了多少

- 对 **2 s 预热**的负载，MEMORY 从 2.85 s 降到 **0.173 s**，约 **16×**；这是“恢复预热进程”的核心收益。
- 对 **短进程**，冷启动 `runsc` 只要 **76 ms**，MEMORY 恢复约 173 ms，快照反而更慢。快照不是无条件加速，收益取决于被跳过的预热/初始化时间。
- 对 **文件状态恢复**，ROOTFS/VOLUMES 的制作和恢复都很快（制作 12–14 ms，`wait -fsrestore` 8 ms），但它们不保存进程现场，无法跳过应用预热。

### 4.2 KVM 虚机的优势与代价

- **恢复延迟**：Firecracker 的 19 ms 比 gVisor 的 173 ms 快约 **9×**；Cloud Hypervisor 的 eager restore 367 ms 则比 gVisor 慢约 2×。KVM 微虚机的优势主要体现在“硬件隔离 + 已经预热的 VM 快照”这一组合。
- **快照制作**：Firecracker 512 MiB 要 2.22 s，Cloud Hypervisor 0.70 s；gVisor 256 MiB 只要 0.407 s。gVisor 的用户态内核 checkpoint 明显更轻。
- **冷启动**：gVisor 76 ms，Firecracker 1.10 s，Cloud Hypervisor 0.95 s；gVisor 快约 **12–14×**。KVM 微虚机的时间花在 guest 内核解压/初始化、设备探测和 `/init`。
- **隔离与可移植性**：KVM 提供硬件边界和 guest 内核控制，适合必须硬件隔离的场景；代价是依赖 `/dev/kvm`（云上要嵌套虚拟化）、CPU 型号一致、快照体积/制作 IO 更大。gVisor 用用户态内核换隔离，ptrace/systrap 不依赖 KVM，适合本环境和“不可信 syscall、但不需要硬件 VM”的 agent 负载。
- **结论**：在这个 MVP 里，KVM 的不可替代优势是硬件隔离和 19 ms 级恢复；如果目标只是“跳过 agent 预热、保留进程现场”，gVisor MEMORY 已经足够，且制作和冷启动成本更低。只有必须硬件隔离，或恢复延迟必须压到几十毫秒时，才值得为 Firecracker 付出 KVM、CPU 一致性和更重的快照制作成本。

## 5. 关键坑与工程约束

1. **rootless 不能 create/checkpoint。** 在 WSL 宿主机以普通用户执行 `runsc --rootless ... create` 直接报 `Rootless mode not supported with "create"`；本次改用特权驱动容器，在容器内以 root 运行 runsc。rootless `run` 可以配合 `--network=none` 跑通，但不能覆盖快照流程。
2. **WSL 没有可用的嵌套 KVM。** `systrap` 在嵌套容器里报 `out of memory`，`ptrace` 可用；本次全部数据来自 ptrace。KVM 平台的历史数据与本次同量级，但绝对值和平台相关。
3. **`fscheckpoint` 只接受“可 checkpoint 的文件系统”。** 直接把 `/data` 做成普通 host bind mount 时，`runsc checkpoint` 报 `failed to save split filesystem bundle: no checkpointable filesystems`。复刻 Agent Substrate 的做法：在 sandbox spec 上加 gVisor 共享 tmpfs 注解，app spec 保留 `/data` bind mount：

   ```json
   "dev.gvisor.spec.mount.data.type": "tmpfs",
   "dev.gvisor.spec.mount.data.share": "container",
   "dev.gvisor.spec.mount.data.source": "/work/<run>/vol",
   "dev.gvisor.spec.mount.data.options": "mode=0777"
   ```

   这样 `/data` 是 disk-backed、可 checkpoint 的共享 tmpfs，`fs/` bundle 才能保存卷。
4. **ROOTFS 快照是增量。** `fscheckpoint` 保存的是可写层 delta（本次约 0.1 MiB），不是 12 MiB 的基础 rootfs；恢复时必须先准备干净的基础 rootfs，再叠加 checkpoint。不要把 0.1 MiB 当成整个根文件系统的体积。
5. **`restore -background -detach` 返回不等于页加载完成。** 需要 `runsc wait -restore _sandbox`（内存）或 `runsc wait -fsrestore app`（文件系统）来等待后台加载；本次 `wait -fsrestore` 约 8 ms，`wait -restore` 约 37 ms。
6. **就绪探测放在容器内。** 本次用 `/tmp/state.json` + `runsc exec` 探测，避免依赖 host bind mount 的就绪文件；探测本身有开销，恢复时间应理解为“命令返回 + 探测到 ready”的上界。
7. **网络未验证。** 全部测试使用 `--network=none`；Agent Substrate 的 warm worker 还需要处理网络命名空间、端口和连接恢复，这部分不在本次 MVP 范围内。

## 6. 复现要点

完整脚本可在实验机上复现，核心参数：

```sh
# 驱动容器（WSL 无 KVM，使用 ptrace）
docker run -d --name gvisor-bench-driver --privileged --cgroupns=host \
  -v /usr/local/bin/runsc:/usr/local/bin/runsc:ro \
  -v /usr/local/bin/gvisor-bin:/usr/local/bin/gvisor-bin:ro \
  -v /tmp/gvisor-bench:/work node:22-slim sleep infinity

# 基础 rootfs + 静态工作负载
cid=$(docker create alpine-local:3.22 /bin/sh)
docker export "$cid" | tar -xf - -C /work/template/rootfs
docker rm "$cid"
# 将静态 Go 工作负载放到 /work/template/rootfs/bench，并准备 sandbox/app config.json
```

复现时建议至少固定：runsc 版本、平台（ptrace/KVM）、内存触碰大小、预热时间、是否 `-background`、是否等待 `wait -restore`/`wait -fsrestore`。这些口径不同，数字不能直接横向比较。

## 7. 边界

- 单机 WSL2、嵌套容器、ptrace 平台，绝对值不代表裸金属或生产 K8s。
- 单 app 容器、无网络、无跨节点恢复；未验证多容器共享卷、真实 Agent Substrate 的 worker 池和 GCS 快照路径。
- ROOTFS/VOLUMES 的“恢复”包含应用重新预热；如果应用预热更短，内存快照的相对收益会下降；如果预热更长，收益会放大。
- KVM 数据来自历史同机测试，未在本轮重新复测；Firecracker 的 19 ms 是 API 返回时间，页面仍按需加载。
