---
title: 实验二十 · 为一个服务定 SLO，并把它变成发布门禁
---

# 🧪 动手实验 · Day 20

> **目标**：亲手走一遍「定 SLI/SLO → 算错误预算 → 写 burn rate 告警 → 把它做成发布门禁 → 触发一次燃烧看门禁拦人」的完整闭环。做完你会有一张能贴进自己项目的模板。
>
> 三档任选：**档位 A 真环境**（有监控的集群 / 可部署 kube-prometheus-stack）／**档位 B 本地**（docker 起 Prometheus）／**档位 C 纸上**（20 分钟，纯推理）。

---

## 档位 A · 真环境（有 Prometheus + Grafana）

### 1. 先填这张 SLO 工作表，再动手

| 项 | 你的填写 | 示例 |
|---|---|---|
| 用户视角的「好事件」 | | 返回 `2xx/3xx` 的请求 |
| SLI 表达式 | | `sum(rate(http_requests_total{status!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))` |
| SLO 目标 + 窗口 | | 99.9% / 30d |
| 错误预算 | | 0.1% ≈ 43.2 分钟不可用 |
| 可接受的下游依赖失败 | | 上游超时的算不算 |

**关键判断**：SLI 必须从**用户视角**取（成功请求比例），不要用 CPU、磁盘这类资源指标——它们回答不了「用户现在能不能用」。

### 2. 用 recording rule 预计算 SLI

```yaml
groups:
  - name: slo-payments
    interval: 30s
    rules:
      - record: sli:http_error_ratio:5m
        expr: |
          sum(rate(http_requests_total{job="payments",status=~"5.."}[5m]))
          / sum(rate(http_requests_total{job="payments"}[5m]))
```

用 `promtool` 校验语法（`promtool` 随 Prometheus 发行包，命令以官方文档为准）：

```bash
promtool check rules slo-rules.yml
```

### 3. 写「多窗口、多燃烧率」告警并对齐阈值

照 guide 的三档，在你的 Prometheus 里落地至少两档（critical 14.4 + warning 6）。触发后到 **Grafana** 建一行 SLO 面板：**当前 burn rate + 剩余预算百分比**。

### 4. 把门禁接进流水线

把 guide 20.5 的 `check-error-budget` job 抄进你的流水线，指向你的 `$PROM_URL`，跑一次确认基线 `burn_rate` 接近 0、门禁放行。

记录：

| 观察项 | 你的记录 |
|---|---|
| 基线 burn rate | |
| 剩余预算 % | |
| 门禁是否放行 | |

---

## 档位 B · 本地（docker + Prometheus，无需集群）

### 1. 起一个最小 Prometheus

```bash
mkdir -p slo-lab && cd slo-lab
cat > prometheus.yml <<'YAML'
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
YAML
docker run -d --name prom -p 9090:9090 \
  -v "$PWD/prometheus.yml:/etc/prometheus/prometheus.yml" \
  prom/prometheus:latest
```

（`prom/prometheus` 标签随版本演进，锁定具体版本更可复现。）

### 2. 用真实指标算 burn rate

Prometheus 自己就暴露了可用指标。用它的 HTTP 请求计数器练手：

```bash
# 先用 API 看一眼 metric 名（此处 job 名为 prometheus）
curl -sG 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=prometheus_http_requests_total' | jq '.data.result[0].metric'
```

**度量练习**：把下面这条 burn rate 查询的 `job`/指标名换成你观察到的，并解释它为什么在 SLO 99.9% 下超标：

```bash
curl -sG 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=sum(rate(prometheus_http_requests_total{code=~"5.."}[1h]))/sum(rate(prometheus_http_requests_total[1h]))/(1-0.999)' \
  | jq -r '.data.result[0].value[1]'
```

### 3. 写一个本地门禁脚本

```bash
cat > gate.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
BR=$(curl -sG 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=sum(rate(prometheus_http_requests_total{code=~"5.."}[1h]))/sum(rate(prometheus_http_requests_total[1h]))/(1-0.999)' \
  | jq -r '.data.result[0].value[1] // "0"')
echo "burn rate = $BR"
awk "BEGIN{exit !($BR > 1)}" && { echo "阻断发布"; exit 1; } || echo "放行"
SH
chmod +x gate.sh && ./gate.sh
```

| 你观察到的 | 结论 |
|---|---|
| `burn rate = 0` | 无 5xx，预算未消耗，放行 |
| 脚本以非 0 退出 | 门禁逻辑正确，可接进任一 CI 的 step |

**收敛实验**：人为制造一些 5xx（若条件不允许，改用 `vector(2)` 之类常量表达式模拟），观察 `>1` 时脚本是否真的拒发。

---

## 档位 C · 纸上（20 分钟，无需任何环境）

服务 `orders-api`，30 天窗口，SLO 定为 **99.95% 可用性**（成功请求比例）。

**问题**：
1. 错误预算是多少？30 天允许累计不可用多久？
2. 当前 1 小时窗口的错误率是 **0.5%**，burn rate 是多少？按此速度，30 天预算会在多久内烧完？
3. 在这个 burn rate 下，`page`（14.4）和 `warning`（6）哪个会触发？
4. 若改用 99.9%，同样的 0.5% 错误率，burn rate 变化如何？说明「阈值不能脱离 SLO 硬编码」。

<details><summary>对照答案（先写完再看）</summary>

1. **错误预算** = 100% − 99.95% = **0.05%**。30 天 = 720 小时 → 允许不可用 = 0.05% × 720h = **0.36 小时 = 21.6 分钟**。
2. **burn rate** = 错误率 / (1 − SLO) = 0.5% / 0.05% = **10**。含义：预算以正常速度的 10 倍燃烧。烧完整个 30 天预算需要 720h / 10 = **72 小时（3 天）**。（校验：1 小时消耗的预算比例 = burn_rate × 1h/720h = 10/720 ≈ 1.39%，与 0.5% 错误率相对 0.05% 预算一致。）
3. burn rate = **10 > 14.4**？否——10 **没有**超过 14.4，所以 **page 不触发**；10 **> 6**，所以 **warning（6，6h/30m 窗）会触发**（前提是持续 6h/30m）。
4. 改用 99.9%：错误预算 = 0.1%，burn rate = 0.5% / 0.1% = **5**。同一错误率下 burn rate 从 10 降到 5，甚至低于 warning 阈值 6。**结论**：burn rate 是相对 SLO 的量，阈值必须随 SLO 计算（`14.4×(1−SLO)`），硬编码绝对错误率会错。

</details>

### 最后一问（写下你的答案）

你的主服务，**发布前**有人会去看错误预算吗？如果没有，你打算把 `check-error-budget` 放在流水线的**哪个 stage**、用 `burn_rate` 的哪一档做阻断？把决定写下来——这就是 Day 20 落地的最小一步。
