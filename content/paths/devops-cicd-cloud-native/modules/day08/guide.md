---
title: 制品仓库与版本晋升策略
---

# Day 8 · 制品仓库与版本晋升策略

## 8.1 registry 布局：先问「谁推、谁拉、谁能覆盖」

布局不是审美问题，是**权限与爆炸半径**问题。原则：

- **按组件分仓**，环境差异落在权限与保留策略上，而非「重新构建」。
- **CI 只推 dev 仓**，staging / prod 只读或只允许「搬运」；本地不该有 prod 仓 push 权限。

| 布局 | 形态 | 代价 / 适用 |
|---|---|---|
| 单仓多 tag | 一个仓，环境靠 tag 前缀（`dev-1.4.0`） | 简单；权限无法按环境隔离，误覆盖波及所有环境 |
| 一组件一仓，环境靠凭证 | `…/api` 一仓，prod 由只读凭证拉取 | 推荐；按环境配不同凭证即可 |
| 一环境一仓 | `…/api-dev`、`…/api-prod`，晋升靠**搬运 digest** | 隔离最强、账单翻倍；适合强合规 |

命名由平台给定：GitLab `$CI_REGISTRY/<group>/<project>`、GHCR `ghcr.io/<owner>/<image>`；**组织路径即仓库路径。**

## 8.2 tag 会骗人：tag 是可变指针，digest 才是身份

- **tag 是可被覆盖的指针**：`app:1.4.0` 今天指 A，明天有人重推同一 tag，它**静默地**指向 B——引用它的部署清单下次拉取就拿到 B。
- **digest 内容寻址**：`app@sha256:abc…` 由镜像内容算出，内容一变必变，无法伪造。

```bash
# 同一 tag 两次查询可能得到不同 digest
crane digest registry.example.com/api:1.4.0
# 用 digest 引用，行为确定
crane digest registry.example.com/api@sha256:ac1f0e...   # 打印自身，恒定
```

两个推论：

1. **人读 tag，机器认 digest**：部署清单、签名、provenance、SBOM 全锚定 digest，tag 只是别名。
2. **K8s `imagePullPolicy` 是隐式漂移**：`IfNotPresent` 时节点缓存了某 digest 就不再拉，「同一 tag」在不同节点可能是不同镜像。

**不可变 tag 命名规则**（可直接抄）：

```
prod    :  <semver>              # 1.4.0
staging :  <semver>-rc.<n>       # 1.4.0-rc.3
dev     :  <branch>-<short-sha>  # main-9f31c2a
```

硬规则：**一个 tag 一经推送，永不复用**。做不到全平台强制时，至少打开 registry 的 tag 不可变开关（GitLab 有；GHCR 无内建开关），并让 CI 拒绝覆盖已存在的 tag。

## 8.3 语义化版本、release 与 changelog 自动生成

版本号是**契约** `MAJOR.MINOR.PATCH`：破坏兼容→MAJOR，兼容新增→MINOR，修 bug→PATCH，预发布加 `-rc.1`。**由 release 动作决定，不手敲**，否则必然「同名不同内容」。changelog 由 conventional commits（`feat:` / `fix:` 等）自动生成。

```yaml
# GitLab CI：打 tag 时生成 changelog 并创建 Release
release:
  stage: release
  image: registry.gitlab.com/gitlab-org/release-cli:latest
  rules:
    - if: $CI_COMMIT_TAG
  script:
    - git-cliff --output CHANGELOG.md        # 由 conventional commits 生成
    - release-cli create --name "Release $CI_COMMIT_TAG" \
        --tag-name "$CI_COMMIT_TAG" --description ./CHANGELOG.md
```

同类可选 `release-please`、`semantic-release`。**changelog 记录的是哪个 commit、哪个 digest**；Release 带上 digest 才是可核对的制品指针。

## 8.4 晋升 = 搬运同一个 digest（多架构用 index digest）

晋升的唯一定义：**把已构建、已验证的制品原样搬到下一环境**，不是「prod 再构建一次」。

```bash
# 把 dev 上验证过的同一 digest 搬到 staging（不重新构建）
crane copy registry.example.com/api@sha256:ac1f0e... registry.example.com/staging/api:1.4.0
# 多架构：搬运整个 index（含全部平台），用 skopeo 更直观
skopeo copy --all \
  docker://registry.example.com/api@sha256:ac1f0e... \
  docker://registry.example.com/prod/api:1.4.0
```

**多架构时晋升与引用都必须用 index digest**（Day 7）：顶层 digest 指向 manifest list 而非某架构；按单架构 digest 晋升，`arm64` 节点会拿到不匹配的层。规则：

- 记录并搬运 **index（manifest list）digest**；
- 部署清单写 `image@sha256:<index-digest>`；
- 单架构 digest 只在只跑一个平台时引用。

## 8.5 检测并阻止「为生产重新构建」

「给 prod 重跑一次构建」是最隐蔽的供应链漏洞：源码没变，但**构建环境变了**（基础镜像、依赖、密钥），prod 跑的是**从未被测过的二进制**，而所有人以为它测过。检测内核：**比对 digest**。

```bash
# 1) 构建后记录 digest
crane digest "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" > image.digest
# 2) 部署前断言 tag 的 digest 等于记录值
test "$(crane digest registry.example.com/prod/api:1.4.0)" = "$(cat image.digest)" \
  || { echo "drift: prod 制品与 CI 产物不一致"; exit 1; }
```

阻止它要三道闸，缺一不可：

1. **架构上**：prod 仓对 CI 只给「搬运」，不给「构建推送」。
2. **流程上**：部署清单（GitOps 仓）钉死 digest，改它必须走显式、可审计的提交。
3. **准入上**：集群侧策略校验镜像 digest 与签名/来源（Day 9）。

## 8.6 保留策略与仓库容量治理

镜像会**无声膨胀**：每 commit 一个 tag，几个月就吃光存储额度。治理：

- **只留有意义的 tag**：prod 的 semver 永久保留；dev 的 `<branch>-<sha>` 保最近 N 个或超 X 天删。
- **用平台的清理策略**：GitLab 有「保留最近 N 个匹配 regex 的 tag、删更早的」；GHCR 靠 Actions / 保留脚本。
- **删除要能按 digest 也能按 tag**：

```bash
regctl tag rm registry.example.com/api:main-9f31c2a   # 删一个 tag
```

- **把容量当指标**：存储用量、tag 数量、最老 tag 年龄，和 Day 5 看板放一起。**没人看的仓库一定会烂。**

## 8.7 GitLab Container Registry 与 GHCR 对照

| 维度 | GitLab Container Registry | GHCR |
|---|---|---|
| 路径 | `$CI_REGISTRY/<group>/<project>/<component>` | `ghcr.io/<owner>/<image>` |
| 认证 | `$CI_REGISTRY_USER` + `$CI_JOB_TOKEN`（job 内免配） | `GITHUB_TOKEN`（需 `packages: write`） |
| tag 不可变 | 有 tag 不可变 / protected tags 设置 | 长期无等价内建开关（**以文档为准**） |
| 清理策略 | 项目级 cleanup policy（keep-N / 保留 regex / 年龄） | 需自建（Actions + API） |
| 与流水线 | 同一平台内建 | 与 Actions 内建 |

意义：同一套「tag 会骗人、按 digest 晋升」的原则两端都成立，差异只在平台是否提供不可变与清理开关；GHCR 没有，就**必须把纪律写进流水线**。

## 8.8 今天的判断力

- 看到部署清单里写 tag，先问「它会不会被覆盖成另一个镜像」。
- 看到「给 prod 单独构建一次」，直接判红——**产物必须是同一个 digest**。
- 看到多架构，问「引用的是 index digest 还是单架构 digest」。
- 看到仓库在长，问「保留策略在哪、谁在看容量」。
