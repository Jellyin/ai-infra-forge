---
title: 实验十七 · 搭一条「数据→训练→评估→制品」的流水线
---

# 🧪 动手实验 · Day 17

> **目标**：不是学某个工具的语法，而是**亲手把训练的四个阶段串成一条带门禁的流水线**，并让模型变成一个能被 digest 引用的制品。老 DevOps 会在这里第一次感到「编排」和「CI 流水线」其实是同一件事，只是资源换成了 GPU。
>
> 三档任选：**档位 A 真环境**（有 K8s + Argo Workflows）／**档位 B 本地**（用 `kind` 起集群装 Argo，或退化为纯 K8s Job 链）／**档位 C 纸上**（12 分钟，纯推理）。

---

## 档位 A · 真环境（有 K8s 与 Argo Workflows）

### 1. 写一条最小 DAG（数据 → 训练 → 评估 → 注册）

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
            template: shell
            arguments:
              parameters: [{name: cmd, value: "echo '{\"rows\":1000}' > /tmp/manifest.json"}]
          - name: train
            template: shell
            depends: data
            arguments:
              parameters: [{name: cmd, value: "sleep 20; echo 'trained' > /tmp/model.bin"}]
          - name: eval
            template: shell
            depends: train
            arguments:
              parameters: [{name: cmd, value: "echo '{\"accuracy\":0.87}' > /tmp/metrics.json"}]
          - name: register
            template: shell
            depends: eval
            arguments:
              parameters: [{name: cmd, value: "echo registered"}]
    - name: shell
      inputs:
        parameters: [{name: cmd}]
      container:
        image: alpine:3.20
        command: ["sh", "-c"]
        args: ["{{inputs.parameters.cmd}}"]
```

```bash
kubectl -n argo apply -f pipeline.yaml
kubectl -n argo get pods -l workflows.argoproj.io/workflow
```

| 观察项 | 你的记录 |
|---|---|
| 四个 task 是串行还是并行？（提示：看 `depends`） | |
| 把 `train` 改成 `depends: []` 会怎样？ | |
| 让 `eval` 故意 `exit 1`，`register` 还会跑吗？ | |

**关键观察**：`eval` 失败 → 依赖它的 `register` **不会执行** → 制品不会被晋级。这就是「评估即门禁」在编排层的形态。

### 2. 加一个「会阻断」的门禁步骤

把 `eval` 的指令换成读指标 + 判断阈值，不达标就非零退出：

```yaml
              parameters: [{name: cmd, value: "sh -c 'echo \"{\\\"accuracy\\\":0.80}\" > /tmp/m.json; python -c \"import json;assert json.load(open(\\\"/tmp/m.json\\\"))[\\\"accuracy\\\"]>=0.85\"'"}]
```

（真实场景里这是 `gate.py --candidate … --baseline …`；这里用 `assert` 模拟。）跑一次，确认 workflow 变红、后续步骤被跳过。

### 3. 把模型产出成制品

```bash
oras push registry.example.com/models/llm-sft:v3 ./model/ \
  --annotation org.opencontainers.image.source=$GIT_SHA
docker buildx imagetools inspect registry.example.com/models/llm-sft:v3   # 看 digest
```

记下 digest：**下游要用 digest 引用它，而不是 `:v3` 这种可变的 tag。**

---

## 档位 B · 本地（无 Argo，用 kind）

### 1. 装 Argo Workflows（能装就装，装不上走 B-2）

```bash
kind create cluster --name orchestration
kubectl create namespace argo
kubectl apply -n argo -f https://github.com/argoproj/argo-workflows/releases/latest/download/install.yaml
# 注意：安装清单地址与版本随发布演进，以官方文档为准
kubectl -n argo get pods -w
```

装好后，把档位 A 的 `pipeline.yaml` 提交，`kubectl -n argo get pods -l workflows.argoproj.io/workflow` 观察四个 Pod 的先后顺序。

### 2. 退化为纯 K8s Job 链（无 Argo 的替代）

用三个 `Job` 手动串顺序：`kubectl wait --for=condition=complete job/data` → 再 `kubectl create -f train-job.yaml` → 再 `eval`。体会一下「手动编排」的痛点——这正是工作流引擎存在的理由。

| 你观察到的 | 结论 |
|---|---|
| 手动 `kubectl wait` 串 Job | 能跑，但没有依赖图、没有自动重试、产物传递靠约定 |
| 换 Argo 后 | DAG 声明化、失败自动停下游、重试策略可配 |

### 3. 本地演练「制品晋级」

不推真 registry，只做**引用演练**：写两个清单（champion / candidate），内容差别只在引用的 digest，用 `diff` 对比。记住：**「晋级」改的是引用，不是文件。**

---

## 档位 C · 纸上（无需环境，12 分钟）

一次流水线运行：`data` 成功、`train` 成功、`eval` 输出如下，`register` 与后续部署被挂起。请判断：**该不该晋级这个模型？**

```
eval 结果（评估集 500 条）：
  当前 champion（线上）:   accuracy 0.861
  本次候选:               accuracy 0.858
  安全指标（某敏感子群）:  候选 0.792 / champion 0.845   ← 门禁只配了整体 accuracy
  评估脚本 stdout 末尾:   "eval done"（无 JSON artifact，指标靠人肉从日志抄）
```

问题：

1. 只看整体 accuracy，候选比 champion 低 0.003——能过门禁吗？值不值得晋级？
2. 你还应该看什么？门禁的设计有什么问题？
3. 如果这次直接晋级，最可能出的「事故」是什么？

<details><summary>参考答案（先写完再看）</summary>

1. 只配了「相对基线最大回退」，0.003 很可能在容差内 → 门禁**会通过**。但「通过」不等于「值得晋级」：**指标没变好，就没理由换线上的东西**（换版本身有风险）。默认应**不晋级**，除非有别的明确收益（延迟、成本、新能力）。
2. 还该看**分群指标**——敏感子群从 0.845 掉到 0.792 是明显退化，而门禁只卡了整体 accuracy，属于**指标选择缺陷**。同时评估集只有 500 条，0.003 的差异很可能落在噪声范围内，应要求显著性而非卡单点。设计问题有二：① 缺分群/公平性门禁；② 指标没有机器可读 artifact，靠抄日志无法稳定比较。
3. 最可能的事故是**分群退化上线**：整体看不出问题，某个子群的用户体验/公平性显著变差，且因为门禁没覆盖而无人拦截。这是最典型的「门禁测了平均值、漏了尾部」。

</details>

### 最后一问

如果给你一个完全自由的团队和 3 个月，你会先建**模型注册表**还是先建**gang scheduling**？写下你的判断和理由（没有标准答案，但要能说清「先解决哪个瓶颈」）：

____________________________________________

<details><summary>参考思路</summary>

先问当前的瓶颈在哪：如果经常「8 卡起不齐、GPU 利用率低」→ 先 gang scheduling / 队列；如果经常「模型版本混乱、不知道线上是哪个」→ 先注册表 + 制品化。多数团队的真实瓶颈是**可追溯性**——先有 digest 化的模型制品，后面的灰度、回滚、审计才有落点。
</details>
