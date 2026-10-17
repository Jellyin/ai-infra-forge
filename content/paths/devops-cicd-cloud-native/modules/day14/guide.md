---
title: 渐进式发布与自动回滚
---

# Day 14 · 渐进式发布与自动回滚

## 14.1 三种策略的适用场景与代价

| 策略 | 换来什么 | 代价 | 适用场景 |
|---|---|---|---|
| **滚动** | 零额外组件，K8s 原生 | 新旧版本同时存在，无法按流量比例观测，退出慢 | 无状态、风险低 |
| **蓝绿** | 切换原子，回滚即切回旧 Service | 双倍资源；切流瞬间全体用户进新版 | 有状态迁移、要么全切要么不切 |
| **金丝雀** | 按流量比例放量，真实体验压到 1% | 需流量路由能力（Istio/Nginx/ALB）+ 可靠指标判定 | 需真实流量验证的高风险服务 |

金丝雀的价值全部押在「指标判定」上——没有可靠指标，它只是「切得慢一点的滚动」。

## 14.2 `Rollout`：把发布写成可推进的状态机

Argo Rollouts 用 `Rollout` CR 取代 `Deployment`，字段相似，差别在 `strategy`。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: {name: api}
spec:
  replicas: 5
  selector:
    matchLabels: {app: api}
  template:
    metadata: {labels: {app: api}}
    spec:
      containers:
        - name: api
          image: registry.example.com/api:1.4.0
  strategy:
    canary:
      steps:
        - setWeight: 20          # 20% 流量导到新版本
        - pause: {duration: 5m}  # 观察 5 分钟
        - setWeight: 50
        - pause: {}              # 空 pause = 无限期等人工 promote
```

- `steps` 顺序推进，每步完成才进下一步。
- `setWeight` 设**流量权重**（需 `trafficRouting`）；无路由时用 `setCanaryScale` 控副本比例，语义不同别混用。
- `pause: {duration: 5m}` 定时；`pause: {}` 无限期等 `kubectl argo rollouts promote`。关键步建议用空 pause。
- 每个 `setWeight` 后可插 `analysis` 步骤，把观察交给指标。

蓝绿换 `strategy.blueGreen`（`activeService`/`previewService`/`autoPromotionEnabled: false`），无 `steps`。

## 14.3 `AnalysisTemplate`：让指标来判定

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: {name: success-rate}
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate
      interval: 1m
      successCondition: result[0] >= 0.95   # 成功判定
      failureLimit: 3                        # 连续 3 次不达标才判失败
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(http_requests_total{job="{{args.service-name}}",code!~"5.."}[1m]))
            /
            sum(rate(http_requests_total{job="{{args.service-name}}"}[1m]))
```

```yaml
      steps:
        - setWeight: 20
        - analysis:
            templates: [{templateName: success-rate}]
            args: [{name: service-name, value: api}]
        - setWeight: 50
        - pause: {}
```

字段：`interval` 每多久查一次；`successCondition`/`failureCondition` 对结果求值，`result[0]` 是第一个标量；**`failureLimit` 不是「一次不达标就回滚」**（设 1 会让任何抖动触发回滚）；`consecutiveErrorLimit` 管查询本身出错允许的次数。

## 14.4 自动回滚：谁判定、谁执行

- **判定依据**：`AnalysisTemplate` 的 Prometheus 查询 + `successCondition`/`failureLimit`。
- **谁执行**：**Argo Rollouts controller** 把流量导回稳定版并标记 Degraded。**不是 CI，也不是人手点**。

误判防护（三类来源）：

1. **样本量不足**：1% 流量下发 30 秒就判定，`成功 2 失败 1` 会被放大。对策：`failureLimit` 给够、留足 `pause` 让分母变大。
2. **抖动/冷启动**：新副本连接池未预热、JIT 未编译，头 30 秒延迟天然偏高。对策：让 analysis 的 `interval` 覆盖过冷启动。
3. **指标选错**：用 CPU 判定会因流量倾斜误判。选与用户体验挂钩的错误率、p95/p99 延迟；更贴近 SRE 的是以「错误预算燃烧速率」为判据——阈值从 SLO 反推，金丝雀阶段比稳态更严。

## 14.5 数据库变更：向后兼容两阶段

**能自动回滚的应用配一个不能回滚的库，等于没有回滚。**

| 阶段 | 数据库动作 | 应用动作 |
|---|---|---|
| **expand** | 加可空新列/新表 | 新代码双写新旧两处 |
| **migrate** | 回填历史数据 | 读路径切到新列 |
| **contract** | 所有实例升级后再删旧列 | 移除双写与旧读 |

判据很硬：**只有当「回滚旧版本」不再需要旧结构时，才能执行 contract**；在此之前任何一次发布都能安全回滚。

## 14.6 与 GitLab CI 的分工

**CI 负责「产出并提交」，Rollouts 负责「推进、判定、回滚」**：CI 构建镜像、推 registry、更新 GitOps 仓库 image tag（触发）；ArgoCD 把 Git 里的 Rollout 同步到集群；Rollouts controller 按 steps 推进、跑 AnalysisTemplate、决定继续或回滚并自己执行。CI 不碰 `kubectl`，也不做「健康检查后手动切流」——那会把判定逻辑散在两条流水线里，无法审计。

## 14.7 多架构陷阱（最隐蔽的发布事故）

集群混有 `amd64` 与 `arm64` 节点、镜像只推了 `amd64` 时，**新副本在 arm64 节点上因 `exec format error` 起不来**。症状隐蔽：发布停在副本 CrashLoop，指标分母为 0，analysis 既不算成功也不算失败——**卡住而非明确失败**。防护：① `docker buildx` 推多架构 manifest；② 用 digest 固定镜像（Day 15）；③ 对「查不到数据」设 `consecutiveErrorLimit`。

## 14.8 今天要建立的判断力

- 选策略先问：**我能付哪种代价**。
- 看到金丝雀，先问：**判定用哪个指标、样本量够不够**。
- 看到「自动回滚」，分清：**判定是 analysis，执行是 controller**。
- 有数据库变更，先问：**能不能安全回滚**。
