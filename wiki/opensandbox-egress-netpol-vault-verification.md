---
name: egress-netpol-vault-verification
description: ubuntu k3s 实测：NetworkPolicy 池化沙箱出口管控 + Credential Vault 场景 mock 验证的完整流程、结果与局限性
type: project
---

# Egress 出口管控验证报告：NetworkPolicy 池化隔离 + Credential Vault 场景 mock

> 验证日期：2026-09-03（单日完成，含排障）
> 验证人：平台组（Qwen Code 辅助执行）
> 结论速览：**NetworkPolicy 池化隔离 13/13 用例 PASS；Credential Vault 注入 V0–V9 全部 PASS（含 1 个根因排查：Host 形式与 binding hosts 不一致）**
> 最佳实践落地手册见姊妹篇：[egress 管控与 Credential Vault 最佳实践 SOP](opensandbox-egress-netpol-vault-sop.md)

---

## 一、验证目的与范围

| # | 需求 | 验证方式 |
|---|---|---|
| 1 | 同 namespace 下不同沙箱之间流量隔离 | 两个池化沙箱 Pod 双向互访（Pod IP 直连 task-executor/execd 端口） |
| 2 | 沙箱不能访问沙箱基础服务（平台控制面） | 沙箱 → controller / metrics-server 等探测 |
| 3 | 只能访问特定 mock 服务白名单 | 白名单内（mock-allow，svc+Pod IP 两种形式）与白名单外（mock-deny、跨 ns、集群外）对比 |
| 4 | 隔离不破坏池化链路 | Pool 预热/补货、BatchSandbox 分配、task 派发、execd 启动、管理面访问 |
| 5 | Credential Vault 在企业内网的启用方式与注入行为 | 手工组装 per-sandbox egress sidecar + 鉴权 mock，V0–V9 场景矩阵 |

不在范围：HTTPS 注入（需镜像信任 MITM CA）、gVisor/Kata 运行时、default-allow 模式（已弃用）、fleet 共享 MITM 端到端（server 编排未落地）。

## 二、验证条件与环境

### 2.1 集群与节点

| 项 | 值 |
|---|---|
| 集群 | k3s v1.30.5 双节点（内网测试集群：ubuntu master + CentOS worker） |
| CNI / 网络策略执行 | flannel + k3s 内置 NetworkPolicy 控制器（kube-router 数据面） |
| 验证负载节点 | 全部落在 worker 节点（镜像已缓存） |
| controller | `opensandbox-controller-manager`（helm release `opensandbox-controller`，chart 0.2.1），ns `opensandbox-system` |
| 工作负载 ns | `opensandbox`（验证时新建，验证后已清理） |
| 前置状态 | 集群内无任何 NetworkPolicy（验证前 `kubectl get networkpolicy -A` 为空） |

### 2.2 镜像清单

| 镜像 | 用途 |
|---|---|
| `sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/code-interpreter:v1.1.0` | 沙箱主容器 / mock 服务 / 管理面跳板（内含 curl + python3） |
| `.../opensandbox/task-executor:latest` | initContainer 安装至 `/opt/opensandbox`，沙箱容器 PID1 运行，监听 5758 |
| `.../opensandbox/execd:v1.1.0` | initContainer 安装，任务派发后由 bootstrap.sh 启动，监听 44772 |
| `.../opensandbox/egress:latest` | vault-test Pod 的 egress sidecar（Version `adadf447-dirty`，commit `adadf4471d`，build 2026-09-03T01:47:57Z） |

### 2.3 权限与 capability 要求

| 组件 | 权限 | 说明 |
|---|---|---|
| egress sidecar 容器 | `capabilities.add: [NET_ADMIN]` | 安装 iptables（DNS/80,443 REDIRECT）与 nftables（inet opensandbox 表，output hook policy drop） |
| 沙箱主容器 | `capabilities.drop: [NET_ADMIN]` | 与 server 逻辑 `build_security_context_for_sandbox_container()` 对齐；实测 CapEff 位 12 = 0，沙箱内无法改网络栈绕过 |
| mitmdump 进程 | 以 uid 10042（`mitmproxy` 用户）运行 | iptables owner match 排除其自身上游流量，防 REDIRECT 回环；active.sock 权限 `root:mitmproxy 0660` |
| NetworkPolicy 部分 | 无特权要求 | 策略在 CNI 数据面执行 |
| kubelet 探针 | 节点流量豁免（实测） | netpol 下沙箱 Pod readinessProbe（tcp 5758）保持通过，Pod 全程 Ready |

### 2.4 Pod 内边车/容器构成

| Pod | 容器构成 | 备注 |
|---|---|---|
| 池化沙箱 Pod（`egress-test-pool-*`） | `sandbox`（PID1=task-executor）+ 2 个 initContainer（task-executor-installer / execd-installer） | **无 egress sidecar**（D-7 决策：池化路径省内存），隔离由 NetworkPolicy 承担 |
| `vault-test` | `sandbox`（sleep，drop NET_ADMIN）+ `egress` sidecar（add NET_ADMIN） | 手工模拟 server 的 `apply_egress_to_spec()` 组装结果；两容器共享 netns 与 `opensandbox-bin` emptyDir（CA 导出路径 `/opt/opensandbox/mitmproxy-ca-cert.pem`） |
| `mgmt-jump`（ns opensandbox-system） | `jump` | 模拟平台管理面（controller/server 同 ns 视角） |

## 三、第一部分：NetworkPolicy 出口管控验证

### 3.1 验证资源清单（配置样例）

清单在 ubuntu `/tmp/osb-deploy/egress-verify/`（`egress-verify-base.yaml` / `egress-verify-netpol.yaml` / `egress-verify-bs.yaml` / `matrix.sh`）。核心配置样例：

**Pool 模板**（沿用 2026-09-01 hook 测试通过版本 + readinessProbe）：

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: Pool
metadata:
  name: egress-test-pool
  namespace: opensandbox
spec:
  template:
    metadata:
      labels: {app: egress-test}          # 模板自定义 label，controller 另注入 sandbox.opensandbox.io/pool-name
    spec:
      volumes:
        - {name: sandbox-storage, emptyDir: {}}
        - {name: opensandbox-bin, emptyDir: {}}
        - {name: sandbox-logs, emptyDir: {}}
      initContainers:                      # task-executor + execd 安装（略，同 hook 测试）
        ...
      containers:
        - name: sandbox
          image: .../code-interpreter:v1.1.0
          command: ["/bin/sh","-c","/opt/opensandbox/task-executor -listen-addr=0.0.0.0:5758 -log-dir=/tmp"]
          readinessProbe: {tcpSocket: {port: 5758}, periodSeconds: 5}
      tolerations: [{operator: Exists}]
  capacitySpec: {bufferMax: 2, bufferMin: 2, poolMax: 4, poolMin: 0}
```

**隔离策略（本次验证生效版，可直接复用）**：

```yaml
# Egress：默认拒绝 + 白名单（DNS + mock-allow）
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sandbox-egress-whitelist
  namespace: opensandbox
spec:
  podSelector:
    matchExpressions:
      - {key: sandbox.opensandbox.io/pool-name, operator: Exists}   # 命中所有池化沙箱 Pod（controller 注入）
  policyTypes: ["Egress"]
  egress:
    - to:                                                            # 集群 DNS（coredns）
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
          podSelector: {matchLabels: {k8s-app: kube-dns}}
      ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]
    - to:                                                            # 白名单：按后端 Pod label（service DNAT 后按 8080 命中）
        - podSelector: {matchLabels: {app: mock-allow}}
      ports: [{protocol: TCP, port: 8080}]
---
# Ingress：仅放行平台管理面 ns，其余（含同 ns 沙箱/mock）默认拒绝
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sandbox-ingress-isolation
  namespace: opensandbox
spec:
  podSelector:
    matchExpressions:
      - {key: sandbox.opensandbox.io/pool-name, operator: Exists}
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: opensandbox-system}}
```

**mock 鉴权服务**（ConfigMap python 脚本，校验 `X-Api-Key`，`/healthz` 恒 200；Deployment `app: mock-allow` + Service 80→8080）与 `mgmt-jump` 跳板 Pod 样例见清单文件。

### 3.2 基线（未下发 netpol）结果

| 用例 | 结果 |
|---|---|
| 沙箱 A → B:5758（task-executor，有监听） | **通**（404 页面，HTTP 可达） |
| 沙箱 A → mock-deny / minio-sim / mock-embedding / 节点 NodePort / metrics-server | **全通** |
| 同 ns mock → 沙箱 A:5758 | **通**（任意 Pod 可直连沙箱） |
| DNS | 通 |

基线结论：k3s 默认 flat 网络，**不配置策略时沙箱之间、沙箱到平台/跨 ns/外网全部可达**。

### 3.3 验证矩阵（netpol 下发后，13/13 PASS）

| 用例 | 方向 | 期望 | 实测 | 说明 |
|---|---|---|---|---|
| E1 | A→`mock-allow.opensandbox.svc`（svc:80） | allowed | ✅ allowed | 白名单按 FQDN+svc 访问 |
| E2 | A→mock-allow Pod IP:8080 直连 | allowed | ✅ allowed | 白名单按 Pod IP 也放行（label 选择器命中后端） |
| E3 | A→mock-deny（同 ns） | blocked | ✅ blocked | 非白名单同 ns 服务不可达 |
| E4 | A→B Pod IP:5758（task-executor 有监听） | blocked | ✅ blocked | **同 ns 沙箱互隔（正向）** |
| E5 | A→controller Pod IP:8081（health 端口有监听） | blocked | ✅ blocked | **不可访问平台基础服务** |
| E6 | A→metrics-server.kube-system:443 | blocked | ✅ blocked | kube-system 非 DNS 服务不可达 |
| E7 | A→minio-sim.s3-sim:9000（跨 ns） | blocked | ✅ blocked | 跨 ns 业务默认拒绝（S3 中间件如需沙箱直连须显式加白） |
| E8 | A→mock-embedding.decision-test:8000（跨 ns） | blocked | ✅ blocked | 同上 |
| E9 | A→节点 IP:31300（NodePort/集群外） | blocked | ✅ blocked | 外发默认拒绝 |
| E10 | A→DNS 解析（kube-dns 53） | allowed | ✅ allowed | 白名单域名解析依赖 |
| I1 | mgmt-jump（opensandbox-system）→A:5758 | allowed | ✅ allowed | **管理面→沙箱放行**（task 派发前提） |
| I2 | mock-allow（同 ns）→A:5758 | blocked | ✅ blocked | 同 ns 非"opensandbox-system"来源不可入 |
| I3 | 沙箱 B→A:5758（反方向） | blocked | ✅ blocked | **同 ns 沙箱互隔（反向）** |

> 拦截表现为 `rc=7 connection refused`（REJECT 快速失败，非超时 DROP），探测体验好、失败原因明确。

### 3.4 池化链路回归（netpol 生效中）

| 步骤 | 结果 |
|---|---|
| Pool 预热 2 Pod、保持 bufferMin=2 | ✅ Pod 全程 Ready（kubelet 探针不受 netpol 影响） |
| 创建 BatchSandbox（poolRef）分配 | ✅ ALLOCATED=1 READY=1，alloc-status 注解正常 |
| 池自动补货（分配后） | ✅ 新预热 Pod `hd99w` 自动创建 |
| task 派发与执行 | ✅ `egress-test-sb-0` 任务进程运行：`execd --init -- sleep 600` + 业务进程 |
| 管理面访问 execd:44772 / task-executor:5758 | ✅ HTTP 可达（404=端口通） |

### 3.5 本部分关键发现

1. **选择器用 `sandbox.opensandbox.io/pool-name Exists`** 可覆盖所有池化沙箱 Pod（controller 注入、跨 Pool 通用），且分配后 Pod label 不变、策略持续生效。
2. **白名单粒度是 IP/端口/label，不是域名**：netpol 无法表达 `*.example.com` 域名白名单；域名级管控需要 egress sidecar（第四部分）或 CNI 扩展（Cilium toFQDNs）。
3. **管理面例外必须保留**：ingress 侧放行 `opensandbox-system` ns，否则 controller 无法派发任务（实测 I1）。
4. **DNS 是唯一必须放行的"基础服务"**：白名单解析依赖 kube-dns；kube-system 其余服务仍被拒。
5. **netpol 不影响 kubelet 探针与镜像拉取**（kubelet 节点流量豁免；拉镜像走节点网络不在 pod egress 范围）。

## 四、第二部分：Credential Vault 场景 mock 验证

### 4.1 vault-test Pod 配置样例（手工模拟 server 组装）

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: vault-test
  namespace: opensandbox
spec:
  volumes:
    - {name: opensandbox-bin, emptyDir: {}}     # 共享：egress 导出 MITM CA 到 /opt/opensandbox
  containers:
    - name: sandbox                             # 主容器：只放假凭据
      image: .../code-interpreter:v1.1.0
      command: ["/bin/sh","-c","sleep infinity"]
      env: [{name: MOCK_API_KEY, value: "fake-key-inside-sandbox"}]
      securityContext: {capabilities: {drop: ["NET_ADMIN"]}}
      volumeMounts: [{name: opensandbox-bin, mountPath: /opt/opensandbox}]
    - name: egress                              # sidecar：server [egress] 配置的容器形态
      image: .../egress:latest
      env:
        - name: OPENSANDBOX_EGRESS_RULES        # 网络策略 JSON（default-deny + 白名单）
          value: '{"defaultAction":"deny","egress":[{"action":"allow","target":"mock-allow.opensandbox.svc.cluster.local"}]}'
        - {name: OPENSANDBOX_EGRESS_MODE, value: "dns+nft"}              # vault 硬前提：dns+nft
        - {name: OPENSANDBOX_EGRESS_SANDBOX_ID, value: vault-test}
        - {name: OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT, value: "true"} # 开启 MITM（=credentialProxy）
        - {name: OPENSANDBOX_EGRESS_TOKEN, value: "vlt-test-token"}       # vault 写 API 鉴权
      securityContext: {capabilities: {add: ["NET_ADMIN"]}}
      ports: [{name: egress-api, containerPort: 18080}]                 # 策略/vault API
      readinessProbe: {httpGet: {path: /healthz, port: 18080}, periodSeconds: 2}
      volumeMounts: [{name: opensandbox-bin, mountPath: /opt/opensandbox}]
```

对应 server 侧生产字段：`[egress].image`、`[egress].mode="dns+nft"`、create 请求 `networkPolicy`（defaultAction=deny）+ `credentialProxy.enabled=true`（`egress_helper.apply_egress_to_spec()` 即按上述形态拼 sidecar）。

### 4.2 强制层证据（sidecar 内实测）

```
# iptables -t nat OUTPUT（DNS 代理 + MITM 透明拦截）
-A OUTPUT -p udp --dport 53 -m mark --mark 0x1 -j RETURN          # egress 自身 DNS 上游豁免(mark)
-A OUTPUT -p udp --dport 53 -j REDIRECT --to-ports 15353          # DNS → 内置 DNS 代理
-A OUTPUT -d 127.0.0.0/8 -p tcp -j RETURN
-A OUTPUT -p tcp -m owner ! --uid-owner 10042 -m multiport --dports 80,443 -j REDIRECT --to-ports 18081
                                                                  # 非 mitm 自身流量 80/443 → mitmdump 透明拦截
# nft list table inet opensandbox
set allow_v4  { 10.43.0.10, 127.0.0.1 }                           # 静态：DNS + 本地代理
set dyn_allow_v4 { 10.43.78.203 timeout 1m5s }                    # 动态：白名单域名解析结果，TTL 续期
chain egress { type filter hook output priority filter; policy drop; }   # 默认拒绝
```

conntrack 佐证注入路径：`curl → (REDIRECT) → 127.0.0.1:18081 应答 → mitmdump → (uid 10042 免 REDIRECT) → ClusterIP:80 → mock`。

### 4.3 场景矩阵（V0–V9 全部 PASS）

mock-allow 校验 `X-Api-Key` 是否等于真凭据 `vx-secret-token-2026`，响应回显收到的 key 掩码提示（前 4 字符+长度）。

| 用例 | 操作 | 期望 | 实测 |
|---|---|---|---|
| V0 | 受信面（mgmt-jump）带 token `POST /credential-vault` 推送凭据+binding | 成功，返回脱敏元数据 | ✅ revision=1，响应无明文 |
| V1 | 沙箱内 `curl http://mock-allow.opensandbox.svc.cluster.local/`（不带任何 key） | 自动注入真凭据 | ✅ `auth=ok, received_key_hint="vx-s...len=20"` |
| V2 | 沙箱内带假 key `fake-key-inside-sandbox`（len 23）请求 | 同名 header 被删除并注入真凭据 | ✅ mock 仍收到 `vx-s...len=20`，auth=ok |
| V3 | 沙箱内按 Pod IP 直连 mock:8080 | nft 拦截（allow 集只含白名单域名解析结果） | ✅ rc=28 超时 |
| V4 | 沙箱内访问非白名单域名 mock-deny | DNS 层拒绝 | ✅ rc=6（NXDOMAIN） |
| V5 | 带 token `GET /credential-vault` | 只返回脱敏元数据 | ✅ 仅 name/sourceType/revision/match |
| V6 | 不带 token `POST /credential-vault` | 拒绝 | ✅ 401 |
| V7 | 沙箱容器本地 `curl 127.0.0.1:18080/credential-vault`（无 token） | 拒绝（防沙箱自改 vault） | ✅ 401 |
| V8 | 沙箱容器 CapEff 检查 | NET_ADMIN 已 drop | ✅ CapEff 位 12 = 0 |
| V9 | 运行时 `POST /policy` 增加白名单 → `PATCH /credential-vault` 补 host → 短名请求注入 | 全链路动态生效 | ✅ policy ok → revision=2 → 注入成功 |

### 4.4 根因分析：一次"注入不生效"的完整排查（重要教训）

**现象**：初版 binding 只配 FQDN `mock-allow.opensandbox.svc.cluster.local`，沙箱内 curl `http://mock-allow.opensandbox.svc/` 未注入（V1/V2 失败）。

**排查路径**（定位手段可复用）：

1. iptables REDIRECT 计数器随请求 +1 → 流量已进拦截规则；
2. conntrack 实抓：`src=10.42.1.27 dst=10.43.78.203 dport=80 ← reply src=127.0.0.1 sport=18081` → **流量确实经 mitmdump**；
3. mitmdump cmdline 确认 system.py 已加载、镜像内 `/var/lib/mitmproxy/.mitmproxy/config.yaml` 含 `mode: transparent`、CA 已生成；
4. active.sock（`/credential-vault/_active`）root 直连返回完整 binding → vault 数据面正常；
5. 挂载用户 debug addon（`OPENSANDBOX_EGRESS_MITMPROXY_SCRIPT`，文件日志 + 标记头注入），拿到 **addon 视角的第一现场**：

```
req: scheme=http host=mock-allow.opensandbox.svc port=80 method=GET path=/ ...
vault=HTTP 200: {"bindings":[{"hosts":["mock-allow.opensandbox.svc.cluster.local"], ...}]}
```

**根因**：Pod resolv.conf 带 `search opensandbox.svc.cluster.local`，curl 发出的 Host 头是**短名** `mock-allow.opensandbox.svc`；binding hosts 是**精确匹配**（仅 `*.` 前缀通配），短名 ≠ FQDN → 不命中 → 原样透传。

**伴随发现（fail-closed 实证）**：想给 binding 补短名 host 时被拒：
`binding "mock-allow-api" host "mock-allow.opensandbox.svc" is not allowed by egress policy` —— **binding 的 host 必须被 egress policy 显式 allow（字符串精确一致）**，先 `POST /policy` 放行短名后 PATCH 才成功（V9）。

**规则**：**客户端请求用什么 host 形式，egress policy 与 binding hosts 就要覆盖什么形式**（短名/FQDN/IP 直连三种形态的覆盖关系见 SOP）。

## 五、局限性与注意事项（汇总）

| # | 局限 | 影响/建议 |
|---|---|---|
| 1 | NetworkPolicy 无域名级控制 | 池化主路径的"域名白名单"只能做 IP/label/端口级；域名级需求走 egress sidecar（仅敏感沙箱）或 CNI 扩展 |
| 2 | netpol 拦截为 REJECT（refused） | 快速失败、易排障，但向沙箱暴露"被策略拒绝"信号（与 DROP 语义差异） |
| 3 | Vault 依赖 per-sandbox egress sidecar（约 20–50MB 内存/沙箱） | 与 D-7（池化去 sidecar）冲突：池化沙箱默认无 Vault；敏感沙箱单独启用 |
| 4 | Vault 状态内存态 | Pod 重启/重建/暂停恢复即丢失，须由受信控制面重推（上游 #1594 跟踪持久化） |
| 5 | 仅 80/443 可注入；端口由 scheme 推导 | 非标端口不拦截不注入；HTTP 注入需 binding 显式 `schemes:["http"]`；HTTPS 需镜像信任 MITM CA（本次未覆盖） |
| 6 | binding host 精确匹配 + 必须被 egress policy 显式 allow | 短名/FQDN 形态不一致是最高频翻车点（见 4.4）；IP 直连天然绕过 host 匹配（被 nft 挡） |
| 7 | fleet 共享 MITM（OSEP-0022 A1）数据面已落地、server 编排未落地 | 池化场景的"共享 sidecar 省 memory"形态暂不可端到端，跟踪上游 |
| 8 | egress sidecar 与服务网格（Istio/Envoy）互斥、gVisor 不兼容 | 同 Pod 二选一；gVisor 走 CNI 级策略 |
| 9 | netpol 只覆盖 `pool-name Exists` 的 Pod | 同 ns 内非池化 Pod（无该 label）不受沙箱隔离策略管；策略设计要按实际 label 盘点 |
| 10 | 本次未覆盖：default-allow 模式、Docker runtime、HTTPS/CA 链路、vault 在 K8s pause/resume 后的状态 | 后续按需补测 |

## 六、复现指引

1. 清单与脚本：ubuntu `/tmp/osb-deploy/egress-verify/`（`egress-verify-base.yaml`、`egress-verify-netpol.yaml`、`egress-verify-bs.yaml`、`vault-test-debug.yaml`、`matrix.sh`）。
2. 流程：apply base → 等 Ready → `bash matrix.sh`（基线）→ apply netpol → `bash matrix.sh`（13 用例）→ apply BS（池化回归）→ 按 4.1 组装 vault-test 并推 vault → V 矩阵。
3. 调试手段（注入不生效时）：iptables 计数器 → conntrack 实抓 → addon 文件日志（`OPENSANDBOX_EGRESS_MITMPROXY_SCRIPT`）→ active.sock 直连。
4. 验证后清理：删除 BS/netpol/mgmt-jump/`opensandbox` ns（本次已清理，集群恢复仅剩 helm controller）。

## 参考

- 机制背景：[K8s NetworkPolicy vs Egress 边车对比](opensandbox-k8s-networkpolicy-vs-egress-sidecar.md)、[Egress 网络策略调研](opensandbox-egress-network-policy.md)、[Egress 实现细节进阶参考](opensandbox-egress-internals-reference.md)
- 相关事实：[execd 命令执行 vs K8s exec 与 egress 同 ns 隔离](opensandbox-execd-command-vs-k8s-exec-and-egress-isolation.md)
- 落地手册：[egress 管控与 Credential Vault 最佳实践 SOP](opensandbox-egress-netpol-vault-sop.md)
- 上游文档：`docs/guides/credential-vault.md`、`components/egress/docs/mitmproxy-transparent.md`、`exporter/credential-vault-cookbook.md`
- 跟踪上游：OSEP-0022（fleet MITM server 编排）、issue #1594（vault 持久化）、#1647（port-scoped rules）
