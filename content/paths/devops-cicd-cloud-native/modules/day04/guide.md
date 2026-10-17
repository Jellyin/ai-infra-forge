---
title: CI 内嵌的安全与质量工具链
---

# Day 4 · CI 内嵌的安全与质量工具链

## 4.1 位置：扫描是一等公民，不是发版前的仪式

安全工具链最常见的失败不是「工具选错了」，而是**位置放错了**：所有扫描堆进发版前最后一个 job，一次冒几百条 finding，没人有动机分诊，结局只有两种——整体 `allow_failure: true`，或干脆删掉那几个 job。两者都是「看起来有安全」，与 Day 1 的假绿灯同源。

正确位置：扫描与单测同级——**在 MR 上跑、结果回流到 MR、分级阻断**。差异在信号质量：扫描误报远高于单测，且依赖运行期上下文。所以重点不是「跑起来」，而是**分诊、基线、allowlist 与回收**——单测问「它坏了吗」，扫描问「这里有没有**可能**被利用的模式」，后者天然带概率，当布尔门禁必然失败。

## 4.2 GitLab 内置模板：覆盖 80%，也留下那 20%

```yaml
include:
  # 注意路径：现行模板在 Jobs/ 下（Security/ 是仍能解析的旧路径，旧博客里常见，别照抄）
  - template: Jobs/SAST.gitlab-ci.yml
  - template: Jobs/Secret-Detection.gitlab-ci.yml
  - template: Jobs/Dependency-Scanning.gitlab-ci.yml
  - template: Jobs/Container-Scanning.gitlab-ci.yml
  # GitLab 自己并不统一：DAST 目前仍挂在 Security/ 下（Jobs/DAST.gitlab-ci.yml 不存在）
  # - template: Security/DAST.gitlab-ci.yml
  # License Scanning 模板已移除，不要再 include

# 默认 rules 只覆盖分支；要在 MR 上就拦，得自己追加
sast:
  rules:
    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

container_scanning:
  variables:
    CS_IMAGE: '$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA'          # 指向本次构建产物
    CS_DISABLE_LANGUAGE_VULNERABILITY_SCAN: 'true'         # OS 包归容器扫描，语言依赖交给 SCA
  artifacts:
    reports:
      container_scanning: gl-container-scanning-report.json   # 靠这个键回流面板/MR
```

**覆盖**：装工具、配 runner、出报告、渲染 MR 组件全免。**局限**（考点）：① 默认 `rules` 面向分支/默认分支，MR 上拦要自己加；② 只给原始结果、不给策略（几条 High 才该拦是你的事）；③ 扫描器版本与语言覆盖受模板约束，深度分析默认未必开；④ 变量名、报告键、弃用状态**随版本演进，以官方文档为准**。

## 4.3 六类扫描：能发现什么、发现不了什么

| 扫描 | 典型发现 | 明确发现不了 |
|---|---|---|
| **SAST** | 注入、危险 API、硬编码凭证等源码**模式** | 运行期才成立的漏洞、跨服务逻辑缺陷；误报高 |
| **SCA** | 依赖的已知 CVE、可升级版本、部分传递依赖 | 0-day、库被**误用**、供应链投毒 |
| **Secret Detection** | 提交/历史中的凭证、token、私钥模式 | 非标准自研密钥；且**命中即已泄露**，删文件不算止血 |
| **容器扫描** | 镜像内 OS 包与语言依赖 CVE | 宿主/编排配置、运行期行为；**只覆盖被扫的那个架构** |
| **License** | 许可证类型（GPL/AGPL 传染性等） | 许可证**实际如何被用**；独立模板正逐步并入依赖扫描 |
| **DAST** | 运行中应用的注入、认证、CORS、报头问题 | 需业务上下文的逻辑漏洞；最慢最贵、最靠右 |

一句话：**越靠左越便宜、离「真实可利用」越远；越靠右越接近事实、越慢、越难进 MR 门禁**——所以 DAST 通常不硬拦，而是进夜间/发布前管道 + 人工确认。

## 4.4 结果回流 MR 的三条路径

1. **报告**：靠 `artifacts:reports` 的原生键驱动 Security 面板与 MR 小组件——每个扫描器对应一个 `gl-<名称>-report.json`（`sast` / `secret_detection` / `dependency_scanning` / `container_scanning` / `dast`；较新版本也接受 SARIF，以文档为准）。
2. **内联注释**：把 finding 落到**改动的那些行**上——唯一能让人当场修掉的通道。
3. **合并门禁**：真正的「阻断」不写在 `.gitlab-ci.yml`，而是**合并请求审批策略**（扫描器 + 严重级别 + 允许条数 + 动作 = 要求审批）。Job 变红只是提醒，门禁才是拦住。

### 容器扫描必须按多架构分别做（最隐蔽的覆盖率谎言）

一份 manifest list 下，**amd64 与 arm64 是两组不同的层、不同的 SBOM、不同的 CVE**，而扫描器一次只解析一个平台。只扫 amd64，等于对 arm64 生产镜像**零覆盖**——很多团队恰恰拿 arm64 当主力。做法是给每个平台一个 job（`extends: container_scanning`），`CS_IMAGE` 分别指向 `...:$CI_COMMIT_SHA-amd64` 与 `...:$CI_COMMIT_SHA-arm64`，**SBOM 与报告都要覆盖两个架构**。

## 4.5 allowlist、基线与分级阻断

- **基线**冻结存量，让门禁只对**本次新增**负责。没有基线，老项目第一天全红，人就会去关掉它。
- **allowlist** 对确认**不可利用/已缓解/误报**的条目显式豁免，必须带**到期日、责任人、理由**；历史上有 `vulnerability-allowlist.yml` 一类载体（字段与弃用状态随版本演进），机制不变：每条豁免可审计、可回收。
- **分级**：Secret Detection → **硬拦**；SAST/SCA 的 **Critical 且本次新增** → 硬拦；High 新增 → 要求审批；Medium/Low → 只报告。
- **「不阻断」的正确用法**：DAST、覆盖率趋势、License 提示这类高成本高误报的检查，用 `allow_failure: true` / `when: manual` 只提供信息——但必须**显式说明它不拦**，不能让它冒充门禁。

## 4.6 Actions 侧对应

| 关注点 | GitLab | GitHub Actions |
|---|---|---|
| SAST | `Jobs/SAST.gitlab-ci.yml` | `github/codeql-action/init@v3` + `analyze@v3` |
| 依赖/供应链 | `Jobs/Dependency-Scanning.gitlab-ci.yml` | `actions/dependency-review-action@v4`（需 `on: pull_request`） |
| 结果回流 | `artifacts:reports:sast` 等原生键 | `github/codeql-action/upload-sarif@v3`（需 `permissions: security-events: write`） |
| 阻断 | 合并请求审批策略 | Required status checks / Branch protection |

Actions 以 **SARIF 为通用回流格式**（配 `upload-sarif@v3`），GitLab 更依赖**原生报告键**；门禁上 GitLab 更「声明式」（策略项目），Actions 更「CI 原生」（status check + branch protection）。

## 4.7 误报治理与「全员静音」反模式

剧本固定：上线即几百条告警 → 看不过来 → 把 job 设成 `allow_failure: true` 或加 `|| true` → 几个月后没人再看那个标签页 → 一次真实泄露发生，而报告里它一直写着。**被静音的检查保护不了任何人。**

- 首日只上**高信噪比三件套**：Secret Detection（硬拦）、SCA/容器的 Critical；其余先只报告。
- **基线冻结存量**，门禁只看增量——把「几百条」变成「本次几条」。
- 每条 allowlist **带到期与责任人**，到期提醒、定期回收；定期复核 Top 误报并**调规则**，而不是不断加豁免。
- 度量**「新增=修复」的收敛速度**，不是告警总数——后者只会诱导人关门。

## 4.8 今天要建立的判断力

- 看到「已接入安全扫描」，先问：**跑在 MR 上还是发版前？回流到哪？谁在拦？**
- 看到「容器扫描通过」，再问：**扫了哪几个架构？**
- 看到一堆 finding，先做**基线**再做门禁，否则你亲手制造了「全员静音」的诱因。

下一模块：把扫描、测试、构建放进正确的事件与依赖图里——流水线编排与触发策略。
