---
title: 训练任务的 CI/CD 特殊性
---

# Day 16 · 训练任务的 CI/CD 特殊性

## 16.1 先把「训练流水线到底特殊在哪」说准

| 维度 | Web 流水线 | 训练流水线 | 被打破的假设 |
|---|---|---|---|
| 时长 | 秒~分钟 | 小时~天 | 超时即失败 → 超时是**误杀** |
| 资源 | CPU/内存，可弹性 | GPU 稀缺、有配额、要排队 | 「想跑就能跑」不再成立 |
| 中断 | 罕见，中断 = 失败 | 抢占/驱逐是常态，中断 ≠ 失败 | 需要断点续训 |
| 输入 | Git 里的代码 | 代码 + TB 级数据集（外部版本） | 输入不只是 Git |
| 产出 | 不可变镜像 | 权重 + 指标 + 超参 | 产物非单文件、非完全确定 |
| 判定 | 退出码 | 退出码 + 指标阈值 + 可复现性 | 「绿」不足以交付 |

**一句话**：核心命题不是「能不能跑起来」，而是「**结果能不能复现、能不能安全重跑**」。

## 16.2 长时作业：不要用「超时」表达失败

训练里 8 小时作业被 60 分钟超时杀掉，是**把正常作业当失败**。让训练自我感知状态：

- 用 `activeDeadlineSeconds` 表达「墙钟预算」（> 最坏时长 × 重试预算），而非 CI timeout。
- 训练脚本定期上报心跳/进度，区分「卡住」与「在跑」。
- 长时作业**日志必须外置**：Pod 被杀后 `kubectl logs` 拿不到，须实时写进日志系统或对象存储。

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: llm-sft
spec:
  backoffLimit: 4                 # 重建 Pod 次数上限
  activeDeadlineSeconds: 86400    # 墙钟预算 24h
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: trainer
          image: registry.example.com/llm/trainer@sha256:REPLACE_ME   # 钉死 digest
          command: ["python", "-m", "train"]
          args: ["--config=/etc/run/config.yaml", "--resume"]
          resources:
            limits:
              nvidia.com/gpu: "1"   # 扩展资源：整数、只出现在 limits
```

## 16.3 GPU 稀缺：排队、抢占与「中断 ≠ 失败」

GPU **稀缺且不可超卖**（`nvidia.com/gpu` 按整数分配）：

- **提交 ≠ 开始**。Pod 长期 `Pending` 是**排队**不是失败，别设把 Pending 判死的短超时。
- 集群常开**抢占式/Spot 节点**，训练须假设「随时可能被杀」。

抢占/重试分清三层职责：

| 层 | 谁负责 | 表现 |
|---|---|---|
| 节点被回收 | 云厂商 / 集群自动伸缩器 | Pod 收到终止信号，宽限期后被删 |
| Pod 被删 | **Job 控制器**（`restartPolicy` / `backoffLimit`） | 重建 Pod，从镜像**原样重跑** |
| 进程重启 | 训练脚本（signal handler + checkpoint） | 从最近 checkpoint 续训 |

**关键**：Job 控制器只会「原样重跑容器」，**不懂 checkpoint**。续训必须写进训练脚本（`SIGTERM` 时 flush、启动时 `--resume`），否则抢占一次 = 白跑。

```yaml
      # 落到 Spot/抢占节点（键名随云厂商而异）
      tolerations:
        - key: "cloud.google.com/gke-spot"
          operator: "Exists"
          effect: "NoSchedule"
      nodeSelector:
        cloud.google.com/gke-spot: "true"
```

> 分布式训练还多一层：多个 worker 必须**同时**拿到资源，否则先到的空等——即 **gang scheduling**（Day 17）。

## 16.4 可复现性三要素：代码 / 数据 / 超参都要版本化

| 要素 | 版本化载体 | 不可复现的写法 |
|---|---|---|
| **代码** | Git commit SHA（镜像 tag 用 SHA，或把 SHA 打进镜像 label） | 用 `:latest` 训练镜像，事后不知道跑的是哪版 |
| **数据** | 数据集 manifest（路径 + 内容哈希 + 条数）；DVC / lakeFS / Delta 时间旅行 | 直接指 `s3://bucket/raw/`——内容随时被覆盖 |
| **超参** | 配置文件进 Git，或全量落进实验追踪（MLflow run 的 params） | 超参只在某人的 notebook / 命令行里 |

三要素外还要锁**环境**（16.7）与**种子**（`random`/`numpy`/`torch.manual_seed` 及**数据加载顺序**）。

**给我三要素就能重建这次训练；缺一个，结果就只是「一次性」。**

## 16.5 checkpoint 与断点续训：存什么、多久存一次

checkpoint 不只是权重。要**精确续训**，至少存：

- 模型权重
- **优化器状态**（Adam 动量/二阶矩）——只存权重续训 loss 会跳变
- **学习率调度器**状态与 global step / epoch
- **各 RNG 状态**（含 dataloader 采样器）——否则恢复后数据顺序变
- 训练配置与代码 SHA

存太频拖慢 I/O，太稀一次抢占丢几小时。

```
间隔 ≈ min(可接受的丢失时长, 单次写入 checkpoint 的耗时 × 安全系数)
```

工业做法是**异步写**（先写本地 NVMe，后台拷到对象存储），只在里程碑同步写。

## 16.6 数据依赖：数据集版本与缓存对流水线的约束

训练输入以 TB 计，**每次重跑都从对象存储拉一遍**不可接受，流水线须显式处理：

- **版本**：数据集当**不可变制品**——产出 manifest（key + 哈希 + 条数），流水线引用 manifest 哈希而非 `s3://…/latest/`。
- **缓存**：缓存 key 要含**数据集哈希**；版本一变即失效，否则静默在旧数据上训练（同 Day 1「缓存假命中」）。

## 16.7 训练镜像即环境：别在流水线里装 conda

训练环境（Python、框架、CUDA/cuDNN、算子）必须**构建进镜像**并**固定到 digest**：

- **可复现**：`pip/conda install` 结果**随时间变化**，同一配置今天与下周装出的环境不同。
- **离线与速度**：GPU 节点常无外网；运行时装包既慢又易失败，还把失败混进「训练失败」。
- **架构匹配**：镜像须与目标节点架构（amd64/arm64）及 CUDA 版本、驱动兼容，否则「调度成功、容器起不来」（`exec format error`，Day 18）。

> 自检：`docker run` 起 shell 能**离线**跑通 `python -c "import torch; print(torch.cuda.is_available())"` 即环境自足。

## 16.8 「跑成功了」和「结果可复现」是两件事

| 说法 | 含义 | 需要什么 |
|---|---|---|
| 跑成功了 | 进程退出码 0，loss 看起来降了 | 一次能跑完的 job |
| 结果可复现 | 给定三要素，能在同一容差内重现指标 | 三要素版本化 + 固定镜像 + 固定种子 + 确定性算子 |

「不可复现」最常见根因：① 数据被就地覆盖无版本记录；② 用浮动 tag 镜像；③ 种子没固定（含数据加载顺序）；④ 框架算子非确定性。

## 16.9 今天的判断力

- 看到训练「失败」：**真失败，还是被抢占 / 排队超时？**
- 看到「跑成功了」：**三要素齐了吗？换台机器能复现吗？**
- 看到启动脚本里有 `pip install`：**这环境明天还是同一个吗？**
- 看到 checkpoint 只存了权重：**续训后 loss 会不会跳？**
