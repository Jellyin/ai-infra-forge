---
title: 密钥与身份治理
---

# Day 10 · 密钥与身份治理

## 10.1 CI 变量的分层：masked / protected / environment 作用域

一把钥匙开所有门，是 CI 泄密的头号成因。三层机制把「谁能看到、在哪能看到」收窄：

| 机制 | 作用 | 边界（它**不**保证什么） |
|---|---|---|
| **Masked**（掩码） | 让变量的值在 **job 日志**里显示为 `[MASKED]` | 只挡**原样**出现；编码过、切片过、拼进 URL 就绕过；某些字符/多行值本就无法掩码 |
| **Protected**（受保护） | 变量**只注入到受保护分支 / tag 的 job** | 不约束受保护分支上**能改 CI 配置的人**；也不防止 job 主动外传 |
| **Environment 作用域** | 变量只在指定 environment 的 job 里存在 | 依赖 environment 定义正确，否则形同虚设 |

要点：**masked 是减少「误入日志」的护栏，不是安全边界**——真正的边界是 **protected + environment + 最小权限的短期凭证**。GitHub Actions 侧对应 `secrets` / environment secrets（带审批）与变量 `vars`。**字段随平台演进，以官方文档为准。**

## 10.2 变量泄露的常见路径

泄露几乎不来自「有人攻破 CI」，而是**设计上就漏**。逐条对照你的流水线：

- **日志**：`echo $TOKEN`、`set -x`、密钥塞进 URL 被打印；masked 只挡原样，`base64` 一下就穿。**排错时临时打印密钥，是最常见的自伤。**
- **Artifact / 缓存**：`.env`、`.npmrc`、`kubeconfig` 写进产物或被缓存——会**长期保存**且可下载。
- **Fork PR**：GitHub 默认**不给** fork 的 `pull_request` 传 secrets；但改用 **`pull_request_target`** 后 job 会带**基仓库 secrets**运行——若又 checkout 了 PR 代码，攻击者改一行就能拿密钥。
- **被改动的 job**：能改 `.gitlab-ci.yml` / workflow 的人都能加一步外传密钥，所以**受保护分支 + 环境审批**必需。
- **第三方镜像 / service**：能读环境变量的镜像/service 就拿到密钥。**别对未固定 digest 的第三方镜像开放凭证。**
- **调试开关**：`CI_DEBUG_TRACE`、Actions step debug 会打印环境变量——开着它跑含密钥的 job 等于主动泄露。

## 10.3 OIDC 免密上云：信任模型要点（AWS / GCP / Azure）

**免密**的核心：CI **不持有**云上长期密钥，而用 **OIDC 令牌**换一份**短期**云凭证；云侧信任的是「一个身份 + 一组条件」。三家骨架相同——**issuer、audience、subject 条件**：

| 云 | issuer | audience | 主体条件（限制谁能换） | 换取的凭证 |
|---|---|---|---|---|
| **AWS** | `token.actions.githubusercontent.com`（OIDC provider） | `sts.amazonaws.com` | 条件键 `<provider>:sub`，如 `repo:org/repo:ref:refs/heads/main` | `sts:AssumeRoleWithWebIdentity` 的短期 STS 凭证 |
| **GCP** | Workload Identity Pool 里的 OIDC provider | provider 定义的 audience | 属性映射 + attribute condition（如限制 `assertion.sub`） | 池内 principalSet 冒充服务账号，换短期 access token |
| **Azure** | federated identity credential 的 issuer | `api://AzureADTokenExchange` | federated credential 的 subject，如 `repo:org/repo:ref:refs/heads/main` | Entra ID 令牌（`azure/login` 换取） |

**写出信任策略的四个铁律：**

1. **subject 条件收窄到具体分支/环境**——`repo:org/*`、`repo:org/repo:*` 等于对全会开放。
2. **audience 精确匹配**，别放过期/测试 audience。
3. **权限只给这次要用的**：换来的角色只挂当次 job 需要的策略。
4. **资源生命周期短**：STS/令牌 TTL 已是小时级，别换成长期密钥存起来。

CI 侧：GitHub Actions 需 `permissions: id-token: write`，令牌从 `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` 取（官方 action 会替你取）。**界面路径随平台演进，以官方文档为准。**

## 10.4 Vault 与动态凭证

OIDC 解决「CI 到云」；**Vault 解决「CI 到任意数据源」**，把静态密钥换成**按需签发、到期即废**的动态凭证。

- **认证**：开 **JWT/OIDC** auth method 接受 CI 的 OIDC 令牌，role 上用 `bound_claims` 绑定 `sub`/`aud`——**和云的 subject 条件同思路**。
- **动态凭证**：database engine 每次签发**有 TTL 的新**账号；AWS engine 签发短期 STS；PKI 签发短期证书。随 lease 过期自动失效。
- **一次性交付**：response wrapping 把密钥包进一次性 token，只让目标取出。

```bash
vault write auth/jwt/login role=ci jwt=@/tmp/oidc-token   # 用 CI 身份换 Vault token
vault read database/creds/readonly                        # 换取一份短期数据库凭证
```

**收益**：不再有「一个数据库密码用两年」；泄露一个动态凭证，影响面被 TTL 和权限**天然限制**。

## 10.5 最小权限与「一个 job 一个身份」

原则：**每个 job 用一个恰好够用的独立身份**。

- **别共用万能身份**：build、test、deploy、scan 各用各的角色，subject 各自收窄到需要的分支/环境。
- **权限按 job 最小化**：deploy 才有生产写权限，test 只读。
- **审计要求「一个 job 一个身份」**：出事要能答「**哪个 job、哪次运行**动的手」，共用身份让这不可能。

## 10.6 密钥泄露应急：轮换、审计、影响面

发现泄露后，顺序**几乎总是先轮换，而非先删代码**——**从代码里删掉值不会让它变「没泄露过」**，旧值已经在外。

1. **轮换**：到 **provider 侧**作废旧凭证、签发新凭证。删除 ≠ 收回。
2. **审计**：查 CloudTrail / Cloud Audit Logs / Azure Activity Log、GitLab audit events、Rekor，还原谁在何时用它做了什么。
3. **影响面**：这个身份**本可以**够到什么——按「它理论上能做的全部」评估。
4. **清场**：作废相关会话/token，检查是否**种了持久化**（新密钥、新 IAM 用户、新 webhook）。
5. **收口**：缩短 TTL、收紧 subject、把长期密钥换成 OIDC/Vault——**把教训变成架构改动**。
6. **通报**：按合规与影响面决定通知谁、多快。

## 10.7 今天的判断力

- 看到 CI 变量里有长期密钥，先问「**为什么不是 OIDC / Vault 动态凭证**」。
- 看到 `pull_request_target` + checkout PR 代码，直接判红。
- 看到 masked secret，记住它只是**日志护栏**，不是权限边界。
- 看到「全是同一个云角色」，问「**一个 job 一个身份**在哪」。
- 看到泄露，第一反应是**轮换**，不是删代码。
