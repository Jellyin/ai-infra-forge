---
title: 平台工程与自助化
---

# Day 19 · 平台工程与自助化

## 19.1 病根：20 个团队各写一套流水线

20 个团队各写一份 `.gitlab-ci.yml`，产出的不是 20 条流水线，而是 20 条**各不相同**的流水线：缓存 key 写法不一、构建器不一、安全扫描有的跑有的不跑、凭证散落在各自变量里。平台团队每天在回答同一句话——「你们这条为什么和我们不一样」，然后手工修。

平台工程的目标不是「统一」，而是**把最佳实践变成默认值**：不读文档、不抄别人的 YAML，走现成那条路就自动是对的。这条路叫 **golden path（黄金路径）**。判据只有一句：**新团队从 0 到第一次绿色部署要多久，中间要写几行 YAML。**

## 19.2 抽象到哪一层：CI Components / reusable workflow

不要把「团队 X 的整条流水线」抽象成一个模板——那只是把某个人的 YAML 换个地方放。要抽象**能力（capability）**：构建并推送镜像、跑测试、扫描、签名、部署到环境，每个能力有稳定的**契约**，其余留给团队。

GitLab 用 **CI Components**（`spec:inputs` + `$[[ inputs.x ]]`），GitHub 用 **reusable workflow**（`on: workflow_call`）。两者高度同构：

| 概念 | GitLab CI Component | GitHub reusable workflow |
|---|---|---|
| 定义入口 | `spec:inputs` | `on: workflow_call` |
| 调用 | `include: - component: ...@版本` | `jobs.<id>.uses: ...@版本` |
| 传参 | `inputs:` / `$[[ inputs.x ]]` | `with:` / `inputs.x` |
| 传密钥 | `variables` / `secrets` | `secrets:`（需显式声明） |
| 发版 | catalog 上的 tag | 被引用 workflow 的 ref（tag/branch） |

一个「构建并推送镜像」的 component（**被引用方**，`templates/build-docker/template.yml`）：

```yaml
spec:
  inputs:
    stage:
      default: build
    image_name:
      description: "目标镜像名（不含 registry）"
    context:
      default: "."
---
build-docker:
  stage: $[[ inputs.stage ]]
  script:
    - docker build -t "$CI_REGISTRY_IMAGE/$[[ inputs.image_name ]]:$CI_COMMIT_SHA" "$[[ inputs.context ]]"
    - docker push "$CI_REGISTRY_IMAGE/$[[ inputs.image_name ]]:$CI_COMMIT_SHA"
```

调用方（**业务仓库**，只写意图，不写实现）：

```yaml
include:
  - component: gitlab.com/acme/ci-components/build-docker@1.3.0
    inputs:
      image_name: payments-api
```

**粒度原则**：一个 component 只做一件有清晰契约的事；输入数量应当能用一只手数过来。超了，说明它做了不止一件事。

## 19.3 参数化是承诺，不是自由

每多一个 `inputs`，平台团队就多一份要长期维护、写文档、保兼容的**承诺**。分清两类输入：

- **合法差异**：镜像名、Dockerfile 路径、目标环境——团队真的不同。
- **伪差异**：某个团队想要的特殊分支——这不是参数，是**分叉（fork）**。

一个输入若只服务一个团队，就该拒绝：让那个团队在自己的仓库里从 golden path 分叉，并**自己承担分叉的维护成本**。模板被塞进第 60 个输入时，它已经不是默认值，而是所有人的债。

## 19.4 模板也要发版：版本化与弃用策略

**模板是产品，必须先发版再被消费。**

- **语义化版本**：输入不兼容变更 = major；新增可选输入 = minor；修 bug = patch。
- **按版本固定，禁止引用分支**：写 `@1.3.0`，不写 `@main`。引用 `@main` 等于让全体团队共享一个「随时会变的历史」。
- **弃用四步**：① 公告 → ② **软警告**（组件里 `echo` 警告、门户标黄）→ ③ **硬失败**（引用旧版本时 job fail，并给出升级命令）→ ④ 移除。全程至少留一个版本周期。
- **同时维护 N-1 / N-2**：消费方升级要排期，平台不能「今天发新、明天删旧」。

没有弃用策略的模板集合，三年后会退化成「人手一套 YAML」，只是多了一层没人理解的抽象。

## 19.5 内部开发者门户（Backstage 等）到底解决什么

门户**不是 CI 引擎**。它解决三个与流水线无关的痛：

1. **可发现性**：这个服务是谁的？在哪？流水线和看板在哪？——software catalog。
2. **脚手架**：一键从模板生成仓库 + 流水线 + GitOps 应用 + 看板 + 告警，**生成物天然走在 golden path 上**——scaffolder / software templates。
3. **资产收敛**：TechDocs、运维手册、所有权信息随服务走。

一句话：Component 定义「做对的事怎么写」，门户定义「新人如何五分钟内找到并做对」。别指望门户替你把抽象做对。

## 19.6 平台自己也该有 SLO：把「流水线可用性」当 SLO

平台是产品，产品有 SLO。候选 SLI：

| SLI | 含义 | 目标示例 |
|---|---|---|
| 流水线成功率 | **排除用户代码错误后**的成功率 | ≥ 99.5% |
| 排队时间 p95 | push 到 job 被 runner 认领 | ≤ 60s |
| 平台归因失败率 | 平台侧变更引起的失败占比 | ≤ 0.5% |

**关键**：SLI 必须排除「用户代码本来就编译不过」这类失败，否则指标淹在噪声里、失去行动力。错误预算烧尽时，**冻结的是平台自身的变更（新功能、激进重构），不是团队的发布**——这才叫把「平台是产品」落进决策。

## 19.7 三个必须一眼认出的反模式

1. **过度抽象**：一个「能跑一切」的超级模板，几十个输入、嵌套三层，改一处影响所有人。信号：**没人敢改它**。
2. **「改配置要改平台」**：团队想调个超时、加条规则都得提 issue 排期。这正是平台工程要消灭的瓶颈，却常被它亲手重建。
3. **模板一改全线红**：没有版本固定，平台一次提交让所有仓库同时失败——**爆炸半径 = 全公司**。

照 golden path 三问自检：**默认值是不是最佳实践？团队能否在模板之外自助？平台变更是否只影响主动升级的人？** 三问皆「是」，抽象才算做对。

下一模块：把「能不能发」从经验判断变成可计算的结论——可观测与 SLO 落到交付门禁。
