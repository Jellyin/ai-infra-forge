---
title: 实验十 · 消灭长期密钥，看清一次泄露
---

# 🧪 动手实验 · Day 10

> **目标**：不是背 OIDC 概念，而是**亲手验证「masked 挡不住泄露」「fork PR 会带来密钥风险」**，并**走查一遍自己项目的长期密钥**。
>
> 三档任选：**档位 A 真环境**（GitLab/云项目 + 集群）／**档位 B 本地**（docker + 一个能解码 JWT 的工具，无需云）／**档位 C 纸上**（15 分钟，给一份 CI 变量清单 + 一个 fork PR 场景 + 一次泄露事件，找出问题并排出应急顺序）。

---

## 档位 A · 真环境（GitLab/云项目）

### 1. 验证 masked 挡不住「变形后的密钥」

在含 masked 变量的 job 里，**不要 echo**，而是编码后再输出（模拟攻击者）：

```yaml
leak-mask-bypass:
  variables:
    API_TOKEN: "s3cr3t-token-value"      # 设为 masked
  script:
    - echo "直接打印：$API_TOKEN"          # 日志里显示 [MASKED]
    - echo "$API_TOKEN" | base64           # 掩码只挡原样 —— 这里会漏出！
```

**记录**：第二行是否把密钥以 base64 形式打进了日志？这说明 masked 是**日志护栏**，不是安全边界。

| 观察项 | 你的记录 |
|---|---|
| 直接 echo 是否被掩码 | |
| base64 后是否漏出 | |
| 该变量是否 protected、是否限定 environment | |

### 2. 配一条 OIDC 免密链路（至少一家云）

以 AWS 为例（**界面路径随平台演进，以官方文档为准**），要点是**信任策略里的条件**：

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:org/repo:ref:refs/heads/main"
    }
  }
}
```

**验证**：把 `sub` 条件先写成通配（`repo:org/*`），再收窄到具体分支，观察「非该分支能否换取凭证」。**通配的信任策略＝对全会开放。**

---

## 档位 B · 本地（docker + JWT 解码，无需云）

### 1. 看清 OIDC 令牌里到底有什么

CI 取到的 OIDC 令牌是一个 **JWT**。本地把它的 payload 段解码，看云侧靠哪些字段做信任判断：

```bash
# 令牌形如 header.payload.signature，只看 payload（base64url 解码）
TOKEN='eyJ...eyJ...'          # 从 CI 环境变量取（示例占位）
echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null; echo
```

关注 `iss`（issuer）、`aud`（audience）、`sub`（主体，形如 `repo:org/repo:ref:refs/heads/main`）——**云侧信任策略里的条件，就是在校验这三个字段**。

| 字段 | 值 | 云侧为什么校验它 |
|---|---|---|
| `iss` | | 确认令牌来自可信的 CI IdP |
| `aud` | | 确认令牌是发给「我这个云」的 |
| `sub` | | 收窄到具体分支/环境，防止任一工作流都能换凭证 |

### 2. 用扫描器抓仓库里的失陷密钥

```bash
# gitleaks 扫历史里被提交过的密钥（示例，参数随版本演进，以官方文档为准）
gitleaks detect --source . --report-format json --report-path leaks.json
```

**关键认知**：扫出来的每一条，处置第一步都是**去 provider 轮换**，而不是「从 git 历史里删掉」——**删除不会让旧值变回秘密**。

### 3. 复现 masked 绕过（纯本地）

```bash
TOKEN='s3cr3t-token-value'
echo "直接打印：$TOKEN"
echo "$TOKEN" | base64        # 编码后掩码匹配不到
```

写下：你的项目里，**哪些 job 会把环境变量写进日志或产物**？

---

## 档位 C · 纸上（15 分钟，读配置下判断）

### 材料一：CI 变量与 job 配置

```yaml
variables:
  PROD_DB_PASSWORD: "hunter2"          # masked=false, protected=false, 无 environment 限定
  CLOUD_ACCESS_KEY: "AKIA..."          # masked=true,  protected=true,  无 environment 限定

deploy-prod:
  environment: production
  script:
    - echo "deploying..."
    - curl -H "Authorization: Bearer $CLOUD_ACCESS_KEY" https://deploy.internal/trigger
```

### 材料二：一个 fork PR 的 workflow

```yaml
# .github/workflows/build.yml
on: pull_request_target          # ← 注意触发器
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ github.event.pull_request.head.sha }}" }   # ← checkout 了 PR 的代码
      - run: make build           # 这一步会带着基仓库的 secrets 运行
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
```

### 材料三：一次泄露的时间线

```
09:12  某人为了排查，在 job 里 echo 了一个长期云密钥（protected，未 masked）
09:13  日志被多人访问；密钥被外部人抓取
09:40  运维从代码与变量里删除了该密钥，认为「已处理」
```

<details><summary>对照答案（先写完再看）</summary>

1. **`PROD_DB_PASSWORD` 未 masked、未 protected、无 environment 限定**：任何分支的任何 job、任何人推送的 MR 都可能读到生产库密码。应改为 protected + 限定 environment，并且**根本不该有长期 DB 密码**——用 Vault 动态凭证。
2. **`CLOUD_ACCESS_KEY` 是长期密钥**：即便 masked+protected，也应换成 **OIDC 换短期凭证**，让它没有可泄露的长期值。
3. **密钥进了 URL / 请求头被打印**：`curl -H "Authorization: Bearer $CLOUD_ACCESS_KEY"` 若开了 trace 会泄露——应避免把凭证放进会回显的位置，或改用免密。
4. **`pull_request_target` + checkout PR 代码**：这是最严重的一条。job 带着**基仓库的 `DEPLOY_TOKEN`** 运行，而执行的却是**攻击者能改的代码**（`make build`），改一行即可外传 token。应按需改成 `pull_request`（默认不传 secrets），或严格不 checkout 未信任的 head 代码。
5. **材料三的处置是错的**：删掉不等于收回。**第一步应是到 provider 轮换（作废旧密钥、签发新的）**，再审计（谁在 09:13 之后用了它、做了什么）、评估影响面、清场、收口。删代码只避免了「继续暴露」，没有让已泄露的值失效。

</details>

### 最后一问（写下你的答案）

现在把材料二改「安全」了：不再用 `pull_request_target`，CI 也全面换成 OIDC 免密。**这是否意味着密钥泄露的风险彻底消失了**？写下你认为**仍然存在**的两类风险：

1. ____________________
2. ____________________

<details><summary>参考答案</summary>

没有消失，只是**换了个面**。仍然存在：① **身份本身被滥用**——OIDC 只是把「长期密钥」换成「谁都能触发的换凭证动作」；若信任策略里的 `sub` 条件写得太宽（如 `repo:org/*`），任何分支/任何人改一行工作流就能用同一身份换到凭证，泄露面从「一个密钥」变成「一条可被改动的路径」。② **换取后的短期凭证在 TTL 内被滥用/外传**——凭证短到小时级，但这段时间里它一样能被用来读数据、改资源、种持久化。③ 还有：能改 CI 配置的人仍能把自己的凭证打出去、第三方镜像/service 仍能读到环境变量、产物与缓存仍可能夹带。所以治理不是「上一道 OIDC 就完事」，而是**身份收窄 + 权限最小 + 审计可追 + 轮换可执行**四条一起。

</details>
