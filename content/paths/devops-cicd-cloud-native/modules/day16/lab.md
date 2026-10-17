---
title: 实验十六 · 让一次训练「被杀掉也能续上」
---

# 🧪 动手实验 · Day 16

> **目标**：不是学 YAML，而是**亲手制造一次「训练被杀」，并验证它能否从 checkpoint 续上、结果是否还能复现**。你如果带过训练集群，一定遇到过「跑了 6 小时被抢占、重跑又从头开始」——本实验把它在可控环境里复现一遍。
>
> 三档任选：**档位 A 真环境**（有 GPU 集群）／**档位 B 本地**（无 GPU，用 `kind` 起单机集群跑一个 CPU 版「训练 Job」）／**档位 C 纸上**（10 分钟，纯推理）。

---

## 档位 A · 真环境（有 GPU 集群）

### 1. 提交一个「会写 checkpoint」的训练 Job

```bash
kubectl apply -f - <<'YAML'
apiVersion: batch/v1
kind: Job
metadata:
  name: tiny-sft
spec:
  backoffLimit: 3
  activeDeadlineSeconds: 7200
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: trainer
          image: <你的训练镜像>@sha256:<digest>   # 固定 digest，不要用 tag
          command: ["bash", "-lc"]
          args:
            - |
              trap 'echo "[$(date)] got SIGTERM, flushing checkpoint"; touch /ckpt/flushed; exit 0' TERM
              STEP=0
              [ -f /ckpt/step ] && STEP=$(cat /ckpt/step)     # 有 checkpoint 就续上
              echo "resume from step=$STEP"
              while [ $STEP -lt 100000 ]; do
                STEP=$((STEP+1)); echo $STEP > /ckpt/step
                printf '%s step=%s loss=%.4f\n' "$(date +%T)" "$STEP" "2.$((RANDOM%9000))"
                sleep 2
                [ $((STEP % 20)) -eq 0 ] && { echo "checkpoint @ $STEP" > /ckpt/ckpt; }
              done
          resources:
            limits:
              nvidia.com/gpu: "1"
          volumeMounts:
            - name: ckpt
              mountPath: /ckpt
      volumes:
        - name: ckpt
          persistentVolumeClaim:
            claimName: ckpt-pvc          # 已存在的 PVC；无则先建
YAML
```

### 2. 观察「排队 ≠ 失败」

```bash
kubectl get pods -l job-name=tiny-sft -o wide -w
```

| 观察项 | 你的记录 |
|---|---|
| Pod 是 Pending 还是 Running？Pending 时 `describe` 的 Events 说什么？ | |
| 从提交到 Running 的等待时长（这就是排队） | |

### 3. 制造一次「抢占」并观察恢复

```bash
kubectl logs -f job/tiny-sft          # 记下当前 step
# 另开终端，模拟节点回收：直接删 Pod（等价于被驱逐）
kubectl delete pod -l job-name=tiny-sft
kubectl get pods -l job-name=tiny-sft -w
```

**关键观察**：新 Pod 起来后日志里应出现 `resume from step=…`，且 step **从上次 checkpoint 继续**，而不是 0。这就是「中断 ≠ 失败」的工程含义。

| 观察项 | 你的记录 |
|---|---|
| 被杀时的 step | |
| 恢复后的起始 step | |
| 丢失的步数 =（被杀 step − 恢复 step） | |

---

## 档位 B · 本地（无 GPU，用 kind）

用单机集群跑一个**纯 CPU** 的「训练 Job」，重点是跑通「提交 → 排队 → 被删 → 续训」这条编排链路。

```bash
kind create cluster --name trainlab
# 建一个 PVC，用来跨 Pod 保存 checkpoint（kind 自带默认 storageClass）
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ckpt-pvc
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
YAML
```

把档位 A 的 Job 清单里的 `resources.limits.nvidia.com/gpu` **整段删掉**（CPU 集群没有这个资源），`image` 换成 `python:3.12-slim`，其余照抄，然后：

```bash
kubectl apply -f tiny-sft-job.yaml
kubectl get pods -l job-name=tiny-sft -w
kubectl logs -f job/tiny-sft
kubectl delete pod -l job-name=tiny-sft     # 模拟抢占
kubectl logs job/tiny-sft --prefix          # 看新 Pod 是否从上次 step 续上
```

| 你观察到的 | 结论 |
|---|---|
| 新 Pod 日志从 `resume from step=N` 开始 | checkpoint 生效，续训链路通 |
| 新 Pod 从 `step=0` 开始 | 说明没读到 checkpoint——PVC 没挂上，或脚本没检测 |

再做一个**反面对照**：把 checkpoint 目录改成 `emptyDir`（Pod 删除即丢），重跑一次上面流程——你会发现每次都从头，**这正是「抢占一次 = 白跑」的根因**。

---

## 档位 C · 纸上（无需环境，10 分钟）

下面是一次分布式训练被 Spot 节点回收的时间线。先回答右侧三个问题，再看答案：

```
03:11:58  step 41900  loss 2.13  lr 1.2e-4   ← 最近一次成功 checkpoint：step 41000（8 分钟前）
03:12:01  Warning  NodeDrain  node ip-10-0-3-14  "Spot 实例即将回收"
03:12:01  训练脚本收到 SIGTERM，进入 signal handler，开始 flush checkpoint
03:12:31  宽限期到，SIGKILL；Pod 被删（这次 flush 只写到 60%，未完成）
03:12:35  Job 控制器新建 Pod（backoffLimit 剩 3）
03:12:40  Pod Pending —— 集群无空闲 GPU（配额已满）
04:07:12  Pod Running，加载 checkpoint：只能回退到 step 41000
04:07:40  step 41001  loss 2.14
```

问题：

1. 这次恢复是成功还是失败？
2. 大约丢了多少训练时间？
3. 为什么中间 Pending 了 34 分钟，它是「失败」吗？

<details><summary>参考答案（先写完再看）</summary>

1. **恢复成功**。进程从 step 41000 续上，loss 连续（2.13 → 2.14 属正常波动，不是从头跳变）。**中断 ≠ 失败**在这里成立——抢占被 checkpoint 兜住了。
2. 丢的是 **last-good checkpoint（41000）到被杀（41900）之间的 900 步**。假设 ~0.4s/步，约 **6 分钟** 的训练量。注意：03:12 那次 flush 只写了 60%，**没有形成可用 checkpoint**，所以不能拿它当恢复点。
3. 那 34 分钟是**排队**（无空闲 GPU），不是训练失败，也不该被任何超时判死。要压缩它，方向是提高 GPU 配额/优先级，或让作业能回退到次优资源池——而不是改训练代码。

**该改什么**：① 缩短 checkpoint 间隔（比如 200 步）以降低单次丢失；② 关键 flush 要**原子写**（写临时文件再 rename），避免出现「写了一半」的坏 checkpoint 被误加载；③ `SIGTERM` 后给足宽限期，否则 flush 永远写不完。

</details>

### 最后一问（写下你的答案）

假设这次训练最终「跑成功了」（退出码 0、loss 达标）。仅凭这个事实，你能宣布「这个模型可以被交付」吗？**写下你现在无法确认的三件事**：

1. ____________________
2. ____________________
3. ____________________

<details><summary>参考答案</summary>

至少包括：① 代码 / 数据 / 超参三要素是否都版本化了（否则结果不可复现）；② 训练用的镜像是不是 digest 固定（`latest` 会让「同一代码」跑出不同环境）；③ 随机种子与确定性是否固定（换台机器能否复现同指标）。这三条正是 Day 17 要把它变成「可追溯制品」的原因。
</details>
