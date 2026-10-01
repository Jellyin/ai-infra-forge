---
title: 实验十一 · 提交一个 gang 调度的训练 Job
---

# 🧪 动手实验 · Day 16

> **目标**：把「训练任务」真实地提交给 K8s/Volcano——体验 PodGroup/配额/失败续跑与 Web 负载的差异。
>
> 三档：**真机**（有 K8s 集群）／**纸上**（Job spec 审计 + 架构默画）。

---

## 档位真机（K8s，无需 GPU 也可跑通语义）

```yaml
# train-job.yaml —— 用纯 CPU 训练任务演示 gang 语义
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata: { name: mini-train }
spec:
  minAvailable: 3                    # ★ gang：3 个副本凑齐才启动
  schedulerName: volcano
  queue: team-ml                     # ★ 队列配额（需预先建 Queue）
  maxRetry: 2                        # ★ 失败重试（配合应用侧 checkpoint 续训）
  tasks:
  - replicas: 3
    name: worker
    template:
      spec:
        restartPolicy: OnFailure
        containers:
        - name: train
          image: python:3.11-slim
          command: ["python", "-c", "import time; [time.sleep(60) for _ in range(10)]"]
          resources:
            requests: { cpu: "1" }
            limits:   { cpu: "1" }
```

```bash
# 1. 建 Queue（配额的载体）
kubectl apply -f - <<'EOF'
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata: { name: team-ml }
spec: { weight: 1, capability: { cpu: "8" } }
EOF
kubectl apply -f train-job.yaml

# 2. 观察 gang 语义：故意把 minAvailable 设成 4（大于副本数 3）
#    → Job 永远 pending（凑不齐就不启动）——反向验证 gang
kubectl describe vcjob mini-train | grep -A3 Events

# 3. 观察队列：再提交一个 queue=team-ml 的 Job 抢占配额
kubectl get queue -o wide
```

**记录三件事**：① minAvailable>replicas 时的 pending 事件文案（gang 证据）；② maxRetry 后 Pod 的重启行为；③ Queue capability 满时第二个 Job 的排队状态。

## 纸上档

**spec 审计**：同事的训练 Job 出现「7 个 Pod Running 但训练日志 0 输出、GPU 利用率 0」，spec 节选：

```yaml
spec:
  minAvailable: 1          # ← 疑点
  schedulerName: default-scheduler   # ← 疑点
  tasks:
  - replicas: 8
```

<details><summary>对照</summary>

两个致命点：① `minAvailable: 1` 让 8 副本任务**允许单 Pod 先起**——起的那 7 个在等 NCCL 握手，占卡不干活（gang 没生效）；② 用 default-scheduler 没有 gang 能力。修法：schedulerName: volcano + minAvailable: 8。这正是「训练任务当 Web 服务调度」的典型翻车。
</details>

**架构默画**：合上 guide，白板画训练平台五层（网关/队列调度/执行/支撑/可观测），每层标一个你现有运维能力的映射点。

---

## ✅ 实验完成清单

- [ ] 我见过（或纸上推演过）「凑不齐就不启动」的 gang 行为
- [ ] 我能指出训练 Job 与 Deployment 的五个调度差异
- [ ] 我能默画五层平台架构 + 我的经验映射
