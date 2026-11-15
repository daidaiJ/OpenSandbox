---
name: opensandbox-sandbox-runtime-selection-minimal
description: 沙箱运行时选型的极简版，按 STE-zh 简明技术中文编写：短句、主动语态、一词一义，只保留结论、数据、选型和边界
type: project
---

# 沙箱运行时选型：极简版

> 2026-11-15 | 1 vCPU / 512 MiB | 测试值见[核心结论](opensandbox-sandbox-runtime-selection-core-findings.md)和[详细报告](opensandbox-microvm-kernel-and-sandbox-metrics-comparison.md)

## 结论

1. 只做执行环境的 agent 沙箱，适合 `runc` 或 gVisor。
2. agent 把文件状态保存在 `volume` 或持久卷声明（PVC）。进程可以重启。
3. 只有必须硬件隔离时，才选择 Firecracker 或 Cloud Hypervisor。
4. 微虚机进入 Kubernetes（K8s）时，要经过 Kata Containers（Kata）。Kata 链路更长。启动时间更慢。
5. Fast Sandbox 保持 Firecracker。原因是硬件隔离和客户机内核控制。

## 数据

gVisor 使用 Linux 内核虚拟机（KVM）平台。内存值使用按比例分摊的常驻内存（PSS）口径。

| 运行时 | 热启动时间 | 空闲 PSS | 300 MiB 后 PSS | 隔离 |
|---|---:|---:|---:|---|
| `runc` 1.2.2 | **0.048 s** | **0.95 MiB** | **300.7 MiB** | 共享内核 |
| Docker 27.3.1 | 1.61 s | 15.0 MiB | 306.7 MiB | 共享内核 |
| gVisor（KVM） | **0.077 s** | 57.0 MiB | 326.7 MiB | 用户态内核 |
| Firecracker 1.18 | 1.10 s | 59.5 MiB | 357.1 MiB | 硬件虚拟机 |
| Cloud Hypervisor 54.1 | 1.07 s | 73.7 MiB | 371.7 MiB | 硬件虚拟机 |
| QEMU 6.2 `microvm` | **0.95 s** | 122.0 MiB | 420.2 MiB | 硬件虚拟机 |

说明：

- `runc` 直接运行容器包。测试值不含 Docker、containerd 和 K8s。
- Docker 的启动时间来自 `docker start`。测试值含命令行界面（CLI）和守护进程。
- gVisor 的启动时间来自原生 `runsc`。Docker 路径的启动时间是 1.74 s。
- 核心结论文档列出控制组（cgroup）值。

## 选型

| 条件 | 选择 |
|---|---|
| 代码可信，需要文件持久化 | `runc` + `volume`/`PVC` |
| 系统调用不可信，不要求硬件隔离 | gVisor + `PVC` |
| 必须硬件隔离，且已使用 K8s | Kata |
| 必须硬件隔离，自行调度 | Firecracker 或 Cloud Hypervisor |
| 需要快照创建、设备热插拔或迁移 | Cloud Hypervisor |

## 做法

空闲时，任选一项执行：

1. 停止容器。
2. 删除 Pod。

保留 `volume`、`PVC` 或根文件系统（rootfs）。

不要用 `commit` 或内存快照保存文件状态。

必须硬件隔离时，使用 Kata 或 Firecracker。

## 边界

- 本轮没测 K8s 端到端。48 ms 不是 Pod 启动时间。
- 本轮没测 Kata。第 4 条结论来自链路分析。
- 本轮没测 PVC 的容器存储接口（CSI）连接和挂载。
- 测试环境是 Windows Subsystem for Linux 2（WSL2）嵌套 KVM。本报告的测试值不能直接用于裸金属。
