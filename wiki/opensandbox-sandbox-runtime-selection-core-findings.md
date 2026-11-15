---
name: opensandbox-sandbox-runtime-selection-core-findings
description: 从微虚机、Docker、gVisor 与裸 runc 实测中提炼的沙箱运行时选型核心结论：启动、内存、密度、分时复用、volume/PVC 与 K8s/Kata 链路边界
type: project
---

# 沙箱运行时选型：核心实测结论

> 2026-11-15 | WSL2 嵌套 KVM，1 vCPU / 512 MiB | 方法与原始数据见[详细报告](opensandbox-microvm-kernel-and-sandbox-metrics-comparison.md)

## 结论

1. **agent 沙箱只做执行环境、文件状态挂 volume/PVC 时，runc 或 gVisor 比微虚机更合适。** 裸 runc 热启动 48 ms、空闲约 1 MiB；gVisor 原生启动 77 ms、空闲 57 MiB；Firecracker 1.10 s、59.5 MiB。进程可以重启时，没必要为每次启动付 VM 的固定成本。
2. **只有必须硬件 VM 隔离时才选 Firecracker / Cloud Hypervisor。** 在这个约束内，FC 的密度和恢复最好；离开这个约束，Docker/gVisor 的每沙箱内存更低，**“高密度选 FC”不成立**。
3. **微虚机进 K8s 通常要包 Kata，链路更长。** K8s → containerd → shim-kata → VM/guest kernel → kata-agent → 容器，比 runc 多出 VM 创建、guest 内核启动和 agent RPC。本轮未实测 Kata，不给具体秒数；方向明确：比 K8s + runc 慢。
4. **分时复用按“停计算、留文件”设计。** 停容器/删 Pod 保留 volume/PVC，或停 VMM 保留 rootfs；不要用 commit 或 RAM 快照做文件持久化。
5. **OpenSandbox Fast Sandbox 保持 FC 的理由是硬件隔离和 guest 内核控制，不是密度。** 可信内网 agent 可用 runc，不可信 syscall 用 gVisor；两者都用 PVC/volume 保留文件。

## 核心数据

| 运行时 | 热启动 | 空闲内存（PSS / cgroup） | 300 MiB 后（PSS / cgroup） | 快照 / 恢复 | 隔离 |
|---|---:|---:|---:|---|---|
| 裸 runc 1.2.2 | **0.048 s**（create 0.05 + start 0.009） | **0.95 / 1.3 MiB** | **300.7 / 302.2 MiB** | 需外部 CRIU（未测） | 共享内核 |
| Docker 27.3.1 | 1.61 s start / 2.46 s run | 15.0 / 2.6 MiB | 306.7 / 301.8 MiB | commit 1.05 s（仅磁盘） | 共享内核 |
| gVisor KVM | **0.077 s** 原生 / 1.74 s Docker start | 57.0 / 11.1 MiB | 326.7 / 312.8 MiB | 0.39 s / 0.15 s | 用户态内核 |
| Firecracker 1.18 | **1.10 s** | 59.5 MiB | 357.1 MiB | 2.22 s / **0.019 s** | 硬件 VM |
| Cloud Hypervisor 54.1 | 1.07 s | 73.7 MiB | 371.7 MiB | 0.70 s / 0.013–0.37 s | 硬件 VM |
| QEMU 6.2 microvm | **0.95 s** | 122.0 MiB | 420.2 MiB | 未测 | 硬件 VM |

口径：微虚机启动到 guest `/init`，容器启动到命令完成或容器进入 running；PSS 是宿主进程树，cgroup 是容器 cgroup。Docker 的 15 MiB 里 14.1 MiB 是 containerd-shim，裸 runc 的 0.95 MiB 只是 init 进程本身。**这些边界不同，不能直接把 0.048 s 当成 K8s Pod 启动时间。**

## 怎么读

- **启动分三档。** 微虚机 0.95–1.10 s 同档；容器引擎本身 0.048–0.077 s；Docker CLI 的 1.61–2.46 s 是 daemon/containerd/shim 包装，不是 runc 的开销。
- **内存排序：裸 runc < Docker < gVisor ≈ Firecracker < Cloud Hypervisor < QEMU。** 300 MiB 负载后，所有方案都接近“300 MiB + 固定开销”，差距被摊薄。
- **密度取决于是否要求硬件隔离。** 64 vCPU / 64 GiB / 4:1 超卖时：Docker 213、gVisor 200、FC 183、CLH 176、QEMU 155；1:1 的 64 vCPU 节点上全部上限 64，CPU 先撞顶。
- **恢复延迟和快照成本是两件事。** FC 恢复 19 ms 但创建要 2.22 s；CLH 的 ondemand/COW 恢复 13–15 ms 是把缺页推到首次访问；gVisor 300 MiB checkpoint 0.39 s、恢复 0.15 s。

## 选型

| 场景 | 选择 | 理由 |
|---|---|---|
| 可信内网 agent，文件持久化 | **runc + volume/PVC** | 48 ms、约 1 MiB，链路最短；空闲删 Pod/停容器，保留卷 |
| 不可信 syscall，不要求硬件隔离 | **gVisor + PVC** | 用户态内核，原生 77 ms，57 MiB；K8s 用 RuntimeClass |
| 必须硬件隔离，已在 K8s | **Kata（FC/CLH 后端）** | 集成成熟；接受 VM + agent 的额外链路成本 |
| 必须硬件隔离，自建调度 | **Firecracker / Cloud Hypervisor** | 启动 0.95–1.10 s、恢复 13–19 ms；FC 密度更好，CLH 快照/设备更强 |
| 快照创建、PCI、迁移优先 | **Cloud Hypervisor** | 0.70 s 创建；PCI/ACPI/热插拔/vhost-user |
| 本地嵌入、跨 macOS/Windows | **smolvm / BoxLite** | 单进程、无 daemon；代价是 118–136 MiB 固定开销和内核随 libkrunfw 走 |

## 边界

- **未测 K8s 端到端。** kubelet、CNI、pause 容器、CRI 调用的开销不在上面的数字里；裸 runc 是引擎下限，不是 Pod 启动时间。
- **未测 Kata。** 结论来自运行时链路分析，不是本轮实测；Kata 的 VM 启动、guest 内核和 agent 握手会叠加到容器启动上。
- **未测 PVC 的 CSI attach/mount。** 对块设备 PVC，attach/mount 可能比引擎启动更贵，必须单独计量。
- **WSL2 嵌套 KVM 的绝对值不能直接搬到裸金属。** 只看相对差异和量级；跨机器比较要固定缓存状态和镜像。
- **快照恢复的 13–19 ms 不是全量恢复。** ondemand/COW 把缺页成本推迟到首次访问；首次访问延迟要单独测。

## 复现裸 runc

```bash
mkdir -p /tmp/runc-demo/rootfs && cd /tmp/runc-demo
tar -xzf alpine-minirootfs-*.tar.gz -C rootfs
runc spec
# 改 config.json：process.args=["/bin/sleep","300"]、root.path="rootfs"、
# linux.cgroupsPath="/runc-demo/idle"、resources.memory.limit 设为 512 MiB
time runc run -d demo
cat /sys/fs/cgroup/runc-demo/idle/memory.current
runc delete -f demo
```
