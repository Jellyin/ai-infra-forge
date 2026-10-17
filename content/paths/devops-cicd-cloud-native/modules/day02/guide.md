---
title: 快速反馈链：检查与测试分层
---

# Day 2 · 快速反馈链：检查与测试分层

## 2.1 分层依据是「否决率 ÷ 单位成本」，不是测试类型

反馈链该按**每花一秒能挡掉多少不该进主干的东西**排序，而不是按教科书里的测试分类排序。

| 层 | 单位成本 | 主要否决什么 | MR 时间预算 |
|---|---|---|---|
| 格式化 / lint | 秒级 | 风格、未用导入、低级错误 | ≤ 30s |
| 类型检查 | 十秒级 | 接口不一致、空值路径 | ≤ 90s |
| 单元测试 | 分钟级 | 逻辑回归 | ≤ 3min |
| 集成测试 | 分钟级+ | 真实依赖的行为（DB / 队列 / HTTP） | ≤ 6min |
| 契约测试 | 分钟级 | 消费者与提供者之间的约定漂移 | ≤ 4min |
| e2e | 十分钟级 | 端到端可用性 | ≤ 10min，可后置 |

**上一层能挡的绝不留到下一层**；一层如果否决率长期趋近 0，它就不是门禁而是仪式——要么删，要么挪到 nightly。

## 2.2 快检查必须「跑得早」且「阻断合并」，但不该阻断关键路径

这两件事经常被混成一件。跑得早不阻断，它退化成通知；只阻断不跑早，它拖慢整条链。

```yaml
stages: [check, test, verify]

lint:
  stage: check
  script: [make lint]

typecheck:
  stage: check
  script: [make typecheck]

unit:
  stage: test
  needs: [lint, typecheck]      # 不等整个 check stage 结束
  script: [make test-unit]
```

**踩坑点**：把「阻断」理解成「让后续 job 排队等它」。`lint` 应作为 **required job 阻断合并**，但 `unit` 要能立刻并行起步，最后再校验 `lint` 的结论。同理 `e2e` 必须挂在链尾或 `when: manual`，绝不能挡住 `unit`。

## 2.3 每层都要有数字，没有数字的层会无声膨胀

预算写进仓库（如 `docs/ci-budget.md`），并要求「加测试的人必须说明落在哪一层、该层还剩多少预算」。

| 信号 | 阈值 | 处理 |
|---|---|---|
| 单层超预算 20% | 连续 3 次 | 拆分该层，或标记可后置 |
| 单测 p95 > 3min | 一次 | 找慢用例，别加并发掩盖 |
| MR 总 wall time > 10min | 连续 3 次 | 先查关键路径是否被 stage 栅栏串起 |
| 用例数为 0 | 任何一次 | 直接视为失败 |

## 2.4 并行化：DAG 与 matrix，但先算清资源代价

```yaml
unit:
  stage: test
  parallel:
    matrix:
      - SUITE: [core, api, billing]
        NODE: ["20", "22"]
  script: [./scripts/run-tests.sh "$SUITE"]
```

matrix 是**乘法展开**：`3 × 2 = 6` 个 job。每加一个维度就多吃一份 runner 并发，打满的表现是长时间 pending，不是失败。

```yaml
e2e:                            # 只等矩阵里的指定实例
  needs:
    - job: unit
      parallel:
        matrix:
          - SUITE: [core]
  script: [./scripts/run-tests.sh e2e]
```

| 能力 | GitLab CI | GitHub Actions |
|---|---|---|
| DAG 依赖 | `needs:` | `needs:` |
| 矩阵 | `parallel:matrix` | `strategy.matrix` |
| 矩阵排除 | 无内置，靠命名 / `rules` | `strategy.matrix.exclude` |
| 容忍部分失败 | `allow_failure:exit_codes` | `continue-on-error` |
| 只依赖某矩阵实例 | `needs:parallel:matrix` | `needs` + job outputs |

展开规模有上限（`parallel: N` 与 matrix 的历史口径为 50 / 200，Actions 单 workflow 256）。**数字随版本演进，用前查官方文档。**

## 2.5 「只跑受影响的部分」——判定依据必须能被人复述

```yaml
unit:
  rules:
    - changes:
        paths: ['src/**/*', 'pnpm-lock.yaml']
        compare_to: 'refs/heads/main'
```

**必须记住的坑**：`rules:changes` 在**没有可比较基线的 pipeline 里恒为真**——新分支首次 push、tag pipeline、scheduled / multi-project pipeline 都属于这一类。于是「没改就不跑」在部分场景变成「没改也跑」，在另一些场景又可能意外不跑。**路径过滤必须配一条显式兜底规则**，把判定不出基线的情况写明。

更稳的形态是让构建图工具算 affected（Nx affected、Turborepo `--filter`、Bazel query），把结果写成变量，再决定跑哪些 SUITE。判定依据要满足：**可解释**（能回答为什么这次跑了 billing）与**保守**（拿不准就跑，漏跑是静默假绿灯，多跑只是多花几分钟）。锁文件或公共库变更 → **全量跑**，这条不需要讨论。

Actions 侧：`on.push.paths` 只在 workflow 级；job 级要用 `dorny/paths-filter` 或 `tj-actions/changed-files` 产出布尔量再决定 step。

## 2.6 flake：重试是止疼药，而且会掩盖病情

flake 的精确定义是**同一 commit 重跑结果不同**。

```yaml
# 正确：只对基础设施抖动重试
retry:
  max: 2
  when: [runner_system_failure, stuck_or_timeout_failure]
```

```yaml
# 危险：把业务失败也重试掉，等于给 flake 发免死金牌
retry:
  max: 2
  when: always
```

| 步骤 | 做法 | 退出条件 |
|---|---|---|
| 识别 | 统计「同 commit 两次结果不一致」的用例名并打点 | 有名字，不是「感觉有 flake」 |
| 隔离 | 移入不阻断的 quarantine job，标注 owner 与期限 | 有 owner、有 deadline |
| 根治 | 查时区、随机端口、测试间共享状态、缺 await、mock 时钟、CPU 限流 | 连续 N 次稳定通过 |
| 归位 | 移回阻断层并补一条防回归 | — |

最被低估的根因是**测试间共享状态**（同一 DB / Redis / 临时目录）：本地单跑绿、CI 并行红。用乱序 + 重复执行最快暴露。

## 2.7 覆盖率门禁：卡「变化的部分」，别卡「平均数」

- **误用一**：总量 ≥ 80%。存量只有 40% 的仓库会催生大量无断言测试（跑过即算行覆盖），门过了风险没降。
- **误用二**：掉 0.1% 就 fail。团队的第一反应是加 `// istanbul ignore next` / `/* c8 ignore */`——**门禁的最终产物变成忽略注释**。
- **误用三**：只卡总量不管新增，新增代码覆盖率 0% 也能被存量撑住。

有效形态：**diff / patch coverage**（只卡本次改动的行）；对 hotspot 模块单独定软下限；把覆盖率当**趋势告警**而非红叉；**覆盖率必须和用例数一起看**——覆盖率涨而用例数不变，基本是刷出来的。

GitLab 侧用 `coverage` 与 `artifacts:reports:coverage_report`；Actions 侧常接 Codecov 或自建 diff coverage。**关键字与格式随版本演进，用前看官方文档。**

## 2.8 今天要建立的判断力

- 看一条链，先问：**最便宜的否决在哪层？它阻断合并了吗？它拖了关键路径吗？**
- 看到慢，先分：是真算得慢，还是被 stage 栅栏串起来了。
- 看到「只跑改动」，追问：基线是什么？判不出来时跑不跑？
- 看到 `retry`，问 owner 是谁、期限是什么时候。
- 看到覆盖率门禁，问它卡的是**变化**还是**平均数**。

下一模块：把「每次全量重来」变成「只算变化的部分」——缓存与构建加速。
