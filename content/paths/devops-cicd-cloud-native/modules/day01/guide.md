---
title: 流水线的心智模型与真实失败模式
---

# Day 1 · 流水线的心智模型与真实失败模式

## 1.1 先把「一次 pipeline 到底发生了什么」说准

多数人对流水线的认知停在「push 之后它自己会跑」。要优化它，先得有一张准确的图：

```
push ──► GitLab 收到事件 ──► 判断「要不要创建 pipeline」(workflow:rules)
                                   │
                                   ▼
                         创建 pipeline → 拆成 stage
                                   │
              stage 顺序执行，stage 内 job 并行
                                   │
                    每个 job 需要被 runner 认领
                                   │
        runner 按 tags 匹配、按并发上限排队 → executor 拉镜像 → 跑 script
                                   │
                       产出 artifacts / cache / 报告
```

四个层次要分清，混在一起谈就会得出错误结论：

| 层次 | 是什么 | 出问题时的症状 |
|---|---|---|
| **Pipeline** | 一次触发产生的一整套 job | 根本没创建（`workflow:rules` 拦了） |
| **Stage** | job 的分组，默认串行 | 前置 stage 里一个慢 job 拖住后面全部 |
| **Job** | 一个 runner 上执行的工作单元 | job 失败 / 被跳过 / 幽灵存在 |
| **Runner** | 认领 job 的进程 + executor | **排队**（不是失败，是没资源） |

**「慢」和「失败」是两件事，先分清楚再优化**：job 长时间 pending 是 runner 侧资源问题（Day 5 展开）；job 跑很久才结束是 job 内部问题（Day 3 展开）。

## 1.2 三种 token 别搞混（这是最常见的认知错误）

| Token | 谁持有 | 用途 | 典型误用 |
|---|---|---|---|
| **Runner authentication token**（`glrt-...`） | Runner 进程 | 注册与认领 job 的身份 | 当成 job 里的凭证去用（它不是给 job 的） |
| **`CI_JOB_TOKEN`** | 每个 job 自动注入 | 访问 GitLab 自身资源：Container Registry 推拉、Package Registry、触发下游 pipeline | 当成长期凭证存起来；作用域超出预期 |
| **Project / Group Access Token** | 外部系统 / 脚本 | 机器人身份调 API、克隆私有仓库 | 长期不过期、权限过大、写进 CI 变量明文 |

要点：`CI_JOB_TOKEN` 是**短期、随 job 生命周期存在**的，它是「免密」思路的雏形——凡是能用它或 **OIDC** 解决的，就不该引入长期 token（Day 10 专门讲 OIDC）。

## 1.3 从串行到 DAG：`needs` 才是主干优化

默认 stage 是**栅栏**：stage 内全部 job 完成，下一 stage 才开始。真正的关键路径往往被相邻 stage 里无关的 job 拖长。

```yaml
stages: [build, test, deploy]

build:a:
  stage: build
  script: [echo A]
build:b:
  stage: build
  script: [echo B]

# 只依赖 build:a —— build:b 还在跑时就启动，不必等整个 build stage
test:a:
  stage: test
  needs: [build:a]
  script: [echo testA]
```

两种形态要会写：

```yaml
# 扇出（fan-out）：一个 job 生成一批并行 job
test:
  parallel:
    matrix:
      - SUITE: [unit, integration, contract]
  script: [run "$SUITE"]
```

```yaml
# 扇入（fan-in）：一个 job 收齐全部矩阵产物
report:
  needs: [test]          # needs 某个矩阵 job 会等待它的全部实例
  script: [merge-reports]
```

`needs` 的代价也要知道：它让 job 之间形成显式依赖图，**依赖写错会静默地少跑或早跑**——不出错但结果不可信，比直接失败更危险。

## 1.4 `workflow:rules`：先决定「要不要有 pipeline」

job 级的 `rules` 决定单个 job 跑不跑；`workflow:rules` 决定**整个 pipeline 创不创建**。没有它，一个无关分支的 push 也会拉起全套 job。

```yaml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_COMMIT_TAG
    - when: never        # 其余一律不创建
```

**同时不要**给 job 写 `rules` 又写 `only/except`——后者已被取代，混用会让准入逻辑难以推理。

## 1.5 GitHub Actions 对照（读别人的配置用得上）

| 概念 | GitLab CI | GitHub Actions |
|---|---|---|
| 配置文件 | `.gitlab-ci.yml` | `.github/workflows/*.yml` |
| 执行单元 | job | job（内含多个 step） |
| 触发器 | `rules` / `workflow:rules` | `on:` |
| 依赖 | `needs:` | `needs:`（同概念） |
| 矩阵 | `parallel:matrix` | `strategy.matrix` |
| 复用 | `include:` / CI Components | reusable workflow / composite action |
| 运行器 | self-hosted runner | GitHub-hosted / self-hosted runner |
| 产物 | `artifacts:` | `actions/upload-artifact` |

两者最大的差异在**执行粒度**：GitLab 的 job 是「一个 runner + 一段 script」，Actions 的 job 里还能串多个 step（含官方 action），因此 Actions 更容易把「组合动作」封装成市场里的现成件。理解这点，两边互迁就不难。

## 1.6 八种「看起来在跑、其实没测到」的失败模式

这份清单是本模块最有价值的部分——它们**不会让流水线变红**，只会让绿灯变得没有意义。

1. **幽灵 job**：`rules` 只在特定分支命中，MR 上压根没有这个 job，MR 却显示通过。
2. **缓存假命中**：cache key 不含锁文件哈希，依赖升级了但缓存还是旧的，测试跑在过期依赖上。
3. **产物缺失**：`artifacts` 路径写错或未 `needs` 传递，下游拿到空目录仍然「成功」。
4. **失败被吞**：`allow_failure: true`、`|| true`、`when: manual` 没人点——三种「假装通过」。
5. **退出码被管道吞掉**：`false | tee log` 的退出码是 `tee` 的，脚本照样 0 退出；需要 `set -o pipefail`。
6. **零用例通过**：测试选择器写错、匹配到 0 个用例，退出码 0。
7. **事件不对称**：只配了 push 没配 MR（或相反），导致「本地跑过、CI 不跑」。
8. **只在 CI 跑的差异**：CI 里 `NODE_ENV=test`、时区 UTC、缺 `.env`，本地绿 CI 红（或反过来）。

> 排查方法统一：**不要看「绿不绿」，看「该跑的 job 数目对不对、用时是否合理、用例数是否为 0」**。这一条会在 Day 5 变成一张看板。

## 1.7 今天要建立的判断力

- 看到流水线，先问：**pipeline 创建了吗 → stage 布局对不对 → 关键路径是哪条 → 谁在排队**。
- 看到「绿」，再问：**这份绿覆盖了什么**（Day 2 用分层解决）。
- 看到「慢」，先分**排队 vs 执行**，再谈缓存与并行。

下一模块：把反馈时间压到最短的同时不牺牲可信度——分层与并行。
