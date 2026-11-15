---
name: opensandbox-microvm-kernel-and-sandbox-metrics-comparison
description: 在 WSL2 嵌套 KVM 上实测 Firecracker、Cloud Hypervisor、QEMU microvm、smolvm、BoxLite、Docker 与 gVisor 的隔离模型、启动、内存、CPU、快照与恢复，并给出相同资源下的理论密度上限与闲置暂停分时复用适配度；对照 crosvm、Kata、microsandbox 的机制与边界
type: project
---

# 微虚机、Docker 与 gVisor 沙箱实测：性能、密度与分时复用

> 调研日期：2026-11-15
> 测试环境：Windows + WSL2 Ubuntu 22.04.5，WSL 内核 `6.18.40.1-microsoft-standard-WSL2`，AMD Ryzen 5 4600H（WSL 可见 6 vCPU / 11 GiB），`/dev/kvm` 可用（AMD-V 嵌套虚拟化），以 root 运行。
> 测试对象：Firecracker 1.18.0、Cloud Hypervisor 54.1、QEMU 6.2 `microvm`、smolvm 1.35.0、BoxLite 0.13.1；容器基线 Docker 27.3.1（runc）与 gVisor release-20261109.0（KVM/ptrace）；另对照 crosvm、Kata Containers 4.3.1、microsandbox 的公开机制。
> 口径：性能数字全部在本机实测；WSL2 嵌套虚拟化的绝对值和裸金属不可直接比较，**只看相对差异和量级**。guest 统一为 Alpine 3.22.8，rootfs 256 MiB ext4；除特别说明外统一 **1 vCPU / 512 MiB**、5 轮取中位数，Firecracker/Cloud Hypervisor/QEMU 在 1 轮预热后测热缓存启动。smolvm/BoxLite 的端到端时间包含 CLI、镜像准备和 agent 握手；Docker/gVisor 的 `docker run` 包含 Docker CLI/daemon；它们和“到 guest `/init`”不是同一边界，文中分开标注。

## 一、结论先行

| 维度 | 实测结论 |
|---|---|
| 启动到 guest init / 容器命令完成 | 热缓存中位数：QEMU microvm **0.95 s**、Cloud Hypervisor **1.07 s**、Firecracker **1.10 s**（同内核 6.18.62，1 vCPU）；Docker `docker run` **2.46 s**、gVisor KVM `docker run` **2.67 s**（含 Docker CLI/daemon）；gVisor 原生 `runsc run` 仅 **0.077 s** |
| 端到端 sandbox 启动 | smolvm **1.47 s**（冷启动 4.35 s，本地 rootfs 导入）；BoxLite CLI **3.94 s**（冷启动 8.58 s），其中镜像准备 2.74 s、VMM spawn 仅 0.089 s |
| 空闲宿主内存 | Docker **15.0 MiB**（含 shim 14.1）、gVisor KVM **57.0 MiB**（含 shim/gofer/sentry）、Firecracker **59.5 MiB**、Cloud Hypervisor **73.7 MiB**、QEMU **122.0 MiB**、smolvm **118.5 MiB**、BoxLite **135.8 MiB**（512 MiB guest 仅触碰启动页，PSS 口径；容器另给 cgroup） |
| guest/容器触碰 300 MiB 后 | Docker **306.7 MiB**（cgroup 301.8）、gVisor KVM **326.7 MiB**（cgroup 312.8）、Firecracker **357 MiB**、Cloud Hypervisor **372 MiB**、QEMU **420 MiB**、smolvm **428 MiB**、BoxLite **303 MiB**（分配方式不同，见 §5） |
| 空闲 CPU | 全部 **0.0%**（5 秒采样）；启动 CPU：QEMU ~0.91 s、Firecracker ~1.01 s、Cloud Hypervisor ~1.06 s；容器启动 CPU 被 Docker daemon 摊薄，未单独拆分 |
| 快照创建 | gVisor 300 MiB checkpoint **0.39 s / 301 MiB**；Cloud Hypervisor **0.70 s / 513 MiB**；Docker commit **1.05 s / 8.3 MB**（磁盘镜像，不含 RAM）；Firecracker full **2.22 s / 513 MiB**；smolvm/BoxLite 受镜像/运行时限制未测到 |
| 快照恢复 | Firecracker **0.019 s**；gVisor eager **0.15 s**、async **0.10 s**；Cloud Hypervisor 默认 eager **0.367 s**，`ondemand` **0.015 s**、`copyonwrite` **0.013 s**（后两者把缺页成本推迟到首次访问）；Docker commit 恢复等同新容器启动，Docker checkpoint 在本次环境不可用 |
| 隔离模型 | Docker 共享宿主内核（namespace/cgroup/seccomp）；gVisor 用户态 Sentry 应用内核（无 guest 内核，KVM/ptrace 平台）；Firecracker/Cloud Hypervisor/QEMU/libkrun 系是硬件虚拟化 microVM，各自带 guest 内核 |
| guest 内核 | Firecracker 6.18.62（完整 CI config、`/proc/config.gz` 可用）；smolvm 6.18.60（libkrunfw 5.5.0，无 IKCONFIG）；BoxLite 默认 6.12.87（原生 VMM RC 为 6.12.110）；Kata 4.3.1 固定 6.18.56；Cloud Hypervisor/QEMU/crosvm 自带内核（BYO）；Docker 用宿主 6.18.40.1-WSL2；gVisor 无 guest 内核，`uname` 报 4.19.0-gvisor |
| 理论密度上限 | 64 vCPU/64 GiB、4:1 超卖、1 vCPU/512 MiB 时：Docker **213**、gVisor **200**、Firecracker **183**、Cloud Hypervisor **176**、QEMU **155**、smolvm **153**、BoxLite **150**；1:1 的 64 vCPU 节点上所有方案都是 64，CPU 先撞顶 |
| 分时复用（停计算、留文件） | Docker/FC/CLH/QEMU/gVisor 适配度高，恢复 0.95–1.74 s（gVisor 原生 0.077 s）；smolvm 1.47 s 中等，BoxLite 3.94 s 偏低；保留 rootfs/可写层即可，不需要每次 commit 或 RAM 快照 |
| Agent 沙箱 + volume/PVC | 只保留文件状态、进程可重启时，runc/gVisor + volume/PVC 通常比 FC 更合适；FC/Kata 只在必须硬件隔离时选，且 PVC 的块设备/CSI attach 语义更受限 |
| 选型直觉 | 要硬件隔离 + 最快恢复选 Firecracker；要快照创建/PCI/迁移选 Cloud Hypervisor；要最低固定开销、弱隔离选 Docker；要用户态内核隔离、快照/分叉且不换硬件 VM 选 gVisor；要嵌入库、跨 macOS/Windows 或分支/打包选 libkrun 系（smolvm/BoxLite） |

## 二、测试口径与边界

### 2.1 环境

| 项 | 值 |
|---|---|
| 宿主 | Windows，WSL2 Ubuntu 22.04.5 LTS |
| WSL 内核 | `6.18.40.1-microsoft-standard-WSL2` |
| CPU | AMD Ryzen 5 4600H，WSL 可见 6 vCPU，AMD-V |
| 内存 | 11 GiB（WSL） |
| KVM | `/dev/kvm` 存在，`kvm_amd` 已加载；普通用户不在 `kvm` 组，测试用 `wsl -u root` |
| 测试日期 | 2026-11-15 |

WSL2 默认不保证嵌套虚拟化；这台机器已经暴露 `/dev/kvm`。如果换一台机器，先确认：

```bash
ls -l /dev/kvm
lscpu | grep -E 'Virtualization|Hypervisor'
lsmod | grep kvm
```

没有 `/dev/kvm` 时，Firecracker/Cloud Hypervisor/QEMU/Kata 的 KVM 路径都不可用；Windows 上只能走 WHP（例如 smolvm 的 Windows 构建），不在本文实测范围。

### 2.2 版本与镜像

| 组件 | 版本 | 说明 |
|---|---|---|
| Firecracker | 1.18.0（2026-11-09） | 官方 x86_64 release |
| Firecracker guest kernel | 6.18.62 | 取自 Firecracker CI `20261111-778a26c0594c-0`，配官方 `.config` |
| Cloud Hypervisor | 54.1（2026-11-11） | `cloud-hypervisor-static` |
| QEMU | 6.2.0（Ubuntu 22.04 包） | `-M microvm`；当前上游 QEMU 版本更高，机器模型语义一致 |
| smolvm | 1.35.0（2026-11-14） | 自带 libkrun + libkrunfw 5.5.0 |
| BoxLite | 0.13.1（2026-11-12） | 默认 libkrun 引擎；原生 VMM 为 RC |
| Docker | 27.3.1（containerd 1.7.24） | 原生 Docker Engine，cgroup v2 + systemd driver；`runc` 运行时 |
| gVisor | release-20261109.0 | `runsc`（OCI spec 1.2.1）；KVM/ptrace 平台（WSL 上 systrap 启动失败） |
| 根文件系统 | Alpine 3.22.8 minirootfs | 256 MiB ext4；自定义 `/init` 只做 proc/sys/dev 挂载并打印标记；Docker 镜像 `alpine-local:3.22`（8.3 MB） |

### 2.3 测量边界

- **启动**：Firecracker/Cloud Hypervisor/QEMU 从进程启动到 guest `/init` 打印 `MVM_BOOT_END`；smolvm/BoxLite 从 CLI 进程启动到 guest 命令执行完成。后者包含镜像准备、CLI 启动、agent 握手和退出清理，不能直接当成 VMM 启动时间。
- **容器启动**：Docker 用 `docker run`（CLI 启动到容器命令退出）和 `docker start`（预创建容器后启动并等待）两个边界；两者都包含 Docker CLI/daemon，不等于 runc 引擎本身。gVisor 另测原生 `runsc run`（CLI 启动到容器退出），用来区分引擎启动和 Docker 包装开销。
- **内存**：VMM 用宿主进程树 PSS（`/proc/<pid>/smaps_rollup`），不是 guest 配置内存。Docker/gVisor 同时记录 PSS 和 cgroup `memory.current`：PSS 含 shim/sentry/gofer，cgroup 含该容器计入的匿名页和页缓存；gVisor ptrace 的 PSS 会低估共享映射，以 cgroup 为准。guest 配置统一 512 MiB；VMM 普遍按需分配，所以“配置 512 MiB”不等于“宿主常驻 512 MiB”。
- **300 MiB 触碰**：Firecracker/Cloud Hypervisor/QEMU/smolvm 在 guest `/dev/shm` 写入 300 MiB；BoxLite 的 `/dev/shm` 固定 64 MiB，改用主机静态二进制经 volume 挂入 guest，`malloc(300 MiB)` 并逐页写入。Docker/gVisor 用同一个静态 `memtest`：`malloc(300 MiB)`、逐页写入后 `sleep`。
- **快照**：Firecracker/Cloud Hypervisor 用各自原生的 full snapshot API；gVisor 用原生 `runsc checkpoint/restore`；Docker 的 `commit` 是磁盘/镜像快照，`docker checkpoint` 需要 experimental + CRIU，本次未启用；smolvm/BoxLite 的 checkpoint 能力受镜像/运行时限制，未拿到可比数字，按机制记录。
- **噪声**：WSL2 嵌套虚拟化、宿主代理、镜像缓存都会放大方差；表中给中位数和范围，单轮异常值不应当作稳定结论。Firecracker/Cloud Hypervisor/QEMU 的数字是热缓存 5 轮中位数，冷缓存首轮会明显更高。

## 三、内核与 VMM 架构对照

### 3.1 总表

| 项目 | VMM 形态 | Hypervisor | guest 内核由谁提供 | 本次内核版本 | 启动接口 / 设备模型 | 快照能力 |
|---|---|---|---|---|---|---|
| Firecracker | Rust，独立进程，极简设备模型 | KVM | 用户提供；官方 CI 内核 + config | 6.18.62 | Linux boot protocol；ACPI + virtio-mmio（可选 PCI）；无 BIOS；串口 `ttyS0` | full/diff snapshot，load+resume 很快 |
| Cloud Hypervisor | Rust，rust-vmm 生态，独立进程 | KVM / MSHV | 用户提供；PVH 或 bzImage | 6.18.62（测试用） | 直接内核启动或固件；ACPI + PCI；热插拔、迁移、vhost-user | snapshot/restore；支持 eager/ondemand/COW 恢复 |
| QEMU microvm | C，QEMU 的 `microvm` 机器类型 | KVM / TCG | 用户提供 | 6.18.62（测试用） | 无 PCI/ACPI；最多 8 个 virtio-mmio；无热插拔；qboot/SeaBIOS 可选 | 无 Firecracker 式 snapshot API；未实测 |
| crosvm | Rust，ChromeOS VMM，进程级设备沙箱 | KVM / WHPX / Gunyah 等 | 用户提供；Linux/Android 内核 + initramfs/rootfs | 未固定 | 无 BIOS；virtio-mmio/PCI；`bzImage`；进程级设备隔离 | snapshot 框架仍属实验，限定设备；本次未实测 |
| libkrun（smolvm/BoxLite 底座） | C API 的库，嵌入调用方进程；内部起 VMM 进程 | KVM / HVF / WHP | 内核打包进 `libkrunfw.so` | smolvm 6.18.60；BoxLite 6.12.87 | virtio-mmio；`hvc0`；`init=/init.krun`；virtio-fs/块设备/vsock/balloon | 取决于上层产品；libkrun 本身不是快照 API |
| smolvm | Rust CLI + libkrun，OCI 镜像，可嵌入 SDK | KVM / HVF / WHP | libkrunfw 5.5.0，内核 6.18.60 | 6.18.60 | virtio-mmio + virtio-fs rootfs；4 vCPU 默认、弹性内存 | `machine checkpoint` 捕获 RAM/CPU/磁盘；需可移植镜像 |
| BoxLite | Rust CLI/库，默认 libkrun；原生 VMM 为 RC | KVM / HVF / WHP | libkrunfw（默认）；原生 VMM 固定内核 | 默认 6.12.87；原生 6.12.110 | virtio-mmio + virtio-fs/块设备/vsock | 磁盘 + 执行配置 checkpoint，REST-only；无 RAM 快照 |
| Kata Containers | 容器运行时 + 每容器 VM；QEMU/CLH/FC/Dragonball 后端 | KVM | Kata 打包内核 | 4.3.1：6.18.56 | 取决于后端；guest agent 管理容器 | 无统一 VM 快照 API；取决于后端/CRIU，本次未实测 |
| Docker（runc） | 容器运行时，无 VMM | 无（共享宿主内核） | 宿主内核 | 6.18.40.1-WSL2 | namespace/cgroup/seccomp/capabilities；runc + containerd shim | `docker commit` 磁盘镜像；`docker checkpoint` 需 CRIU/experimental |
| gVisor | Go 用户态应用内核（Sentry），不是硬件 VM | KVM（KVM 平台）/ 无（ptrace、systrap） | 无 guest 内核 | n/a（`uname` 报 4.19.0-gvisor） | 实现 Linux ABI；runsc OCI runtime；KVM/ptrace | 原生 `runsc checkpoint/restore`；本次 300 MiB 工作负载镜像 301 MiB |
| microsandbox | Rust，`msb_krun`（libkrun 分支）+ libkrunfw | KVM / HVF / WHP | libkrunfw 5.6.1，内核 6.12.117 | 6.12.117 | 与 libkrun 同类；fork/snapshot 为产品能力 | beta；fork/snapshot 未实测 |

### 3.2 关键差异

**Firecracker 的内核是“用户资产”，不是内置件。** 官方只保证 guest 5.10 / 6.1 / 6.18（6.18 从 v1.16.1 起支持），并提供 CI config；内核由用户自己构建或取 CI 产物。它的设备模型刻意做小：ACPI + virtio-mmio，PCI 是可选；CI config 明确 `# CONFIG_VIRTIO_FS is not set`，所以 virtio-fs 需要自定义内核。好处是攻击面小、启动路径短；代价是设备能力要靠内核配置补齐。

**Cloud Hypervisor 更像“现代云负载 VMM”。** 它同样 BYO 内核，但支持 PVH/bzImage、ACPI + PCI、热插拔、vhost-user、迁移和 snapshot；设备比 Firecracker 多，启动路径也更接近通用虚拟化。代价是宿主内核要求更高（README 推荐 5.13+，CI 主要测 5.15），内存开销也略高。

**QEMU microvm 是“去掉历史包袱的 QEMU”。** 官方文档明确说它 inspired by Firecracker，无 PCI/ACPI，最多 8 个 virtio-mmio，不支持热插拔，跨 QEMU 版本的 live migration 也不支持。它适合短生命周期、内核直启的沙箱；如果你需要 QEMU 的设备生态，应该用 `q35`/`pc`，而不是 `microvm`。

**crosvm 的重点是进程级设备隔离。** 每个 virtio 设备可以 fork 到独立进程，再用 Minijail/namespace/seccomp 收权；这比“一个 VMM 进程模拟所有设备”的安全边界更细。它的 snapshot 文档自己标注为 highly experimental、只支持有限设备，不能当作成熟沙箱快照方案。

**libkrun 把内核变成共享库。** `libkrunfw` 把 Linux 内核打包进 `.so`，libkrun 通过链接器把内核段映射进 guest，省去固件和内核文件加载；这也是 smolvm/BoxLite 能做到“无 daemon、单进程嵌入”的原因。代价是：内核版本跟随 libkrunfw 发行版，调用方很难单独替换；内核 config 也由 libkrunfw 决定（smolvm 的 6.18.60 config 没有 `CONFIG_IKCONFIG`，guest 内看不到 `/proc/config.gz`）。

**Docker 是容器基线，不是 microVM。** runc 只负责 namespace/cgroup/挂载/能力收权，容器与宿主共享内核；启动和空闲内存的固定成本主要是 containerd-shim（本次约 14 MiB/容器），应用本身可以低到 1 MiB。它的快照是镜像层（`docker commit`），不保存运行中进程内存；Docker 的 checkpoint 走 CRIU，本次环境未启用 experimental，未测。

**gVisor 用用户态内核换隔离，不启动 guest 内核。** Sentry 用 Go 实现 Linux ABI，应用 syscall 被 Sentry 截获；平台可选 ptrace、systrap、KVM。本次 WSL 上 systrap 报 `out of memory: unknown`，ptrace 与 KVM 可用；KVM 平台下空闲 PSS 57 MiB，300 MiB 触碰后 327 MiB（cgroup 313 MiB），原生 runsc 启动 77 ms。checkpoint 保存 Sentry/进程状态，300 MiB 工作负载镜像 301 MiB、创建 0.39 s、eager restore 0.15 s。

**“libkrun”不等于“同一个内核”。** 本次三个 libkrun 系产品的内核版本就不同：smolvm 6.18.60、BoxLite 默认 6.12.87、microsandbox 6.12.117。选型时不能只写“基于 libkrun”，必须把 libkrunfw 版本、内核版本和 config 摘要写进模板/镜像清单。

### 3.3 关键 config 对照

| 选项 | Firecracker 6.18.62 | libkrunfw 6.18.60（smolvm） | BoxLite 原生 6.12.110 |
|---|---|---|---|
| `CONFIG_MODULES` | `y`（启动参数 `nomodule` 禁用加载） | 未启用 | 未在 fragment 中声明 |
| `CONFIG_IKCONFIG_PROC` | `y`（guest 有 `/proc/config.gz`） | `# CONFIG_IKCONFIG is not set` | 未在 fragment 中声明 |
| `CONFIG_NR_CPUS` | 64 | 16 | 64 |
| `CONFIG_HZ` | 250 | 250 | 未在 fragment 中声明 |
| `CONFIG_PVH` | `y` | `y` | 未在 fragment 中声明 |
| `CONFIG_ACPI` | `y` | `y` | 未在 fragment 中声明 |
| `CONFIG_PCI` | `y` | 未启用 | 未在 fragment 中声明 |
| `CONFIG_VIRTIO_PCI` | `y` | 未启用 | 未在 fragment 中声明 |
| `CONFIG_VIRTIO_MMIO` | `y` | `y` | `y` |
| `CONFIG_VIRTIO_MMIO_CMDLINE_DEVICES` | 未启用 | `y` | `y` |
| `CONFIG_VIRTIO_FS` | `# CONFIG_VIRTIO_FS is not set` | `y` | `y` |
| `CONFIG_VIRTIO_BLK` | `y` | `y` | `y` |
| `CONFIG_VIRTIO_NET` | `y` | `y` | `y` |
| `CONFIG_VIRTIO_VSOCKETS` | `y` | `y` | `y` |
| `CONFIG_VIRTIO_BALLOON` | `y` | `y` | `y` |
| `CONFIG_KVM_GUEST` | `y` | `y` | `y` |
| `CONFIG_SERIAL_8250_CONSOLE` | `y`（`ttyS0`） | 未启用（用 `hvc0`） | `y` |
| `CONFIG_RANDOMIZE_BASE` | `y` | 未启用 | 未在 fragment 中声明 |

> BoxLite 的 `src/vmm/boot/kernel.config` 只有 75 行，是叠加在基线 config 上的 fragment，不能把“未声明”当成“关闭”。Firecracker 和 libkrunfw 的文件是完整 config（分别约 1542 / 986 行），可以直接比较。Docker 共享宿主内核（6.18.40.1-WSL2），gVisor 没有 guest 内核（`uname` 报 4.19.0-gvisor）；这两者不参与 kconfig 对比。

## 四、启动速度

### 4.1 结果

统一 1 vCPU / 512 MiB；Firecracker/Cloud Hypervisor/QEMU 到 guest `/init`，smolvm/BoxLite 到 guest 命令结束，Docker 到容器命令结束，gVisor 到容器/Sentry 启动完成。

| 类别 | 实现 | 中位数 | 范围 | 边界 | 备注 |
|---|---|---:|---:|---|---|
| 微虚机 | QEMU 6.2 microvm | **0.953 s** | 0.845–1.012 s | guest 0.44 s | ACPI/PCI 关闭，virtio-mmio；启动 CPU ~0.91 s |
| 微虚机 | Cloud Hypervisor 54.1 | **1.067 s** | 1.037–1.097 s | guest 0.56 s | PCI virtio；启动 CPU ~1.06 s |
| 微虚机 | Firecracker 1.18.0 | **1.102 s** | 0.935–1.127 s | guest 0.54 s | 使用 FC 默认 i8042 参数；启动 CPU ~1.01 s；冷缓存首轮 guest uptime 2.31 s |
| 微虚机 | smolvm 1.35.0 | **1.470 s** | 1.370–4.345 s | guest 0.71 s（4 vCPU 单独探测） | 中位数已排除首次 4.35 s 的本地 rootfs 导入；端到端含 CLI/agent |
| 微虚机 | BoxLite 0.13.1 | **3.940 s** | 3.786–4.616 s | guest 0.19 s | 首次 8.58 s；CLI 端到端含 2.741 s 镜像准备；VMM spawn 0.089 s |
| 容器 | Docker 27.3.1（runc） | **2.461 s** `docker run` / **1.610 s** `docker start` | 2.321–4.109 / 1.565–1.742 | 无 guest 内核 | 含 Docker CLI/daemon；命令退出为边界 |
| 用户态内核 | gVisor KVM | **2.665 s** `docker run` / **1.744 s** `docker start` / **0.077 s** `runsc run` | 2.433–3.120 / 1.693–2.478 / 0.071–0.086（冷 0.829） | 无 guest 内核 | Docker 路径含 CLI/daemon；原生 runsc 是引擎启动 |
| 用户态内核 | gVisor ptrace | **2.591 s** `docker run` | 2.579–2.730 | 无 guest 内核 | WSL 上 systrap 不可用，ptrace 作回退 |

### 4.2 怎么读这组数

- **三者热缓存启动都在 0.95–1.10 s，差距在 0.15 s 以内。** guest 内核到 `/init`：QEMU 0.44 s（无 ACPI/PCI）、Firecracker 0.54 s（ACPI + i8042）、Cloud Hypervisor 0.56 s（PCI virtio）。设备模型决定 guest 内的启动时间，但三者总 wall 很接近。
- **Firecracker 之前的 1.389 s 是测试口径问题。** 自定义 `boot_args` 覆盖了 Firecracker 默认的 `i8042.noaux/nomux/dumbkbd`，guest 多花约 0.45 s 探测键盘控制器；改用官方默认参数后降到 1.102 s。不要为这 0.45 s 去裁剪内核——先保留默认启动参数。
- **冷缓存会显著放大启动时间。** Firecracker 在重建 rootfs 后的首轮 guest uptime 是 2.31 s，随后 5 轮热缓存为 0.48–0.55 s。表中是热缓存中位数；跨机器比较必须固定缓存状态，否则会把存储 I/O 当成 VMM 差异。
- **Docker 的 2.46 s 不是 runc 的引擎开销。** `docker run` 包含 CLI、create、daemon/containerd 和启动；预创建后 `docker start` 仍要 1.61 s。原生 gVisor `runsc run` 只有 0.077 s，说明容器引擎本身远快于 microVM；Docker 包装是主要成本。
- **gVisor 的 Docker 路径 2.67 s，只比 Docker runc 多约 0.2 s。** 原生 runsc 0.077 s 与 microVM 的 0.95–1.10 s 不是同一种启动：gVisor 不引导 guest 内核，只启动 Sentry 和容器进程；microVM 的时间花在内核解压/初始化、设备探测和 `/init`。
- **libkrun 系的 guest 内核启动更快，但端到端不一定更快。** BoxLite 的 guest 内核到 `init.krun` 只有 ~0.19 s，smolvm ~0.71 s；但 BoxLite CLI 每次要花 2.74 s 准备镜像 rootfs，smolvm 也要导入本地 rootfs。BoxLite 的 3.94 s 里 VMM spawn 仅 0.089 s；对 sandbox 服务，应该用预构建模板、warm pool 或 snapshot 把镜像准备摊销掉。

## 五、内存占用

### 5.1 结果

PSS 为主，容器另列 cgroup；1 vCPU / 512 MiB guest；“空闲”指 guest/容器只完成启动、没有额外负载；“触碰 300 MiB”指实际写入 300 MiB 后。

| 类别 | 实现 | 空闲 PSS | 300 MiB 后 PSS | 300 MiB 后 cgroup | 备注 |
|---|---|---:|---:|---:|---|
| 微虚机 | Firecracker | **59.5 MiB** | **357.1 MiB** | — | 单进程；guest 内存按需驻留 |
| 微虚机 | Cloud Hypervisor | **73.7 MiB** | **371.7 MiB** | — | 单进程；PCI/ACPI 设备略多 |
| 微虚机 | QEMU microvm | **122.0 MiB** | **420.2 MiB** | — | QEMU 进程本身和设备的固定开销最高 |
| 微虚机 | smolvm | **118.5 MiB** | **428 MiB**（libkrun VM 416.2 + CLI 11.8） | — | `/dev/shm` 300 MiB；端到端 CLI 常驻 |
| 微虚机 | BoxLite | **135.8 MiB**（libkrun VM 93 + CLI 42） | **303 MiB**（libkrun VM 259.7 + CLI 43.2） | — | 静态 malloc 300 MiB；分配/统计方式与其他行不同，见下 |
| 容器 | Docker（runc） | **15.0 MiB**（shim 14.1 + app 0.9） | **306.7 MiB**（shim 6.4 + memtest 300.3） | **301.8 MiB** | 共享宿主内核；cgroup 空闲 2.6 MiB |
| 用户态内核 | gVisor KVM | **57.0 MiB**（shim 14.3 + gofer 11.0 + sentry 31.8） | **326.7 MiB**（shim 6.4 + gofer 4.8 + sentry 315.5） | **312.8 MiB** | cgroup 空闲 11.1 MiB |
| 用户态内核 | gVisor ptrace | — | 27.7 MiB（PSS 低估） | **310.2 MiB** | 按 cgroup 读；PSS 只算到 sentry 的部分映射 |

### 5.2 解释与容量规划

- **配置内存 ≠ 宿主常驻。** 512 MiB 是 guest 的地址空间上限；VMM 用 mmap/按需分配，guest 没碰的页不会变成宿主 PSS。空闲时 Firecracker 只有 59.5 MiB，Cloud Hypervisor 73.7 MiB，Docker 15.0 MiB，gVisor KVM 57.0 MiB，说明启动只触碰了内核/页表/少量用户态页。
- **有负载时按“触碰量 + 固定开销”估算。** 300 MiB guest 触碰对应 Firecracker 357 MiB、Cloud Hypervisor 372 MiB、QEMU 420 MiB、Docker 307 MiB（cgroup 302 MiB）、gVisor KVM 327 MiB（cgroup 313 MiB）；libkrun 系在 400–430 MiB（BoxLite 的 303 MiB 是异常低值，见下）。做容量规划时，建议用这个量级，再留 10–20% 给 guest 峰值、页缓存和 Fastlet/egress 等边车。
- **容器基线：Docker 最低，gVisor 与 Firecracker 同量级。** Docker 的空闲 15.0 MiB 里 14.1 MiB 是 containerd-shim，应用只有 0.9 MiB；它共享宿主内核，不能把“15 MiB”当作“每个沙箱的隔离成本”与 microVM 直接比较。gVisor 的空闲 57.0 MiB 由 shim 14.3 + gofer 11.0 + Sentry 31.8 组成，和 Firecracker 的 59.5 MiB 接近；300 MiB 工作负载下 Sentry 的 PSS 315.5 MiB，cgroup 312.8 MiB。
- **gVisor 的 PSS 口径要小心。** KVM 平台下 Sentry 的 PSS 能反映大部分内存；ptrace 平台下 300 MiB 工作负载的 PSS 只有 27.7 MiB，而 cgroup 是 310.2 MiB，说明内存主要落在共享映射里，PSS 会严重低估。比较 gVisor 时以 cgroup `memory.current` 为准，并注明平台。
- **BoxLite 的 303 MiB 需要谨慎解读。** 它的 guest `/dev/shm` 被固定为 64 MiB，普通 `dd` 只能写 64 MiB；本次改用主机静态二进制挂载进 guest，`malloc(300 MiB)` 并逐页写入。宿主 PSS 259.7 MiB（libkrun VM）+ 43.2 MiB（CLI）仍低于 300 MiB + 预期开销，可能是 KVM 大页/零页、balloon 或 PSS 统计口径导致。**不要把 303 MiB 当作“BoxLite 比 Firecracker 更省内存”的结论**；它只说明“在本次方法下测得 303 MiB”。生产选型应在目标宿主机上用相同 workload 复测。
- **libkrun 系的固定开销不低。** smolvm 的 libkrun VM 进程 416 MiB（300 MiB guest 触碰）比 FC/CLH 多约 60–70 MiB；BoxLite 的 libkrun VM 为 260 MiB，但 CLI 又占 43 MiB。对“节点资源受限、服务更多用户优先”的场景，libkrun 系的嵌入便利性要用内存密度来换。
- **PSS 包含运行时的固定进程。** smolvm 的 118.5 MiB 里包含 `smolvm-bin`；BoxLite 的 135.8 MiB 里包含 `boxlite` CLI；Docker 的 15.0 MiB 里 14.1 MiB 是 containerd-shim；gVisor 的 57.0 MiB 里 14.3 MiB 是 shim、11.0 MiB 是 gofer、31.8 MiB 是 Sentry。真实服务如果走 SDK/REST、复用常驻 runtime，CLI 部分可以摊销，但 shim/Sentry/gofer 的固定成本要计入每沙箱预算；这些进程的共享页在多沙箱间会分摊一部分，单容器 PSS 会偏高。

## 六、CPU 占用

### 6.1 空闲 CPU

Docker、gVisor KVM、Firecracker、Cloud Hypervisor、QEMU、smolvm、BoxLite 在 5 秒空闲窗口内都是 **0.0%**（按单核百分比计；容器用 cgroup `cpu.stat`，VMM 用进程 CPU ticks）。这说明稳态下 VMM/容器运行时没有明显的轮询/心跳开销；沙箱密度主要由内存和启动/快照 CPU 决定，而不是空闲 CPU。

### 6.2 启动 CPU

| VMM | 启动 wall | 启动 CPU（user+sys） | 说明 |
|---|---:|---:|---|
| Firecracker | ~1.10 s | ~1.01 s | 使用默认 i8042 参数后 wall 与 CPU 接近；旧 1.39 s 是自定义 cmdline 的偏差 |
| Cloud Hypervisor | ~1.07 s | ~1.06 s | wall 与 CPU 接近，启动基本是 CPU-bound |
| QEMU microvm | ~0.95 s | ~0.91 s | 同上 |

启动阶段基本是单 vCPU 的 CPU-bound 工作：guest 内核解压/初始化、设备探测、页表构建。VMM 自身的 CPU 开销相对小；差距更多来自 guest 内核 config 和设备模型。容器路径没有单独拆分启动 CPU：`docker run` 的 1.6–2.5 s wall 主要由 Docker CLI/daemon/containerd 消耗，进程树跨多个常驻进程；原生 gVisor 0.077 s 的 CPU 也未单独采集。

### 6.3 业务 CPU

本次没有做 guest 内 CPU-bound benchmark。KVM 下 guest 的 vCPU 时间直接消耗宿主 CPU，VMM 只增加 VM exit/设备模拟的开销；Docker 的 syscall 路径接近原生；gVisor 的 syscall 经 Sentry 处理，syscall 密集负载的 CPU 开销会高于 Docker 和微虚机，本次未量化。对沙箱选型，更有意义的是：
- **启动 CPU**：决定冷启动时的瞬时争抢。
- **快照 CPU/IO**：决定 checkpoint 对宿主的影响。
- **空闲 CPU**：决定密度；本次所有实现都为 0%。

## 七、快照成本与恢复速度

### 7.1 结果

| 类别 | 实现 | 快照创建 | 产物大小 | 恢复 | 备注 |
|---|---|---:|---:|---:|---|
| 微虚机 | Firecracker 1.18.0 | **2.219 s** | **513 MiB**（512 MiB mem + 14 KiB state） | **0.019 s**（load + resume） | 先 `PATCH /vm {"state":"Paused"}`（0.01 s），再 `PUT /snapshot/create`；full snapshot；file backend |
| 微虚机 | Cloud Hypervisor 54.1 | **0.702 s** | **513 MiB**（512 MiB memory-ranges + 31 KiB state + 900 B config） | **0.367 s** eager；**0.015 s** ondemand；**0.013 s** copy-on-write | pause 0.006 s；restore 后 VM 为 paused，resume 0.003 s；ondemand/COW 把缺页推迟到首次访问 |
| 微虚机 | smolvm 1.35.0 | 未测到 | 未测到 | 未测到 | `machine checkpoint` 支持 RAM/CPU/磁盘；本次 local-dir 镜像被拒（host-backed layers），pack 也因 flatten/permission 失败 |
| 微虚机 | BoxLite 0.13.1 | 未测到 | 未测到 | 未测到（磁盘恢复后重新启动） | checkpoint 是磁盘 + 执行配置，REST-only；本地 CLI 明确拒绝；无 RAM 快照 |
| 微虚机 | QEMU 6.2 microvm | 未测 | — | 未测 | 没有 Firecracker 式 snapshot API；microvm 文档明确不支持跨 QEMU 版本 live migration |
| 微虚机 | crosvm | 未测 | — | 未测 | snapshot 框架为 highly experimental、限定设备；上游文档写明 “100% not supported” |
| 微虚机 | Kata 4.3.1 | 未测 | — | 未测 | 没有统一 VM 快照 API；取决于后端/CRIU |
| 容器 | Docker commit | **1.047 s** | **8.3 MB** | 新容器启动（未单独测） | 磁盘/镜像快照，不含 RAM；restore 是重新 `docker run` |
| 容器 | Docker checkpoint | 未测 | — | — | 需 experimental + CRIU；本次环境未启用 |
| 用户态内核 | gVisor KVM（idle） | **0.078 s** | **120 KiB** | **0.090 s** | 原生 runsc；`--leave-running`；image 为 pages/checkpoint |
| 用户态内核 | gVisor KVM（300 MiB） | **0.390 s** | **301 MiB** | **0.152 s** eager；**0.095 s** async | `--background=false` 为 eager；默认 async 把页加载推迟到首次访问 |

### 7.2 解读

**Firecracker：创建慢、恢复极快。** full snapshot 要把 512 MiB guest 内存写盘，2.22 s 是合理的；restore 用 file backend 按需映射，API 返回 19 ms。这个组合适合“快照不频繁、恢复要快”的 warm pool / 模板恢复。分叉/批量恢复时，FC 的 19 ms 级别很有吸引力；但每次快照创建 2 s 的 CPU/IO 成本要在控制面做限流，避免和业务争抢。

**Cloud Hypervisor：创建快、默认恢复慢、可切换恢复模式。** 0.70 s 创建 512 MiB 镜像明显快于 FC，可能和它的 memory-ranges 布局/稀疏写有关；默认 eager-copy restore 367 ms，适合“恢复次数不多、行为最可预测”的场景。`ondemand` 15 ms、`copyonwrite` 13 ms（均含 3 ms resume），和 FC 同量级，但：
- `ondemand` 依赖 `userfaultfd`；本次以 root 成功，生产要确认 `/dev/userfaultfd` 或 `vm.unprivileged_userfaultfd` 策略。
- `copyonwrite` 依赖 snapshot 文件在 VM 生命周期内不被修改，且要求普通私有内存、同文件系统 reflink 等约束；它把页错误推迟到首次访问，**API 返回快不等于业务首次访问快**。
- 选型时要把“恢复 API 延迟”和“首次访问缺页延迟”分开测；本次只测了前者。

**smolvm：checkpoint 是产品级能力，但本次环境没打通。** `machine checkpoint` 的语义是保存 RAM + CPU + 磁盘，`--branchable` 用 memfd 做 CoW 分支，适合“保存一个正在运行的 agent 会话，再分叉/回滚”。本次失败原因是：
1. `local-dir` 镜像的层还在宿主机上，checkpoint 明确拒绝 host-backed layers；
2. 用 `docker import` 生成的 tar 镜像启动时报 `run container detached: Permission denied`；
3. `pack create` 从 local-dir/tar 走 flatten 时失败（`flatten archive exited with exit status: 2` 或拉取 local 镜像 `Permission denied`）。

这更像是“本地镜像/打包路径在这个 WSL + root 环境下的兼容性问题”，不能据此否定产品能力；但选型时要验证：**checkpoint 必须基于可移植、自包含的镜像/模板**，不能依赖宿主机上的 local-dir 层。若这条链路对你的场景重要，建议在目标环境用 registry 镜像或正式 pack 产物做一次端到端验收。

**BoxLite：checkpoint 是磁盘快照，不是内存快照。** 本地 runtime 明确报 “checkpoints are only implemented for REST runtimes”；checkpoint 捕获的是磁盘 + 执行配置，restore 是新建一个 box 后从磁盘启动，不是恢复 RAM。它的价值在“快速复制已安装环境”，不在“毫秒级恢复运行中的会话”。如果业务需要保存执行中的内存状态，BoxLite 不是这条路径。

**Docker：commit 是磁盘快照，不是运行态快照。** `docker commit` 1.05 s 生成 8.3 MB 镜像，只包含文件系统层，不保存进程内存；restore 等价于从该镜像启动一个新容器（本次未单独计 restore）。Docker 的 `checkpoint` 走 CRIU，需要 experimental 和 CRIU，本次环境未启用；对“保存运行中的沙箱会话”，commit 不够。

**gVisor：用户态内核的 checkpoint 介于容器和 microVM 之间。** 空闲容器 checkpoint 0.078 s / 120 KiB、restore 0.090 s；300 MiB 触碰后 0.390 s / 301 MiB，eager restore 0.152 s，默认 async 0.095 s。创建比 Firecracker（2.22 s）和 Cloud Hypervisor（0.70 s）快，恢复比 Firecracker（0.019 s）慢、比 Cloud Hypervisor 默认 eager（0.367 s）快。代价是 gVisor 的 syscall 兼容性和开销，以及 checkpoint 的平台/版本约束。

**QEMU microvm / crosvm / Kata：不要按“成熟统一快照方案”选。** QEMU 有 `savevm`/migration，但 microvm 的设计目标是短生命周期、无 PCI/ACPI，官方文档明确限制跨版本 live migration；crosvm 的 snapshot 仍是实验特性；Kata 没有统一的 VM 快照 API。gVisor 有可用的原生 checkpoint，但它是用户态内核的进程/沙箱状态，不是硬件 VM 的 guest 内存快照；选型时不要把两者混为一谈。

## 八、选型建议

### 8.1 按优先级

| 优先级 | 推荐 | 理由 |
|---|---|---|
| 最低固定内存/最高密度（弱隔离） | **Docker（runc）** | 空闲 15.0 MiB、300 MiB 负载 306.7 MiB（cgroup 301.8）；共享宿主内核，隔离只到 namespace/cgroup/seccomp；不能用于需要硬件隔离的不可信负载 |
| 用户态内核隔离 + 快照/分叉 | **gVisor（KVM 平台）** | 空闲 57 MiB、300 MiB 负载 326.7 MiB（cgroup 312.8）；原生启动 0.077 s；300 MiB checkpoint 0.39 s / 301 MiB、eager restore 0.15 s；代价是 syscall 兼容性和开销 |
| 恢复延迟优先（warm pool、模板恢复、分叉） | **Firecracker** | 512 MiB guest full snapshot restore 19 ms；设备模型小，行为可预测；成熟 jailer/最小攻击面 |
| 快照创建速度 + 设备能力/迁移 | **Cloud Hypervisor** | 0.70 s 创建；PCI/ACPI/热插拔/vhost-user/迁移；`ondemand`/COW 恢复可到 13–15 ms |
| 单节点密度（**必须硬件隔离**时） | **Firecracker**，其次 **Cloud Hypervisor** | 在硬件隔离约束下比较：空闲 60/74 MiB、300 MiB 触碰 357/372 MiB；若允许共享内核/用户态内核，Docker（15/307）和 gVisor（57/327）的内存密度更高，见 §11 |
| 启动速度（热缓存，硬件隔离） | **QEMU microvm / Cloud Hypervisor / Firecracker** | 热缓存 0.95–1.10 s；Docker `run` 2.46 s、gVisor `run` 2.67 s 是 CLI 包装；gVisor 原生 0.077 s 不引导 guest 内核 |
| 嵌入到应用、跨 macOS/Windows、本地 agent sandbox | **libkrun 系（smolvm/BoxLite）** | 单库/单进程、无 daemon；WHP/HVF 路径；smolvm 还有 branch/pack；代价是内核随 libkrunfw 走、内存开销略高 |
| 完全控制 guest 内核/config | **Firecracker / Cloud Hypervisor / QEMU / crosvm** | BYO 内核；可以按 workload 裁剪；libkrun 的内核封装在 `.so` 里，替换成本高；Docker/gVisor 没有 guest 内核 |
| 需要 PCI 设备、热插拔、迁移 | **Cloud Hypervisor**（或 QEMU q35） | microvm 不适合；FC 的 PCI 是可选但设备面仍小 |
| 需要容器运行时/每容器 VM 的成熟编排 | **Kata Containers** | 运行时 + agent + 多 hypervisor 后端；代价是栈重、快照不统一 |
| 不需要硬件 VM、要低开销隔离 | **gVisor**（用户态内核）或 **Docker**（共享内核） | gVisor 的隔离强于 runc，启动/内存接近 FC；Docker 最轻但隔离最弱；两者都不是硬件 VM，不能拿“guest 内核版本”比较 |

> 密度结论分两层：**只比每沙箱内存，Docker > gVisor > Firecracker > Cloud Hypervisor > smolvm ≈ QEMU > BoxLite**；FC/CLH 的“高密度”只成立于“必须硬件 VM 隔离”的约束下。1 vCPU/512 MiB、1:1 的 64 vCPU 节点上，所有方案都先撞 64 个 CPU 上限，内存差异要到高超卖或内存紧张节点才体现。

### 8.2 一句话选型

- **做“可恢复的沙箱池”**：Firecracker 或 Cloud Hypervisor；恢复延迟优先 FC，快照创建/设备能力优先 CLH。如果只需要用户态内核隔离、能接受 0.15 s 级恢复，gVisor 的 0.39 s checkpoint 也可用；Docker commit 不保存运行态，不适合这条路径。
- **做“本地开发/agent 工具”**：smolvm/BoxLite 的嵌入和跨平台更省事；注意镜像准备和 checkpoint 的镜像可移植性。信任的代码用 Docker 最轻；不可信 syscall 用 gVisor。
- **做“agent 执行环境 + volume/PVC”**：文件状态挂 volume/PVC、进程可重启时，优先 runc（可信）或 gVisor（不可信 syscall）；只有必须硬件隔离时才上 FC/Kata。PVC 的 CSI attach/mount 延迟要单独计入启动 SLA。
- **做“每容器 VM 的 K8s 运行时”**：Kata；不要期待统一的 VM 快照 API。
- **做“容器级隔离但不换运行时”**：gVisor 的隔离强于 runc，但仍有 syscall 兼容性和开销；Docker 隔离最弱。两者都不是 microVM，不能拿“guest 内核版本”比较。

## 九、对 OpenSandbox 的落点

OpenSandbox 的 Fast Sandbox 已经走 Firecracker 路径：模板声明 guest kernel 和 reference machine，宿主要求 KVM、`/dev/net/tun`、cgroup v2、XFS reflink，默认 Firecracker `v1.16.1`，支持可选自定义内核 URL；当前 ACK 报告里 cold kernel boot 未验证，模板 create 主要走 `vmstate.snap` 恢复。结合本次实测：

1. **内核版本钉到 6.18.x，并把 config 摘要写进模板清单。** Firecracker 从 v1.16.1 起支持 6.18 guest；6.18.62 的 CI config 自带 `CONFIG_IKCONFIG_PROC=y`，guest 内可直接读 `/proc/config.gz`，适合做运行时核验。模板 manifest 至少记录：kernel version、config digest、vmlinux digest、Firecracker 版本。Docker/gVisor 没有 guest 内核，不适用这条；gVisor 的“内核版本”是用户态 ABI 版本（`uname` 报 4.19.0-gvisor），不是 vmlinux。
2. **保持 block rootfs，不要为了“看起来现代”加 virtio-fs。** FC 的 CI config 明确 `# CONFIG_VIRTIO_FS is not set`；Fast Sandbox 当前用块设备 + TAP 网络，和这个 config 匹配。只有确实需要共享目录时才自定义内核并承担额外攻击面。
3. **使用 Firecracker 默认的 i8042 启动参数，不要为 0.45 s 去裁剪内核。** FC 的默认 cmdline 已带 `i8042.noaux/nomux/dumbkbd`；本次旧数 1.389 s 是因为自定义 `boot_args` 覆盖了它们。改用默认参数后 1.102 s，和 Cloud Hypervisor/QEMU 同量级。模板若自定义 cmdline，应显式保留这三项，并单独验证串口/关机路径。
4. **快照成本按“创建 2 s / 恢复 19 ms”做预算。** 对 512 MiB guest，full snapshot 约 513 MiB、创建 2.2 s；恢复 19 ms。批量恢复时瓶颈在存储带宽和快照创建时的 CPU/IO，不在 resume。任务型 workload 继续“重建优于快照”；只有长会话/敏感池才值得为快照付出 2 s 创建成本。如果引入 gVisor，按“300 MiB 负载 0.39 s / 301 MiB / eager 0.15 s”另算；Docker commit 1.05 s / 8.3 MB 只是磁盘层，不保存运行态，不能替代 `vmstate.snap`。
5. **内存容量按 PSS/cgroup 而不是配置内存算。** 512 MiB guest 在 guest 触碰 300 MiB 时，FC 宿主 PSS 约 357 MiB；空闲约 60 MiB。Docker 空闲 15 MiB、300 MiB 负载 307 MiB（cgroup 302）；gVisor KVM 空闲 57 MiB、300 MiB 负载 327 MiB（cgroup 313）。节点容量规划应使用“活跃沙箱的触碰量 + VMM/Sentry/shim 固定开销 + Fastlet/egress 边车 + 10–20% 余量”，不要用 512 MiB × 沙箱数做简单乘法。
6. **Cloud Hypervisor 是值得保留的备选。** 如果后续需要 PCI 设备、热插拔、迁移，或者快照创建速度成为瓶颈，CLH 的 0.70 s 创建 + ondemand/COW 13–15 ms 恢复很有竞争力；但切换运行时会影响 Fast Sandbox 的 artifact、checkpoint 和 node readiness，不能只看 benchmark。
7. **把“libkrun 系内核碎片化”当成供应链风险。** smolvm 6.18.60、BoxLite 6.12.87、microsandbox 6.12.117 说明“基于 libkrun”不保证同一内核；如果未来在本地开发/边缘节点引入 libkrun，必须把 libkrunfw 版本和内核 config 纳入清单，不能只记录“libkrun”。
8. **Docker/gVisor 是基线或可选 runtime，不是 Fast Sandbox 的替代。** Docker 共享宿主内核，适合可信任务；gVisor 提供用户态内核隔离，适合 syscall 级不可信负载，但 checkpoint、网络和存储语义都与 Firecracker 不同。Fast Sandbox 若继续走硬件隔离，保持 FC；把 gVisor 作为“隔离强度/启动/恢复”三维度的备选时，需要单独验证 execd、TAP 网络、S3 中间件和快照模板。Fast Sandbox 保持 FC 的原因是硬件隔离和 guest 内核控制；如果只追求密度且能接受弱隔离，Docker/gVisor 的每沙箱内存低于 FC。

## 十、复现命令

以下命令均在 WSL2 里执行；测试文件放在 `/root/mvm`，不在仓库内。版本号和 URL 以 2026-11-15 为准。

```bash
# 0. 确认 KVM
ls -l /dev/kvm
lscpu | grep -E 'Virtualization|Hypervisor'

# 1. 取 Firecracker 1.18.0 和 CI 内核
mkdir -p /root/mvm && cd /root/mvm
curl -fL -o fc.tgz \
  https://github.com/firecracker-microvm/firecracker/releases/download/v1.18.0/firecracker-v1.18.0-x86_64.tgz
tar xzf fc.tgz
S3=https://s3.amazonaws.com/spec.ccfc.min
P=firecracker-ci/20261111-778a26c0594c-0/x86_64
curl -fL -o vmlinux-6.18.62 "$S3/$P/vmlinux-6.18.62"
curl -fL -o vmlinux-6.18.62.config "$S3/$P/vmlinux-6.18.62.config"

# 2. Alpine rootfs（含自定义 /init，仅用于读内核信息）
curl -fL -o alpine.tar.gz \
  https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64/alpine-minirootfs-3.22.8-x86_64.tar.gz
mkdir rootfs && tar xzf alpine.tar.gz -C rootfs
cat > rootfs/init <<'EOF'
#!/bin/sh
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sys /sys 2>/dev/null
mount -t devtmpfs dev /dev 2>/dev/null
cat /proc/version
echo "MVM_UPTIME:$(cut -d' ' -f1 /proc/uptime)"
echo MVM_BOOT_END
exec /bin/sh
EOF
chmod +x rootfs/init
truncate -s 256M rootfs.ext4
mke2fs -q -t ext4 -d rootfs -F rootfs.ext4

# 3. Firecracker 启动
cat > fc.json <<'EOF'
{
  "boot-source": {
    "kernel_image_path": "/root/mvm/vmlinux-6.18.62",
    "boot_args": "reboot=k panic=1 nomodule i8042.noaux i8042.nomux i8042.dumbkbd swiotlb=noforce pci=off console=ttyS0 root=/dev/vda ro init=/init"
  },
  "drives": [
    {"drive_id":"rootfs","path_on_host":"/root/mvm/rootfs.ext4","is_root_device":true,"is_read_only":false}
  ],
  "machine-config": {"vcpu_count":1,"mem_size_mib":512}
}
EOF
./release-v1.18.0-x86_64/firecracker-v1.18.0-x86_64 --no-api --config-file fc.json

# 4. Cloud Hypervisor 启动（同一内核/rootfs）
./cloud-hypervisor-static \
  --kernel vmlinux-6.18.62 \
  --disk path=rootfs.ext4,image_type=raw \
  --cmdline 'console=ttyS0 root=/dev/vda ro init=/init' \
  --cpus boot=1 --memory size=512M \
  --serial tty --console off

# 5. QEMU microvm 启动（同一内核/rootfs）
qemu-system-x86_64 -M microvm -enable-kvm -cpu host -smp 1 -m 512 \
  -kernel vmlinux-6.18.62 \
  -append 'console=ttyS0 root=/dev/vda ro init=/init' \
  -drive id=root,file=rootfs.ext4,format=raw,if=none \
  -device virtio-blk-device,drive=root \
  -display none -serial stdio -monitor none -no-reboot
```

Firecracker 快照/恢复：

```bash
# 启动时保留 API socket（注意参数是 --api-sock）
./firecracker-v1.18.0-x86_64 --api-sock /root/mvm/fc.sock --config-file fc.json &

# pause -> snapshot
curl -sS --unix-socket /root/mvm/fc.sock -X PATCH http://localhost/vm \
  -H 'Content-Type: application/json' -d '{"state":"Paused"}'
curl -sS --unix-socket /root/mvm/fc.sock -X PUT http://localhost/snapshot/create \
  -H 'Content-Type: application/json' \
  -d '{"snapshot_type":"Full","snapshot_path":"/root/mvm/fc-snap/state","mem_file_path":"/root/mvm/fc-snap/mem"}'

# restore
./firecracker-v1.18.0-x86_64 --api-sock /root/mvm/fc2.sock &
curl -sS --unix-socket /root/mvm/fc2.sock -X PUT http://localhost/snapshot/load \
  -H 'Content-Type: application/json' \
  -d '{"snapshot_path":"/root/mvm/fc-snap/state","mem_backend":{"backend_path":"/root/mvm/fc-snap/mem","backend_type":"File"},"resume_vm":true}'
```

Cloud Hypervisor 快照/恢复：

```bash
./cloud-hypervisor-static --api-socket /root/mvm/ch.sock \
  --kernel vmlinux-6.18.62 --disk path=rootfs.ext4,image_type=raw \
  --cmdline 'console=ttyS0 root=/dev/vda ro init=/init' \
  --cpus boot=1 --memory size=512M --serial null --console off &
./ch-remote-static --api-socket /root/mvm/ch.sock pause
./ch-remote-static --api-socket /root/mvm/ch.sock snapshot file:///root/mvm/ch-snap

# restore（先起一个空 VMM，再 restore）
./cloud-hypervisor-static --api-socket /root/mvm/ch2.sock &
./ch-remote-static --api-socket /root/mvm/ch2.sock \
  restore source_url=file:///root/mvm/ch-snap,memory_restore_mode=copyonwrite
./ch-remote-static --api-socket /root/mvm/ch2.sock resume
```

smolvm / BoxLite 启动：

```bash
# smolvm（本地 rootfs 目录可避开 registry）
./smolvm machine run --cpus 1 --mem 512 --image /root/mvm/alpine-rootfs -- true

# BoxLite（需要能访问 registry；本地镜像缓存后可用）
./boxlite run --cpus 1 --memory 512 --network disabled alpine:3.22 true
```

Docker / gVisor：

```bash
# Docker（本地 Alpine 镜像）
docker run --rm --cpus=1 --memory=512m alpine-local:3.22 sh -c 'echo MVM_BOOT_END'
docker commit <container> osb-bench-commit:latest

# gVisor release-20261109.0：解包后安装 runsc / containerd-shim / gvisor-bin
install -m 755 runsc /usr/local/bin/runsc
install -m 755 containerd-shim-runsc-v1 /usr/local/bin/containerd-shim-runsc-v1
mkdir -p /usr/local/bin/gvisor-bin && cp gvisor-bin/* /usr/local/bin/gvisor-bin/

# 把 runtimes 合并进现有 /etc/docker/daemon.json（保留原有 registry-mirrors），再重启 Docker
{
  "runtimes": {
    "runsc-kvm": {"path": "/usr/local/bin/runsc", "runtimeArgs": ["--platform=kvm"]},
    "runsc-ptrace": {"path": "/usr/local/bin/runsc", "runtimeArgs": ["--platform=ptrace"]}
  }
}
systemctl restart docker

# Docker 路径（WSL 上 systrap 启动失败，用 KVM 或 ptrace）
docker run --rm --runtime=runsc-kvm --security-opt seccomp=unconfined \
  --cpus=1 --memory=512m alpine-local:3.22 sh -c 'echo MVM_BOOT_END'

# 原生 runsc checkpoint/restore（OCI bundle 需先按 runc spec 生成并改 args/rootfs）
runsc --root /root/mvm/runsc-root --network=none --platform=kvm \
  run -detach -bundle /root/mvm/gv-bundle gvtest
runsc --root /root/mvm/runsc-root --platform=kvm checkpoint --leave-running \
  --image-path /root/mvm/gv-snap gvtest
runsc --root /root/mvm/runsc-restore --platform=kvm restore --background=false \
  --image-path /root/mvm/gv-snap --bundle /root/mvm/gv-bundle gvrestore
```

> Docker 的 `checkpoint` 需要 daemon 开启 experimental 并安装 CRIU；本次环境未启用，所以没有 Docker checkpoint 数字。Firecracker 的 `boot_args` 保留官方 i8042 参数；`8250.nr_uarts=0` 会关闭本测试使用的 `ttyS0` 串口，因此未加入。

## 十一、相同资源下的理论密度上限

> 本节是按实测固定开销做的模型推算，不是测出来的并发数。密度由节点的 CPU:内存比、CPU 超卖比、每沙箱 vCPU/内存、以及“暂停”是否保留 RAM 决定；换节点时把数字代进公式即可。

### 11.1 公式与假设

- 节点：**64 vCPU / 64 GiB（1 GiB/core）**，CPU 超卖 **4:1**（256 个可调度 vCPU），1 TiB NVMe。
- 沙箱：1 vCPU / 512 MiB guest；分别按“只触碰 300 MiB”和“全部 512 MiB 驻留”估算。
- 固定开销取第 5 节的 PSS：Docker 15.0、gVisor 57.0、Firecracker 59.5、Cloud Hypervisor 73.7、QEMU 122.0、smolvm 118.5、BoxLite 135.8 MiB。
- 公式：
  - `N_cpu = floor(64 × 4 / 1) = 256`
  - `N_mem = floor(64 × 1024 / (touched + fixed))`
  - `N_max = min(N_cpu, N_mem, N_disk)`，未计 10–20% 安全余量。
- BoxLite 的 300 MiB 实测值 303 MiB 异常偏低（见 §5），密度表用“固定开销 + 300 MiB”的保守值 435.8 MiB；其余 300 MiB 行用实测 PSS。
- smolvm/BoxLite 的固定开销包含 CLI；真实服务走常驻 SDK 时可以摊薄，表中是保守值。

### 11.2 结果

| 方案 | 固定开销 | 300 MiB 活跃 | 512 MiB 活跃（模型） | N_mem(300M) | N_mem(512M) | N_max(300M) | N_max(512M) | 内存口径排序 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Docker（runc） | 15.0 MiB | **306.7 MiB** | 527 MiB | **213** | **124** | **213** | **124** | 1 |
| gVisor KVM | 57.0 MiB | **326.7 MiB** | 569 MiB | **200** | **115** | **200** | **115** | 2 |
| Firecracker | 59.5 MiB | **357.1 MiB** | 572 MiB | **183** | **114** | **183** | **114** | 3 |
| Cloud Hypervisor | 73.7 MiB | **371.7 MiB** | 586 MiB | **176** | **111** | **176** | **111** | 4 |
| QEMU microvm | 122.0 MiB | **420.2 MiB** | 634 MiB | **155** | **103** | **155** | **103** | 5（300M）/ 6（512M） |
| smolvm | 118.5 MiB | **428 MiB** | 630 MiB | **153** | **104** | **153** | **104** | 6（300M）/ 5（512M） |
| BoxLite | 135.8 MiB | **435.8 MiB**（保守） | 648 MiB | **150** | **101** | **150** | **101** | 7 |

### 11.3 怎么读

- **在 1 vCPU / 512 MiB、1:1 不超卖的 64 vCPU 节点上，所有方案的上限都是 64 个。** 64 GiB 节点上 `N_mem` 有 150–213，256 GiB 节点上为 600–850，均远大于 64；CPU 先成为瓶颈，内存固定开销的差异体现不出来。
- **只有 CPU 超卖、每沙箱 vCPU 更少，或节点内存更紧时，固定开销才决定密度。** 上表用 64 GiB 内存 + 4:1 超卖把差异放大；同样的排序在 256 GiB 节点上要超卖到 16:1 左右才会出现。
- **内存口径排序：Docker > gVisor > Firecracker > Cloud Hypervisor > smolvm ≈ QEMU > BoxLite。** Docker 领先来自共享宿主内核和 15 MiB 固定开销；gVisor 的 57 MiB 与 Firecracker 的 59.5 MiB 几乎同档；QEMU 的 122 MiB 和 BoxLite 的 135.8 MiB 固定开销最高。300 MiB 与 512 MiB 两种口径下 QEMU/smolvm 的顺序会互换，差异在 1–2 个沙箱以内。所以“高密度选 FC”只在“必须硬件隔离”的前提下成立；只比内存密度，Docker > gVisor > FC。
- **这些是活跃沙箱的上限。** 如果闲置时用 SIGSTOP/冻结保留 RAM，密度仍然受 `N_mem` 限制，不会因为“暂停”而提高；要释放内存必须停止计算进程，只保留文件状态（见下一节）。
- **磁盘也要算进 `N_max`。** 1 TiB / 256 MiB rootfs ≈ 4096 个完整副本；共享只读基座 + reflink/overlay 只存变更块时还能更高，但要受 inode、元数据和 IOPS 限制。

## 十二、分时复用（闲置暂停）适配度

### 12.1 前提：暂停 = 停止计算、保留文件状态

沙箱只作为执行环境时，闲置暂停不需要保留进程内存、TCP 连接或 CPU 寄存器；需要保留的是**文件系统状态**。因此推荐：

1. **停止/杀掉计算进程**，释放 CPU 和 RAM；
2. **保留 rootfs / 可写层 / 用户目录**；
3. 下次请求到来时**冷启动**并挂回同一文件状态；
4. 不把 `docker commit`、Firecracker `vmstate.snap`、gVisor checkpoint 当作每次暂停的默认动作。

这和“SIGSTOP/冻结”不同：冻结会保留 RAM，密度仍受第 11 节的内存上限约束；停止计算才能把闲置沙箱变成磁盘状态。

### 12.2 文件状态载体与恢复

| 方案 | 文件状态载体 | 闲置动作 | 恢复路径 | 恢复时间 | 适配度 |
|---|---|---|---|---|---|
| Docker（runc） | 容器可写层 / named volume / bind mount | `docker stop` | `docker start`（或重新 `run` 挂同一 volume） | 1.61 s（start）/ 2.46 s（run） | **高**（可信负载） |
| Firecracker | rootfs 块设备（ext4/XFS reflink） | 停止 VMM 进程 | 冷启动内核 + 挂同一 rootfs | 1.10 s | **高** |
| Cloud Hypervisor | 磁盘镜像 / rootfs | 停止 VMM 进程 | 冷启动 + 挂同一磁盘 | 1.07 s | **高** |
| QEMU microvm | 磁盘镜像 / rootfs | 停止 QEMU 进程 | 冷启动 + 挂同一磁盘 | 0.95 s | **高** |
| gVisor KVM | bundle rootfs / 用户目录 | 停止容器/Sentry | `docker start` 或原生 `runsc run` | 1.74 s / 0.077 s | **高/中** |
| smolvm | 镜像/rootfs | 停止 CLI 进程 | 重新 `machine run` | 1.47 s（含 CLI） | **中** |
| BoxLite | 磁盘 + 执行配置 | 停止 box | 重新 `run`（REST 路径可 checkpoint） | 3.94 s（含镜像准备） | **中/低** |
| Kata Containers | volume / rootfs | 停止 pod | 重新启动 pod | 取决于运行时/后端 | **中** |

### 12.3 为什么不用 commit / 快照做文件持久化

- **Docker commit**：1.05 s、8.3 MB，只保存镜像层，不保存运行态；每次暂停都 commit 会增加 I/O 和镜像层垃圾，且恢复仍要新容器启动。文件状态用 `docker stop` 的可写层或 volume 就够；commit 只用于制作模板。
- **Firecracker full snapshot**：2.22 s、513 MiB；它保存的是 RAM + 设备状态，适合毫秒级恢复运行中的会话，不适合作为“文件状态”载体。文件状态在 rootfs 块设备里，停止 VMM 即可保留。
- **gVisor checkpoint**：300 MiB 负载 0.39 s / 301 MiB；它保存 Sentry/进程状态，文件状态在 rootfs 里。只保留文件时，停止容器即可，不需要 checkpoint。
- **smolvm/BoxLite checkpoint**：前者受可移植镜像限制，后者是 REST-only 的磁盘 + 配置快照；高频暂停/恢复的收益不如直接停进程 + 保留 rootfs。

### 12.4 适配度结论

- **最适合高频分时复用**：Docker（可信负载、运维最简单）、Firecracker / Cloud Hypervisor / QEMU microvm（硬件隔离、冷启动约 1 s）、gVisor（用户态隔离、原生启动 77 ms）。
- **适合低频/本地场景**：smolvm（1.47 s、镜像导入约束）、BoxLite（3.94 s，CLI 镜像准备占大头）；Kata 适合已有 K8s + 每容器 VM 编排。
- **推荐策略**：
  - 共享只读基座 + 每沙箱可写层/reflink；闲置超时后停止计算，保留文件状态；下次请求冷启动。
  - 用 warm pool 只保留少量热沙箱覆盖延迟 SLA；冷沙箱放磁盘，不计 CPU/RAM。
  - 如果 SLA 要求毫秒级恢复，再对少量长会话启用 Firecracker snapshot / gVisor checkpoint；这时按第 7 节的快照内存成本单独做容量预算。
  - 对 OpenSandbox Fast Sandbox：现有 block rootfs + XFS reflink 已经适合“停 VMM、留 rootfs”的分时复用；`vmstate.snap` 用于 warm start，不用作文件持久化。

### 12.5 Agent 沙箱 + volume/PVC 的适用边界

如果 agent 只把沙箱当执行环境、进程可以重启，文件状态放在 volume/PVC，那么 **runc/gVisor + volume/PVC 往往比 Firecracker 更合适**：

- **密度与启动**：runc 固定开销 15 MiB、gVisor 57 MiB；gVisor 原生启动 0.077 s（runc 原生未单独测，Docker 路径 1.61 s start / 2.46 s run 包含 daemon）；FC 59.5 MiB、1.10 s。K8s 的 CRI 路径不会和 Docker CLI 完全一样；PVC 的 CSI attach/mount 时间要单独测，可能比引擎启动更贵。
- **存储形态**：Docker 用 named volume / bind mount；K8s 用 PVC（每沙箱一个 RWO，RWX 需要 NFS/CephFS 等）；gVisor 通过 gofer 挂载；FC/CLH 需要块设备作为 rootfs 或 virtio-fs，PVC 的块设备/文件系统语义更受限。
- **适用条件**：代码可信或在内网、隔离只到进程级；或能接受 gVisor 的 syscall 兼容性；PVC attach 延迟可接受；agent 能从文件恢复，不依赖进程内存、长连接或浏览器会话。
- **不适合**：多租户不可信代码、合规要求硬件隔离；PVC attach 成为启动瓶颈；agent 需要保留内存数据库、浏览器会话或长连接。
- **推荐形态**：
  - 可信内网 agent：runc + PVC/volume；空闲时删除 pod 或 `docker stop`，保留 PVC/volume。
  - 不可信 syscall：gVisor + PVC；K8s 用 `runsc` RuntimeClass。
  - 必须硬件隔离：FC/Kata + 块设备 PVC 或共享存储；空闲时停 VMM/pod，保留 PVC；冷启动约 1.1 s，snapshot 只用于 warm start。

## 十三、来源

- Firecracker kernel policy：<https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md>
- Firecracker rootfs/kernel setup：<https://github.com/firecracker-microvm/firecracker/blob/main/docs/rootfs-and-kernel-setup.md>
- Firecracker snapshot support：<https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md>
- Firecracker release v1.18.0：<https://github.com/firecracker-microvm/firecracker/releases/tag/v1.18.0>
- Cloud Hypervisor README：<https://github.com/cloud-hypervisor/cloud-hypervisor>
- Cloud Hypervisor snapshot/restore：<https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/snapshot_restore.md>
- Cloud Hypervisor release v54.1：<https://github.com/cloud-hypervisor/cloud-hypervisor/releases/tag/v54.1>
- QEMU microvm 文档：<https://github.com/qemu/qemu/blob/master/docs/system/i386/microvm.rst>
- crosvm README / snapshotting：<https://github.com/google/crosvm>、<https://github.com/google/crosvm/blob/main/docs/book/src/architecture/snapshotting.md>
- crosvm 运行要求：<https://github.com/google/crosvm/blob/main/docs/book/src/running_crosvm/requirements.md>
- libkrunfw（smolvm fork）：<https://github.com/smol-machines/libkrunfw>
- smolvm：<https://github.com/smol-machines/smolvm>
- BoxLite：<https://github.com/boxlite-ai/boxlite>
- BoxLite 原生 VMM / 自定义内核：<https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/native-vmm.md>、<https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/custom-kernel.md>
- BoxLite 内核锁：<https://github.com/boxlite-ai/boxlite/blob/main/src/vmm/boot/kernel.lock>
- Kata Containers 4.3.1 versions：<https://github.com/kata-containers/kata-containers/releases/tag/4.3.1>
- gVisor：<https://github.com/google/gvisor>；release-20261109.0：<https://github.com/google/gvisor/releases/tag/release-20261109.0>；checkpoint/restore：<https://github.com/google/gvisor/blob/master/g3doc/user_guide/checkpoint_restore.md>
- Docker commit：<https://docs.docker.com/reference/cli/docker/container/commit/>；Docker checkpoint：<https://docs.docker.com/reference/cli/docker/checkpoint/>；gVisor Docker 集成：<https://gvisor.dev/docs/user_guide/quick_start/docker/>
- microsandbox：<https://github.com/superradcompany/microsandbox>
- OpenSandbox Fast Sandbox Firecracker：`docs/architecture/fast-sandbox/firecracker.md`、`docs/architecture/fast-sandbox/templates.md`、`docs/architecture/fast-sandbox/performance.md`
