---
title: 实验三 · 跑通一条能增量、能删、能重跑的接入管道
---

# 🧪 动手实验 · 里程碑 3

> **本里程碑的交付物**：① 接入数据流图 ② 增量水位线方案 ③ 幂等键设计 ④ 删除/更新传播方案 ⑤ 失败隔离与失败清单 ⑥ 作业可观测指标。
> **验收标准**：把同一批语料接入两遍，向量库块数不翻倍；删掉源站一个文件再跑一次，该文件的块从检索结果里消失；制造一篇坏文档，作业照常跑完并输出失败清单。
>
> 三档任选：**档位 A 真实项目**（接你的真实源）／**档位 B 本地练习**（用 git 仓库当源 + docker 起 Qdrant）／**档位 C 纸上评审**（30 分钟，判断力训练）。

---

## 档位 A · 真实项目（推荐）

### 1. 画出你这条管道的五步数据流

照 guide 3.1 的五步，把每步的**输入、输出、失败后会怎样**写清：

| 步骤 | 输入 | 输出（落哪） | 失败后 | 能否单独重跑 |
|---|---|---|---|---|
| 取数 | | 变更集清单 | | |
| 解析 | | 结构化文本 + 锚点 | | |
| 切分 | | 块 + 元数据 | | |
| 索引 | | 向量库点 | | |
| 登记 | | 登记表记录 | | |

### 2. 建登记表并定义幂等键

登记表至少要能回答「这份文档上次什么时候、以什么指纹、以什么状态处理过」：

```sql
CREATE TABLE doc_registry (
    doc_id          TEXT PRIMARY KEY,
    source_uri      TEXT NOT NULL,
    content_hash    TEXT NOT NULL,      -- 规范文本 sha256
    parser_version  TEXT NOT NULL,
    chunker_version TEXT NOT NULL,
    status          TEXT NOT NULL,      -- ok / failed / deleted
    error           TEXT,
    indexed_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

写下你的幂等键公式，并**解释每一段为什么必要**（对照 guide 3.3）。

### 3. 跑两遍，验证幂等

```text
第一遍：接入 N 个文档 → 记录向量库总点数 P1
第二遍：不删源、原样再跑 → 记录 P2
通过标准：P2 == P1（不是 2×P1）
```

### 4. 制造一次删除，验证传播

```bash
# 删掉源站一个文件，重跑作业，确认该 doc_id 的块被清掉
mv /path/to/corpus/bad-doc.md /tmp/
# 重跑接入后，用检索/计数确认 bad-doc 的块已消失
```

### 5. 制造一次失败，验证隔离

拿一个畸形文件（截断的 PDF、超大文件、编码错误）混进变更集，确认作业**跑完**且失败清单里有它。

---

## 档位 B · 本地练习（git 仓库当源，可完整复现）

用 git commit 历史当「增量水位线」，其余流程与真实项目同构：

```bash
# 1) 起 Qdrant 并建集合
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant
curl -s -X PUT 'http://localhost:6333/collections/kb_docs' \
  -H 'Content-Type: application/json' \
  -d '{"vectors":{"size":4,"distance":"Cosine"}}'

# 2) 用 commit SHA 当水位线：只处理上次 SHA 之后的变更
git clone --depth=1 https://github.com/prometheus/prometheus /tmp/kb-corpus
cd /tmp/kb-corpus
LAST_SHA=$(git rev-parse HEAD)          # 假装上次处理到这个点
git diff --name-status "$LAST_SHA" HEAD -- docs/   # 之后的变更集

# 3) 文档指纹：对「规范文本」算哈希（归并所有空白后 sha256）
python3 -c 'import hashlib,sys;print("sha256:"+hashlib.sha256("".join(open(sys.argv[1]).read().split()).encode()).hexdigest())' docs/introduction/overview.md

# 4) 用「确定性 id」upsert（同 id 覆盖=幂等，id 由 doc_id+chunk_index 派生）
curl -s -X PUT 'http://localhost:6333/collections/kb_docs/points?wait=true' \
  -H 'Content-Type: application/json' \
  -d '{"points":[{"id":1,"vector":[0.1,0.2,0.3,0.4],"payload":{"doc_id":"d1","chunk_index":0}}]}'

# 5) 删除传播：按 doc_id 过滤删除该文档全部块
curl -s -X POST 'http://localhost:6333/collections/kb_docs/points/delete?wait=true' \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"must":[{"key":"doc_id","match":{"value":"d1"}}]}}'

# 6) 清单比对找出「已删除文档」：源清单 vs 登记表
comm -23 <(sort registry_ids.txt) <(sort current_ids.txt)
```

**关键观察点**：把「指纹」从**原件字节 sha256** 换成**规范文本 sha256**，再故意改一下文件 mtime（`touch`），看哪种指纹会误报「变更」。你会看到只有规范文本哈希能避开 mtime 抖动。

---

## 档位 C · 纸上评审（30 分钟）

下面是一条**看似没问题、实际会重复块 / 删不掉 / 越权**的接入管道，找出它的 6 个问题：

```text
每日凌晨 2 点全量跑一次：
for f in 遍历源目录下所有文件:
    text = parse(f); chunks = split(text)
    for c in chunks:
        qdrant.insert(id=uuid4(), vector=embed(c), payload={"path": f, "text": c})

增量判断：file_mtime > 上次运行时间 才处理
文档指纹：sha256(open(f,'rb').read())        # 对原始字节算
删除处理：（无）      登记表：（无）
权限：payload 里没有权限字段
失败处理：try 全量接入() except Exception: print("接入失败，明天再试")
```

<details><summary>对照答案（先写完再看）</summary>

1. **幂等键是随机 `uuid4()`**：重复接入必产生重复块。ID 应由 `doc_id + chunk_index` 派生，稳定确定。
2. **指纹算在原件字节上**：mtime、文件元数据、压缩包头的抖动都会让哈希变化，导致「没变也重跑、变了也可能漏」。应算在**解析后的规范文本**上。
3. **用 `mtime` 做增量**：`cp`/`rsync`/解压都会改 mtime，与内容无关，会误判或漏判。应以内容哈希为准。
4. **完全没有删除处理**：源站删了文件，向量库照旧能检索到——用户能看到已撤下的内容。必须靠清单比对或 diff 状态检测删除，并按 `doc_id` 过滤删除。
5. **payload 没有权限字段**：检索期无法做权限过滤，只能生成后过滤（已经晚了），必然越权泄漏。
6. **失败处理是整批 try/except**：一篇坏文档会让全量失败，且无记录、无隔离。应逐文档 try/except、失败写登记表、作业照常跑完并输出失败清单。

补充：还缺水位线持久化与登记表，导致无法断点续跑、无法回答「这份文档上次以什么状态处理过」。

</details>

### 最后：把「两遍接入不翻倍 + 删得掉」记成基线

无论哪一档，收尾时记下两个数——**重复接入后的块数**（必须等于首次）与**删除后该 doc_id 的残留块数**（必须为 0）。这两个数就是接入管道的合格线。

---

## 交付物验收清单

| 交付物 | 通过标准 | 你的产出 |
|---|---|---|
| 接入数据流图 | 五步齐全，每步标注输入/输出/失败后果/能否单独重跑 | |
| 增量水位线方案 | 水位线落库；明确用内容哈希而非 mtime 判变 | |
| 幂等键设计 | 给出确定性键公式，并解释为何用文档指纹 | |
| 删除/更新传播 | 能说明删除与权限变更如何从源传播到向量库 | |
| 失败隔离与失败清单 | 单文档失败不阻塞全量；作业结束输出失败清单 | |
| 可观测指标 | 至少含吞吐/失败率/滞后三项，各给一个告警阈值 | |

> **收束**：接入管道的合格线不是「跑得通」，而是「重复跑不产生重复块、删得掉、坏一篇不影响其余」——做实这三件事，增量接入才算成立。
