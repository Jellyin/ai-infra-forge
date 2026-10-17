---
title: 可观测与 SLO 落到交付门禁
---

# Day 20 · 可观测与 SLO 落到交付门禁

## 20.1 OpenTelemetry：把指标/日志/追踪收敛成一条接入

过去每接一个后端就改一次埋点；换成 OTel 后接一次、处处可用：

```
应用（SDK／自动注入）──OTLP──► Collector（receiver→processor→exporter）──► 后端
```

resource 属性里 `service.version` 标明是哪一版。对交付链路两个硬要求：**`service.version` 必须是制品的不可变版本**（Day 8/9 的 digest 或 commit SHA，不是 `latest`），否则看板与「哪次发布回滚了」对不上号；**OTel 接在发布链路里**，上线换 `service.version`，SLO 曲线与回滚判定就自动按版本切分。

## 20.2 Prometheus + Grafana：从一条 counter 到一块可用看板

先有指标才有 SLO。以一个带 `status`、`route` 标签的 counter 为例：

```
http_requests_total{job="payments", status="200", route="/pay"}
```

PromQL 的基本单位是**速率**（counter 只增，看趋势要 `rate`）：

```promql
sum by (route) (rate(http_requests_total{job="payments"}[5m]))   # 各路由 QPS

sum(rate(http_requests_total{job="payments",status=~"5.."}[5m]))  # 5xx 比例
/ sum(rate(http_requests_total{job="payments"}[5m]))
```

**别把 SLO 表达式直接塞进告警**——用 **recording rule** 预计算成 `sli:http_error_ratio:5m`，看板和告警都引用它，避免各算一遍、结果不一致。看板至少四行：**四个黄金信号（延迟/流量/错误/饱和度）+ 一行 SLO 与剩余预算**。

## 20.3 SLI / SLO / 错误预算：把「够不够可靠」变成数字

- **SLI**：一个**比例**——好事件 / 总事件。从用户视角、可测量、与业务相关（成功请求数、`duration < 阈值` 的请求数），不是 CPU 使用率。
- **SLO**：SLI 的目标值 + **窗口**，如 `99.9% / 30d`。脱离窗口谈 SLO 没有意义。
- **错误预算** = `100% − SLO`：允许「不达标」的量。

30 天按 720 小时算，各档允许的不可用时长（burn rate 全靠这张表）：

| SLO | 错误预算 | 30 天允许不可用 |
|---|---|---|
| 99% | 1% | 7.2 小时（432 分钟） |
| 99.5% | 0.5% | 3.6 小时（216 分钟） |
| 99.9% | 0.1% | **43.2 分钟** |
| 99.95% | 0.05% | 21.6 分钟 |
| 99.99% | 0.01% | 4.32 分钟 |

> 每多一个 9，允许的不可用时长砍掉一个数量级——这就是「每个 9 贵 10 倍」的算术来源。

## 20.4 burn rate：把「还剩多少预算」变成能告警的数

单点错误率阈值回答不了「这样烧下去月底够不够用」。**burn rate（燃烧速率）**回答了它：

```
burn_rate = 当前错误率 / (1 − SLO)
```

- `burn_rate = 1`：按这个速度，**窗口结束时恰好烧完**预算。
- `burn_rate > 1`：会**提前**烧完。`14.4` 在 99.9% 下就是「1 小时烧掉 2% 的 30 天预算」。

PromQL 求 burn rate（针对 99.9% SLO）：

```promql
sum(rate(http_requests_total{job="payments",status=~"5.."}[1h]))
/ sum(rate(http_requests_total{job="payments"}[1h]))
/ (1 - 0.999)
```

**必须用「多窗口、多燃烧率」**——单一窗口要么太钝、要么太吵。长窗口判断「是不是真问题」，短窗口保证「恢复得快也灭得快」。三档：

| 严重度 | 长窗口 | 短窗口 | burn rate 阈值 | 含义 |
|---|---|---|---|---|
| page | 1h | 5m | **14.4** | 1h 烧掉 2% 预算 |
| page | 6h | 30m | **6** | 6h 烧掉 5% 预算 |
| ticket | 3d | 6h | **1** | 3d 烧掉 10% 预算 |

两个窗口同时超阈值才触发：

```yaml
- alert: ErrorBudgetBurnFast
  expr: |
    (sum(rate(http_requests_total{status=~"5.."}[1h])) / sum(rate(http_requests_total[1h]))) > 14.4*0.001
    and
    (sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))) > 14.4*0.001
  for: 2m
  labels: { severity: page }
  annotations: { summary: "错误预算燃烧过快：1h/5m 双窗 >14.4x" }
```

> `14.4 * 0.001` 里的 `0.001` 就是 `1 − 0.999`。字段名随 Prometheus 版本演进，以官方文档为准。

## 20.5 发布门禁：部署前先查错误预算

把「可不可以发」变成流水线里一个会 fail 的 job——这是 Day 20 的核心落点：

```yaml
check-error-budget:
  stage: gate
  script:
    - |
      BR=$(curl -sG "$PROM_URL/api/v1/query" \
        --data-urlencode 'query=(sum(rate(http_requests_total{job="payments",status=~"5.."}[1h]))/sum(rate(http_requests_total{job="payments"}[1h])))/(1-0.999)' \
        | jq -r '.data.result[0].value[1]')
      awk "BEGIN{exit !($BR > 1)}" && echo "✅ 放行" || { echo "❌ 预算燃烧过快，阻断发布"; exit 1; }
```

策略通常两级：`burn_rate > 1` **阻断**部署；`0.5 < burn_rate ≤ 1` **要求人工审批**。Prometheus HTTP API 返回结构随版本演进，接线上前以官方文档为准。

## 20.6 告警分级与告警疲劳治理

**分级的唯一判据**：用户是否正在受损 / 是否在烧 SLO 预算——不是「曲线难看」。

| 级别 | 触发条件 | 响应 |
|---|---|---|
| **page** | SLO 快烧毁、用户受损 | 立刻叫醒，需 runbook |
| **ticket** | 慢烧毁、需处理不必立刻 | 工作时间处理 |
| **log** | 仅供回溯 | 不通知，只入库 |

治理手段：**分组**、**抑制**（大故障时压掉其引发的次级告警）、**静默**（计划内维护）、**`for` 延时**、**用 SLO 告警替代阈值告警**。跟踪三个健康指标：每周 page 数、被静默比例、**触发后真正采取了行动的比例**；后者低于 ~50% 就是在制造疲劳。

## 20.7 从不追责复盘到行动项闭环

**Blameless**：系统会失败，人不会故意失败——要找的是系统为何让这个错误成为可能。复盘若产不出**有 owner、有截止日期、进入统一 issue 追踪**的行动项，就等于没复盘。**MTTR（恢复时间）比 MTBF 更可行动**——你无法阻止所有故障，但能决定恢复多快。

## 20.8 今天要建立的判断力

**三问收束**：要不要发 → 先看 burn rate 与剩余预算；看到告警 → 先问用户是否受损；看到指标 → 先问 `service.version` 能否定位到某次发布。

下一模块：把二十天串成端到端流程，并给出你自己的差距清单。
