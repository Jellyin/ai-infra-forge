---
title: 实验十四 · 用指标判定一次金丝雀发布
---

# 🧪 动手实验 · Day 14

> **目标**：亲手跑一次**由 Prometheus 指标驱动的金丝雀发布**，再制造一次「误判」并修正它。你要体会的是：**回滚阈值定得对不对，比工具装没装重要得多**。
>
> 三档任选：**档位 A 真环境**（K8s 集群 + Argo Rollouts + Prometheus）／**档位 B 本地**（`kind` 起集群 + 装 Rollouts，用最小 Deployment 做金丝雀）／**档位 C 纸上**（读时间线判断该在哪一刻回滚）。

---

## 档位 A · 真环境

### 1. 把 Deployment 换成 Rollout

```bash
# 官方 kubectl 插件，主版本需与集群内控制器对齐；拿不准先 --help
kubectl argo rollouts version
kubectl argo rollouts get rollout api -n demo --watch
```

把 `spec.strategy` 换成 guide 里的 `canary.steps` 并带上 `analysis` 步骤，apply 后发动一次 `set image`。

### 2. 观察推进过程

| 观察项 | 你的记录 | 说明 |
|---|---|---|
| 每个 step 停留多久 | | `pause` 时长是否落在预期 |
| analysis 每轮查询结果 | | `result[0]` 是多少、分母多大 |
| 失败计数何时达到 failureLimit | | 是否「抖动一次」就回滚了 |

### 3. 故意制造一次误判

把 `failureLimit` 改成 `1`、`interval` 改成 `10s`、`setWeight` 后只 `pause: 30s`。你会看到：**新副本冷启动的头几秒延迟尖峰，直接把发布打成 Degraded**。记下回滚发生在第几轮查询——这个数字就是「样本量不足」的代价。

---

## 档位 B · 本地（无云集群，纯 kind）

### 1. 起集群并安装控制器

```bash
kind create cluster --name rollout-lab
kubectl create namespace argo-rollouts
# 安装控制器与 CRD（版本以官方 install 文档为准）
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
brew install argoproj/tap/kubectl-argo-rollouts   # 安装 kubectl 插件
```

### 2. 用最小镜像跑一次「能停住的」金丝雀

没有 Prometheus 时，先用**空 pause** 做「人工判定」的金丝雀，把 `steps` 推进流程跑通：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: {name: demo}
spec:
  replicas: 4
  selector:
    matchLabels: {app: demo}
  template:
    metadata: {labels: {app: demo}}
    spec:
      containers:
        - name: web
          image: registry.k8s.io/pause:3.9
  strategy:
    canary:
      steps:
        - setWeight: 25
        - pause: {}          # 无限期，等人工 promote
        - setWeight: 50
        - pause: {}
```

```bash
kubectl apply -f rollout.yaml
kubectl argo rollouts get rollout demo --watch     # 停在第一步
kubectl argo rollouts promote demo                 # 推进到下一步
kubectl argo rollouts abort demo                   # 回滚：把稳定版重新拉满
```

**记录**：`abort` 之后看 `get rollout` 输出——你能看到 Rollback 事件，这就是 controller 执行回滚的证据。

### 3. 制造多架构陷阱（进阶）

```bash
docker build --platform linux/amd64 -t myreg/demo:v2 . && docker push myreg/demo:v2
kubectl get pods -o wide    # arm64 节点上新副本 exec format error，起不来
```

结论：**多架构集群里镜像没有对应架构，新副本「起不来」，analysis 因分母为 0 既不算成功也不算失败——发布静默卡住。**

---

## 档位 C · 纸上（15 分钟，无需环境）

一次金丝雀发布：`v2` 在 T=0 放量 20%，判定用「5xx 错误率」，`interval=1m`，`failureLimit=3`。

| 时刻 | 流量占比 | 5xx 错误率 | 样本数/分钟 | 备注 |
|---|---|---|---|---|
| T+1m | 20% | 4.0% | 120 | 冷启动尾延迟高，部分请求超时 |
| T+2m | 20% | 0.2% | 600 | 预热完成 |
| T+4m | 50% | 0.1% | 1500 | 通过，放量到 50% |
| T+5m | 50% | 8.5% | 1500 | **DB 连接池在 50% 流量下被打满** |
| T+6m | 50% | 9.1% | 1500 | 持续 |
| T+7m | 50% | 8.8% | 1500 | 持续 |

1. 若「单次不达标即回滚」，会在 T+1m 触发——**这是误判还是真故障？为什么？**
2. 若「连续 3 次不达标才回滚」，回滚落在哪一刻？**是不是太晚了？**
3. 该用什么手段同时**避免 T+1m 误判**、又**不错过 T+5m 真故障**？

<details><summary>对照答案（先自己写）</summary>

1. **T+1m 是误判**：4% 来自冷启动（连接池/JIT 未就绪），样本只有 120/分钟，分母太小，一次尖峰被放大。T+2m 回落到 0.2% 就是证据。
2. 连续 3 次在 T+5、T+6、T+7 达成，**T+8m 才回滚——太晚**。50% 流量下 8.8% 错误率约每分钟 130 个用户报错，多烧了 3 分钟错误预算。
3. 手段：**让判定晚于冷启动**（`setWeight` 后加 `pause: {duration: 2m}`）；**样本量护栏**（分母达阈值才判定，或提高 `interval`）；**区分尖峰与持续**（`failureLimit` 过滤抖动，但 N 与放量失败代价一起权衡）；**选对指标**（错误率贴近用户，用 CPU 会因流量倾斜误判，更好的是「错误预算燃烧速率」）。而且回滚不是唯一动作——T+5m 根因是连接池容量，正确处置是**先回滚保用户、修容量后重发**。
</details>

### 最后一问

用一句话说清：**「自动回滚」里，谁做判定、谁执行动作？** 如果你的流水线里 CI 也在做「健康检查后决定回滚」，你会怎么改？

<details><summary>参考答案</summary>

判定由 `AnalysisTemplate`（Prometheus 查询 + successCondition/failureLimit）完成，执行由 **Argo Rollouts controller** 完成——它把流量导回稳定版并标记 Degraded。CI 只构建镜像、推进 image tag（触发），**不应再散落一份判定逻辑**：判定与执行都收敛在 Rollouts 里才能审计、统一改阈值。两处各有一份阈值不一致时会互相打架。
</details>
