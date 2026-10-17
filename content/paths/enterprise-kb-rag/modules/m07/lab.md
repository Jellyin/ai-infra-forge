---
title: 实验七 · 测出你的第一个召回基线
---

# 🧪 动手实验 · 里程碑 7

> **本里程碑的交付物**：① 黄金集（query → 正确块 id）② 召回@k 与 MRR 基线报告 ③ 失败归因表 ④ 一条可重复运行的评测命令 ⑤ 一份检索日志样本。
> **验收标准**：别人拿你的脚本与黄金集，能一键复现出**同一组** recall@k / MRR 数字；并且你能指着失败清单说清每条 query 该归到「语料缺失」「检索失败」还是「切分问题」。
>
> 三档任选：**档位 A 真实项目**（有真实提问与真实语料）／**档位 B 本地练习**（docker 起 Qdrant + 小语料，跑通评测脚本）／**档位 C 纸上评审**（给一组检索日志，逐条判断失败归因）。

---

## 档位 A · 真实项目（推荐）

### 1. 先建黄金集，别急着跑指标

找真实提问者，收集 **30–50 条真实问题**（不是你自己编的），逐条人工标注「哪些块是回答它必须的」：

| query | 正确块 id（可多个） | 标注人 | 依据 |
|---|---|---|---|
| 年假怎么请 | c1024 | | 制度文档 §3 |
| M4 评审定的超时 | c88, c91 | | 评审纪要 |

> 规则：**分母 = 你标注的相关块数**。一条问题标了 2 个正确块，recall@5 就要能把它俩都召回才算 1.0（见 guide 7.2）。黄金集本身要进版本库，改一次就在报告里注明。

### 2. 跑基线，得到第一个数字

用 guide 7.7 的脚本骨架，接上你的检索函数：

```bash
python eval_recall.py --golden golden.jsonl --k 5 --collection kb_chunks --out baseline.json
# 期望输出形如：
# recall@5 = 0.62   mrr = 0.48   n_queries = 42   n_failed = 16
```

**先接受这个数字，别优化。** 本步骤只交付「可复现的基线」。

### 3. 失败归因（本里程碑最重要的一步）

对每条 `recall < 1` 的 query，按 guide 7.6 分类，填表：

| query | 正确块在全库能查到吗 | 归因 | 下一步动作 |
|---|---|---|---|
| | 查不到（grep 原文也没有） | 语料缺失 | 补数据/修解析 |
| | 查得到但排名靠后 | 检索失败 | 记入 m08 的优化清单 |
| | 答案跨块被切断 | 切分问题 | 回 m05 改切分 |

```bash
# 判断「语料缺失」还是「检索失败」：拿正确答案里的关键串去原始语料搜
grep -rl "E-4021" /path/to/corpus | head
```

---

## 档位 B · 本地练习（docker 起 Qdrant，跑通评测脚本）

```bash
docker run -d --name qdrant -p 6333:6333 -v "$(pwd)/qdrant_storage:/qdrant/storage" qdrant/qdrant
python -m venv .venv && source .venv/bin/activate
pip install "qdrant-client" sentence-transformers
```

用 20–50 条自造文本灌一个集合，然后**编 10 条 query 的黄金集**：

```python
from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

model = SentenceTransformer("BAAI/bge-small-zh-v1.5")
dim = model.get_sentence_embedding_dimension()
cli = QdrantClient(url="http://localhost:6333")
cli.recreate_collection("kb_demo", vectors_config=VectorParams(size=dim, distance=Distance.COSINE))

docs = {100: "入职满一年可享年假 5 天", 101: "年假需提前三个工作日申请", 102: "调休不计入年假"}
vecs = model.encode(list(docs.values()), normalize_embeddings=True)
cli.upsert("kb_demo", points=[PointStruct(id=i, vector=v.tolist(), payload={"text": t})
                              for i, (v, t) in enumerate(zip(vecs, docs.values()))], wait=True)

def retrieve(q, k=5):
    v = model.encode([q], normalize_embeddings=True)[0].tolist()
    return [h.id for h in cli.search("kb_demo", query_vector=v, limit=k)]
```

黄金集（示例）：

```jsonl
{"query":"年假有几天","gold_ids":[100]}
{"query":"年假怎么申请","gold_ids":[101]}
{"query":"调休算年假吗","gold_ids":[102]}
```

跑 guide 7.7 的 `evaluate()`，观察两件事：① 数字能不能**稳定复现**（多跑一次是否一样）；② 把 k 从 3 改到 5，recall@k 怎么变——体会 k 与召回的关系。

> 也可把小模型换成任意 embedding API；关键不是模型多强，而是**把评测脚本跑通并读懂每个数字**。

---

## 档位 C · 纸上评审（30 分钟）

下面是一组检索日志（每行一次查询）。逐条判断失败归因：**语料缺失 / 检索失败 / 切分问题 / 看起来像但不答得对**。

```text
1. query「2023 版计费规则」 top5 全是「2022 版计费规则」；grep 语料存在「2023版计费规则.pdf」
2. query「报错 E-4021 怎么解」 top5 无关；grep 全语料 0 命中 E-4021
3. query「年假天数和申请方式」 top5 里第 1 条只有天数、第 4 条只有申请方式（两块分别为 c100/c101）
4. query「V2 路由器怎么重置」 top1 相似度 0.95，命中的是「V1 路由器重置」文档
5. query「怎么撤销已提交的报销」 top5 相似度 0.41 起，全部与报销无关；但阈值设为 0.3，结果照常返回
```

<details><summary>对照答案（先写完再看）</summary>

1. **检索失败**（多半是版本/时间意图没落到过滤条件）：正确文档在语料里，却输给了旧版本措辞。→ 记入查询理解/过滤的优化（m09）。
2. **语料缺失**：全语料都不含 E-4021，检索再优化也没用——要么补数据，要么让系统拒答。
3. **切分问题**（答案跨块）：两块都在，只是没被同一 query 一起召回——父子块或检索后聚合可解（回 m05）。
4. **看起来像但不答得对**：高相似度命中的是错误版本，说明「像」不等于「对」，靠相似度阈值挡不住，需要版本/元数据过滤。
5. **阈值过低**：0.41 全是不相关，却因阈值 0.3 被放行——用噪声冒充覆盖率，本应触发「没找到/拒答」。

</details>

---

## 交付物验收清单

| 交付物 | 通过标准 | 你的产出 |
|---|---|---|
| 黄金集 | ≥ 30 条真实问题，标注了正确块 id，且明确分母口径 | |
| 基线报告 | 给出 recall@k 与 MRR 两个数字，并注明 k、样本量、口径（recall 还是 hit） | |
| 失败归因表 | 每条失败 query 都落到「语料缺失/检索失败/切分问题」之一 | |
| 可重复命令 | 一条命令能从黄金集复现出同一组数字 | |
| 检索日志样本 | 含 query、top-k 块 id、分数、延迟，格式统一 | |

> 一句话收束：**先有基线，才谈得上优化**——你要的不是一个漂亮的数字，而是一套能让「改得更好」变得可判定的方法。
