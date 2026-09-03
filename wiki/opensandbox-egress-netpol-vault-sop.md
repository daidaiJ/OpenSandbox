---
name: egress-netpol-vault-sop
description: 企业内网部署 OpenSandbox 出口流量管控与 Credential Vault 的最佳实践 SOP（基于 2026-09-03 实测验证）
type: project
---

# Egress 出口管控与 Credential Vault 最佳实践 SOP（企业内部署）

> 依据：[Egress 出口管控验证报告（2026-09-03 实测）](opensandbox-egress-netpol-vault-verification.md)。所有步骤均在 ubuntu k3s（flannel + k3s 内置 netpol）实测通过。
> 定位：给平台运维/集成开发的落地手册——"按什么分层、抄什么配置、走什么步骤、避什么坑"。

## 0. 架构分层（先定基调）

```
┌─ 第 1 层（全量，零组件成本）：K8s NetworkPolicy
│    池化沙箱默认隔离：同 ns 沙箱互隔 / 平台基础服务禁达 / 白名单(IP,label,端口)放行
│    承担业务约定 D-7：池化路径不注入 egress sidecar
│
├─ 第 2 层（按需，敏感沙箱）：egress sidecar（per-sandbox，dns+nft 模式）
│    域名级白名单（DNS 代理 + nft 动态 allow 集）+ Credential Vault（MITM 注入）
│    每沙箱 +1 sidecar（约 20–50MB 内存）→ 只给"凭据不落地"硬需求的沙箱
│
└─ 第 3 层（未来）：fleet 共享 MITM（OSEP-0022）
     每 Pod 一份 egress、多 subject 共享 → 消解第 2 层内存顾虑
     ⚠ 现状：数据面已落地，server 编排未落地，不可端到端（跟踪上游）
```

**选型口诀**：默认只做第 1 层；出现"凭据不落地 + 域名最小权限"硬需求（或审计要求）的**个别 Pool/沙箱**，叠加第 2 层；第 3 层等上游就绪再评估。

---

## SOP-A：池化沙箱 NetworkPolicy 隔离（全量基线）

### A1. 前提盘点

- [ ] 确认 CNI 支持并启用 NetworkPolicy（k3s 内置启用；自建集群需 Calico/Cilium 等）。**空跑验证**：先对测试 Pod 下发 default-deny 并确认拦截生效。
- [ ] 摸清沙箱 Pod 的 label 方案：controller 对池化 Pod 注入 `sandbox.opensandbox.io/pool-name=<pool>`（跨 Pool 用 `Exists` 匹配），BatchSandbox 维度另有 `batch-sandbox.sandbox.opensandbox.io/*`。**策略选择器以实际 label 为准**，同 ns 非 pool 的 Pod 不在沙箱策略覆盖内。
- [ ] 盘点"必须保留的连通性"：DNS（kube-dns 53）、管理面 → 沙箱（controller/server 所在 ns，task-executor 5758 / execd 44772）、业务必须的出向目标（白名单）。
- [ ] 盘点"必须切断的连通性"：沙箱互访、平台基础服务（controller/metrics 等）、跨 ns 默认、集群外默认。

### A2. 下发策略（模板）

```yaml
# 1) Egress：默认拒绝 + 白名单
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sandbox-egress-whitelist
  namespace: opensandbox            # 沙箱工作负载 ns
spec:
  podSelector:
    matchExpressions:
      - {key: sandbox.opensandbox.io/pool-name, operator: Exists}
  policyTypes: ["Egress"]
  egress:
    - to:                            # DNS 必放
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
          podSelector: {matchLabels: {k8s-app: kube-dns}}
      ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]
    - to:                            # 业务白名单：按目标 Pod label + 端口（可多条）
        - podSelector: {matchLabels: {app: mock-allow}}
      ports: [{protocol: TCP, port: 8080}]
---
# 2) Ingress：仅平台管理面可入沙箱
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

要点：
- **服务访问的命中点在后端 Pod**：egress 规则写"目标 Pod 的 label + 容器端口"（service DNAT 后按后端端口匹配），不是 service 端口。
- **ingress 侧不要写端口白名单就够用**：平台 ns 全端口放行（controller 派发 task 5758、探针、execd 44772 都要从这里走）；精细端口化收益低、故障面大。
- 每多一个被选择的 Pod 都会进入"默认拒绝"集合——**策略下发顺序**：先白名单齐全，再下发 default-deny；或直接一次 apply（沙箱重建即可恢复）。

### A3. 变更后必做验证（5 分钟清单）

1. 池 Pod 全部 Ready（kubelet 探针不受 netpol 影响，若 NotReady 先查探针路径）。
2. 沙箱 A → 沙箱 B:5758 **双向** blocked。
3. 沙箱 A → controller health 端口 blocked；A → 任一白名单目标 allowed；A → DNS 解析 allowed。
4. 管理 ns 跳板 Pod → 沙箱 5758/44772 allowed。
5. 从 Pool 分配一个 BatchSandbox 走通 task 派发 + execd 启动（策略变更最容易伤到这里）。

### A4. 已知坑（实测踩过/规避过）

| 坑 | 现象 | 规避 |
|---|---|---|
| 忘放 DNS | 白名单域名全部解析失败 | 第一条 egress 规则永远先写 kube-dns:53 |
| ingress 未放管理面 ns | BatchSandbox 分配卡住/READY 不涨 | ingress 必含 `opensandbox-system`（或 server 所在 ns） |
| 用 service 端口写 egress 端口 | 白名单目标不通（DNAT 后端口变化） | egress 端口写**容器端口**（如 8080），不是 svc 的 80 |
| 用 Pod IP 写死白名单 | Pod 重建 IP 变化即失效 | 用 podSelector label；Pod IP 仅作调试 |
| 沙箱互隔只测单向 | B→A 反向漏测 | ingress/egress 双向各测一次（实测两条都需策略覆盖） |
| 拦截表现为 refused 而非超时 | 误判"端口没监听" | k3s netpol 是 REJECT；区分 rc=7(refused) 与 rc=28(timeout) 的含义 |

---

## SOP-B：敏感沙箱启用 Credential Vault（按需叠加）

### B1. 硬前提 checklist（任一不满足不要开）

- [ ] server `[egress].image` 已配置，`[egress].mode = "dns+nft"`（**DNS-only 模式 vault 拒绝激活**）。
- [ ] 沙箱 create 请求同时带：`networkPolicy`（`defaultAction="deny"`）+ `credentialProxy.enabled=true`。binding 的每个 host 必须被 policy 显式 allow（字符串一致，fail-closed 校验）。
- [ ] 沙箱 Pod 无 mesh sidecar（Istio/Envoy 注入互斥）；非 gVisor 运行时。
- [ ] （HTTPS 场景）沙箱镜像已信任 MITM CA（镜像预装，或用 sidecar 导出到 `/opt/opensandbox/mitmproxy-ca-cert.pem` 的 bootstrap 流程）。
- [ ] 池化注意：`credentialProxy.enabled` 与 `poolRef` 互斥（池分配路径拒绝该字段）；敏感沙箱走独立 create 或独立 Pool 模板预置 sidecar。

### B2. 凭据推送（受信控制面 → sidecar vault API）

```bash
# 端点：egress sidecar 18080，鉴权头 OPENSANDBOX-EGRESS-AUTH: <OPENSANDBOX_EGRESS_TOKEN>
POST /credential-vault          # 首次创建（唯一创建入口），体：{credentials:[...], bindings:[...]}
GET  /credential-vault          # 只读脱敏元数据（无明文）
PATCH /credential-vault         # 原子轮换：{expectedRevision?, credentials:{add/replace/delete}, bindings:{...}}
DELETE /credential-vault        # 清空

# binding 样例（apiKey 注入）
{"credentials":[{"name":"kb-token","source":{"type":"inline","value":"<真实token>"}}],
 "bindings":[{"name":"kb-api",
   "match":{"schemes":["http"],"hosts":["kb.internal.example.com"],"methods":["GET"],"paths":["/api/*"]},
   "auth":{"type":"apiKey","name":"X-Api-Key","credential":"kb-token"}}]}
```

auth 类型：`bearer` / `basic`（值=base64(user:pass)）/ `apiKey`（自定义 header 名）/ `customHeaders` / `passthrough`（配合 `substitutions` 做 path/query/body 占位符替换）。

**轮换**：业务层保存原始凭据引用 → 定期/触发式 `PATCH`（带 expectedRevision 乐观锁）→ 沙箱内请求即刻生效，沙箱全程无明文。

### B3. 上线前验证（10 分钟）

1. `GET /credential-vault`（带 token）→ 确认 revision 与 binding 元数据，**确认响应无明文**。
2. 沙箱内不带凭据请求目标 host → 上游收到注入 header（用可控 echo/mock 上游核对）。
3. 沙箱内带**假值**同名 header → 上游仍收到真值（同名覆盖生效）。
4. 非白名单域名 → NXDOMAIN；白名单外 IP 直连 → 超时。
5. 不带 token 从沙箱内读/写 18080 → 401（沙箱无法自改 vault）。
6. 沙箱容器 CapEff 无 NET_ADMIN（`grep CapEff /proc/self/status` 位 12 = 0）。

### B4. 运行期陷阱（实测根因 + 上游明确项）

| 陷阱 | 后果 | 规避 |
|---|---|---|
| **Host 形式不一致**（客户端发短名 `a.b.svc`，binding 写 FQDN `a.b.svc.cluster.local`） | binding 不命中 → **静默不注入**（无报错） | 客户端统一用 FQDN；或 policy/binding 同时覆盖两种形式。排障：挂用户 addon（`OPENSANDBOX_EGRESS_MITMPROXY_SCRIPT`）打印 `flow.request.host` |
| binding host 未被 egress policy 显式 allow | vault 写操作 400 fail-closed | 先 `POST /policy` 补白名单，再 `PATCH` binding |
| HTTP 注入未声明 scheme | 不注入（默认仅 https） | binding 显式 `schemes:["http"]`（内网 HTTP mock/服务） |
| 同一请求命中多个 binding | fail-closed 拒绝请求 | binding 按 host+path 收窄，避免重叠 |
| 沙箱内拿不到明文但**上游能看到** | 响应 body 回显凭据不脱敏 | mock/echo 上游要可控；红队审计关注上游日志 |
| sidecar 重启/重建/pause-resume | 内存态 vault 丢失，注入静默停止 | 受信控制面持有凭据引用，沙箱恢复后**重推**再放行业务（K8s pause 会重建 Pod，必丢） |
| 明文出现在推送路径 | 127.0.0.1:18080 / server→sidecar 链路 | 推送走受信网络面；开启 `OPENSANDBOX_EGRESS_CREDENTIAL_VAULT_REQUIRE_TLS`（有反代终止 TLS 时配 `TRUSTED_PROXY_CIDRS`） |
| default-allow 策略 | 安全告警、凭据目的绕过风险 | 一律 `defaultAction:"deny"` |

### B5. 什么时候不要用 Vault

- 业务已按 D-8 用 taskTemplate env 注入、无强合规诉求 → 维持现状（省一个 sidecar）。
- 目标服务无法配合"host/path 固定形态"（binding 无法稳定匹配）→ 先治理上游再上 Vault。
- 沙箱需要访问大量异构域名（白名单维护成本爆炸）→ 重新评估网络边界，而不是堆规则。

---

## SOP-C：排障速查

| 症状 | 先查 | 工具/命令 |
|---|---|---|
| 沙箱出向全断 | DNS 是否放行 | `getent hosts <域名>`；netpol egress 第一条规则 |
| 白名单目标不通（netpol 路径） | egress 端口是否写成 svc 端口；label 是否命中后端 | `kubectl get pod --show-labels`；`curl -m4 -v` 看 refused/timeout |
| 沙箱被分配后任务卡住 | ingress 是否放行管理面 ns；5758/44772 可达性 | 管理 ns 跳板 `curl pod:5758`；BS alloc-status 注解 |
| Vault 不注入（无报错） | **Host 形式**；binding 是否命中 fail-closed；80/443 之外端口 | addon 文件日志（见 B4）；conntrack 抓 `--dport 80` 应答是否来自 18081；active.sock 直连 `GET /credential-vault/_active` |
| Vault 写入 400 | binding host 是否被 policy 显式 allow；端口字段（已废弃） | 错误消息即答案；hosts 补齐后重 PATCH |
| Vault 注入突然停止 | sidecar 是否重启过（内存态丢失）；pause/resume | `kubectl logs -c egress` 看 mitmdump 重启；重推 vault |
| 沙箱能改 iptables？ | 主容器 NET_ADMIN 必须被 drop | `grep CapEff /proc/self/status`（位 12） |

## 演进跟踪

- **OSEP-0022 fleet MITM**：server 编排（phase 1b）落地后，第 2 层可下沉为"每 Pod 一份 egress、多 subject 共享"，池化场景可大规模启用域名级管控 + Vault → 回访本文档。
- **上游 #1594**（策略磁盘化 + vault 加密持久化）：落地后消除"分配后重推 vault"的编排负担。
- **上游 #1647**（port-scoped rules）：binding/规则端口粒度演进。
- 相关：D-7（池化去 sidecar）、D-8（taskTemplate env 注入为短期方案）。
