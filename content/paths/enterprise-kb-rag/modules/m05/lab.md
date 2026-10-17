---
title: 实验五 · 用控制变量实验调出切分参数
---

# 🧪 动手实验 · 里程碑 5

> **本里程碑的交付物**：① 三类文档的切分策略选择与理由 ② 可复用切分配置 ③ 父子块存储结构与检索流程 ④ 不可切分内容清单 ⑤ 切分参数对比实验表与结论。
> **验收标准**：你能指着实验表说「chunk_size 取 800、overlap 取 15% 是因为这组 recall@5 达标且块数最少」；并且父子块流程跑通、能解释它解决了什么。
>
> 三档任选：**档位 A 真实项目**（用你的语料与黄金集）／**档位 B 本地练习**（公开文档，用召回指标做对照）／**档位 C 纸上评审**（30 分钟，判断力训练）。

---

## 档位 A · 真实项目（推荐）

### 1. 先给三类文档各定一种策略

| 文档类型 | 结构特征 | 选定策略 | 理由 |
|---|---|---|---|
| 有标题层级的规范 | h1/h2/h3 清晰 | 结构感知 + 节内递归 | 层级进 metadata，供引用与过滤 |
| 纯流水正文 | 无标题、长段落 | 递归切分 | 无结构可依，靠分隔符保句 |
| 表格/代码密集 | 大量表与代码块 | 整块保留（atomic） | 长度硬切会毁结构 |

### 2. 建黄金集，跑控制变量实验

准备 50–100 条 `(query, 相关块或段落)`，**固定 embedding / 检索器 / k，一次只改一个参数**：

```text
组1  chunk_size ∈ {256, 512, 800, 1200}   overlap=15%   → 看 recall@5 与块数
组2  overlap   ∈ {0, 10%, 20%, 40%}      chunk_size=800 → 看 recall@5 与近重复率
组3  策略      ∈ {固定长度, 结构感知}      参数同上       → 看 recall@5 与引用可定位率
```

每组填一行：

| 组 | 参数 | 块数 | recall@5 | 近重复率 | 平均块长 | 结论 |
|---|---|---|---|---|---|---|
| | | | | | | |

### 3. 实现父子块并量化收益

按 guide 5.5 建子块（入库）+ 父块（另存），跑同一批 query，对比「只用子块」与「子块检索→父块生成」的指标（尤其是生成侧的完整性，可用 context_recall 或人工判读）。**要能说清：多一跳查询、多一份存储，换来了什么。**

---

## 档位 B · 本地练习（用召回指标说话）

拿一份公开技术文档（Markdown/HTML 皆可），用脚本跑同一批问题：

```bash
# 1) 跑一版递归切分，看块数（先有个基线）
cat doc.md | python -c "import sys; from langchain_text_splitters import RecursiveCharacterTextSplitter as R; cs=R(chunk_size=800, chunk_overlap=120).split_text(sys.stdin.read()); print('chunks', len(cs))"

# 2) 把 overlap 从 0 到 200 各跑一次，看块数与重复量怎么变
for ov in 0 50 100 200; do cat doc.md | python -c "import sys; from langchain_text_splitters import RecursiveCharacterTextSplitter as R; print('$ov', len(R(chunk_size=800, chunk_overlap=$ov).split_text(sys.stdin.read())))"; done

# 3) 量块长（token 口径，确认不超嵌入模型上限）
cat doc.md | python -c "import sys, tiktoken; e=tiktoken.get_encoding('cl100k_base'); print('tokens', len(e.encode(sys.stdin.read())))"
```

**关键观察点**：overlap 越大，块数越多、近重复越多；把 overlap 翻倍往往只换来很小的召回提升，却让索引和上下文一起膨胀。**这就是「overlap 有副作用」的可测证据。**

---

## 档位 C · 纸上评审（30 分钟）

下面是一段切分代码与一次实验结论。找出 **5 个问题**：

```python
# 切分实现
splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=400)  # ①③
chunks = splitter.split_text(text)      # ② 无视结构：层级未进 metadata，表格/代码会被切断

# 实验结论
# “把 overlap 从 0 调到 400 后，感觉召回变好了，所以定为 400。”   # ④
# 块长度用 len() 计（字符），embedding 模型上限 512 token。        # ⑤
```

<details><summary>对照答案（先写完再看）</summary>

1. **overlap=400 过大**：已达 chunk_size 的 50%，会产生大量近重复块，占满 top-k、虚高 recall、浪费生成预算。
2. **无视结构与表格**：`split_text` 在纯文本上硬切，层级没进 metadata，表格/代码会被拦腰截断——应按 guide 5.3「先结构后长度」，并让表格/代码块 `atomic` 跳过切分。
3. **参数单位没说清**：`chunk_size=800` 未注明字符还是 token，且与嵌入模型上限的换算缺失。
4. **结论凭感觉**：「感觉召回变好」不是指标。应给出控制变量实验表（recall@5、近重复率、块数），并证明增益值得重复代价。
5. **字符口径超上限**：800 字符（中文量级上约等于 800 token）已超过 512 上限，尾部会被**静默截断**、对检索不可见；应改用嵌入模型的 tokenizer 度量并留余量。

</details>

### 最后：把参数与证据绑定

无论哪一档，收尾时给出这句话：

> 「本语料按 **__** 类文档切分；chunk_size=**__**（单位 **__**）、overlap=**__**，依据是 **__** 组对比实验中该组 recall@5=**__** 且块数最少；表格/代码走 `atomic`；父子块把生成完整性提升了 **__**。」

---

## 交付物验收清单

| 交付物 | 通过标准 | 你的产出 |
|---|---|---|
| 三类文档的策略选择 | 每类写明策略与理由，含单位与依据 | |
| 可复用切分配置 | chunk_size/overlap/分隔符/单位齐全，中文标点已补 | |
| 父子块存储与检索 | 子块带 `parent_id`；检索流程含去重与父块封顶 | |
| 不可切分内容清单 | 表格/代码等 `atomic` 内容整块保留 | |
| 参数对比实验表 | 控制变量、含 recall@k/近重复率/块数，结论有数字 | |

> **收束**：切分合格的标准不是「块切得整齐」，而是「**检索能命中、生成读得懂，且你能用一串数字解释为什么是这个参数**」——凭感觉定的 chunk_size，早晚会在评测里翻车。
