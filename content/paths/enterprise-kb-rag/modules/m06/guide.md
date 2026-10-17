---
title: 向量化与索引：模型、维度与向量库选型
---

# 里程碑 6 · 向量化与索引：模型、维度与向量库选型

> **交付物**：embedding 选型表（模型/维度/上下文/归一化/自测 recall）、向量库选型 ADR（Qdrant/Milvus/pgvector 三选一并写明代价）、容量与内存估算表、建集合与索引参数、批量写入脚本、索引版本与回滚方案。
> **验收标准**：任一同事照你的参数能在干净机器上建集合、灌数据、跑通一次查询，并说得出「换模型时动什么、多久、怎么回滚」。

## 6.1 embedding 选型：先看自己的语料，再看榜单

MTEB 排名高，不等于在你的语料上召回高。定选型前确认四件事：

| 维度 | 要确认 | 影响 |
|---|---|---|
| 语言 | 单语/跨语种 | 多语模型单语通常略逊 |
| 维度 | 384/768/1024/1536/3072 | 精度↑，也↑内存/延迟/成本 |
| 上下文 | 单块最多多少 token | 超长被**静默截断**，等于丢内容 |
| 归一化 | 是否输出单位向量 | 决定用 cosine 还是 dot（见 6.2） |

**必做**：抽 100–200 篇真实文档 + 50 条 (query, 正确块) 对，对 2 个候选各测一次 recall@k 再定——选错要全量重灌（6.5）。若模型要求 query/document 加前缀（如 `query:`/`passage:`），**用错不报错、只静默掉点**。

## 6.2 归一化与度量：一张必背的对应关系

| 度量 | 含义 | 何时用 | 与归一化的关系 |
|---|---|---|---|
| cosine | 夹角，忽略模长 | 文本 embedding 默认 | 归一化后与 dot **等价** |
| dot | 模长×夹角 | 已单位化、想更快 | 未归一化被模长污染 |
| L2 | 直线距离，越小越近 | 模长本身有信息时 | 归一化后排序与 cosine 一致 |

核心恒等式：`normalize(u)·normalize(v) = cos(u,v)`；当 `||u|| = ||v|| = 1` 时 `||u-v||² = 2 - 2·cos(u,v)`。

结论：归一化后 **dot/cosine/L2 排序完全一致**；归一化即可用 dot 走最快路径，不归一化则必须显式 cosine；文本 embedding 别「用 L2 又不归一化」。验证 `np.linalg.norm(v) ≈ 1`。

## 6.3 向量库选型：边界与代价

| 维度 | Qdrant | Milvus | pgvector |
|---|---|---|---|
| 索引 | HNSW | HNSW/IVF_FLAT/IVF_SQ8/DISKANN/AUTOINDEX | ivfflat/hnsw |
| 度量 | Cosine/Euclid/Dot/Manhattan | COSINE/L2/IP | vector_cosine_ops/vector_l2_ops/vector_ip_ops |
| 过滤 | payload filter（可建索引） | scalar field + partition | SQL WHERE + GIN/B-tree |
| 何时选 | 单机跑得动、filter 强 | 亿级、要水平扩展与 GPU 建索引 | 已有 PG、块数百万级内 |
| 主要代价 | 高基数过滤 + 大 payload 内存吃紧 | 运维最重（多组件） | 索引在 PG 进程内抢连接，超千万级吃力 |

按序问：① 已有 Postgres 且块 < 几百万 → 先试 pgvector；② 要复杂过滤且过滤后仍高召回 → Qdrant；③ 亿级、要独立扩缩容 → Milvus。**把「过滤 vs 召回」写进 ADR**（易漏 / 不足 k 条），务必实测。

## 6.4 建集合、建索引、归一化、批量写入（可直接抄）

**API 名各版本有差异（`search` 与 `query_points`），以官方文档为准。**

```python
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, HnswConfigDiff, PointStruct
import numpy as np

client = QdrantClient(url="http://localhost:6333")
COLL, DIM = "kb_chunks", 1024      # DIM 必须 = 模型输出维度，写错建集合失败
client.recreate_collection(        # 生产慎用（清空）；换版本应建新集合再切
    collection_name=COLL,
    vectors_config=VectorParams(size=DIM, distance=Distance.COSINE),
    hnsw_config=HnswConfigDiff(m=16, ef_construct=100),
)

def normalize(v):                  # 归一化后 cosine 与 dot 等价
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.clip(n, 1e-12, None)

BATCH = 128
for i in range(0, len(chunks), BATCH):     # 每批 128 条，别一条一条灌
    pts = [PointStruct(id=c["id"], payload=c["payload"],
                       vector=normalize(np.asarray(c["vector"], "float32")).tolist())
           for c in chunks[i:i+BATCH]]
    client.upsert(collection_name=COLL, points=pts, wait=True)
```

参数：`m`＝每节点连边数（大→召回/内存↑、建慢）；`ef_construct`＝建索引候选队列（大→质量↑、建慢，**不影响查询**）；查询期 `ef`（`hnsw_ef`）只增召回与延迟、**不改索引**；`wait=True` 保证写完即可查。pgvector 侧：`VECTOR(1024)` 列 + `USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 128)`（或 ivfflat `WITH (lists = 100)` + `SET ivfflat.probes = 10;`）。

## 6.5 换 embedding 模型 = 全量重建索引

不同模型的向量**不在同一空间**，跨模型比距离没有意义（维度不同直接报错）；即便维度相同，换版本/改归一化也改变空间。流程固定：**建新集合 → 新模型重灌全部块 → 重跑基线 → 切流量 → 旧集合回滚**，绝不混装。

| 元素 | 做法 |
|---|---|
| 集合命名 | 带版本后缀，如 `kb_chunks_bge_m3_v2` |
| 切换 | 应用层配置指向集合名；切换 = 改配置 + 重载 |
| 回滚 | 指回旧集合名，保留 N 天再删 |
| 台账 | 记「集合名 → 模型/版本/维度/归一化/建立时间」 |

## 6.6 内存与容量估算

HNSW 常驻内存 ≈ `块数 × 维度 × 4 字节（float32）` + 图结构（粗略按每点 `m × 2` 条边）。例：100 万块 × 1024 维 ≈ 3.9 GB，**再留 1.5–2 倍余量**给图/副本/峰值。先算，再决定是否降维或标量量化（int8）。稀疏索引（BM25/SPLADE）只预留写入通路，融合留给 m08。

## 6.7 本里程碑的判断力

- 有人报「榜单第一的模型」，追问：**你自己的语料上 recall@k 多少？** 问「cosine 还是 dot」，先反问：**归一化了吗？**
- 听「平滑迁移新模型」，追问：**旧向量怎么办？回滚指哪个集合？**

下一里程碑：用黄金集测出第一个 recall@k 与 MRR 基线——先量出来，再谈优化。
