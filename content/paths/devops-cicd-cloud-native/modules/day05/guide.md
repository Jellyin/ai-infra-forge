---
title: 流水线自身的可观测、成本与治理
---

# Day 5 · 流水线自身的可观测、成本与治理

流水线是团队里**最忙、却最缺 owner** 的生产系统：每天被触发上百次，却常常没有 SLO、没有账单、没有告警。今天用它自己的数据回答：它慢在哪、贵在哪、被谁用坏了。

## 5.1 五个指标，一张表

| 指标 | 精确含义 | 取数来源 | 坏掉时的信号 |
|---|---|---|---|
| **排队时长** | job 创建 → 被 runner 认领（`queued_duration`） | job API 字段 | 与代码无关地飙升 → **资源供给**问题 |
| **执行时长** | runner 开始 → job 结束（`duration`） | job API 字段 | 与代码改动同步变慢 → 脚本/缓存问题 |
| **失败率** | `failed / 全部 job` | status 聚合 | 长期偏高，「红」失去威慑 |
| **重试率** | `retried == true` 的 job 占比 | job 字段 `retried` | 高重试率 = flaky 被重试掩盖 |
| **缓存命中率** | 命中的任务 / 需要缓存的任务 | **从日志派生**（见 5.4） | 骤降让所有 job 一起变慢 |

一句话分工：**排队归运维、执行归开发；失败率与重试率归代码；缓存命中率归两者。**

## 5.2 先把「排队慢」和「执行慢」分开

看着都是「流水线慢」，修复方向却相反。GitLab 的 job 对象同时给了这两个数：

```bash
# 最近 100 个 job 的排队/执行/是否重试
glab api "projects/$PROJECT_ID/jobs?per_page=100" \
| jq -r '.[] | [.name,.stage,.status,.queued_duration,.duration,.retried] | @tsv'
```

把 `queued_duration` 与 `duration` 两列各自求和，就是「排队总秒 / 执行总秒」。

- **排队占比高** → 加 runner / 调并发 / 错峰（5.5）。排队是 **100% 的浪费**，不产出任何东西。
- **执行占比高** → 优化脚本、缓存、镜像与并行度（Day 3、Day 6）。
- **两者都高** → 先解排队，它是零代码风险的收益。

GitHub Actions 对照：job 页面的时间线（queue → setup → steps → complete）同样能分开排队与执行，但**没有同名 API 字段**，要自己用 run 的 `created_at` 与 job 的 `started_at` 差值算。

## 5.3 把「流水线慢」定位到具体阶段

1. **按 stage 聚合 p50/p95**，先找最占时间的阶段。
2. **算关键路径，不是最慢 job**：并行 job 只计最慢那个，关键路径 = 依赖链时长之和（`needs` 图就是它，Day 1）。
3. **分别排序**：常见答案是 e2e 与镜像构建占执行，test 与 e2e 占排队。
4. **二分验证**：把可疑 job 的 `script` 暂换成 `echo`；时长塌陷 → 脚本问题；仍旧很长 → 排队、拉镜像或 artifacts 下载。

## 5.4 artifact 与缓存：看不见的存储账单

- **不写 `expire_in` 就等于永久累积**（默认保留期随配置，常见 30 天，**以官方文档为准**）。
- **`paths` 写太宽**（整个 `dist/`、`node_modules/`）→ 体积翻十倍，还拖慢下游下载。
- **`cache` 同样吃存储**，键写错会同时造成「假命中」（Day 1）与垃圾堆积。

可抄的策略：MR `expire_in: 1 day`、主分支 `1 week`、tag/release 更长。**缓存命中率只能从日志派生**：GitLab 侧 grep `Checking cache for` 与 `Successfully extracted cache`，命中率取后者/前者；Actions 侧看 `actions/cache` 的 `Cache restored from key` 与 `Cache not found`。

## 5.5 runner 利用率与并发治理：挤兑与饥饿

Runner 侧只有两个旋钮：`config.toml` 的全局 `concurrent` 与每个 `[[runners]]` 的 `limit`。利用率 = 当前运行 job 数 / 上限。

```bash
# Runner 的 Prometheus 指标（需设 listen_address，默认端口 9252）
curl -s http://localhost:9252/metrics | grep '^gitlab_runner'

# GitLab 侧：还没被认领、正在排队的 job 数
glab api "projects/$PROJECT_ID/jobs?scope[]=pending&per_page=100" | jq 'length'
```

指标名随版本演进（以官方文档为准）。两类典型故障：

- **挤兑**（瞬时尖峰）：schedule 都排整点、全组同时 push、monorepo 一次触发上千 job。缓解：错峰 schedule、`interruptible: true` + 自动取消冗余流水线、`resource_group` 串行化共享资源。
- **饥饿**（长期不公）：少数 tag 绑定的 runner 被长期占用，别的项目永远排不上。缓解：给重活（多架构构建）分独立 runner、按项目/组划分 runner。

> 利用率长期贴着上限 = 排队正在发生；长期极低 = 你在为闲置付费。**两个方向都花钱。**

## 5.6 Schedules / 手动 job / Review Apps：三个易被滥用的事件源

- **Schedules**：必须用 `rules` 处理 `$CI_PIPELINE_SOURCE == "schedule"`，否则定时触发会拉起一整套 CI（含部署）——最常见的「半夜烧钱」。Cron 走 **UTC**、默认跑默认分支，别叠到整点挤兑上。
- **手动 job**：`when: manual` **默认 `allow_failure: true`**，即不阻断流水线——「没人点所以全绿」（Day 1 的假绿灯）。要让它真成为门禁，得显式 `allow_failure: false`。
- **Review Apps**：没有自动回收 = 集群资源无限期泄漏。用 `environment:auto_stop_in` 配合 `on_stop` / `action: stop` 的清理 job；Actions 侧没有对应开关，要用定时 workflow 主动销毁。

## 5.7 CI 成本归因：按项目 / 分支 / 用户 / 平台

```
CI 成本 ≈ Σ(job 时长 × runner 单价) + Σ(artifact 字节 × 保留天数) + Σ(缓存字节 × 保留天数)
```

| 维度 | 看什么 | 典型浪费 |
|---|---|---|
| **项目** | 各项目 compute minutes / 存储用量 | 少数项目吃掉大半额度 |
| **分支** | 按 `ref` 聚合 | 长期存活的 `dev`、机器人分支反复跑全套 |
| **用户** | job/pipeline 的 `user` 与触发来源 | 一次 push 触发多次、个人分支滥用 |
| **平台** | 多架构 job 拆开统计 | 见下 |

**多架构必须单独归因**：在 amd64 runner 上靠 QEMU 模拟跑 arm64，耗时会**数倍于原生**（CPU 密集构建尤甚）；换原生 arm64 runner 快很多，但单价通常更高。把构建拆成 matrix 的独立 job（如 `PLATFORM: [linux/amd64, linux/arm64]`），**按平台分别统计时长与成本**，否则「多架构有多贵」永远是一笔糊涂账。

## 5.8 把「流水线可用性」当作 SLO

给四个 SLI 定目标（示意）：**≥99% 的 job 在 2 分钟内被认领、MR 流水线 p95 ≤ 10 分钟、p95 排队 ≤ 2 分钟、缓存命中率 ≥ 80%**。有了目标才有阈值与 burn rate：**排队 p95 破线 = 消耗可靠性预算**；执行时长悄悄上涨 = 消耗开发者体验预算。今天先建看板与阈值，Day 20 再接到平台级 SLO。

## 5.9 今天的判断力

- 看到「流水线慢」，先问：**排队占多少、执行占多少**。
- 看到账单，先问：**artifact 与缓存各占多少**。
- 看到整点尖峰，先问：**谁在同一时刻触发**；看到 arm64 构建慢，先问**是模拟还是原生**。
