---
title: 实验五 · 给流水线做一次体检
---

# 🧪 动手实验 · Day 5

> **目标**：把「流水线感觉有点慢」变成一份**可量化的体检报告**——排队多少、执行多少、谁在烧钱、哪一步先修。这就是给一个不自带监控的系统补上 SLI 的标准流程。
>
> 三档任选：**A 真环境**（GitLab 实例）／**B 本地**（CLI 拉数据做统计）／**C 纸上**（15 分钟纯推理）。

---

## 档位 A · 真环境（有 GitLab 实例或 gitlab.com 项目）

### 1. 在分析页面读出第一手数字

打开项目的 **Analyze → CI/CD analytics**（部分版本入口为 **CI/CD → Analytics**），观察两张图：

| 观察项 | 你的记录 | 说明 |
|---|---|---|
| Pipeline duration 趋势 | | 是缓涨还是某天突变（突变 = 有人改了 CI 或上游变重） |
| Failure rate 趋势 | | 失败率长期偏高，「红」会失去威慑 |
| 最近一次流水线的总时长 | | 记住这个数，第 3 步要拆开它 |

> 页面名称与图表随版本演进，找不到时用第 3 步的 API 直接取数。

### 2. 制造一次「排队」，亲眼看见 queued_duration

用 `tags` 指向一个**一定不存在**的 tag，job 就会一直 pending（不会被认领）：

```bash
cat >> .gitlab-ci.yml <<'YAML'

probe:queue:
  stage: test
  tags: [runner-that-does-not-exist]
  script: [echo "永远不会跑"]
  allow_failure: true        # 别让这次实验把流水线拖红
YAML
git add -A && git commit -m "day05 queue probe" && git push
```

去 **Build → Pipelines → 该 pipeline → Jobs** 展开这个 job：**Status 会长时间停在 pending，而 Duration 是空的（或极小），Queued duration 一直增长**。这就是「排队慢」的实体——它和「执行慢」在同一个页面上、却是完全不同的两列。

### 3. 用 API 把总量拆成排队与执行

```bash
export PROJECT_ID=<你的数字项目ID>
glab api "projects/$PROJECT_ID/jobs?per_page=100" \
| jq '{"排队总秒":(map(.queued_duration // 0)|add),"执行总秒":(map(.duration // 0)|add)}'
```

把它填进报告表（第 4 步），并回答：**你的项目，钱主要花在排队还是执行？**

### 4. 产物与保留策略的账单核对

在 **Settings → Usage quotas**（或项目存储用量页）看当前 artifact 占用了多少。

```bash
cat >> .gitlab-ci.yml <<'YAML'

big-artifact:
  stage: build
  script:
    - mkdir -p out && head -c 20000000 /dev/urandom > out/blob.bin   # 造 20MB 产物
  artifacts:
    paths: [out/]
    expire_in: 1 day        # 试一次不写 expire_in，对比默认保留行为
YAML
```

**关键观察**：不写 `expire_in` 时产物按实例默认保留期累积；写了 `1 day` 后自动过期。把两次 Usage quotas 的差值与保留天数记下来，换算成「一份产物 · 天」的成本。

---

## 档位 B · 本地（无 GitLab 实例）

目标：**用一条命令算出排队/执行占比**，不依赖任何 UI。

### 1. 用官方 CLI 拉真实数据做统计

```bash
# glab 子命令与参数随版本演进，拿不准先 glab <sub> --help
glab ci list                        # 最近的流水线
export PROJECT_ID=<你的数字项目ID>

# 每个 job 的排队与执行，按执行时长倒序
glab api "projects/$PROJECT_ID/jobs?per_page=100" \
| jq -r '.[] | [.name,.stage,.status,.queued_duration,.duration,.retried] | @tsv' \
| sort -t$'\t' -k5 -nr | head -20

# 排队 vs 执行两个总数
glab api "projects/$PROJECT_ID/jobs?per_page=100" \
| jq '{"排队总秒":(map(.queued_duration // 0)|add),"执行总秒":(map(.duration // 0)|add)}'
```

### 2. 按 stage 聚合，找出最占时间的阶段

```bash
glab api "projects/$PROJECT_ID/jobs?per_page=100" \
| jq -r 'group_by(.stage)[] | [.[0].stage, (map(.duration // 0)|add), (map(.queued_duration // 0)|add)] | @tsv' \
| sort -k2 -nr
```

### 3. 本地复现一次「排队」

不用 runner 也能看见排队：下面 6 个任务只允许同时跑 2 个。

```bash
seq 1 6 | xargs -P 2 -I{} sh -c 'echo "job {} start $(date +%T)"; sleep 3; echo "job {} done $(date +%T)"'
```

**记录**：把 `-P 2` 换成 `-P 6` 再跑一次，对比总耗时。前者多出来的时间**就是排队时间**，与任务工作量无关——这正是 5.5「加并发」的收益。

---

## 档位 C · 纸上（15 分钟，无需任何环境）

下面是一次 MR 流水线的 job 数据（`queued` = 排队秒，`exec` = 执行秒），job 同 stage 内并行：

| job | stage | queued | exec | status | retried |
|---|---|---|---|---|---|
| build:amd64 | build | 3 | 340 | success | false |
| build:arm64 | build | 4 | 1180 | success | false |
| lint | test | 2 | 40 | success | **true** |
| test:unit | test | 210 | 95 | success | false |
| test:integration | test | 190 | 160 | success | false |
| e2e | e2e | **640** | 420 | success | true |
| deploy:staging | deploy | 5 | 30 | success | false |

先自己算，再看答案（不许先翻）：

1. 排队总时长与执行总时长各是多少？**浪费占比**是多少？
2. 瓶颈在「排队」还是「执行」？还是两处都有？
3. **如果只能改一处**，先改哪个？为什么？
4. `build:arm64` 比 `build:amd64` 慢了 3 倍多，最可能的原因是什么？

<details><summary>对照答案（先写完再看）</summary>

1. 排队 = 3+4+2+210+190+640+5 = **1054s**；执行 = 340+1180+40+95+160+420+30 = **2265s**。排队占总时间约 **32%**，而这 32% 不产出任何东西——纯浪费。
2. **两处都有，但性质不同**。排队集中在 `test:*`（每个 ~200s）与 `e2e`（640s）：典型的 runner 供给不足 / 并发触顶。执行集中在 `build:arm64`（1180s）与 `e2e`（420s）。
3. **先解排队**。加 runner 或调 `concurrent` 是零代码风险、收益 100% 落到端到端时长的动作；改脚本/缓存风险与工时都更高。SRE 的第一优先级：**先摘不花钱的果子**。（排队接近 0 后才轮到执行侧。）
4. **多半不是 arm64 本身慢，而是 QEMU 模拟**：在 amd64 runner 上交叉构建 arm64 会走模拟执行，CPU 密集型构建耗时常是原生的数倍。换原生 arm64 runner 可大幅缩短，但单价更高——所以要把两个平台**拆成独立 job 分别归因**。
   补充信号：`lint` 与 `e2e` 都 `retried: true`——重试率非零意味着 flaky，靠重试「修好」的红灯会掩盖真问题。

</details>

### 最后一问（写下你的答案，贯穿本路径）

给你现在的项目，写出**两条**你会真正挂上告警的阈值，以及它们对应的动作：

| SLI | 阈值 | 破线后做什么 |
|---|---|---|
| p95 排队时长 | __________ | __________ |
| MR 流水线 p95 端到端 | __________ | __________ |

<details><summary>参考答案</summary>

参考填报：① 排队 p95 > 2 分钟 → 检查 runner 在线数与 `concurrent`，给热门 tag 加 runner，或错峰 schedule；② MR 流水线 p95 > 10 分钟 → 先按 stage 聚合定位最占时间的阶段，再决定是加缓存、并行化还是砍掉不必要的 job（Day 2 的分层）。

关键是：**阈值必须绑定动作**。只报警不挂动作的阈值，三个月后就会被静音。
</details>
