# 沙箱供应商方案盘点：隔离路线、持久化保证级别、成本与密度上限

> 数据截点：2026-11-15。价格与能力来自 [orble.tech/sandboxes](https://orble.tech/sandboxes)（页面注明核对日期 2026-11-14）
> 与 [computesdk.com/discover](https://www.computesdk.com/discover)（公开压测，最近一次 2026-11-13）。
> 两家都是第三方汇总，价格由厂商定价页归一化，能力多为厂商自述；本文把所有关键数字标注了口径。

## 结论

1. **主流路线是“microVM 执行单元 + 预热池/快照恢复 + 分层持久化 + 无状态控制面”**。orble 的 705 家里 262 家标注 VM 隔离、144 家容器、19 家 gVisor、13 家 WebAssembly；ComputeSDK 排名靠前的 Isorun、Miosa、Arker、Blaxel、Daytona、E2B 都是 VM/microVM 或 VM 快照路线。
2. **在 2 vCPU / 4 GiB 这个主流规格上，隔离路线不决定密度上限**：一台 128 vCPU / 512 GiB 节点按 1:1 CPU 配额只能放 64 个，按内存能放 122 个，虚拟化开销只占 1%–2%。K8s 的 110 Pod/节点上限**只在规格同时低于约 1.16 vCPU 和 4.65 GiB 时才是卡点**；超过任一阈值就回到 CPU/内存约束，此时提高分时复用率比继续压密度更划算。
3. **成本上限由空闲策略和快照频率决定，不由隔离技术决定**。2c/4G 托管价中位数 $0.132/h；自建满配成本约 $0.01–0.02/h。暂停时把内存留在 RAM 里，每小时成本约为写入对象存储的 20–100 倍；但每轮对话都做全量内存快照，写入量在万级并发下不可行，必须走 diff 或仅在 idle 时快照。
4. **持久化要按“保证级别”分层，而不是笼统说支持快照**。PVC 只保证目录文件；镜像快照保证整个文件系统；CRIU/gVisor checkpoint 保证进程现场但绑定内核与 CPU 特性；microVM 快照保证内存 + vCPU 寄存器 + 设备状态且可跨主机；整机/桌面快照才带 GPU 与外设。级别越高，可移植性越差、存储与恢复成本越高。
5. **对 OpenSandbox**：池化短任务保持 P0/P1 最划算；现有 OCI 镜像 pause/resume 是 P2，实验性的 QEMU VMState 是 P4；普通 K8s 集群缺 KVM，microVM 路线要先解决裸金属或嵌套虚拟化，否则应把 gVisor/Kata 作为可选 RuntimeClass。

---

## 1. 两个目录的口径与样本

### 1.1 orble：价格与隔离方式的全景表

- 收录 **705 家**“卖沙箱或云电脑给 AI agent”的公司，按 9 类划分：Core 213、Runtime/SDK 141、Local 116、Platform feature 89、Browser infra 49、Computer-use desktop 43、Unified API 32、Dev environment 19、GPU 3。
- 能把价格归一化到 **2 vCPU / 4 GiB** 的只有 **142 家**（很多厂商只卖固定规格或按月套餐）。这 142 家的每小时价格分布：

| 分位 | p10 | p25 | 中位数 | p75 | p90 | 最高 |
|---|---|---|---|---|---|---|
| $/h @2c/4G | 0.018 | 0.054 | **0.132** | 0.171 | 0.252 | 1.500 |

- 隔离方式标注（可多类目重复，故总数不等于 705）：**VM 262、Container 144、Process 26、gVisor 19、WebAssembly 13、V8 isolate 3、Browser 27、未标注 211**。
- 按隔离方式分组的 2c/4G 价格中位数（样本少，仅作量级参考）：VM $0.133（n=101）、gVisor $0.106（n=8）、Container $0.153（n=12）、未标注 $0.130（n=19）。
- 空闲策略：**280 家**在暂停/停止时不计计算费（含按月套餐），**46 家**明确空闲仍按运行计费，**244 家**部分收费或规则复杂，**135 家**未说明；**104 家**提到保留内存的暂停/挂起/休眠。
- 页面把“Since”也列出来了：**443 家是 2026 年才出现**。这个市场仍在快速涌入，价格与能力半年就会变一轮。

### 1.2 ComputeSDK：可复现的公开压测

- Discover 页收录 **39 家**沙箱供应商，其中 32 家进入对比，累计 **490 组**两两对比、**44 个**沙箱 benchmark 结果。
- 关键指标：Burst TTI（并发启动到可交互）、DAX（clone → install → typecheck 的开发闭环）、Filesystem Snapshot & Restore、OCI Boot TTI、Sandbox OS Capabilities。
- **端到端 TTI 与“125 ms 启动”不是一回事**。2026-11-13 的 Burst TTI 中位数：Isorun **108 ms**、Daytona **627 ms**、E2B **1,068 ms**（p95 1,348 ms）、Cloudflare **3,003 ms**。这说明预热池/快照恢复能把 TTI 压到百毫秒级，而冷启动容器/整机仍在秒级。
- **文件系统快照能力并不普及**：Filesystem Snapshot & Restore 一项 31 家参评，**10 家为 0 分**（未测到或未支持）。这直接印证了“支持快照”在市场上仍是差异化能力，而不是基线。

### 1.3 口径差异与局限

- orble 的价格是“能归一化就归一化”，固定规格、按月套餐、按请求计费的厂商会被标注为不可比；个别低价行（如 $0.006/h）对应的是最小规格或促销，不能当作 2c/4G 市场价。
- ComputeSDK 的压测是第三方执行，但配置、区域、镜像、并发曲线由各厂商提供或默认，跨厂商只应比较数量级，不应比较小数点。
- 两家的“沙箱”定义都偏宽：既包括代码执行沙箱，也包括浏览器沙箱、云电脑、本地运行时。下文的路线归纳按隔离边界重新分组。

---

## 2. 六条隔离路线

| 路线 | 隔离边界 | 单实例开销 | 冷启动 | 兼容性 | 代表厂商 | 2c/4G 价格带 |
|---|---|---|---|---|---|---|
| R1 共享内核容器（runc + namespace/seccomp） | 进程 | 10–50 MiB（shim、pause、页缓存） | 50–800 ms | 完整 Linux，无需 KVM | Beam、Apify、Railway、多数 K8s 平台 | $0.05–0.30 |
| R2 用户态内核（gVisor） | 进程 + syscall 拦截 | 30–80 MiB（Sentry + 应用） | 100–600 ms（快照恢复可到百 ms） | 大多数 Linux 应用；syscall 密集场景变慢 | Modal、Google Cloud Run/GKE Sandbox、Agent37、Brimble、Chalk | $0.06–0.25 |
| R3 microVM（Firecracker 类） | 硬件虚拟化 | **<5 MiB VMM** + 客户机内核/用户态 15–40 MiB | **<125 ms** 到 guest init；端到端 100–1,000 ms | 需 KVM；无 GPU 直通；需自建网络/存储 | E2B、Daytona、Morph、Blaxel、Northflank、Tensorlake、Runloop、Microsandbox | $0.07–0.34 |
| R4 K8s 内 microVM（Kata + QEMU/Cloud Hypervisor） | 硬件虚拟化 + Pod | 30–80 MiB（QEMU 设备模型更重） | 300 ms–2 s | K8s 原生，RuntimeClass 切换；需嵌套虚拟化或裸金属 | Kata、KubeVirt、OpenSandbox 可选路径 | 自建为主 |
| R5 整机/云电脑（QEMU/KVM、桌面） | 整机 | 100–300 MiB + 镜像 | 1–10 s | 完整桌面、GPU/外设、Windows/macOS | Agent Computer、CoreWeave、Alibaba AgentBay、ArcBox | $0.04–1.50 |
| R6 WASM / V8 isolate | 语言运行时 | 1–10 MiB | **<10 ms** | 仅支持编译到 WASM 的语言与系统调用子集 | Cloudflare Workers、Akamai Agent Sandbox、Upstash、AgentRunBox | 多为按请求，归一化样本少 |

### 2.1 R1 共享内核容器

密度最好、启动最快、运维最成熟，代价是隔离边界就是宿主内核。它适合“可信代码 + 多租户靠业务层隔离”的内部平台，不适合直接执行用户上传的任意代码。orble 里 144 家标注 Container，其中大量是 K8s 封装或 CI 型产品。

### 2.2 R2 gVisor

Sentry 用 Go 实现了一个用户态内核，syscall 在进入宿主前被拦截。它不需要 KVM，因此能在普通 K8s 节点上跑，这是它相对 microVM 的最大工程优势。代价是 syscall 密集负载（编译、包管理、大量小文件 IO）会明显变慢，实际 CPU 密度取决于负载类型，而不是内存开销。gVisor 自带 `runsc checkpoint/restore`，可以做到进程级快照，但网络连接、CPU 特性、GPU 都有边界（见 §3）。

### 2.3 R3 Firecracker 类 microVM

Firecracker 官方规格：1 vCPU/128 MiB 配置下 VMM 内存开销 **≤5 MiB**、从 `InstanceStart` 到 guest `/sbin/init` **≤125 ms**、单机创建速率 **150 个/秒**。它是当前“不可信代码 + 高密度”事实上的默认选择。限制同样明确：需要 KVM（云上要嵌套虚拟化）、无 GPU 直通、设备模型只有 virtio 的最小集合、网络与存储编排要自己做。

### 2.4 R4 K8s 内 microVM

Kata 把 microVM 包装成 OCI 运行时，用 RuntimeClass 接入 K8s，保留 Pod 语义和 CNI/CSI。它解决了“microVM 怎么进 K8s”，但每层都加开销：QEMU 设备模型、guest 内核、RuntimeClass 切换、镜像分发。Kata + Cloud Hypervisor 比 Kata + QEMU 轻，但仍比裸 Firecracker 重。OpenSandbox 的 `qemu-vmstate` 走的是另一条路：QEMU 跑在普通 runc 容器里，用 QMP 做进程级暂停，不依赖 RuntimeClass。

### 2.5 R5 整机/云电脑

卖的是“一台能开浏览器、能装驱动、能跑桌面的机器”，不是代码执行槽。启动秒级、镜像 GB 级、单实例 8–16 GiB 起，密度天然低一个数量级。它的价值在 GUI/GPU/Windows/macOS 兼容性，不在密度。orble 单列了 43 家 Computer-use desktop，其中只有 4 家有归一化价，区间 $0.04–1.14/h。

### 2.6 R6 WASM / V8 isolate

冷启动毫秒级、内存 1–10 MiB，理论密度比 microVM 高两个数量级。边界是能力：Python C 扩展、Node 原生模块、JVM、shell 工具、编译器这类企业内网常见需求，WASM 要么不支持，要么需要维护双路径。它适合“稳定、高频、能力受限的工具调用”，不适合作为主执行路径。Cloudflare 容器型 sandbox 的 3,003 ms TTI 也提醒：毫秒级只覆盖执行本身，镜像、依赖、网络这些外围准备仍可能是秒级。

---

## 3. 持久化保证级别：P0–P5

这是选型时最容易含糊的一点。“支持快照”可能指六种完全不同的东西。按“捕获了哪些状态、能在哪里恢复”分六级：

| 级别 | 名称 | 文件 | 全文件系统 | 进程/线程 | 内存 | CPU 寄存器/设备 | 恢复位置 | 一致性 | 存储放大 | 典型恢复时延 |
|---|---|---|---|---|---|---|---|---|---|---|
| **P0** | 无持久化 | — | — | — | — | — | — | — | 0 | 重建 |
| **P1** | 目录/卷（PVC、对象前缀） | ✅ 指定目录 | ❌ | ❌ | ❌ | ❌ | 任意节点（同 FS/驱动） | 应用级（需 fsync/静默） | 1× 数据量 | 百 ms 级挂载 |
| **P2** | 镜像/文件系统快照 | ✅ | ✅ | ❌ | ❌ | ❌ | 任意节点（同架构） | 崩溃一致（除非 freeze） | 全盘或增量 | 秒级（大镜像） |
| **P3** | CRIU / gVisor checkpoint | ✅ | ✅（含 rootfs 状态） | ✅ | ✅ | ✅ 用户态寄存器；内核态由运行时重建 | 同内核版本、同 CPU 特性、同容器运行时 | 需 stop-the-world | 内存 0.5–1× + 磁盘 | 数十 ms–数 s |
| **P4** | microVM 快照 | ✅ | ✅ | ✅ | ✅ | ✅ vCPU 寄存器、virtio 设备状态 | 同架构、兼容 CPU 模板；可跨主机 | 需毫秒级暂停 | 内存 1×（diff 可增量） | 5–200 ms（页按需加载） |
| **P5** | 整机/桌面快照 | ✅ | ✅ | ✅ | ✅ | ✅ + GPU/外设（厂商相关） | 同机型/固件；GPU 需专用 checkpoint | 需停顿 | 内存 + 显存 + 磁盘 | 秒级–数十秒 |

### 3.1 每一级到底保证了什么

**P1 目录/卷：只保证“数据”，不保证“现场”。**
PVC、hostPath、对象存储前缀都属于这一级。容器可以重建、换节点，目录里的文件还在；但进程、内存、打开的文件描述符、网络连接全部丢失。CSI 卷快照是卷级、崩溃一致的，不等于应用一致；RWX 卷的子目录只提供路径隔离，不是多租户安全边界。OpenSandbox 的 Volume API（OSEP-0003）就是这一级。

**P2 镜像/文件系统快照：保证“整块盘”，不保证“进程”。**
把容器 rootfs（或 VM 磁盘）打成 OCI 镜像/快照，恢复时起一个新容器。它适合“重建胜过恢复”的任务型负载：环境、依赖、生成的文件都在，重启后重新跑进程即可。限制是：未 flush 的页缓存会丢，数据库/编辑器这类有内存状态的应用会丢最后一段工作；镜像里可能残留密钥。OpenSandbox 的 pause/resume 是这一级——把 rootfs 提交成 OCI 镜像后释放 Pod。

**P3 CRIU / gVisor checkpoint：保证“进程现场”，但绑定内核。**
CRIU 保存进程树、内存页、文件描述符、信号、定时器，恢复时在内核里重建 task 结构。它不保存内核态对象本身，所以要求恢复端内核版本、CPU 特性、cgroup/namespace 布局兼容；打开的文件必须仍然存在；RDMA、GPU 需要额外支持（NVIDIA 的 CUDA checkpoint 是独立组件）。gVisor 的 checkpoint 是 runsc 自己的实现，限制类似：host 网络下 socket 不能保存、监听 backlog 会丢、时钟按 suspend/resume 语义走、CPU 特性不匹配会失败。它适合“同一集群、同一内核池”内的热恢复，不适合跨代际迁移。

**P4 microVM 快照：保证“整机现场”，可跨主机。**
Firecracker 快照包含 guest 内存文件和 microVM 状态文件（vCPU 寄存器、设备状态）。恢复时内存按需从快照文件缺页加载并 COW 到匿名内存，所以恢复可以做到毫秒级，代价是首次访问的缺页延迟。约束：磁盘后端、TAP 网卡、vsock socket 必须在新进程里以相同相对路径可见（或显式 override）；网络连接不保证保留，vsock 会 reset；arm64 的 GICv2/GICv3 不能互恢复；guest 时钟会停在快照时刻，需要 `clock_realtime` 或 guest 内校时；快照文件必须不可变。E2B 的“内存 + 磁盘快照 + userfaultfd 懒加载”就是这一级。

**P5 整机/桌面快照：保证“设备现场”。**
在 P4 之上再加 GPU、USB、音频、显示等设备状态。GPU 快照目前依赖厂商（NVIDIA CUDA checkpoint、ROCm），且 arm64 支持不全；跨机型恢复基本不成立，只能在同型号池内做。云电脑/桌面厂商卖的就是这一级。

### 3.2 级别与厂商的对应关系

| 级别 | 代表实现/厂商 | 说明 |
|---|---|---|
| P1 | OpenSandbox Volume API、Cloudflare DirectoryBackup、Archil S3-backed disk、Railway/Fly volumes、Northflank volumes | 目录/卷外置，容器重建后重新挂载 |
| P2 | Cloudflare Container snapshot、Alibaba 深度休眠（仅磁盘）、Docker commit、OpenSandbox pause/resume、E2B 文件系统快照 | 整盘打包，进程重启 |
| P3 | Modal（gVisor + checkpoint）、gVisor `runsc checkpoint`、CRIU（Docker/K8s container checkpointing） | 进程现场，绑定内核池 |
| P4 | E2B、Morph、Fly Machines suspend/resume、AWS Lambda MicroVMs、Azure Container Apps sandboxes（memory 模式）、Baseten standby、Blaxel、AgentSphere、Anona、Isorun、OpenSandbox QEMU VMState（实验） | 内存 + vCPU 寄存器 + 设备，可跨主机 |
| P5 | Agent Computer、CoreWeave、Alibaba AgentBay desktop、ArcBox、macOS/Windows 云电脑 | 含 GPU/外设，同机型池 |

### 3.3 选型含义

- **会话状态与执行现场要分开设计**。文件/产物放 P1，执行现场按需 P3/P4；不要用 P4 去替代对象存储，也不要用 P1 去承诺“恢复后进程还在”。
- **P3 是“同内核池”能力，P4 是“跨节点”能力**。如果集群内核版本混杂、CPU 型号不一，P3 的失败率会很高；microVM 快照对异构的容忍度更好，但仍有 CPU 模板约束。
- **级别越高，快照里越可能含密钥**。内存快照会包含解密后的凭证、token、会话密钥；必须加密、按租户隔离、设置 TTL，并避免跨租户复用同一快照。
- **P2 的一致性要说清楚**。没有 freeze/thaw 的镜像快照是崩溃一致的；数据库、SQLite WAL、包管理器锁文件都可能需要恢复时修复。

---

## 4. 成本模型

### 4.1 三个成本项

1. **运行成本**：vCPU·h + GiB·h，按秒或按分钟计费。
2. **空闲/暂停成本**：三种策略——销毁（0）、内存驻留（按 RAM 计费）、落盘（按存储计费，恢复要读回）。
3. **快照成本**：存储容量 + 写入请求 + 恢复读取 + 恢复时的 CPU/网络占用。

### 4.2 参考价格

| 口径 | 2c/4G 每小时 | 说明 |
|---|---|---|
| 自建 K8s（128c/512G 节点，$0.6–1.5/h） | **$0.009–0.023** | 64 个槽位满配；按 50% 利用率翻倍 |
| 公有云按需裸 VM（2c/4G） | **$0.07–0.10** | 不含控制面、镜像、存储、网络 |
| 托管沙箱市场中位数 | **$0.132** | orble 142 家归一化样本 |
| 托管沙箱 p25–p75 | **$0.054–0.171** | 同上 |
| 高端/桌面/GPU 型 | **$0.25–1.50** | 规格与 SLA 不同，不可直接比 |

托管价约为自建满配成本的 **6–15 倍**，这部分买的是控制面、空闲容量、快照、网络、合规与运维。自建的真实成本还要加上：镜像仓库、对象存储、CNI/IP、监控、值班。按 3 年摊销，企业内部 128c/512G 节点落在 $0.5–1.0/h 是常见区间，对应 2c/4G 槽位 $0.008–0.016/h。

### 4.3 空闲策略的单位经济学

以 4 GiB 内存为例：

- **内存驻留**：按 $0.005–0.012/GiB·h 计，4 GiB 是 **$0.02–0.048/h**；即使按暂停折扣 5 折，也在 $0.01–0.024/h。
- **落盘快照**：按 $0.05–0.20/GB·月 计，4 GiB 是 **$0.0003–0.0011/h**。
- 两者差 **20–100 倍**（典型 50 倍上下）。所以“暂停时保留内存”是延迟优化，不是成本优化；它的合理窗口是分钟到小时级，超过就应落盘或销毁。
- 反过来，**恢复成本**不能忽略：从对象存储读 4 GiB，按 1 GB/s 需要 4 s；1,000 个并发恢复就是 4 TB 读取。恢复风暴会同时打满对象存储带宽和节点网络。

### 4.4 快照频率才是规模化的成本杀手

单看容量，4 GiB 快照每月 $0.2–0.8，不贵。真正贵的是**写入频率**：

- 假设 1 万个活跃会话、每分钟一次全量内存快照、每次 4 GiB：每小时写入 **2.4 PB**。任何对象存储都扛不住，成本也不是容量单价能覆盖的。
- 现实做法只有三种：**只在 idle/会话结束时快照**；**用 diff 快照**（Firecracker 的 dirty page tracking、E2B 的内存 diff）；**用 SSD 热层 + 后台批量下沉**（Rivet 的做法，S3 不在写路径上）。
- 这也解释了为什么“每沙箱一个 bucket/目录 + 高频小对象写”是请求成本反模式：之前 celld vs OpenOrange 的 benchmark 里，1 万并发 agent 的 S3 请求成本是 $9,007/月 vs $259/月（34.8×），而且随并发线性增长。

### 4.5 成本上限的判断

- **单沙箱小时成本的下限**由节点摊销价 ÷ 满配槽位数决定，当前硬件约 **$0.008–0.02/h**（2c/4G）。
- **可接受上限**由业务决定：如果 agent 单次任务只跑 30–120 s，按小时价看是 $0.001–0.01/任务；真正的成本大头是**空闲时间**和**镜像/依赖安装**（ComputeSDK 的 DAX 跨厂商区间是 32–193 s，其中 clone + install 占 80% 以上）。
- 因此优化顺序应是：**缩短空闲、复用预热环境、减少冷启动 IO**，最后才是压虚拟化开销。

---

## 5. 密度上限

### 5.1 参考节点与两个规格

参考节点：**128 vCPU / 512 GiB / 110 Pod（K8s 默认 max-pods）/ 25 Gbps / NVMe**。

| 规格 | 按 CPU（1:1） | 按内存 | K8s max-pods | 实际约束 |
|---|---|---|---|---|
| 2 vCPU / 4 GiB | 64 | 122 | 110 | **CPU 配额**（64）；2× 超卖后变成 Pod 限制（110 vs 128） |
| 0.5 vCPU / 512 MiB | 256 | ~980 | 110 | **max-pods**（110）；非 K8s 编排受 CPU 配额限制（约 256–500） |
| 0.25 vCPU / 256 MiB | 512 | ~1,900 | 110 | **max-pods**（110）；非 K8s 编排受 CPU 配额限制（约 512） |

### 5.2 隔离路线的真实开销

| 路线 | 每实例额外内存 | 最小可用规格 | 每个 vCPU 的额外 CPU | 2c/4G 槽位 | 0.5c/512MiB 槽位（非 K8s） |
|---|---|---|---|---|---|
| R1 容器 | 10–50 MiB | 32–64 MiB | ~0 | 64–122 | 256–500 |
| R2 gVisor | 30–80 MiB | 64–128 MiB | syscall 密集场景 1.5–3× | 60–120 | 180–450 |
| R3 Firecracker | 5 MiB VMM + 15–40 MiB guest | 128–256 MiB | 设备模型 3–10% | 64–122 | 230–480 |
| R4 Kata/QEMU | 30–80 MiB | 256 MiB–1 GiB | 5–15% | 60–120 | 200–450 |
| R5 整机 | 100–300 MiB | 1–2 GiB | 5–15% | 60–120 | 不适用 |
| R6 WASM | 1–10 MiB | 8–32 MiB | 计算密集 1.5–3× | 64–128 | 250–500（降到 0.05 vCPU 可到数千） |

关键结论：

- **2c/4G 规格下，六条路线的槽位数几乎一样**（64–122）。差异在启动时间、隔离强度、运维复杂度，不在密度。
- **512 MiB 以下，开销占比才开始显著**：30–80 MiB 的固定开销是 6%–16%；K8s 的 110 Pod 上限则直接把密度压到内存容量的 1/8–1/9（110 × 0.5 vCPU = 55 vCPU、55 GiB）。
- **固定 vCPU 时所有路线都撞 CPU 配额**。WASM 的密度优势只有在同时把单实例 vCPU 降到 0.05–0.1 时才成立；如果仍按 0.5 vCPU 卖，它和容器的槽位数没有区别。
- **CPU 税比内存税更值得关注**：gVisor 在 syscall 密集负载上有效 CPU 只有 1/1.5–1/3；microVM 的设备模型在 0.25 vCPU 小规格上可能占掉 0.02–0.05 核；WASM 在计算密集负载上慢 1.5–3×。这些都会直接乘到“每 vCPU 能卖多少”上。
- **其他硬约束**：每沙箱一个 IP 会先撞 CIDR（一个 /16 只有 65k 地址）；每沙箱一个 Pod 会撞 max-pods；每沙箱一个镜像会撞镜像缓存与拉取带宽；每沙箱一个 PVC 会撞 CSI 的 attach 上限。
- **厂商宣称的密度上限**：阿里云 Agent Sandbox 宣称每分钟创建 10 万个、百万级并发；AWS Lambda MicroVMs 的公开约束是每个父 vCPU 最多 5 个、单实例最多 896 个、每个至少 256 MiB。前者是创建速率，后者是稳态驻留，两个数字不能混用。

### 5.3 持久化对密度的“税”

- **内存驻留暂停**：暂停比例 p 直接吃掉 p 的容量。30% 会话处于暂停驻留，就要多备 43% 的机器才能维持同样的峰值并发。
- **落盘暂停**：容量不占，但恢复时要占 CPU、网络和对象存储带宽；恢复风暴是容量规划的一部分，不是免费的。
- **P2 镜像快照**：存储便宜，但每次 pause 都要 push 一个镜像层；镜像仓库的写入带宽和 GC 会成为新的瓶颈。
- **P4 全量内存快照**：4 GiB × 并发数 的写入量；必须配 diff 或 SSD 热层，否则网络先于存储被打满。

### 5.4 编排限制与资源限制：交叉点在哪

把节点资源和 Pod 上限写成约束：

```text
C = 可分配 vCPU（128）
M = 可分配内存 GiB（512）
N = kubelet max-pods（110）
c, m = 单沙箱规格（vCPU, GiB）
r, q = CPU / 内存超卖比

并发槽位 K = min(N, r·C/c, q·M/m)
```

Pod 数成为卡点的条件：

```text
N < r·C/c  且  N < q·M/m
⇔ c < r·C/N  且  m < q·M/N
```

代入 C=128、M=512、N=110、r=q=1：

```text
c < 1.16 vCPU  且  m < 4.65 GiB
```

**规格一旦超过 1.16 vCPU 或 4.65 GiB，卡点必然是 CPU 或内存，Pod 数不再起作用。** 两个条件要同时满足：例如 2c/8G 虽然 vCPU 不高，但 4 GiB/vCPU 的内存比会让内存先撞墙；8c/4G 则是 CPU 先撞墙。

| 规格 | CPU 槽位 | 内存槽位 | Pod 槽位 | K | 卡点 | 相对资源上限的损失 |
|---|---|---|---|---|---|---|
| 8c/16G | 16 | 32 | 110 | 16 | CPU | 0 |
| 4c/8G | 32 | 64 | 110 | 32 | CPU | 0 |
| 2c/4G | 64 | 128 | 110 | 64 | CPU | 0 |
| 1c/2G | 128 | 256 | 110 | 110 | Pod | 14% |
| 0.5c/1G | 256 | 512 | 110 | 110 | Pod | 57% |
| 0.25c/512M | 512 | 1024 | 110 | 110 | Pod | 79% |

**“Pod 是卡点”不等于“值得为它改架构”。** 1c/2G 的损失是 110/128 = 14%，在容量规划误差范围内；0.5c/1G 损失 57%、0.25c/512M 损失 79%，才是实质性瓶颈。把 20% 作为分界线：损失低于 20% 先调 max-pods 或忽略，高于 40% 才考虑改编排方式。

超卖会把这个边界推到更大的规格上：

| 规格 | r=1 | r=2 | r=4 |
|---|---|---|---|
| 8c/16G | CPU 16 | CPU 32 | CPU 64 |
| 4c/8G | CPU 32 | CPU 64 | Pod 110（14%） |
| 2c/4G | CPU 64 | Pod 110（14%） | Pod 110（57%） |
| 1c/2G | Pod 110（14%） | Pod 110（57%） | Pod 110（79%） |
| 0.5c/1G | Pod 110（57%） | Pod 110（79%） | Pod 110（89%） |

所以“要不要 CPU 超卖”和“要不要处理 Pod 限制”是同一个决策：超卖 2 倍会把 2c/4G 从资源受限变成 Pod 受限，超卖 4 倍会把 4c/8G 也推过去。

**节点越大，Pod 限制越早出现。** max-pods 不随节点规模增长，C/N 会变大：128c 节点的阈值是 1.16 vCPU，256c/1TiB 是 2.33 vCPU（2c/4G 开始受 Pod 限制），512c 是 4.65 vCPU（4c/8G 开始受 Pod 限制）。反过来，32c/128G 小节点的阈值只有 0.29 vCPU，几乎所有实用规格都是资源受限。这条结论对扩容方向有直接影响：**加机器会把瓶颈从资源推向编排，除非同步调大 max-pods。**

把 1c/2G 和 2c/2G 两个常见规格代入（N=110、r=q=1）：

| 节点 | 1c/2G 槽位 | 1c/2G 卡点 | 2c/2G 槽位 | 2c/2G 卡点 |
|---|---|---|---|---|
| 32c/64G | 32 | CPU/内存 | 16 | CPU |
| 64c/128G | 64 | CPU/内存 | 32 | CPU |
| 96c/192G | 96 | CPU/内存 | 48 | CPU |
| 128c/256G | 110 | Pod（14%） | 64 | CPU |
| 192c/384G | 110 | Pod（43%） | 96 | CPU |
| 256c/512G | 110 | Pod（57%） | 110 | Pod（14%） |
| 384c/768G | 110 | Pod（71%） | 110 | Pod（43%） |

- **1c/2G**：Pod 限制要求 `C > 110` 且 `M > 220 GiB`。128c/256G 起出现，但只损失 14%；**192c/384G 起损失 43%，才算实质瓶颈**；256c 以上损失 57%+。
- **2c/2G**：Pod 限制要求 `C > 220` 且 `M > 220 GiB`。128c 节点上 CPU 只允许 64 个，远低于 110；**要到 256c/512G 才开始受 Pod 限制（14%），384c/768G 起损失 43%**。
- 在 64c/128G、96c/192G 这类常用节点上，两个规格都是资源受限；卡点是 CPU，不是 Pod。
- 如果 CPU 超卖 r 倍，vCPU 门槛降为 `110r/c`；内存门槛 `M > 220 GiB` 不变。例如 r=2 的 128c/256G 节点：1c/2G 和 2c/2G 都会变成 Pod 受限（14%），因为 CPU 槽位分别到了 256 和 128。96c/192G 节点即使 r=2，内存仍先于 Pod 触顶（96 个）。

除 max-pods 外，还有几个可能更早撞上的编排限制：

- **CNI IP**：/24 只有 254 个地址；VPC ENI 模式常见 30–234 个 IP/节点；Overlay（Calico VXLAN、Cilium）可以解耦，但会加封装开销。max-pods 调到 250 以上时，IP 往往先成为新卡点。
- **CSI attach**：EBS 类卷每节点 25–39 个，**每沙箱一个 PVC 会在 25–39 就撞墙，早于 max-pods**。这也是池化模式只能挂共享 RWX 根目录 + 每沙箱 subPath 的原因。
- **镜像缓存与拉取带宽**：110 个 Pod × 2 GB 镜像 = 220 GB/节点的冷缓存；镜像分发会成为启动 TTI 的隐形上限。
- **cgroup/PID/kube-proxy**：1,000 Pod 以上时，cgroup 数量、kubelet QPS、iptables/IPVS 规则开始成为稳定性问题；eBPF 数据面可以缓解，但不会降低 Pod 数。

### 5.5 分时复用什么时候比压密度更合适

单位成本可以写成：

```text
成本/活跃沙箱·小时 = 节点小时价 / (K × U)
K = 并发槽位
U = 平均并发 / K（分时复用率）
```

K 和 U 是乘法关系：K 翻倍或 U 翻倍，成本都减半。区别是代价不同——提高 K 要改编排或隔离架构，提高 U 主要靠池化、排队和短 TTL。

Agent 负载的形状通常有利于分时复用：任务 30–120 s、会话空闲 5–30 min、峰值/平均比 3–10，池化模式的 U 常在 0.2–0.4。把 U 从 0.3 提到 0.6，成本直接减半，而且不动物理架构。

| 观察 | 优先动作 | 理由 |
|---|---|---|
| U < 0.5，任务 < 5 min | 池化 + 排队 + 短 TTL，提高 U | 成本线性下降，改动最小 |
| U > 0.6，规格 ≥ 1 vCPU | 加节点或 CPU 超卖 | 资源已接近打满，Pod 不是卡点 |
| U > 0.6，规格 ≤ 0.5 vCPU | 提 max-pods/IPAM → 多沙箱/Pod → 绕过 kubelet | Pod 限制造成 40%–80% 损失 |
| 会话 > 30 min 且稳定 | 密度架构（microVM/裸金属） | U 接近 1，分时没有空间 |

分时复用的边界也要说清楚：

- **CPU 可压缩，内存不可压缩**。CPU 超卖 2–4 倍、limits > requests 是安全的；内存超卖依赖 reclaim/swap/balloon，page cache 重的沙箱容易 OOM，p99 会先坏掉。
- **重置成本决定下限**。任务 60 s、重置 2 s，开销 3%；任务 10 s、重置 2 s，开销 20%。任务时长必须显著大于重置成本，分时复用才划算。
- **尾延迟和状态残留**。超卖会抬高 p99，需要为 SLO 留 headroom；重置必须清干净工作区、环境变量和凭证，P1 重置通常 0.5–2 s，P2 镜像重建是秒级。
- **长会话不可分时**。交互式 session 一旦持续几十分钟，U 接近 1，只能靠密度或更多节点。

用 $1/h 的节点算一笔账：

- 2c/4G、K=64、U=0.3：$0.052/活跃沙箱·小时；U=0.6 降到 $0.026。
- 0.5c/1G、K=110（Pod 限制）、U=0.3：$0.030；U=0.6 降到 $0.015，不需要改架构。
- 同样是 0.5c/1G，绕过 Pod 模型把 K 提到 256、U 仍为 0.3：$0.013。收益和“把 U 翻倍”相同，但工程成本高一个量级。

**结论：资源受限区（规格 ≥ 1.2 vCPU 或 ≥ 4.7 GiB）优先提 U；Pod 受限区（规格 ≤ 0.5 vCPU 且 ≤ 2 GiB）先提 U，再调 max-pods/IPAM，最后才考虑多沙箱/Pod 或绕过 kubelet。** 1c/2G 这种 14% 损失的边界规格，调 max-pods 的成本低就调，调不动就算了。

### 5.6 工业界怎么绕开编排限制

社区和供应商的做法可以归成五类，成本和收益依次上升：

| 做法 | 代表 | K8s 的角色 | 密度来源 | 代价 |
|---|---|---|---|---|
| A. 抬高上限 | GKE/EKS 调 max-pods、VPC CNI prefix、Calico/Cilium overlay | 全量 | 110 → 250/500 Pod | 配置与 CNI 改造；kubelet/QPS/iptables 压力 |
| B. 一个 Pod 装多个沙箱 | Agent Substrate、CubeSandbox、firecracker-containerd 类 | worker Pod 作为容量单元 | 单 Pod 数十到数百 | 失去 per-sandbox 调度语义；自建装箱、健康、驱逐 |
| C. 绕过 kubelet | E2B、Modal、Fly Machines、Vercel Sandbox、Cloudflare、AWS Lambda MicroVMs | 只做控制面 | 单机数百到数千 | 自建数据面、网络、存储、升级；工程成本最高 |
| D. 会话与执行槽解耦 | OpenSandbox Pool、E2B pause/resume、Modal warm pool | 全量 | 提高 U，降低峰值 Pod 数 | 需要池化、租约、TTL、重置 |
| E. 去掉 per-sandbox IP/PVC | 各家池化模式 | 全量 | 解除 IP 与 CSI attach 上限 | 共享 RWX + subPath、对象存储、vsock/Unix socket |

**A 抬高上限**是最便宜的，但只是把墙往后推：max-pods 从 110 调到 250，1c/2G 的 Pod 门槛从 110 vCPU 变成 250 vCPU；再往上，kubelet 的 Pod 生命周期、CNI IPAM、kube-proxy 规则、cgroup 数量都会成为新瓶颈。它适合把 14%–20% 的边界损失抹平，不适合解决 50%+ 的密度问题。

**B 一个 Pod 装多个沙箱**是目前“留在 K8s 内”最现实的工业做法。K8s 只调度 worker Pod，Pod 内由一个 supervisor 创建 microVM/容器，装箱、回收、健康检查由控制面自己做。Agent Substrate 用 worker Pod 提交容量、用 PG 行锁做严格预占；CubeSandbox 用 quota 超卖 + 并发闸门，把 worker Pod 当成容量池。两者都把“一沙箱一 Pod”换成了“一 Pod 多沙箱”，代价是 Pod 变成故障域、per-sandbox 的 K8s 隔离/配额/网络策略要重新实现。firecracker-containerd 这类项目提供了底层能力，但装箱和生命周期仍要自己做。

**C 绕过 kubelet**是头部供应商的默认选择：E2B 用 Firecracker + 自有调度，Modal 用 gVisor + 自有调度，Fly 用 Firecracker Machines，Vercel Sandbox 和 Cloudflare 也各自有数据面；AWS Lambda MicroVMs 更直接——每个 EC2 实例最多 896 个 microVM、每个父 vCPU 最多 5 个，完全按硬件容量而不是 Pod 数计量。K8s 在这些架构里通常只负责控制面（API、配额、元数据），数据面跑在裸金属或专用节点上。代价是自建网络、存储、镜像分发、升级和可观测性，只有规模足够大才摊得平。

**D 会话与执行槽解耦**和上面的 A/B/C 正交：沙箱 ID 稳定，执行槽可换节点、可复用、可回收；池化把峰值 Pod 数从“总用户数”降到“峰值并发数”。OpenSandbox 的 Pool + BatchSandbox 就是这一层；它不改变单节点 Pod 上限，但能把需要的节点数按 U 打折。

**E 去掉 per-sandbox IP/PVC** 解决的是比 max-pods 更早出现的墙：EBS 类卷每节点 25–39 个 attach，每沙箱一个 PVC 会在 25–39 就卡住；每沙箱一个 IP 会在 /24 的 254 个地址或 ENI 的 30–234 个 IP 上卡住。工业做法是共享 RWX 根目录 + 每沙箱 subPath、对象存储前缀、vsock/Unix socket 替代 Pod IP，以及 overlay CNI。OpenSandbox 池化模板只能挂共享根目录，正是这个约束的体现。

选型上可以按规格和节点规模对号入座：

| 场景 | 建议 |
|---|---|
| 1c/2G，≤128c 节点 | A/D 足够；Pod 损失 ≤14%，优先提 U |
| 1c/2G，≥192c 节点 | A（max-pods ≥200）或 B；否则损失 40%+ |
| 2c/2G，≤128c 节点 | 资源受限，D + CPU 超卖是主杠杆 |
| 2c/2G，≥256c 节点 | A 或 B；C 只在规模很大时划算 |
| 0.5c/512MiB 及以下 | B 或 C；A 只能缓解，不能解决 |

需要强调的是：**Kata/gVisor 的 RuntimeClass 不解决这个问题**。它们改变的是隔离边界，Pod 数仍然是一沙箱一 Pod；只有把多个沙箱装进一个 Pod，或者绕过 kubelet，才会改变编排上限。

### 5.7 Pod 数的非计算资源限制

节点能放多少 Pod，取以下全部限制的最小值。计算资源只是其中一层，而且经常不是最先撞上的那一层：

| 限制层 | 机制 | 典型值 | 什么时候先撞上 | 怎么观测 |
|---|---|---|---|---|
| kubelet max-pods | `--max-pods` 声明调度槽位 | 110；EKS 按 ENI 公式，≤30 vCPU 封顶 110、>30 vCPU 封顶 250；AKS 30/110/250 | 小规格 + 大节点 | `kubectl get node -o jsonpath='{.status.allocatable.pods}'` |
| Pod CIDR / IPAM | 每节点分到的 Pod 网段 | 每节点 /24 约 254 个；Calico 默认 /26 块 64 个，可多块；集群池 /16 | max-pods 调高后 | `calicoctl ipam show`、CNI 日志 |
| VPC ENI | ENI 数 × (每 ENI IP 数 − 1) + 2；prefix 模式每槽 /28（16 个） | m5.large 29、m5.xlarge 58、m5.4xlarge 234；prefix 后受 110/250 封顶 | 非 overlay 的云上 CNI | `kubectl get cninodes`、AWS `eni-max-pods.txt` |
| CSI attach | 每节点可挂载的块设备数 | EBS 约 25–39（7 代 baseline 32，裸金属 31，机型相关）；GCE PD 16–128；Azure Disk 8–64 | **每沙箱一个 PVC** | `kubectl describe pvc`、`lsblk`、CSI 指标 |
| conntrack | 连接跟踪表 | `nf_conntrack_max` 常为 65536 起，随内存调整 | 每沙箱大量出站连接、Service 转发 | `conntrack -C`、`sysctl net.netfilter.nf_conntrack_max` |
| iptables / IPVS | 规则数随 Pod × Service 增长 | 1,000 Pod × 1,000 Service 可达百万级规则 | 大量 Service/NetworkPolicy、非 IPVS/eBPF | `iptables-save \| wc -l`、kube-proxy 指标 |
| PID / 线程 | `pid_max`、cgroup `pids.max` | 32768（可调），每 Pod 多进程/JVM 消耗大 | 每沙箱多进程、JVM、编译任务 | `cat /proc/sys/kernel/pid_max`、`ps -eLf \| wc -l` |
| inotify / FD | `fs.inotify.max_user_instances`、`max_user_watches`、`nofile` | instances 128、watches 8192/524288，发行版相关 | 文件监听型 workload（IDE、watch、日志采集） | `sysctl fs.inotify.*`、`ulimit -n` |
| 镜像 / 磁盘 | 镜像缓存、ephemeral storage、inode | 110 Pod × 2 GB 镜像 = 220 GB/节点 | 大镜像、日志多、emptyDir 大 | `df -h`、`df -i`、`crictl images` |
| 运行时 | containerd shim、pause 容器、cgroup | shim 约 10–20 MB RSS/Pod | 高 Pod 密度 | `ps aux \| grep containerd-shim`、`systemd-cgtop` |
| API / etcd | QPS、watch、对象数 | 无硬上限，随 Pod churn 恶化 | 高频创建销毁、大量 watch | apiserver 指标、etcd DB size |
| 调度策略 | requests、拓扑、PDB、配额 | — | 资源碎片、亲和性、命名空间配额 | `kubectl describe node`、scheduler 指标 |

几个容易混淆的点：

- **max-pods 是 kubelet 给的，不是 CNI 给的**。CNI 只决定“IP 够不够”；把 max-pods 调到 ENI 能提供的 IP 数以上，Pod 会调度成功但卡在 `ContainerCreating`，报“failed to assign IP address”。
- **云上 max-pods 常常小于 110**。EKS 默认按 ENI 公式算，m5.large 只有 29、m5.xlarge 58；只有开了 prefix delegation 或换大机型，才会接近 110/250。所以“K8s 默认 110”在云上不成立。
- **每沙箱一个 PVC 时，CSI attach 往往比 max-pods 更早撞墙**。EBS 类卷每节点 25–39 个，远低于 110；共享 RWX + subPath 或对象存储是池化模式的必要配套。
- **每沙箱一个 Service 时，iptables/conntrack 会比 max-pods 更早出问题**。1,000 Pod × 1,000 Service 的规则数和连接跟踪表，足以让 kube-proxy 同步变慢、丢包。
- **高密度下 PID/inotify/FD 是隐性上限**。110 个 Python 沙箱各开几十个线程、监听一批文件，`pid_max` 和 `max_user_instances` 很快见底，表现是“资源还有，进程起不来”。
- **RuntimeClass 的 pod overhead 会占资源，但不改变 Pod 数**。Kata/gVisor 的 sandbox 开销会计入 Pod 的 requests，减少可售资源，不会绕过 max-pods。

排查顺序建议：先看 `allocatable.pods` 和实际 Pod 数，确认是不是 max-pods；再看 CNI 是否有 IP（`ContainerCreating` vs `Pending` 的报错不同）；然后看 PVC attach、conntrack、PID/inotify；最后才怀疑 CPU/内存。

---

## 6. 主流路线：一个可落地的蓝图

把上面的事实收拢，当前市场的主流路线可以写成五层：

1. **执行单元**：Firecracker 类 microVM 作为默认隔离单元；需要 K8s 原生时用 Kata/Cloud Hypervisor；可信代码或成本敏感场景保留 runc；WASM 只用于能力受限的工具调用。
2. **启动路径**：预热池 + 快照恢复。目标 TTI 100–600 ms（Isorun 108 ms、Daytona 627 ms、E2B 1,068 ms 是可参照的档位）。冷启动秒级的供应商在 burst 场景会明显掉队。
3. **持久化分层**：
   - 默认 P0/P1：工作区挂 PVC 或对象存储前缀，容器/VM 可随时销毁重建。
   - 可选 P2：pause 时把 rootfs 打成 OCI 镜像，适合“重建胜过恢复”。
   - 可选 P4：长会话/交互式场景才启用内存 + 设备快照，按小时或按次收费，设置 TTL 与加密。
   - P3 只在同内核池内使用，作为过渡能力。
4. **控制面**：无状态 API + 租户配额 + 会话 ID 与执行槽解耦。会话是稳定 ID，执行槽可以换节点、换规格、换隔离方式；不要让 sandbox ID 绑死在一台机器上。
5. **空闲策略**：默认 destroy；短窗口 pause 驻留内存；超过阈值落盘或销毁；快照只在 idle/会话边界触发，禁止每轮全量。

### 6.1 与 OpenSandbox 的对应

| 能力 | OpenSandbox 现状 | 建议 |
|---|---|---|
| 池化短任务 | Pool + BatchSandbox + taskTemplate | 保持 P0/P1，主路径不变 |
| 目录/卷持久化 | Volume API（PVC、subPath、readOnly、deleteOnTermination） | 池化模板只能挂共享根目录；per-sandbox 子目录要在 claim 后创建 |
| 文件系统快照 | pause 提交 rootfs 为 OCI 镜像（P2） | 明确“进程不保留”，文档补一致性说明 |
| 进程/整机现场 | QEMU VMState（P4，实验性） | 先在单机/同型号池验证；补齐 PVC、网络、时钟的边界说明 |
| gVisor/Kata | 可选 RuntimeClass | 普通 K8s 无 KVM 时的现实隔离升级路径 |
| microVM 直通 | 依赖 KVM/裸金属 | 内网集群若无嵌套虚拟化，不作为默认路线 |

按 §5.4 的阈值，一沙箱一 Pod 在 **2c/4G 是资源受限**，池化分时复用是主杠杆；在 **0.5c/512MiB 会撞 110 Pod 上限**，先调 max-pods/IPAM，再考虑多沙箱/Pod。每沙箱一个 PVC 在 EBS 类存储上 25–39 就撞 attach 上限，早于 max-pods，所以共享 RWX + subPath 或对象存储是池化模式的必要配套。

### 6.2 选型决策树

- 代码不可信 + 多租户 + 要 GPU：**R5 整机**（同型号池 + P5）。
- 代码不可信 + 要通用 Linux + 追求启动速度：**R3 microVM + P4**。
- 代码不可信 + 只有普通 K8s、不想碰 KVM：**R2 gVisor + P1/P3**。
- 代码可信 + 成本优先 + 短任务：**R1 容器 + P1**。
- 高频、能力受限的工具调用：**R6 WASM**，与主路径并存。
- 需要桌面/Windows/macOS：**R5**，接受密度低一个数量级。

---

## 7. 证据与局限

- orble 的 705 家、142 个归一化价格、隔离标注与空闲策略均来自 2026-11-14 的页面快照；价格是厂商定价页的归一化结果，未做账单复核。
- ComputeSDK 的 TTI/DAX/快照分数来自 2026-11-13 的公开压测；同一供应商不同区域、镜像、并发配置会显著改变结果。
- Firecracker 的 ≤5 MiB / ≤125 ms / 150 个每秒来自官方 SPECIFICATION 与 FAQ；快照约束来自官方 snapshot-support 文档。
- gVisor 的 checkpoint 限制来自官方 Checkpoint/Restore 文档；CRIU 的内核/CPU/文件/RDMA 限制来自 CRIU 文档与厂商实现说明。
- 密度表中的“槽位”是工程估算，假设无 CPU 超卖、无内存 balloon、无 NUMA 亲和；实际集群要按 workload 的 CPU 利用率和 page cache 行为打折。
- 成本表中的自建价格是 3 年摊销的硬件+机房估算，不含人力；托管价格是挂牌价，不含长期折扣与企业协议。
- 本文不评价各厂商的合规、SLA 与实际故障率；需要的话应按租户、区域、任务类型分别做 POC。
