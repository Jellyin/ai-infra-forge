---
title: SBOM、SLSA 与签名验签
---

# Day 9 · SBOM、SLSA 与签名验签

## 9.1 先分清三样东西：SBOM ≠ provenance ≠ 签名

| 东西 | 回答的问题 | 谁生成 | 靠什么保证可信 |
|---|---|---|---|
| **SBOM**（物料清单） | 「制品**里面有什么**组件」 | 构建后扫描镜像 | 无——本身不自带可信性 |
| **provenance**（构建来源证明） | 「制品是**怎么、由谁构建出来的**」 | 构建平台 | 由构建平台签名（attestation） |
| **签名**（signature） | 「制品/声明的**完整性与身份**」 | 构建方/发布方 | 密码学 |

三者可互引（provenance 可带 SBOM digest），不能互替：**SBOM 说有什么、provenance 说怎么来的、签名说没被动过。**

## 9.2 SBOM：CycloneDX / SPDX，何时生成、放哪

- **CycloneDX**（OWASP）：JSON/XML，偏安全用例，`vulnerabilities` 段可带漏洞。
- **SPDX**（Linux Foundation，ISO/IEC 5962:2021）：偏许可证与合规。

**生成时机**：构建后扫**最终镜像**；基础镜像系统包常是漏洞大头。

```bash
# syft 从镜像生成 SBOM
syft registry.example.com/api:1.4.0 -o cyclonedx-json > sbom.cdx.json
syft registry.example.com/api:1.4.0 -o spdx-json       > sbom.spdx.json
# 或用 trivy 一并产出
trivy image --format cyclonedx --output sbom.cdx.json registry.example.com/api:1.4.0
```

**放哪**：别只当流水线产物（会过期），**与制品绑定**，作 attestation 附同一 digest：

```bash
cosign attach sbom --sbom sbom.cdx.json registry.example.com/api@sha256:ac1f0e...
```

## 9.3 SLSA 分级：每一级到底保证什么

SLSA **v1.0** 的 **Build track** 有 1–3 级：

| 级别 | 保证 | 前提 / 意味着什么 |
|---|---|---|
| **Build L1** | 有 provenance，记录构建过程与产出 | 只要求**存在**证明；不保证不可伪造。防「事后说不清怎么构建的」 |
| **Build L2** | provenance **由可信构建平台**生成并签名 | 需平台托管构建、签名对用户不可见。防「构建后替换/篡改证明」 |
| **Build L3** | 构建平台**加固**、用户步骤**无法访问签名密钥**、环境隔离 | 需受控隔离的构建环境。防「构建过程被投毒以伪造 provenance」 |

> 旧版 SLSA 为 1–4 级，v1.0 重组成 track + 级别（**以 slsa.dev 为准**）。多数团队目标 **L2**；**L3 需控制构建环境隔离**，runner 不够加固反而降级。

**该到几级**看**威胁模型**：环境可信 → L2；制品外流再谈 L3。

## 9.4 provenance（attestation）与它的内容

provenance 是一份 **in-toto attestation**（签名 JSON 信封），核心是 **SLSA provenance predicate**：

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "registry.example.com/api", "digest": { "sha256": "ac1f0e..." } }],
  "predicateType": "https://slsa.dev/provenance/v1",
  "predicate": {
    "buildDefinition": { "buildType": "https://github.com/...", "externalParameters": { "source": "<commit>" } },
    "runDetails": { "builder": { "id": "https://gitlab.com/..." }, "metadata": { "invocationId": "..." } }
  }
}
```

`subject.digest` 把 provenance **钉在具体制品**上。生成（BuildKit/GHA 亦可原生产出，**以官方文档为准**）：

```bash
# cosign 附加 provenance attestation（predicate 文件自行生成）
cosign attest --predicate provenance.json --type slsaprovenance \
  registry.example.com/api@sha256:ac1f0e...
```

## 9.5 cosign 两条签名路：keyless 与密钥

**路线一 · keyless（推荐默认）**：不持长期私钥，用 **OIDC 身份**换**短期证书**：CI 的 OIDC → **Fulcio** 签分钟级证书（绑定身份 ↔ 本次公钥）→ 签名记入 **Rekor** 透明日志；无长期私钥可泄露。

```bash
# keyless：CI 里带 OIDC 身份直接签（本地走浏览器 OIDC 流程）
cosign sign --yes registry.example.com/api@sha256:ac1f0e...
```

**路线二 · 密钥签名**：自管密钥对，适合离线/无 OIDC 环境，代价是**要保管私钥**。

```bash
cosign generate-key-pair                       # 生成 cosign.key / cosign.pub
cosign sign --key cosign.key <image>           # 用私钥签
cosign verify --key cosign.pub <image>         # 用公钥验
```

**验签（keyless 必须同时给出身份与 issuer）**：

```bash
cosign verify registry.example.com/api@sha256:ac1f0e... \
  --certificate-identity-regexp 'https://github.com/org/repo/.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

> keyless 验签（v2+）**必须**显式给 `--certificate-identity*` 与 `--certificate-oidc-issuer`，identity/issuer 格式随平台而异，**以官方文档为准**。

## 9.6 多架构镜像：对 index 签还是对单架构签

规则与 Day 8 晋升一致：**对 index（manifest list）签**。

- tag 解析到 **index digest**；**签 index** 才能让 `cosign verify <tag>` 通过。
- 只签单架构 manifest，按 tag（解析到 index）拉取会**找不到 index 签名**。
- 需覆盖两者就签**全部相关 digest**（部分版本支持 `--recursive`，**以文档为准**）。

**要点**：签什么、验什么必须**一一对应**——**签 index digest、验 index digest**。

## 9.7 准入端验签：让未签名的镜像进不来

**Kyverno** 内建 `verifyImages`（keyless attestor 直接支持 Fulcio/Rekor）：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signature
spec:
  validationFailureAction: Enforce     # 拒绝，而不是只告警
  rules:
    - name: check-signature
      match:
        any:
          - resources:
              kinds: [Pod]
      verifyImages:
        - imageReferences:
            - "registry.example.com/prod/*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/org/repo/.github/workflows/build.yml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
```

**OPA Gatekeeper** **不原生验签**；需外挂验证器（如 **Ratify**）把结果喂给策略——**装了 Gatekeeper ≠ 会验签**（**以文档为准**）。

**验签失败怎么办**：prod 应 **fail-closed（拒绝部署）**，并把失败接进告警。

## 9.8 密钥 / 身份的生命周期

**keyless** 证书用完即弃、无轮换负担，要治理**身份**（OIDC subject 规则、分支限制）与 **Fulcio/Rekor 信任根**；**密钥签名**私钥进 KMS/Vault、有轮换与吊销。共同点：**信任根怎么分发、怎么更新**，不一致就会集体验签失败。

## 9.9 今天的判断力

- 看到「我们有 SBOM」：**它在哪、谁会用、和哪个 digest 绑定？**
- 看到「到 SLSA Lx」：**威胁模型是什么、环境是否真加固？**
- 看到签名：**验签端在哪、失败是拒绝还是放行？**
- 看到多架构：**签的是 index 还是单架构，验的又是哪个？**
