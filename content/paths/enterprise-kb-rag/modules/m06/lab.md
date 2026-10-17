---
title: 实验六 · 从零建起一个向量索引并跑通一次检索
---

# 🧪 动手实验 · 里程碑 6

> **本里程碑的交付物**：① embedding 选型表（含你在自己语料上的自测 recall）② 向量库选型 ADR ③ 容量/内存估算表 ④ 建集合与索引参数脚本 ⑤ 批量写入脚本（可重复跑）⑥ 索引版本与回滚方案。
> **验收标准**：别人拿你的脚本能在干净机器上起库、建集合、灌 1 万条并跑通至少一次查询；且能正确回答「换模型时你要动哪些东西、大概多久、怎么回滚」。
>
> 三档任选：**档位 A 真实项目**（有真实语料与真实提问）／**档位 B 本地练习**（docker 起 Qdrant + 本地 embedding 模型）／**档位 C 纸上评审**（给一份有问题的配置与写入方案，逐条挑错）。

---

## 档位 A · 真实项目（推荐）

### 1. 用自己的语料选 embedding，而不是用榜单

```bash
# 抽 100–200 篇代表性文档做样本
find /path/to/corpus -type f -name '*.md' | shuf | head -200 > /tmp/sample.txt
```

再造 50 条 (query, 正确块 id) 对——这就是 m07 黄金集的雏形。对 2 个候选模型分别算 recall@5：

```python
for model in candidates:
    ids = index_sample(model)                     # 灌进临时集合
    hit = []
    for q, gold_id in pairs:
        got = [h.id for h in search(q, k=5)]      # 用该模型编码 query
        hit.append(gold_id in got)
    print(model, sum(hit) / len(hit))             # 只信这个数字，不信"感觉更像"
```

> 目的不是得到终版基线，而是**在 2 个候选之间做出有依据的选择**。

### 2. 填选型表（交付物）

| 候选模型 | 维度 | 上下文 | 是否需对称改写 | 归一化 | 自测 recall@5 | 单块成本 |
|---|---|---|---|---|---|---|
| | | | | | | |

### 3. 容量估算并下结论

按 guide 6.6 的公式填：块数、维度、向量本体内存、图结构余量、副本数 → **单机是否放得下**。放不下就先谈降维或量化，再谈选库。

---

## 档位 B · 本地练习（docker + 本地 embedding 模型）

```bash
# 1. 起 Qdrant（数据落盘到当前目录，可反复重启）
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 \
  -v "$(pwd)/qdrant_storage:/qdrant/storage" qdrant/qdrant
curl -s http://localhost:6333/collections | jq .

# 2. 装依赖
python -m venv .venv && source .venv/bin/activate
pip install "qdrant-client" sentence-transformers
```

```python
from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

model = SentenceTransformer("BAAI/bge-small-zh-v1.5")  # 中文小模型；维度以模型卡片/下面的 getter 为准
dim = model.get_sentence_embedding_dimension()

def enc(texts):
    # normalize_embeddings=True：归一化后 cosine 与 dot 等价（见 guide 6.2）
    return model.encode(texts, normalize_embeddings=True)

client = QdrantClient(url="http://localhost:6333")
client.recreate_collection(
    collection_name="kb_demo",
    vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
)
```

### 1. 灌 20 条，跑通一次查询

```python
docs = [f"第 {i} 条：这是关于主题 A 的说明，编号 {i}。" for i in range(20)]
vecs = enc(docs)
client.upsert(
    collection_name="kb_demo",
    points=[PointStruct(id=i, vector=v.tolist(), payload={"text": d})
            for i, (v, d) in enumerate(zip(vecs, docs))],
    wait=True,
)
hits = client.search(collection_name="kb_demo", query_vector=enc(["主题 A 是什么"])[0].tolist(), limit=3)
for h in hits:
    print(round(h.score, 4), h.payload["text"])
```

### 2. 必做的对照实验：归一化决定度量能不能互换

对同一批向量，比较三种做法的**排序**是否一致：

| 实验 | 写法 | 预期 |
|---|---|---|
| 归一化 + cosine | `Distance.COSINE` + `normalize_embeddings=True` | 基准 |
| 归一化 + dot | 换成 `Distance.DOT`，向量仍归一化 | **排序与基准一致** |
| 未归一化 + dot | 编码时不归一化，用 dot | **排序可能不同**（被模长污染） |

跑完把三次的 top-3 id 列出来贴进交付物——这就是你「真的懂了」的证据。

### 3. 看索引状态

```bash
curl -s http://localhost:6333/collections/kb_demo | jq '.result.points_count, .result.status'
```

---

## 档位 C · 纸上评审（30 分钟）

下面是一份**看起来能跑、实际全是坑**的建库与写入方案，找出其中的 6 个问题：

```text
建集合：collection=kb，vectors.size=768，distance=Cosine，hnsw{m=4, ef_construct=16}
embedding：模型 A（输出 1024 维），编码时未做归一化
写入：逐条 upsert，每条 wait=True，100 万条，串行
查询：使用 dot 距离
迁移：模型 A 出了新版本 A'，只对新增文档用 A' 编码，旧向量保持不动
```

<details><summary>对照答案（先写完再看）</summary>

1. **维度不匹配**：集合 `size=768`，但模型输出 1024 维——写入会直接失败（或建集合后无法 upsert）。
2. **`m` / `ef_construct` 过小**：`m=4, ef_construct=16` 远低于常见默认（如 m=16、ef_construct=100），召回会明显偏低。
3. **逐条 `upsert` 且串行**：100 万条逐条写入、每条都等网络往返，慢到不可接受；应按批（如 128/批）。
4. **未归一化却用 dot**：dot 会被向量模长污染，排序与 cosine 不一致；要么归一化后用 dot，要么显式用 cosine。
5. **换模型版本却混装**：A 与 A' 的向量不在同一空间，新旧混装会让距离失去意义——必须**全量重建**。
6. **缺少回滚与台账**：没有「集合名→模型版本」记录，也没有旧集合作回滚，出问题无法退。

</details>

---

## 交付物验收清单

| 交付物 | 通过标准 | 你的产出 |
|---|---|---|
| embedding 选型表 | 含维度/上下文/归一化/自测 recall，且是**在自己语料上**测的 | |
| 向量库选型 ADR | 在 Qdrant/Milvus/pgvector 中定一个，写明弃选理由与代价 | |
| 容量/内存估算表 | 有块数、维度、向量内存、余量、副本数，结论明确 | |
| 建集合脚本 | 能一键建集合，`size` 与模型输出维度一致 | |
| 批量写入脚本 | 分批写入、可重复运行、失败可重试 | |
| 索引版本与回滚方案 | 集合命名带版本、切换与回滚路径明确 | |

> 一句话收束：**索引是检索的物理基础**——这些参数不是玄学，是能算出来、能测出来的取舍；把它们写进文档，别留在你脑子里。
