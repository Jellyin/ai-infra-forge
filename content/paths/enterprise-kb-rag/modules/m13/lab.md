---
title: 实验十三 · 产出一份可验收的黄金集
---

# 🧪 动手实验 · 里程碑 13

> **本里程碑的交付物**：① 覆盖四类问题的黄金集（JSONL）② 标注口径文档 ③ 标注一致性与仲裁记录 ④ 评测集版本与防污染纪律。
> **验收标准**：另一位同事拿着你的口径文档，能独立标注 10 道新题并与你的一致率达到 κ ≥ 0.6；且你能指出哪些数据绝对不能进训练/提示词。
>
> 三档任选：**档位 A 真实项目**（手上有真实提问日志）／**档位 B 本地练习**（用公开文档集 + 小模型造 20 题）／**档位 C 纸上评审**（30 分钟，纯判断力训练）。

---

## 档位 A · 真实项目（推荐：黄金集从这里来）

### 1. 分层采样，先攒候选池

```bash
# 从提问日志抽候选问题，按频次排序（高频题代表主干场景）
jq -r '.query' logs/qa-2026Q3.jsonl | sort | uniq -c | sort -rn | head -300

# 再按类别分层：事实/流程/多跳，各取一部分（别只取热问）
jq -r 'select(.intent=="howto") | .query' logs/qa-2026Q3.jsonl | shuf -n 40
```

采候选时**同步记录脱敏前的原始上下文**（谁、什么时候、什么入口），后面定 `strata` 要用。

### 2. 两人独立标注，先算一致性

各标 50 题，只用二值（对/错）＋类型标签，先别写长注释：

```bash
python -m eval.agreement --a anno_alice.jsonl --b anno_bob.jsonl --field verdict --metric kappa
```

- κ ≥ 0.8 → 口径可用，继续扩量。
- 0.6 ≤ κ < 0.8 → 记录分歧集中的题型，微调口径。
- κ < 0.6 → **停下来改口径**。别指望标得更多就能一致——不一致的根源是 rubric 不清楚。

### 3. 仲裁并回写口径

```bash
# 抽出两人不一致的题，交第三人仲裁
python -m eval.agreement --a anno_alice.jsonl --b anno_bob.jsonl --list-disagreements > disagreements.jsonl
```

每条仲裁结论都要写进「口径文档」，并注明**为什么**这样判。口径文档要能让新人不需要问你就能标。

### 4. 组装黄金集并校验

```bash
python -m eval.lint --evalset evalset/gold-v1.jsonl --schema schemas/evalset.json
# 看四类分布，确认没有畸形偏斜
jq -r '.type' evalset/gold-v1.jsonl | sort | uniq -c
```

### 5. 版本与防污染

```bash
# 防污染断言：评测集问题是否泄漏进了索引或提示词配置
grep -Ff <(jq -r '.question' evalset/gold-v1.jsonl) -r prompts/ corpus-index/ \
  && echo "LEAK FOUND" || echo "OK"
git tag evalset/v1.0.0 && echo "评测集版本已固定"
```

---

## 档位 B · 本地练习（用公开文档集 + 小模型造 20 题）

没有真实日志时，用一份有层级、有表格、有多版本的公开文档集当「企业知识库」：

```bash
git clone --depth=1 https://github.com/prometheus/prometheus /tmp/kb-corpus
find /tmp/kb-corpus/docs -type f -name '*.md' | wc -l
```

**造题配额（20 题）**：事实 8 / 流程 3 / 多跳 4 / 不可答 5。

用本地小模型（ollama 或 llama.cpp）**辅助生成候选**，但 **gold 必须回原文人工核对**——模型生成的「标准答案」不能直接当 gold，它自己就可能错：

```text
你是一名出题人。下面是一段文档，请据其出 3 道题：
- 1 道事实题（答案是一个明确的数值/版本/名称）
- 1 道多跳题（需要结合至少两处内容）
- 1 道不可答题（该文档未包含答案，考的是「会不会乱答」）
每题给出：问题、你的参考答案、答案依据的原文片段。
文档：{chunk_text}
```

拿到候选后做三件事：① 逐题回原文核对 gold_answer；② 补 `gold_doc_ids`（这道题应该命中哪个文件/章节）；③ 不可答题的 `must_refuse` 置 `true`、`gold_answer` 置 `null`。

然后**跑一次最小评测**，只算检索侧命中，看黄金集本身是否「可被检索到」——一道连人都检索不到的题，是坏题不是难题：

```bash
python -m eval.retrieval --evalset evalset/gold-v1.jsonl --index http://localhost:6333 --k 10 --out reports/baseline.json
jq -r 'select(.gold_in_topk==false) | .qid' reports/baseline.json
```

> 这一档的价值：练「标注口径 + 一致率 + 防污染」这套纪律的手感，而不是练出题。

---

## 档位 C · 纸上评审（30 分钟）

下面这份黄金集与口径「看起来能用」，其实有 **6 个致命问题**，先自己找，再看答案：

```jsonl
{"qid":"1","question":"年假多少天","gold_answer":"15天"}
{"qid":"2","question":"如何申请报销","gold_answer":"填写报销单交主管审批"}
{"qid":"3","question":"公司明年的战略重点是什么","gold_answer":"聚焦云计算"}
{"qid":"4","question":"最新版《安全规范》第 3.2 条写了什么","gold_answer":"禁止明文存储口令"}
```

标注口径：「**答对 = 回答正确。**」

<details><summary>对照答案（先写完再看）</summary>

1. **无 `gold_doc_ids`**：检索侧指标全部无法计算（recall 的分母没有来源）。评测只剩生成侧。
2. **无 `type` 字段**：无法按类型分档说清「什么算答对」，也无法分层看指标。
3. **题 3 是应拒答的题，却给了 gold_answer**：分类错误；它应标 `unanswerable` + `must_refuse=true`，正确行为是拒答。若把编造的「聚焦云计算」当 gold，等于奖励幻觉。
4. **题 4 是时效陷阱**：写「最新版」但没标文档版本，「最新」是活的、不可复现。要么冻结版本号，要么改成明确版本。
5. **口径「答对 = 回答正确」不可操作**：两人无法独立复现。应分类型写清判据（数字/编号是否必须一致、流程顺序是否计分等）。
6. **题 1–4 全是易题、无难例，且没有版本号与来源**：测不出系统边界；也无法管理（不知道是谁标、哪一版）。

</details>

### 最后：把纪律压成一段话

无论哪一档，结束前必须能填出这句——填不出说明还没建立防污染意识：

> 「本评测集是 **v__**，共 **__** 题（四类各 **__**），其中 held-out **__** 题不参与调优；**__（问题/答案）绝不进入** 训练数据、few-shot、提示词与语料索引；每次评测记录 **评测集+代码+模型+提示词** 四个版本。」

---

## 交付物验收清单

| 交付物 | 通过标准 | 你的产出 |
|---|---|---|
| 黄金集（JSONL） | 覆盖四类问题；每题含 `gold_doc_ids`、`type`、`answerable`/`must_refuse`、`source` | |
| 标注口径文档 | 分类型、可操作到两个陌生人能独立复现；含仲裁规则 | |
| 一致性记录 | 给出 Cohen's κ；κ<0.6 时有「改口径」的动作而非硬标 | |
| 版本与防污染 | 有版本号；有一句可执行的防污染断言；held-out 已划出 | |
| 难例覆盖 | 不可答题占 15–25%；含跨文档、权限受限、时效陷阱各 ≥1 | |
