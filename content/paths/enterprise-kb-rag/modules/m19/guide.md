---
title: 交付与发布：把知识库当生产系统上线
---

# 里程碑 19 · 交付与发布：把知识库当生产系统上线

> **本里程碑的交付物**：制品版本化表、含质量门禁的金丝雀配置骨架、可自动校验的上线检查单、三类回滚的分别计时记录。
> **验收标准**：任意第三方拿到一次线上回答的 trace id，能顺着它查出当时的**代码 commit / 模型 digest / 提示词 commit / 索引快照 / 评测集 commit**五者分别是哪个版本。

## 19.1 两类制品：模型与索引必须一起版本化

知识库有两个制品，必须对应同一时刻：

- **模型类**：推理权重 + **提示词**（system prompt、few-shot、模板）；提示词是制品，它改变了输出分布。
- **索引类**：**embedding 模型版本** + **数据快照** + 切分/解析参数。

**换 embedding 模型必须重建索引**：查询与文档向量若落在不同空间，相似度失效，检索**静默失效**（不报错、只答非所问）。**发布记「四元组」——代码、模型、索引、评测集。**

## 19.2 制品版本化表（照抄）

| 制品 | 组成 | 版本标识 | 存放位置 | 可变性 |
|---|---|---|---|---|
| 代码/编排 | 检索编排、API、判定脚本 | git commit | Git | 不可变 |
| 模型 | 权重 + 推理服务镜像 | 权重 digest / 镜像 **index digest** | 制品库 / OCI registry | 不可变 |
| 提示词 | system + few-shot + 模板 | git commit（独立 prompt 仓库） | Git | 不可变 |
| 索引 | embedding 版本 + 数据快照 + 切分参数 | `collection` 名 + `snapshot_id` | 向量库 / 对象存储 | 快照不可变 |
| 评测集 | 黄金集 + 判分脚本 | git commit + 数据集 digest | Git / 对象存储 | 不可变 |

把五个标识写进随镜像走的 `release.json` 并注入服务，响应带 `release_id`，观测与审计据此回溯；「**快照可寻址、可切回**」不变。

## 19.3 用 CI/CD 交付：与 DevOps 路径的衔接

本项目**不重写交付链路**：镜像构建、多架构、签名、GitOps 同步、渐进式发布，交给同仓 **`devops-cicd-cloud-native`** 路径承接。

**差异只有一处但关键**：那边制品是**一个**不可变镜像，知识库是**两个**（镜像 **和** 索引）。故补：索引构建做成流水线 job、产出**不可变快照 + digest** 并按环境晋级，且 GitOps 同记镜像 index digest 与索引快照 id，**让回滚能分别回退两类制品**。

## 19.4 环境晋级与数据隔离

| 环境 | 数据 | 目的 | 不变量 |
|---|---|---|---|
| dev | 脱敏小样本 | 快速迭代 | 可随时重建 |
| staging | 全量脱敏 | 真实分布下验证质量 | 与 prod 同构 |
| prod | 真实语料 | 对外服务 | 权限与审计齐全 |

三条不变量：① prod 语料**绝不**流向 dev；② staging 与 prod 的 embedding、向量库版本必须一致；③ 晋级靠**改变引用**、**绝不重建**。

## 19.5 金丝雀：让质量指标决定是否放量

**HTTP 200 不代表答对了**：门禁要同时盯「系统健康」与「答复质量」：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: {name: rag-quality-gate}
spec:
  args: [{name: service-name}]
  metrics:
    - name: error-rate
      interval: 2m
      successCondition: result[0] < 0.02
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(rag_requests_total{job="{{args.service-name}}",status!="ok"}[2m]))
            / sum(rate(rag_requests_total{job="{{args.service-name}}"}[2m]))
    - name: citation-coverage          # 有引用的回答占比，RAG 特有
      interval: 2m
      successCondition: result[0] >= 0.90
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(rag_answers_total{has_citation="true"}[2m]))
            / sum(rate(rag_answers_total[2m]))
```

判据：① 看**质量与错误预算**，不看 CPU；② `failureLimit` ≠ 1（否则抖动即回滚）；③ 样本量要够。

## 19.6 回滚要区分对象：三类回滚的耗时与前置条件

**「回滚」不是一个动作，是三个不同的动作。**

| 回滚对象 | 动作 | 前置条件 | 典型耗时 |
|---|---|---|---|
| 提示词 | `git revert` prompt commit + 重载 | 无状态；最好重跑评测 | 分钟级（+评测） |
| 应用/编排 | `kubectl rollout undo` / `argocd app rollback` | 上一版 index digest 仍在 | 分钟级 |
| 模型 | 推理服务切回旧权重 | 旧权重仍在、显存够；换了 embedding 则**必须连带回滚索引** | 分钟～小时 |
| 索引 | 切 `alias` 回旧快照 | 旧快照**未被删除** | 分钟（切别名）／小时（重建） |

**核心区分**：① **索引回滚的快路径是切别名、不是重建**——维护 `kb_current → snapshot_N` 别名，出事原子切换。② **模型与索引可能必须一起回**（改了 embedding 时）。③ 演练要**分别计时**。

## 19.7 上线检查单：能自动校验的才进流水线

| 检查项 | 类型 | 校验方式 |
|---|---|---|
| release manifest 五元组齐全 | 自动 | 字段非空 + 与部署清单一致 |
| 索引快照可寻址、别名正确 | 自动 | 快照存在 + `alias` 指向预期 collection |
| 评测门禁通过（不退化） | 自动 | m14 回归 job 非失败 |
| embedding 版本 = 索引构建时版本 | 自动 | 比对元数据 |
| 镜像 index digest 与部署清单一致 | 自动 | 比对流水线 digest 与 Git manifest |
| 越权用例全部被拦 | 自动 | m16 的双保险生效 |
| 两类回滚路径均演练过 | 半自动 | 演练记录 + 目标可解析 |
| oncall / runbook 就位 | 人判断 | 评审 |

原则：机器能判定的做成会 fail 的 job，勾选表只留需人判断项。

## 19.8 多架构提醒（最隐蔽的发布事故）

自建环境下推理/向量库节点**可能同时存在 amd64 与 arm64**。**镜像必须与目标节点架构匹配**，否则容器起不来（`exec format error`），金丝雀门禁**卡住而非明确失败**。

- 镜像**要么双架构，要么按 `kubernetes.io/arch` 对齐**，清单带 `nodeSelector`/`nodeAffinity`；
- 晋升与回滚**引用 index digest**（`app@sha256:<index-digest>`），不引用单架构 digest；
- 索引与 CPU 架构无关，但**必须与 embedding 版本对齐**。

> 多架构构建的完整做法见 `devops-cicd-cloud-native` 路径 day07，此处不重复。

## 19.9 本里程碑的判断力

- 看到「发了新版本」：**模型、提示词、索引是哪三个版本？一起发的吗？**
- 看到「回滚很快」：**回滚哪个对象？索引是切别名还是重建？**
- 看到金丝雀门禁只看错误率：RAG 还要看**引用覆盖率与拒答行为**。

下一里程碑：把项目交给团队。
