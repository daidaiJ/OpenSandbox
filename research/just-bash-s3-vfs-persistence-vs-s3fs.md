# just-bash 的 S3 VFS、持久化机制与 s3fs 对比

> 数据截点：2026-11-17。代码基于 `vercel-labs/just-bash` 的 `main` 分支 `5b82979`（v3.6.1，2026-11-16 推送）。
> 结论来自源码、README、issue #181/#185、Archil 文档、`prisma/accelerated-fs` 文档与 `s3fs-fuse` 的 README/man page。
> 本文没有跑 S3 端到端基准；性能判断来自数据路径、接口约束和实现文档。

## 结论

1. **just-bash 核心包提供的是可插拔的 `IFileSystem` 抽象，没有内置 S3 文件系统。** 自带实现只有 `InMemoryFs`、`ReadWriteFs`、`OverlayFs`、`MountableFs`；S3 读写由第三方适配器（Archil、`s3-bun-cached-fs`）或 OS 层 s3fs 挂载接入。
2. **库级 S3 适配器的代表是 `s3-bun-cached-fs`（Prisma accelerated-fs）。** 它用本地 SQLite 做元数据索引，用内容寻址 blob/pack 存数据，用远端 WAL + `heads/main.json` 的条件更新做原子发布；`writeFile` 返回即 durable，多读一写，整文件替换语义。
3. **Archil 适配器把 S3 作为 Archil disk 的 backing store。** `ArchilFs` 通过原生协议做路径到 inode 的解析、分块读、按 offset 写、临时文件 + rename 覆盖；写前需要 delegation。disk 层强一致，S3 桶异步同步（文件空闲约 15 秒后开始，最长约 10 分钟）。
4. **just-bash 本体的持久化边界很清楚。** `InMemoryFs` 在进程内存，`ReadWriteFs` 写 host 盘，`OverlayFs` 写内存且不回写；`InMemoryFs` 没有内置快照/序列化 API。跨进程持久化必须换 FS、用远程 `IFileSystem`，或自己导出文件。
5. **相对 s3fs：just-bash 的优势是无挂载、无 root、可定制元数据/事务/请求合并，适合 serverless agent；劣势是非 POSIX、整文件读写、大文件和大目录不友好、适配器成熟度参差。** s3fs 的优势是 POSIX 子集和任意程序兼容；劣势是 FUSE 依赖、元数据慢、写放大、无原子 rename 和跨客户端协调。

## 0. 快速对照

| 问题 | 结论 |
|---|---|
| just-bash 自带 S3 吗 | 核心包只定义 `IFileSystem`；S3 由外部适配器或 s3fs 挂载接入 |
| S3 读写发生在哪一层 | `Bash.exec()` → 命令 → `ctx.fs` → 适配器 → S3 SDK/协议；走 s3fs 时才经过内核/FUSE |
| 默认持久化 | `InMemoryFs`，进程退出即丢失 |
| 跨进程持久化 | `ReadWriteFs`（host 盘）或远程 `IFileSystem`；没有内置的 InMemoryFs 快照 |
| 与 s3fs 最大的区别 | 应用层 VFS vs 内核 FUSE；前者能定制事务/索引，后者能兼容任意程序 |
| 最适合的场景 | 无特权 serverless agent → just-bash + S3 适配器；现有 Linux 工具 → s3fs 类挂载 |

## 1. just-bash 的定位

just-bash 是 Vercel Labs 用 TypeScript 实现的 bash 解释器，面向 AI agent。它实现了 60 多个 Unix 命令（`ls`、`cat`、`grep`、`find`、`sed`、`awk`、`jq` 等），可选启用 Python、JavaScript/TypeScript、SQLite 运行时。

它不执行宿主机的任意二进制程序：命令是 TypeScript 实现，文件访问统一走 `ctx.fs`。这带来两个直接结果：

- 安全边界在进程内，路径校验、命令权限、执行限额由 just-bash 自己控制，不需要 FUSE 或 root。
- 文件系统可以替换。默认是 `InMemoryFs`；传入 `fs` 后，所有命令都基于同一个 `IFileSystem` 实例工作。

`Bash.exec()` 每次执行都会重置 shell 状态（环境变量、函数、cwd），但 `fs` 实例是共享的。因此同一进程内，前一次 `exec()` 写入的文件在下一次可见；进程退出后，默认的内存文件系统就消失了。

## 2. VFS 抽象

### 2.1 接口与方法

`packages/just-bash/src/fs/interface.ts` 定义了 `IFileSystem`。主要方法：

| 类别 | 方法 |
|---|---|
| 读 | `readFile`、`readFileBuffer`、`readFileBytes?` |
| 写 | `writeFile`、`appendFile` |
| 元数据 | `stat`、`lstat`、`readdir`、`readdirWithFileTypes?`、`mkdir`、`createExclusive?`、`rm`、`cp`、`mv`、`chmod`、`symlink`、`link`、`readlink`、`realpath`、`utimes` |
| 路径 | `resolvePath`、`getAllPaths` |

所有 I/O 方法都返回 `Promise`。接口里没有 `open`/文件描述符、`read(offset)`/`write(offset)`、`truncate`、`fsync`、`mmap`、`flock`。因此 just-bash 的文件语义是**整文件读取、整文件写入或追加**，随机读写不在接口层。

这一点在后面和 s3fs 对比时很关键：s3fs 处在内核/FUSE 层，可以按页和 range 读写；just-bash 的命令通过 `readFile` 拿到整个文件内容，适配器无法只返回其中一段。

### 2.2 内置四种文件系统

| 实现 | 数据位置 | 写行为 | 持久化 |
|---|---|---|---|
| `InMemoryFs` | 进程内存的 `Map` | 写内存 entry | 进程退出即丢失；没有内置快照/序列化 API |
| `ReadWriteFs` | host 目录 | 直通 Node `fs` | 写入 host 文件系统；接口层没有 fsync；hardlink 有 copy-on-write 隔离和大小上限 |
| `OverlayFs` | host 只读底座 + 内存 CoW | 写内存层 | 进程退出即丢失；没有回写/commit API；默认 `maxMemoryBytes` 为 1 GiB |
| `MountableFs` | 组合多个 FS | 由挂载点底层决定 | 取决于底层 FS；base 默认 `InMemoryFs` |

补充几点实现细节：

- `InMemoryFs` 支持初始文件、惰性文件（`() => string` 或 async 函数）、符号链接和硬链接；数据只在内存里。
- `ReadWriteFs` 直接把操作落到配置的 host 目录，默认对 multiply-linked 文件的 append/chmod/utimes 做 copy-on-write 隔离；`maxCopyOnWriteSize` 默认 100 MB。
- `OverlayFs` 的读来自 host 目录，写留在内存；`readOnly: true` 可以禁止写；它没有把内存层提交回 host 的方法。
- `MountableFs` 可以把只读知识库、可写工作区、内存 scratch 组合成一个命名空间；跨挂载点的 `cp`/`mv` 由它处理。

### 2.3 远程 FS 的接口约束

三个约束会直接影响 S3 适配器的设计和性能：

1. **`getAllPaths()` 仍然是同步签名。** issue #181 指出，远程 FS 要实现 glob 就得预取整棵树。当前 `main` 的 glob 展开已经改用 `readdir`/`readdirWithFileTypes`（`packages/just-bash/src/shell/glob.ts`），所以主流程对远程 FS 友好；但外部适配器或自定义命令如果依赖 `getAllPaths`，仍需要自己维护同步路径缓存。Archil 适配器的 `getAllPaths()` 目前直接返回 `[]`。
2. **`grep -r` 对每个文件调用一次 `readFile`。** issue #185 指出，远程后端会变成“每个文件一次请求”；提案中的 `searchFiles?()` 钩子尚未落地。`grep.ts` 的递归路径在遍历后逐个 `ctx.fs.readFile(path)`。
3. **命令按整文件读。** `cat`、`head`、`tail` 走 `readBytesFrom`（最终是 `readFileBuffer`）；`grep`、`sed`、`awk` 也以整文件内容为基础。对 S3 适配器来说，`readFileBuffer` 必须把整个对象（或整个逻辑文件）materialize 成 `Uint8Array`。

对象存储没有真正的目录和 inode，`stat`/`readdir` 天然对应 HEAD/LIST。所有 S3 VFS 的第一优化点都是把元数据放到本地索引，第二才是数据缓存。s3fs 用 stat cache，accelerated-fs 用 SQLite，Archil 用服务端 disk 元数据。

## 3. S3 接入路线 A：库级 VFS

代表实现是 Prisma 的 `s3-bun-cached-fs`（仓库 `prisma/accelerated-fs`），它的 just-bash 适配器叫 `AcceleratedJustBashFs`。

```ts
import { S3CachedFsManagerImpl } from "s3-bun-cached-fs/core";
import { AcceleratedJustBashFs } from "s3-bun-cached-fs/just-bash";
import { Bash } from "just-bash";

const manager = new S3CachedFsManagerImpl({ cacheRoot: "/tmp/accelerated-cache" });
const core = await manager.mount({
  name: "workspace",
  mode: "readwrite",
  bucket: "my-bucket",
  prefix: "agent/workspace",
  region: "us-east-1",
  cacheBytes: 500 * 1024 * 1024,
});

const fs = new AcceleratedJustBashFs(core);
const bash = new Bash({ fs, cwd: "/workspace" });
await bash.exec('echo "hello" > reports/out.txt');
```

### 3.1 架构

```text
Bash command
  -> ctx.fs (AcceleratedJustBashFs)
    -> S3CachedFs
      -> local SQLite metadata
      -> local LRU object cache
      -> S3-compatible object store
```

S3 布局：

```text
<prefix>/
  format.json
  heads/main.json
  locks/writer.json
  snapshots/<snapshot-id>/meta.sqlite
  snapshots/<snapshot-id>/manifest.json
  wal/<seq>-<txid>.json
  blobs/sha256/<prefix>/<sha256>
  packs/YYYY/MM/DD/<txid>-000000.pack
```

### 3.2 元数据

本地 SQLite 维护 inode 风格的命名空间：

- `inode`：类型、mode、size、mtime、version。
- `dirent`：父 inode + 名字 → 子 inode。
- `extent`：文件版本对应的逻辑字节范围，指向 object key、offset、length。
- `object_ref`：引用到的 blob/pack 对象。
- `remote_tx`：已经应用的远端 WAL 记录。

mount 后，`stat`、`readdir` 走本地 SQLite，不直接请求 S3；只有数据缺失或需要刷新 head 时才访问对象存储。这解决了对象存储元数据操作慢的问题。

### 3.3 数据布局

- 大文件按 8 MiB 切成内容寻址 chunk，写到 `blobs/sha256/<prefix>/<sha256>`。
- 小文件在事务里拼进 `packs/YYYY/MM/DD/<txid>-000000.pack`，extent 记录在 pack 内的偏移和长度。
- 旧版本数据不被原地覆盖；替换文件会创建新的版本和 extent，旧对象由后台 GC 处理（当前实现不自动回收）。

这种布局的优点是小文件写入的请求数很低：一次事务可以写 10,000 个小文件，最终只产生少量 pack 对象、一条 WAL 和一次 head 更新。代价是 S3 桶里不是“一文件一对象”的原生布局，外部工具不能直接用 AWS CLI 按路径读文件。

### 3.4 读路径

1. 在 SQLite 里查 inode 和 version。
2. 查与请求范围相交的 extent。
3. 查本地 LRU 缓存（按对象缓存，当前实现缓存完整对象）。
4. 缓存未命中时从 S3 GET；核心提供 `readRange`、`stream`、`materialize`。
5. 把请求范围拷贝到返回 buffer，范围可以跨多个 chunk 或 pack。

注意：`readRange` 是核心 API，但 just-bash 的命令通过 `readFile`/`readFileBuffer` 取整个文件。因此 `grep` 一个大文件时，适配器仍会把整个逻辑文件拼出来，range 优化主要体现在核心库的直接调用和 `stream` 场景。

### 3.5 写路径与持久化

一次写事务的提交顺序：

1. 本地暂存字节。
2. 上传不可变的 blob 或 pack 对象。
3. 上传远端 WAL 记录，使用 `If-None-Match: *` 防止覆盖。
4. 用 `If-Match: <previous-head-etag>` 条件更新 `heads/main.json`。
5. 把同一条 WAL 记录应用到本地 SQLite。

可见性由 `heads/main.json` 决定：读者要么看到旧 head，要么看到新 head，不会看到半提交状态。崩溃恢复：

| 崩溃点 | 结果 |
|---|---|
| 数据上传前 | 没有可见变化 |
| 数据上传后、WAL 前 | 孤立数据对象，不可见 |
| WAL 后、head 前 | 孤立 WAL/数据，不可见 |
| head 后、本地 SQLite 前 | 重新 mount 或 refresh 时重放 WAL |
| 本地 SQLite 后 | 提交完成 |

`writeFile()`、`transaction()`、`mkdir()`、`rm()`、`rename()` 的 Promise 在 head 更新后返回；`openWrite()` 在 `handle.close()` 后 durable；`fs.close()` 会自动提交仍未关闭的写句柄。

### 3.6 并发与限制

- 多读一写：只允许一个 readwrite mount；多个 readonly mount 可以并行。
- writer lease 加 head CAS 防止双写；lease 过期后，陈旧 writer 也不能覆盖新 head。
- 不支持 mmap、硬链接、POSIX 文件锁、原地随机写、跨 mount 原子 rename。
- 权限只存 mode bits，不做完整 POSIX 权限强制。
- 旧 blob/pack/WAL/snapshot 不自动 GC，生产环境需要单独的回收任务。

### 3.7 just-bash 适配层

`AcceleratedJustBashFs` 对 `IFileSystem` 做了几处适配：

- `getAllPaths()` 用进程内路径缓存；可以 `refreshPathCache()` 全量遍历，或在构造时 `primePathCache: true`。大工作区全量预热会很贵。
- 符号链接存在隐藏 JSON sidecar 文件里，并通过 `S3CachedFs` 持久化；`readdir` 默认隐藏这个文件。
- 硬链接没有 inode 级支持，`link()` 用复制字节模拟。
- `appendFile()` 读出整个文件，再拼接写回；`cp` 也是整文件读写。
- 目录的 `chmod`/`utimes` 是 no-op，因为核心 API 没有暴露目录元数据更新。
- `readFile`/`readFileBuffer` 直接调用核心的 `readFile`，因此是整文件语义。

### 3.8 适用性

适合：

- 无特权 serverless 环境（Lambda、Fargate、边缘容器）。
- 小文件多、短任务、需要低 S3 请求成本的 agent 工作区。
- 需要“写成功即持久化”和“读者只看到完整提交”的场景。

不适合：

- 需要 POSIX 语义、mmap、文件锁、原地随机写的程序。
- 需要直接用 AWS CLI 或其他 S3 工具按文件路径读写的场景。
- 大文件流式扫描；just-bash 命令仍会整文件 materialize。

## 4. S3 接入路线 B：Archil

Archil 自己是一个 POSIX 兼容的分布式文件系统，S3 是它的 backing store。`@archildata/just-bash` 里的 `ArchilFs` 实现 `IFileSystem`，通过原生客户端协议访问 Archil disk。

```ts
import { ArchilClient } from "@archildata/native";
import { ArchilFs, createArchilCommand } from "@archildata/just-bash";
import { Bash } from "just-bash";

const client = await ArchilClient.connect({
  region: "aws-us-east-1",
  diskName: "myaccount/my-disk",
  authToken: "my-secret-mount-token",
});

const fs = await ArchilFs.create(client);
const bash = new Bash({
  fs,
  customCommands: [createArchilCommand(client, fs)],
});
```

### 4.1 架构

```text
Bash command
  -> ctx.fs (ArchilFs)
    -> ArchilClient (native protocol, TLS)
      -> Archil disk (POSIX-compatible, strongly consistent)
        -> S3 bucket (asynchronous copy)
```

Archil 的 disk 是一个共享的、强一致的存储层；S3 是它的 data source。客户端通过自定义协议访问 disk，不要求本地 FUSE 挂载。`ArchilFs` 负责把 just-bash 的路径操作翻译成 inode 操作。

### 4.2 读写机制

- 路径解析成 inode：逐级 `lookupInode`，支持符号链接和 `..` 规范化。
- 读：`readInode` 按 `MAXIMUM_READ_SIZE` 分块读取；大文件循环读取并拼成 `Uint8Array`。
- 写：`writeData` 按 offset 写入；覆盖已有文件时先创建临时文件，写完再 `rename`，避免读者看到半写状态。
- 追加：`appendFile` 直接用当前 size 作为 offset 调用 `writeData`，不需要读出整个文件。
- 写前需要 delegation：`writeFile`/`mkdir` 在可能的情况下自动处理；需要显式控制时用 `archil checkout` / `archil checkin`。
- `cp` 当前实现是读出整个文件再写；`link` 直接抛“Hard link operations not yet implemented”；`getAllPaths()` 返回 `[]`。

### 4.3 持久化与一致性

- 写到达 Archil disk 即 durable；`fsync`、`checkin`、`unmount` 返回后保证写入已经提交。
- disk 层强一致：写到达 disk 后，任何到达 disk 的读都能看到；rename 是原子的。
- 后台把变更复制到 S3：文件空闲约 15 秒后开始，最长不超过首次写入后约 10 分钟；直接读 S3 桶会看到延迟。
- 客户端缓存：`stat` 属性约 30 秒，目录列表约 5 分钟；打开文件时会和 disk 校验，必要时丢弃缓存。
- 并发：exclusive/shared mount 允许一个路径一个 writer；conditional mount 允许多个 writer，冲突时最后到达 disk 的写获胜；delegation 可以提供路径级独占。
- 崩溃：客户端未发送的缓冲写会丢；已发送到 disk 的写不会丢；崩溃客户端的 delegation 不会自动释放，需要显式回收。

### 4.4 限制与状态

- 需要 Linux x64/arm64 的原生客户端（macOS arm64 也可）；不是纯 TypeScript 运行时。
- `getAllPaths()` 返回 `[]`，依赖它的外部命令需要自己补路径缓存。
- 硬链接未实现。
- `@archildata/just-bash` 的 npm README 已标注“不推荐新项目使用”，推荐改用 Archil 的 `disk exec` serverless execution：命令在 Archil 管理的容器里对 disk 执行，不需要客户端挂载或 just-bash 环境。

### 4.5 适用性

适合：

- 需要 POSIX 语义、原子 rename、共享 disk 的场景。
- 希望 S3 桶里保持原生对象格式、可被其他 S3 工具读取的场景。
- 能接受 Archil 服务、原生客户端和异步 S3 同步延迟的部署。

不适合：

- 纯浏览器/边缘运行时。
- 不能安装原生客户端的环境。
- 希望 just-bash 适配器长期维护的新项目（官方已转向 `disk exec`）。

## 5. S3 接入路线 C：s3fs 挂载

先把桶挂到本地：

```bash
s3fs my-bucket /mnt/s3 \
  -o passwd_file=/etc/passwd-s3fs \
  -o use_cache=/var/cache/s3fs \
  -o stat_cache_expire=900
```

再让 just-bash 指向挂载点：

```ts
import { Bash } from "just-bash";
import { ReadWriteFs } from "just-bash/fs/read-write-fs";

const fs = new ReadWriteFs({ root: "/mnt/s3" });
const bash = new Bash({ fs, cwd: "/mnt/s3" });
```

这条路线把 s3fs 当成普通的 host 文件系统：

- `ReadWriteFs` 的读写经过 Node `fs`，再到内核 VFS/FUSE，最后由 s3fs 转成 S3 请求。
- 数据保持 S3 原生对象格式，AWS CLI 可以直接读写。
- 需要 FUSE、挂载权限和本地缓存；容器里通常要 `/dev/fuse` 和 `SYS_ADMIN`，或者直接 privileged。
- 继承了 s3fs 的全部语义限制：无原子 rename、无硬链接、无跨客户端协调、随机写/append 重写整个对象、元数据操作慢。

**不要用 `OverlayFs` 指向 s3fs 挂载点来做持久化。** `OverlayFs` 的写留在内存层，没有回写/commit API；进程退出后改动就丢了。它适合“只读知识库 + 临时改动”，不适合工作区。

## 6. 持久化机制对比

| 方案 | 数据最终落到哪 | 进程/节点重启 | 写成功语义 | 关键限制 |
|---|---|---|---|---|
| `InMemoryFs` | 进程内存 | 丢失 | `exec` 返回后内存可见 | 无内置快照/序列化 |
| `ReadWriteFs` | host 目录 | 取决于磁盘 | `writeFile` 返回后写入 host | 接口层无 fsync；hardlink CoW 上限 |
| `OverlayFs` | host 读 + 内存写 | 丢失 | 内存可见 | 无回写/commit |
| `s3-bun-cached-fs` | S3 blob/pack + WAL + head | 可恢复 | `writeFile` resolve 后 durable | 单写多读；私有布局；无自动 GC |
| Archil | Archil disk，后台同步 S3 | 可恢复 | fsync/checkin/unmount 后 durable | S3 副本有延迟；delegation 需回收 |
| s3fs | S3 对象 | 可恢复 | close/flush 后上传 | 无事务、无原子 rename、无跨客户端协调 |

几个容易踩的点：

- just-bash 本体没有 `InMemoryFs` 的序列化/恢复 API。要跨进程持久化，需要换 `ReadWriteFs` 或远程 `IFileSystem`，或者自己遍历 `getAllPaths()` 导出文件。
- `ReadWriteFs` 的写入到 host 文件系统，是否真正持久化取决于 host 盘和是否 fsync；在 Lambda 的 `/tmp` 上仍然是临时的。
- `OverlayFs` 的写不会自动合并回底座；它适合“只读知识库 + 临时改动”，不适合工作区持久化。
- S3 适配器的 durable 语义各不相同：`s3-bun-cached-fs` 是写穿 WAL + head 发布；Archil 是 disk 持久后异步同步桶；s3fs 是 close/flush 时上传对象。
- s3fs 的本地缓存是可删除的，不是持久化层；删除缓存不会丢已经上传的数据，但崩溃可能留下临时文件和未完成 multipart。

## 7. 与 s3fs 的逐项对比

下表的 just-bash 列指“用 S3 VFS 适配器接入”的形态，不是 s3fs 挂载路线。

| 维度 | just-bash + S3 VFS 适配器 | s3fs |
|---|---|---|
| 运行形态 | 进程内 TypeScript 库，无挂载、无 root | FUSE 内核挂载，需要 `/dev/fuse` 和挂载权限 |
| 文件语义 | 自定义异步接口，非 POSIX；无 fd、随机写、mmap、锁 | POSIX 子集；任意程序可用；支持随机写/append、symlink、xattr、mode/uid/gid |
| 大文件读 | 命令 `readFile` 把整个文件读进内存；`grep` 对大文件会整对象下载 | 按页/range 读取并预取，进程内存和下载量更可控 |
| 小文件/元数据 | 可用 SQLite 索引、pack、内容寻址，把请求数压得很低 | 每文件一个对象；LIST/HEAD 慢；小文件 PUT 多 |
| 写语义 | 整文件替换或 WAL 事务；可以做到提交后原子可见；单写多读 | 随机写/append 需要重写整个对象；无原子 rename；无硬链接 |
| 多客户端 | 适配器可提供 head CAS、delegation、单写者租约 | 无跨客户端协调；本地缓存可能陈旧；非 AWS 可能最终一致 |
| 部署环境 | Lambda、边缘、无特权容器；部分适配器需要 Bun 或原生客户端 | Linux/macOS；Lambda 和受限容器里通常不可用 |
| 数据形态 | 取决于适配器：私有布局或 S3 原生对象 | S3 原生对象，AWS CLI 可直接读写 |
| 隔离 | 不暴露 host 文件系统；命令是 TS 实现，不能跑任意二进制 | 挂载点对 host 进程可见；需要容器/namespace 做隔离 |
| 成熟度 | just-bash 仍是 beta；S3 适配器多为第三方 | 成熟、部署广泛，但 POSIX 缺陷已知 |

### 7.1 运行边界与部署

just-bash 的 VFS 在应用进程内，不需要 FUSE、内核模块或 root。它可以在 Lambda、边缘运行时、无特权容器里跑；代价是它只能服务 just-bash 自己实现的命令，不能把挂载点暴露给任意 Linux 程序。

s3fs 把桶挂到内核 VFS，任何程序都能用；代价是依赖 FUSE 和挂载权限，在 Lambda、Cloud Run 这类环境里通常不可用，或者需要额外的特权配置。

### 7.2 数据路径与性能

just-bash + S3 适配器的数据路径短：命令直接调用适配器，适配器可以直接用 S3 SDK、自己的元数据索引和缓存。它可以把 10,000 个小文件打包成少量对象，把元数据操作变成 SQLite 查询，把一批写合并成一次 WAL + head 更新。这些是 s3fs 做不到的，因为 s3fs 必须遵守 POSIX 系统调用的逐文件语义。

s3fs 的数据路径长：应用 → 内核 VFS → FUSE → s3fs → S3。它按页/range 读取并预取，适合大文件顺序扫描和任意工具；但每次 `stat`/`readdir` 可能对应 HEAD/LIST，随机写/append 要重写整个对象，小文件多时 PUT/LIST 请求数会放大。

一个具体的例子：

- 对 1 GB 日志跑 `grep`：just-bash 的命令会把整个文件读进内存，适配器需要 materialize 1 GB；s3fs 可以按页/range 读取，内存占用和下载量更可控。
- 写入 10,000 个小文件：s3fs 是 10,000 次对象 PUT（加上目录/元数据请求）；`s3-bun-cached-fs` 可以用一个事务打成少量 pack + 一条 WAL + 一次 head 更新。
- 目录 `mv`：s3fs 通过 server-side copy + delete 完成，逐个对象处理，不是原子操作；Archil 的 rename 是 disk 层原子操作；`s3-bun-cached-fs` 在元数据层改 dirent。

### 7.3 语义与一致性

just-bash 的 VFS 是自定义语义：整文件读写、没有 fd、没有随机写、没有 mmap、没有 POSIX 锁。它可以通过适配器提供“提交后原子可见”“单写多读”“版本/快照”等能力，但这些能力是适配器定义的，不是 POSIX 保证。

s3fs 提供 POSIX 子集：随机写、append、symlink、xattr、mode/uid/gid 都有，但已知缺陷包括无原子 rename、无硬链接、无跨客户端协调、非 AWS 可能最终一致、inotify 只检测本地修改。它适合“现有程序零改造”，不适合“多写者共享同一目录”。

### 7.4 数据互操作与成本

`s3-bun-cached-fs` 的 S3 布局是私有的 `blobs/`、`packs/`、`wal/`、`heads/`；文件内容不能直接用 AWS CLI 按路径读取，需要它的库来重建。s3fs 和 Archil 保持 S3 原生对象格式，外部工具可以直接读。

成本方面，小文件多时 s3fs 的每文件 PUT/LIST 会放大请求成本；`s3-bun-cached-fs` 的 pack/WAL 能把一批小文件压成少量对象和一次 head 更新，但会带来旧对象保留和 GC 成本。Archil 的 disk 层是托管服务，成本模型取决于它的存储/请求计价。

### 7.5 成熟度与运维

just-bash 仍是 beta；S3 适配器多为第三方，质量、维护状态和限制各不相同。Archil 的 just-bash 适配器已经被官方标注为不推荐新项目使用。`s3-bun-cached-fs` 是 Bun 原生实现，依赖本地 SQLite 和缓存目录，生产上需要处理 writer lease、快照、GC 和缓存容量。

s3fs 成熟、部署广泛，文档和运维经验多；但它的 POSIX 缺陷是结构性的，不是配置能完全消除的。

## 8. 选型建议

| 目标 | 建议 | 理由 |
|---|---|---|
| 无特权 serverless / agent 文件工具 | just-bash + `s3-bun-cached-fs` 这类带元数据索引和 WAL 的适配器 | 无挂载、低请求成本、写成功即持久化；接受整文件读写和非 POSIX |
| 现有 Linux 工具直接读写 S3 桶 | s3fs、Mountpoint for Amazon S3、JuiceFS | 任意程序可用、S3 原生对象；接受 FUSE 依赖和 POSIX 缺陷 |
| 已有 s3fs 挂载，想让 just-bash 复用 | `ReadWriteFs` 指向挂载点 | 复用现有挂载；不要用 `OverlayFs` 期待持久化 |
| 需要 POSIX 语义、S3 原生对象、共享盘 | Archil，或它的 `disk exec` | disk 层强一致、原子 rename、原生对象；适配器已不推荐新项目 |
| 大文件扫描、日志分析 | 对象级工具或 range-aware 服务 | just-bash 的整文件 `readFile` 不适合大文件；s3fs 也只能缓解，不是并行分析引擎 |
| 数据库、高并发随机写、多写者共享 | 本地盘 + 增量 checkpoint，或专用文件系统 | s3fs 和单写者 S3 VFS 都不适合 |

一句话总结：**要在无特权 serverless 环境里让 agent 用 bash 操作 S3 工作区，选 just-bash + 带元数据索引/WAL 的适配器；要让现有 Linux 工具直接读写 S3 桶，选 s3fs 这类 FUSE 方案。两者都不适合把 S3 当数据库做高并发随机写。**

## 9. 对 OpenSandbox 的启示

OpenSandbox 的执行面是真容器，just-bash 的 VFS 不能直接替代容器运行时；但它的 S3 适配器设计有几处可以借鉴到 pooled sandbox 的 artifact/workspace 层：

1. **元数据和数据分开。** 本地 SQLite/内存索引负责 `stat`/`readdir`/glob，对象存储只存不可变数据；避免每次目录操作都打 LIST/HEAD。
2. **单写多读 + head CAS。** 一个 writer 持有租约，读者只看到完整发布的 head；这比 s3fs 的多客户端本地缓存更容易推理。
3. **小文件打包。** 短任务产生的许多小 artifact 可以合并成 pack，减少 PUT 和 LIST 请求；代价是需要 GC 和重建工具。
4. **内容寻址 + 增量。** 大文件按 chunk 存，重复内容去重；配合本地热缓存，冷路径只拉缺失块。
5. **写密集工作区仍应本地盘 + 增量 checkpoint。** s3fs 适合只读或低写场景；把 S3 当写穿文件系统会放大延迟和请求成本。

这些和 OpenSandbox 现有的“本地热层 + 异步增量 checkpoint + S3 冷存储”方向一致；just-bash 的适配器提供了一个“纯库级、无 FUSE”的实现参考，但它的非 POSIX/整文件限制也说明它更适合 agent 工具层，而不是通用沙箱文件系统。

## 10. 参考与验证

- `vercel-labs/just-bash` `main` `5b82979`：
  - `packages/just-bash/src/fs/interface.ts`：`IFileSystem` 定义，`getAllPaths()` 同步签名。
  - `packages/just-bash/README.md`：Filesystem Options、四种内置实现、exec 语义。
  - `packages/just-bash/src/shell/glob.ts`：glob 走 `readdir`/`readdirWithFileTypes`。
  - `packages/just-bash/src/commands/grep/grep.ts`：递归 grep 逐文件 `readFile`。
  - `packages/just-bash/src/commands/head/head-tail-shared.ts`：`head`/`tail` 走 `readBytesFrom`。
  - issue #181：异步 `getAllPaths()` 提案；issue #185：`searchFiles?()` 提案。
- `prisma/accelerated-fs`：
  - `docs/architecture.md`：SQLite 元数据、blob/pack、WAL、head 发布。
  - `docs/guarantees.md`：写穿持久化、单写者、崩溃恢复。
  - `docs/limitations.md`：无 mmap/硬链接/锁/原地随机写、无自动 GC。
  - `src/just-bash/accelerated-just-bash-fs.ts`：适配层的路径缓存、symlink sidecar、hard link 复制、append 整文件读写。
- Archil：
  - `https://docs.archil.com/details/architecture.md`：disk + S3 backing store、durability。
  - `https://docs.archil.com/details/consistency.md`：disk 强一致、客户端缓存、S3 复制延迟。
  - `https://docs.archil.com/details/caching.md`：stat 30 秒、目录 5 分钟、客户端缓存。
  - `https://docs.archil.com/integrations/just-bash.md`：`ArchilFs` 用法、delegation。
  - `@archildata/just-bash` 0.8.42 的 README 与 `dist/src-*.mjs`：`getAllPaths()` 返回 `[]`、`link()` 未实现、`writeData`/`readInode` 实现。
- `s3fs-fuse`：
  - `README.md`：POSIX 子集、随机写/append 重写整个对象、无原子 rename、无硬链接、无跨客户端协调、本地缓存。
  - `doc/man/s3fs.1.in`：`use_cache`、`stat_cache_expire`、`multipart_size`、本地缓存要求。
  - `src/fdcache_entity.cpp`：`FdEntity::Read` 按未加载页/range 读取并预取。

验证方式：浅克隆 `vercel-labs/just-bash`、`prisma/accelerated-fs` 与 `elixir-ai-tools/just_bash` 检查 S3 相关代码；用 `rg` 检查 `IFileSystem` 使用点；阅读上述文档和 npm 包。未运行 S3 端到端基准，因此本文不给出吞吐/延迟数字。
