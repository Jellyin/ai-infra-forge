---
title: 混合检索与重排：向量不是万能的
---

# 里程碑 8 · 混合检索与重排：向量不是万能的

> **本里程碑的交付物**：一个可运行的混合检索模块（BM25 + 向量 + RRF 融合）、reranker 的延迟预算与实测表、一份领域词典文件、以及每次改动的评测对比记录。
> **验收标准**：任意同事能按评测报告复现你的结论——「开 reranker 后 context precision 从 0.62 升到 0.79，p95 延迟 +120ms」，而不是「感觉变好了」。

## 8.1 什么时候向量会输给 BM25

向量擅长语义相近，**不擅长精确符号**。而企业内部语料里最要命的恰恰是精确符号：工单号、错误码、缩写、产品名、版本号。

| 查询 | BM25 | 向量 | 为什么 |
|---|---|---|---|
| 「错误码 `0xE003` 怎么解」 | **强** | 弱 | 向量会把 `0xE003` 与 `0xE004` 当成近似 |
| 「年假政策怎么请」 | 中 | **强** | 口语与「休假管理规定」语义对齐 |
| 「M4 评审定的超时」 | **强** | 中 | M4 是内部编号，通用 embedding 没见过 |
| 「AK 泄露怎么处理」 | **强** | 弱 | 缩写未进词表，向量不知道 AK=Access Key |

结论：**两类检索器互补，不是竞争**。上线前先在黄金集上分别量两路各自的 recall@10——某路在某类题上明显偏弱处，就是混合检索的收益来源。

## 8.2 RRF：公式与「为什么不用调权重」

Reciprocal Rank Fusion 只吃**名次**，不吃分数：

```
score(d) = Σ_r  1 / (k + rank_r(d))
```

- `r` 遍历每个检索器（这里是 BM25 与向量两路）；
- `rank_r(d)` 是文档 `d` 在第 `r` 路里的排名，**从 1 开始**；
- `k` 是平滑常数，常取 **60**（来自 Cormack 等人 2009 年提出 RRF 的原始设定）。`k` 越大，名次差距被压得越平。

可抄的融合骨架：

```python
def rrf_fuse(rankings: list[list[str]], k: int = 60) -> list[tuple[str, float]]:
    """rankings: 每个检索器返回的 doc_id 降序列表。返回 (doc_id, rrf_score) 降序。"""
    scores: dict[str, float] = {}
    for docs in rankings:                       # 每路一份排名
        for rank, doc_id in enumerate(docs, start=1):   # rank 从 1 开始
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
```

**为什么不需要调权重？** 因为不同检索器的分数量纲根本不可比——BM25 分数无上界（随语料变化），余弦相似度落在 [-1,1]。加权融合必须先**归一化到同一尺度**，而归一化方式（min-max？z-score？）本身又是一个要调、要维护的超参，且对异常分值敏感。RRF 只用名次，名次**天然可比、尺度无关**，两路默认等权就足够鲁棒——这就是它的工程价值：**少一个需要持续维护的超参**。

## 8.3 加权融合 vs RRF：什么时候才用前者

| 维度 | 加权融合（weighted sum） | RRF |
|---|---|---|
| 输入 | 归一化后的分数 | 名次 |
| 需要调参 | 需要（权重 + 归一化方式） | 不需要 |
| 跨检索器可比性 | 差 | 天然可比 |
| 对异常分值 | 敏感 | 鲁棒 |
| 何时选它 | 你确信分数分布稳定、且愿意持续维护归一化 | **默认选择**，多检索器/快速上线 |

判断依据：**若你还没建立起「每次改权重都跑评测」的纪律，就别用加权融合**——一个没人维护的权重比等权的 RRF 更危险。

## 8.4 两段式：粗排 top-k → 重排 top-n

混合检索召回（recall）已不错，但排在前面的仍混着不相关项。这时才引入**交叉编码器（cross-encoder）重排**：它把 query 与每个候选**拼在一起**打分，精度远高于双塔，代价是**每个候选都要过一次前向**，慢且吃显存。

```
粗排（BM25 + 向量 + RRF） 召回 top-50 ──► 重排（cross-encoder）取 top-8 ──► 送给 LLM
        快、能召回            k 要够大          慢、精度高            n 要够小
```

调用骨架（具体模型名与 `predict` 接口**按你所选交叉编码器的文档实现**，此处只示意形状）：

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder("<按所选交叉编码器文档替换>")   # 例如一个 ms-marco 系列的 cross-encoder

def rerank(query: str, candidates: list[dict], top_n: int = 8,
           batch_size: int = 32) -> list[dict]:
    pairs = [(query, c["text"]) for c in candidates]
    # batch_size 直接决定显存占用与吞吐：先小批量标定，再逐步上调到显存不爆
    scores = reranker.predict(pairs, batch_size=batch_size)
    ranked = sorted(zip(candidates, scores), key=lambda x: x[1], reverse=True)
    return [c for c, _ in ranked[:top_n]]
```

**重排不是免费的**，也不该是默认步。只有当「正确文档已在 top-50 内、但排不进 top-8」时才加它——先看评测里 context precision 是否低于你自己设的阈值。

## 8.5 领域词典：缩写、产品名、内部术语

通用 embedding 与分词器都不认识你的内部词。解法是维护一份**索引期与查询期共享**的词典：

```yaml
# domain_terms.yaml
synonyms:
  AK: ["Access Key", "访问密钥"]
  K8s: ["Kubernetes", "容器编排"]
  M4: ["里程碑4", "M4 评审"]
expand_on_index: true    # 写入时把别名一并索引 —— 提升召回，首选
expand_on_query: false   # 查询期默认不扩，避免漂移；需评测后再开
```

**关键取舍：优先在索引期扩展，而不是查询期**——索引期扩展只让同一实体的多种写法都能被匹配到，不改变用户意图；查询期扩展会往 query 里塞用户没说的词，直接引入漂移（见里程碑 9）。词典收益必须用评测证明：先量「词典命中率」，再看 recall@k 的增量。

## 8.6 延迟预算与「每次改动都回评测」

| 阶段 | 目标 p95 | 依据 |
|---|---|---|
| 双路召回（并行发出） | ≤ 60ms | 两路并发，取较慢者 |
| RRF 融合 | ≤ 5ms | 纯内存排序 |
| reranker（50 → 8） | ≤ 150ms | 交叉编码器，batch=32 |
| 检索阶段合计 | ≤ 200ms | 端到端预算里留给检索的部分 |

这张表要先定，再测。**每次改动（换 k、开 reranker、改词典）都必须跑同一套黄金集并记录 before/after**；没有这组数字，改动一律视为「未验证」——检索的改动极容易产生「我觉得好像好了」的错觉。

## 8.7 本里程碑的判断力

- 有人要「融合权重调一下」时，先反问：**两路分数归一化了吗？谁维护这个权重？** 答不上就该用 RRF。
- 有人要「默认上 reranker」时，先要 **before/after 的 precision 与 p95 延迟**，并核对是否吃掉了端到端预算。
- 看到「效果感觉变好」，一律要求**同一黄金集上的可复现数字**。

下一里程碑：把用户的问题变成适合检索的形式——改写、多跳拆解与元数据过滤，同样每个增强都要可开关、可归因。
