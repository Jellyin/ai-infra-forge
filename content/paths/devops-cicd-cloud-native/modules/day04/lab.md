---
title: 实验4 · 用开源扫描器接出一条会阻断、也会闭嘴的安全门禁
---

# 🧪 动手实验 · Day 4

> **目标**：不是学某个扫描器的用法，而是亲手把安全扫描接成一条**完整的链路**——「跑 → 出可回流格式的报告 → 按严重级别分级阻断 → 用 allowlist 收口误报」。同时亲手复现两个最容易骗过自己的覆盖率陷阱：**只扫了单架构镜像**、**门禁被静音**。
>
> 三档任选：**A 真环境**（有 GitLab 实例，验证回流与门禁）／**B 本地**（无 GitLab，docker 里跑开源扫描器）／**C 纸上**（15 分钟，纯推理）。

---

## 档位 A · 真环境（有 GitLab 实例或 gitlab.com 项目）

### 1. 接入官方安全模板并让它在 MR 上跑

```yaml
# .gitlab-ci.yml
stages: [test, security]

include:
  - template: Jobs/Secret-Detection.gitlab-ci.yml
  - template: Jobs/SAST.gitlab-ci.yml

variables:
  SAST_EXCLUDED_PATHS: 'spec,test,tests,tmp'

secret_detection:
  rules:
    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

> 模板名与变量**随版本演进，以官方文档为准**；先只接两三个模板，别一次全上。

### 2. 故意制造一个 finding，验证「回流到 MR」

在分支上提交一个**假**凭证（用明显假的占位串，别用真钥匙）：

```bash
git checkout -b feature/leak
echo 'AWS_SECRET_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE1111111111"' >> app/config.js
git add -A && git commit -m "oops" && git push -u origin feature/leak
```

去 **Merge requests** 创建 MR，然后观察并记录：

| 观察项 | 你的记录 | 说明 |
|---|---|---|
| MR 小组件是否出现发现 | | 有 → 报告回流成功（靠 `artifacts:reports`） |
| finding 是否标成「本 MR 新增」 | | 靠与默认分支基线对比 |
| Security 面板里有几条 | | 这是你的「分母」，不是「安全度」 |
| job 是失败还是仅告警 | | 模板默认多为告警，**真正的阻断要另配** |

### 3. 配一条分级阻断，体会「job 变红」与「拦住合并」的区别

到 **Secure → Policies** 建一条**合并请求审批策略**：扫描器 = Secret Detection，严重级别 ≥ Critical，允许条数 = 0，动作 = 要求审批。再开一个带假凭证的 MR——你会看到**流水线不一定红，但合并被钉死**。这才是门禁。

**记录**：把「job 失败」和「合并被拦」分成两栏写，它们的触发条件、谁能绕过，分别是什么？

---

## 档位 B · 本地（无 GitLab，docker 跑开源扫描器）

### 1. 依赖与凭证：一次跑起来

```bash
# 依赖的已知 CVE（SCA）+ 目录里的凭证 + 配置错误，一条命令三类
docker run --rm -v "$PWD:/src" aquasec/trivy fs \
  --scanners vuln,secret,misconfig --severity HIGH,CRITICAL /src

# 专门盯凭证，出 SARIF（可回流到 GitLab/Actions 的通用格式）
docker run --rm -v "$PWD:/src" zricethezav/gitleaks:latest \
  detect --source /src --report-format sarif --report-path /src/gitleaks.sarif

# 源码规则扫描（SAST），CI 规则集最适合入门
docker run --rm -v "$PWD:/src" semgrep/semgrep \
  semgrep ci --config p/ci --error
```

> 镜像名与子命令随版本演进（gitleaks 较新版本用 `git`/`dir` 子命令），拿不准先看 `--help`。

### 2. 复现「只扫一个架构」的覆盖率漏洞（本实验最重要的一步）

取一个多架构镜像，**分别**导出两个平台的 SBOM（顺带各自扫一遍 CVE）：

```bash
IMG=alpine:3.20
docker run --rm aquasec/trivy image --platform linux/amd64 \
  --format cyclonedx --output - $IMG > sbom-amd64.json
docker run --rm aquasec/trivy image --platform linux/arm64 \
  --format cyclonedx --output - $IMG > sbom-arm64.json
```

**记录**：两个平台的包列表/CVE 是否完全一致？如果 CI 里只写了 `--platform linux/amd64`（或没写，落到默认架构），你对 arm64 生产镜像的覆盖是多少？

| 平台 | 包数量 | HIGH/CRITICAL 数 | 是否被 CI 覆盖 |
|---|---|---|---|
| linux/amd64 | | | |
| linux/arm64 | | | |

### 3. 复盘门禁被静音的过程

在你熟悉的项目里找出所有**不发红但等于没拦**的写法：

```bash
grep -nE 'allow_failure|when: manual|\|\| true|--exit-code 0' .gitlab-ci.yml
```

**记录**：每一条属于「有意的信息性检查」还是「被静音的门禁」？谁决定的？有没有到期/责任人？

---

## 档位 C · 纸上（15 分钟，无需任何环境）

场景：某服务 MR 的 CI 结果如下（**不是**全绿，也不是全红）：

```
Secret Detection : FAILED  —— 命中 1 条：.env.example 里的 STRIPE_TEST_KEY（占位符，非真值）
SAST             : WARNING —— 新增 2 条 HIGH：SQL 由字符串拼接（参数化改造中）
Dependency Scan  : WARNING —— 新增 1 条 CRITICAL：某传递依赖的已知 RCE，有修复版本
Container Scan   : WARNING —— 新增 0 条，但只扫了 linux/amd64
DAST             : FAILED  —— 测试环境未就绪，扫描直接报错退出
License Scan     : INFO    —— 1 个 AGPL 依赖进入直接依赖
```

门禁策略：Secret Detection 硬拦；SAST/SCA 的 Critical+新增硬拦、High+新增需审批；DAST 不阻断（信息性）；License 仅报告。

先自己判断「这条 MR 该不该被拦住、拦在哪一条」，再看答案：

<details><summary>对照答案（先写完再看）</summary>

- **Secret Detection = FAILED 但其实是误报**：命中 `.env.example` 里的**占位符**。正确做法是给 Secret Detection 加排除路径或在策略里豁免该模式，**而不是**把整个 job 设成 `allow_failure: true`（那是静音）。若确为真凭证，唯一止血动作是**在 provider 侧轮换**，删文件不算修。
- **SCA 的 Critical+新增 → 硬拦**。有修复版本就直接升，这是门禁里「没有讨论空间」的一类。
- **SAST 的 2 条 HIGH → 需审批，不直接硬拦**：策略里「High+新增需审批」要求有人**逐条确认是否可利用**再放行，别让它变成点一下就过。
- **DAST = FAILED 但按策略不阻断**：它是信息性检查，「测试环境未就绪导致没跑」属于**已知而自知的不阻断**——危险的是把它当成了门禁。
- **Container Scan「新增 0 条」是假的安全**：只扫了 amd64，arm64 生产镜像覆盖为零。这条不该记「通过」，该记「覆盖率缺口」。
- **License 的 AGPL 传染性依赖**：不阻断，但必须进台账——它会在**分发**时变成问题，是法务/产品决策，不是 CI 能替你拍的板。

一句话结论：**该被「SCA Critical」硬拦，其余按等级分流；同时把「容器只扫 amd64」当作独立缺陷处理。**

</details>

### 最后一问（写下你的答案，Day 5 回看）

如果某个团队说「我们已经接入了 GitLab 全部安全模板，所以安全是达标的」。**写下三条你无法据此确认的事**：

1. ____________________
2. ____________________
3. ____________________

<details><summary>参考答案</summary>

至少包括：① 这些扫描是否**跑在 MR 上并把结果回流到 MR**（还是只跑在默认分支、甚至没人看那个面板）；② **容器镜像覆盖了哪几个架构**（只扫 amd64 是最隐蔽的谎言）；③ 门禁到底是**真阻断**还是 `allow_failure: true` / allowlist 无穷期地静音——「接入了工具」与「建立了门禁」是两回事，「门禁」与「被静音的检查」更是两回事。
</details>
