---
title: 实验九 · 让「这个镜像是我构建的」可被机器验证
---

# 🧪 动手实验 · Day 9

> **目标**：不是背 cosign 命令，而是**亲手走通「生成 SBOM → 签名 → 准入端验签」这条链**，并看清 SBOM / provenance / 签名三者各自能证明什么、证明不了什么。
>
> 三档任选：**档位 A 真环境**（K8s 集群 + registry + cosign + Kyverno）／**档位 B 本地**（docker + cosign + syft/trivy，无需云，用本地密钥签名）／**档位 C 纸上**（15 分钟，给一批镜像与其签名/来源事实，判断哪些会被准入端拒绝）。

---

## 档位 A · 真环境（集群 + registry）

### 1. keyless 签名，再验签

在带 OIDC 身份的 CI job 里（本地手动则走浏览器流程）：

```bash
export IMAGE=registry.example.com/api@sha256:ac1f0e...
cosign sign --yes $IMAGE
```

验签（**身份与 issuer 必须显式给出**，否则等于没验）：

```bash
cosign verify $IMAGE \
  --certificate-identity-regexp 'https://github.com/org/repo/.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

| 观察项 | 你的记录 |
|---|---|
| 签名后 registry 里多了什么 tag/附件 | |
| 把 issuer 改成一个错的，验签是否失败 | |
| 把 image 换成不存在的 digest，报错信息是什么 | |

### 2. 用 Kyverno 拒绝未签名镜像

部署 9.7 的 `ClusterPolicy`（`validationFailureAction: Enforce`），然后：

```bash
kubectl run signed   --image=registry.example.com/prod/api@sha256:ac1f0e...
kubectl run unsigned --image=registry.example.com/prod/api:latest   # 刻意用未签名的
```

**关键观察**：未签名/来源不符的 Pod **应当被拒绝创建**（admission 阶段直接失败），而不是创建后再告警。记下被拒的报错。

> 若你的集群用 Gatekeeper：记住它**不原生验签**，需要外挂 Ratify 之类的验证器——先确认这条链是通的，否则策略形同虚设。

---

## 档位 B · 本地（docker + cosign + syft/trivy，无需云）

keyless 依赖 OIDC 与网络；离线时用**本地密钥**跑通同样的链路，行为一致。

### 1. 生成 SBOM 并附着

```bash
docker build -t demo:1 .
syft demo:1 -o cyclonedx-json > sbom.cdx.json
head -c 400 sbom.cdx.json        # 看它是不是真列出了组件与版本
```

### 2. 生成密钥并对镜像签名

```bash
cosign generate-key-pair                 # 生成 cosign.key / cosign.pub（会提示设密码）
cosign sign --key cosign.key demo:1
cosign verify --key cosign.pub demo:1    # 应通过
```

### 3. 篡改制品，验证签名会失效

```bash
# 重新构建同名 tag（内容变了，digest 变了）
docker build --no-cache -t demo:1 .
# 对「新内容」用公钥验旧签名 —— 语义上应视为失败/需对不上
cosign verify --key cosign.pub demo:1 || echo "验签失败：制品已不是当初签名的那一份"
```

| 实验 | 期望结果 |
|---|---|
| 未改动的 `demo:1` 验签 | 通过 |
| 重建后同名 `demo:1` 验签 | digest 变，验证的已不是被签制品 |
| 缺 issuer/identity 的 keyless 验签 | 拒绝——不给出身份等于没验 |

写下：**SBOM 与签名分别证明了什么**？把答案和 9.1 的表格对照。

---

## 档位 C · 纸上（15 分钟，判断谁能通过准入）

某集群准入策略要求：**镜像必须带有效的 keyless 签名，且签发 issuer 为 `https://gitlab.com`、identity 属于 `org/repo`，同时存在一份 provenance attestation。** 多架构服务按 tag 拉取。下面是四个候选镜像，判断各自能否通过，并说明原因。

```
A. api@sha256:aa11...  签名：有（issuer=gitlab.com, identity=org/repo 的 main）
                       provenance：有   SBOM：有
B. web@sha256:bb22...  签名：有，但只对 amd64 单架构 manifest 签了；
                       消费者的 tag 解析到的是 index digest —— 未对 index 签名
C. batch@sha256:cc33... 签名：有（issuer=github.com, identity=someone-else/repo）
D. cron@sha256:dd44... 签名：有（issuer=gitlab.com, identity=org/repo 的 main）
                       但没有任何 provenance attestation
```

另外，部署清单写的是：

```yaml
image: registry.example.com/web:1.4.0     # 可被覆盖的 tag
```

<details><summary>对照答案（先写完再看）</summary>

1. **A 通过**：签名有效、issuer 与 identity 都满足、provenance 与 SBOM 齐全——四项都命中。
2. **B 不通过**：只对 **amd64 单架构**签了名，但 consumer 按 tag 拉取解析到的是 **index digest**，准入端校验 index 时找不到对应签名。**这说明「对 index 签还是对单架构签」不是细节，而是决定验签成败的设计选择**——应签 index digest。
3. **C 不通过**：issuer 是 `github.com`、identity 是他人仓库——**签名有效但身份不符**。这正是「验签必须同时校验身份与 issuer」的意义：只验「有签名」会被异源签名蒙混过关。
4. **D 不通过**：有签名但**缺 provenance**。签名证明「没被篡改、是谁签的」，但回答不了「这份制品是怎么、由哪条流水线构建出来的」——策略既然要求 provenance，它就过不了。这印证 SBOM / provenance / 签名三者不可互相替代。
5. （加分）**部署清单用可变 tag**：即便准入端按 tag 解析时验签通过，tag 将来被覆盖成另一个未签名的 digest 就会在下次拉取时被拦（好事）或让节点缓存旧镜像（引入漂移）。应钉死 digest。

</details>

### 最后一问（写下你的答案）

假设你已经让准入端 **fail-closed**：验签不过就拒绝部署。现在生产环境**突然大面积 Pod 无法创建**，报「签名验证失败」。**在不回滚策略的前提下，你会按什么顺序排查**？写下前三条：

1. ____________________
2. ____________________
3. ____________________

<details><summary>参考答案</summary>

先分「**签发侧变了**」还是「**信任侧配错了**」，而不是先删策略。① 查信任根：准入策略里配置的 **issuer/identity 规则、Fulcio roots** 是否与当前签发方一致（gitlab.com 的 OIDC issuer URL 变过吗？identity 前缀改过吗？）——最可能是策略配置漂移。② 查签发侧：新构建的镜像**这个 digest 到底有没有签名、签的是 index 还是单架构**（是不是有人改了流水线，只签了单架构）。③ 查 Rekor / 透明日志与证书有效期：证书是否已在签发时或之后过期、签名事件是否存在。**注意**：把策略临时改成 `Audit`（放行但告警）作为止血手段是可以的，但必须记录、限时、有人跟进——**把 fail-closed 悄悄改成 fail-open 才是事故**。这就是「验签失败的运维处置流程」要提前定的原因。

</details>
