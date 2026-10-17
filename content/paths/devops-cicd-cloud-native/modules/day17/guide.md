---
title: 训练编排与模型制品化
---

# Day 17 · 训练编排与模型制品化

## 17.1 从「一次 Job」到「一条流水线」

单次训练是一个 `Job`；真实交付是一条 **DAG**：数据→训练→评估→制品化→部署。依赖、传参、重试、产物传递属**工作流引擎**，`Job` 管不了。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: sft-pipeline-
spec:
  entrypoint: pipeline
  templates:
    - name: pipeline
      dag:
        tasks:
          - name: data
            template: prepare
          - name: train
            template: train
            depends: data
          - name: eval
            template: evaluate
            depends: train
          - name: register
            template: register
            depends: eval
```

**产物（数据集清单、checkpoint、指标 JSON）在步骤间显式传递**，各步一个容器、各有镜像与资源，不靠共享盘的隐式约定。

## 17.2 gang scheduling：分布式训练的资源原子性

训练要在同一轮 allreduce 里会合，而 kube-scheduler **逐 Pod** 调度——**一个 worker 没起就全在死等**。解法 **gang scheduling**（全就位或都不占）：

- **Volcano** 的 `PodGroup`（配 `minMember`）；
- **scheduler-plugins** 的 coscheduling；
- **Kueue** 负责准入/配额排队（通过 Job 的 `suspend` 控制起不停）。

```yaml
apiVersion: scheduling.volcano.sh/v1beta1
kind: PodGroup
metadata:
  name: llm-sft-pg
spec:
  minMember: 4          # 4 worker 必须同时就位
  queue: gpu-team       # 归属队列
```

> Pod 与 PodGroup 靠 label/annotation 关联，**具体键随 Volcano 版本演进，以官方文档为准**。

## 17.3 三种编排器的定位差异

| | Argo Workflows | Kubeflow Pipelines (KFP) | Volcano |
|---|---|---|---|
| 抽象 | DAG of steps，每步一个 Pod | ML pipeline（Python SDK 编译） | 批调度器（PodGroup + 队列） |
| 强项 | 通用编排、artifacts、重试、Cron | ML 组件复用、实验/元数据 UI | gang scheduling、配额与优先级 |
| 与 K8s 关系 | 一等 CRD（`Workflow`） | DAG 引擎通常基于 Argo（v2 引入 launcher/executor 抽象） | 与/替代默认调度器协作 |
| 何时选 | 数据→训练→评估的编排 | 平台化、多人共用组件与实验管理 | GPU 集群需要成组调度与公平排队 |

三者**不互斥**：KFP/Argo 管 DAG，Volcano/Kueue 管 GPU 成组与配额；「保证 8 卡一起给」看后者。

## 17.4 数据与 checkpoint 的存储选型

两类 I/O 特征不同的数据不能混谈：

| 数据 | I/O 特征 | 选型 |
|---|---|---|
| 数据集（一次写、多 epoch 读） | 顺序读、只读、大文件 | 对象存储 + 缓存层（Alluxio/Fluid/节点 NVMe），让第 2 个 epoch 命中缓存 |
| checkpoint（每 N 步写） | **突发高带宽写** | 并行文件系统（Lustre/GPFS/WekaFS 等），或「本地 NVMe 同步写 + 异步上传对象存储」 |
| 成品模型 | 一次写、多次读、要长期可引 | 对象存储 / OCI registry（见 17.6） |
| 日志与指标 | 追加写、量大 | 日志系统 + 时序库（不要塞进 checkpoint 存储） |

**常见错误**：checkpoint 同步写对象存储——每次写都造成突发带宽，训练被 I/O 卡住。应本地写 + 异步上传。

## 17.5 抢占、重试与失败恢复的编排

重试能力（Argo 的 `retryStrategy`）必须与训练语义配合：

```yaml
      retryStrategy:
        limit: "3"                 # 最多 3 次
        retryPolicy: "Always"      # 每次失败都重试
        backoff:
          duration: "1m"           # 首次等待
          factor: "2"              # 指数退避
          maxDuration: "10m"       # 上限
```

要区分**两类失败**，否则会陷入无意义的重试地狱：

| 失败类型 | 例子 | 处置 |
|---|---|---|
| 基础设施类（可重试） | Pod 被抢占、节点故障、GPU 掉卡 | 重建 + **从 checkpoint resume** |
| 业务类（不可重试） | 脚本 bug、数据污染、配置错误、显存溢出 | 快速失败并告警，重试只是浪费 GPU |

**关键**：基础设施类重试的**价值取决于 checkpoint**（否则等于从头再跑，Day 16）；编排层「重试」与训练层「续训」是同一机制的两半。

## 17.6 模型制品：从实验产物到一等制品

模型若只以「某次 run 的 artifact 文件」存在，就**不可引用、不可灰度、不可审计**。变**一等制品**两条路线：

| 路线 | 载体 | 引用方式 | 适合 |
|---|---|---|---|
| **模型注册表**（MLflow Model Registry 等） | 平台数据库 + 制品存储 | `models:/llm-sft@champion`（别名/版本） | 需要血缘、实验对比、多阶段别名的 ML 团队 |
| **OCI 制品**（`oras` 等） | 容器 registry | `registry.example.com/models/llm-sft@sha256:…` | 与现有镜像/GitOps 体系对齐，可签名（cosign）、可扫描 |

要点：**内容寻址（digest）+ 引用不可变**；晋级 = 搬运 digest/别名，而非拷文件（同 Day 12–14）。

```bash
# 把模型目录推成 OCI 制品，用 digest 引用
oras push registry.example.com/models/llm-sft:v3 ./model/
```

## 17.7 评估作为门禁：离线指标怎么变成 CI 的通过条件

评估不能停在「打表给人看」；要让离线指标变成**流水线的通过条件**：

1. 评估步骤输出**机器可读**指标（JSON artifact，不是 stdout 表格）。
2. 门禁把候选指标与**基线**（上个 champion）或绝对阈值比，**不达标即非零退出** → workflow 失败 → 阻断晋级。

```yaml
    - name: eval
      container:
        image: registry.example.com/llm/eval@sha256:REPLACE_ME
        command: ["bash", "-lc"]
        args:
          - python evaluate.py --model /artifacts/model --out /artifacts/metrics.json
    - name: gate
      container:
        image: registry.example.com/llm/eval@sha256:REPLACE_ME
        command: ["bash", "-lc"]
        args:
          - |
            python gate.py \
              --candidate /artifacts/metrics.json \
              --baseline  /artifacts/baseline.json \
              --min-accuracy 0.85 \
              --max-regression 0.005     # 相对基线允许的最大回退
```

设计门禁的三个坑：

- **小评估集 → 宽置信区间**：差异可能是噪声。要么扩集，要么设宽容差。
- **基线要固定**：用当前线上 champion，不是「上次跑」，否则会缓慢退化。
- **多指标定优先级**：准确率、延迟、公平性冲突时，谁一票否决要写明。

## 17.8 今天的判断力

- 看到「有人起不来」：**有没有 gang scheduling？**
- 看到反复重试同一 step：**基础设施失败还是业务失败？重试有意义吗？**
- 看到模型只以文件躺在共享盘：**能被 digest 引用吗？能签名吗？**
- 看到「评估通过」：**跟谁比的？基线是线上 champion 吗？**
