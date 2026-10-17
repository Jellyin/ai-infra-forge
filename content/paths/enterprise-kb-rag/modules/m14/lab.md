---
title: 实验十四 · 跑通两套评测并接上 CI 门禁
---

# 🧪 动手实验 · 里程碑 14

> **本里程碑的交付物**：① 检索侧评测脚本（recall@k / MRR / nDCG）② 生成侧评测脚本（正确性 / 忠实度 / 引用覆盖率 / 拒答三率）③ judge 偏差控制说明与人工校准结果 ④ 一份 CI 门禁配置（硬门槛 + 相对门槛 + 噪声带）⑤ 评测归档与对比看板。
> **验收标准**：改一行提示词或换一个模型，CI 能自动跑出与基线可比的数字并判定「通过 / 阻断」；且你能指着配置说明本套 judge 在什么情况下不可信。
>
> 三档任选：**档位 A 真实项目**（有黄金集，接进真实仓库）／**档位 B 本地练习**（用 m13 造的 20 题 + 小模型跑一遍）／**档位 C 纸上评审**（30 分钟，纯判断力训练）。

---

## 档位 A · 真实项目（把评测变成门禁）

### 1. 先跑检索侧，单独看得到数字

```bash
python -m eval.retrieval \
  --evalset evalset/gold-v1.jsonl \
  --index http://localhost:6333 \
  --k 10 --out reports/retrieval.json

jq '{recall_at_10, mrr, ndcg_at_10}' reports/retrieval.json
```

**先确认 recall 不为 0 也不为 1**——两者都可能是口径错（分母写错）。再按类型分层看：

```bash
jq -r '.per_type | to_entries[] | "\(.key)\t\(.value.recall_at_10)\t\(.value.mrr)"' reports/retrieval.json
```

若整体 recall 高、但 `multi_hop` 的 MRR 低，说明**召回了却排太后**——下一步该动 rerank，而不是动生成。

### 2. 再跑生成侧，务必开 repeat

```bash
python -m eval.generation \
  --evalset evalset/gold-v1.jsonl \
  --judge configs/judge.yaml --repeat 3 \
  --out reports/generation.json
```

`--repeat 3` 会让每题判定跑 3 次取中位数并报告**一致率**。一致率低的题标记为「judge 不可靠」，进人工队列——这正是对「不可复现」偏差的处理。

### 3. 校准 judge：人工抽 50 题

```bash
python -m eval.judge_agreement \
  --judge reports/generation.json \
  --human labels/human-50.jsonl \
  --metric kappa
```

- κ ≥ 0.6 → judge 可用于相对比较与粗筛，仍需锚点题监测漂移。
- κ < 0.6 → 回去改 rubric，**别把它接进门禁**。

同时跑**锚点题**（已人工标定的小集合），确认 judge 自身没随版本漂移：

```bash
python -m eval.anchors --judge configs/judge.yaml --anchors evalset/anchors.jsonl
```

### 4. 把门禁接进 CI，再做一个 A/B

把 guide 里的 `rag-eval-gate.yml` 与 `configs/gate.yaml` 抄进仓库，先以「只报告不阻断」跑几次，记录正常波动幅度，再据此设 `noise_band`，最后打开阻断。**先观察后阻断**——上来就阻断会让团队天天被红叉淹没。然后故意做一次「单变量」改动（例如只把 k 从 5 调到 10）：

```bash
python -m eval.gate \
  --baseline reports/baseline.json \
  --current reports/retrieval.json reports/generation.json \
  --config configs/gate.yaml
```

记录主指标与护栏指标（误拒率、P95 延迟）的变化，练习「提前写死结论口径」。

---

## 档位 B · 本地练习（用 m13 的 20 题跑一遍）

没有真实仓库时，用公开文档 + 小模型就能把两条流水线跑通：

```bash
# 1. 用 m13 造的 20 题黄金集（事实8/流程3/多跳4/不可答5）
wc -l evalset/gold-v1.jsonl

# 2. 本地起一个向量库与一个小模型（示例）
docker run -d -p 6333:6333 qdrant/qdrant
ollama pull qwen2.5:7b-instruct

# 3. 只跑检索侧，先看 20 题的 recall@10 与 MRR
python -m eval.retrieval --evalset evalset/gold-v1.jsonl --k 10 --out reports/retrieval.json

# 4. 用本地小模型当 judge 跑生成侧（注意它本身也有偏差，只当练习）
python -m eval.generation --evalset evalset/gold-v1.jsonl --judge configs/judge-local.yaml --out reports/generation.json
```

然后**亲手算一遍指标**，把公式变成肌肉记忆——拿 `reports/retrieval.json` 里某一道题的 top-10 与 gold_doc_ids：

```bash
python - <<'PY'
topk = ["d3","d7","d1","d9","d2","d5","d8","d4","d6","d10"]   # 系统返回顺序
gold = {"d7","d2"}                                             # 该题应召回的相关文档
k = 10
hit = [i for i, d in enumerate(topk[:k], start=1) if d in gold]
print("recall@10 =", len(hit)/len(gold))            # 分子命中数 / 分母相关文档数
print("precision@10 =", len(hit)/k)                 # 分母是 k
print("MRR =", 1/hit[0] if hit else 0)              # 第一个相关结果的倒数排名
PY
```

对照你算出来的数与前一步脚本的输出——**对不上就说明口径没吃透**，回去改脚本而不是改期望。

> 这一档的价值：把「分母是谁」「位置怎么折损」练到不用查公式。

---

## 档位 C · 纸上评审（30 分钟）

某团队改了一版提示词后，离线指标全线飘红向上，但线上用户更不满。给你两边的数据，找出原因：

**离线（同一评测集，改动前 → 后）**

| 指标 | 改动前 | 改动后 |
|---|---|---|
| faithfulness | 0.91 | 0.94 |
| correctness | 0.85 | 0.88 |
| 引用覆盖率 | 0.90 | 0.92 |
| recall@10 | 0.88 | 0.89 |

**线上（同期）**

- 点踩率 6% → 11%；平均答案长度 +40%。
- TTFT P95 1.9s → 3.4s；end-to-end P95 6s → 11s。
- 多跳类问题点踩率 +18pp；不可答题「给了答案」的投诉变多。
- 追问率（同一问题换个说法再问）上升。

<details><summary>对照答案（先写完再看）</summary>

至少五条，每条都要能落到具体数据：

1. **judge 的长度偏差**：答案长度 +40% 同时 faithfulness 涨，很可能是 judge 奖励了更长、更啰嗦的答案——用户却嫌烦。应回看 judge 是否声明「简洁不加分」，并用人工抽检校准。
2. **护栏指标恶化被忽略**：延迟（TTFT 1.9→3.4s、端到端 6→11s）明显恶化，但离线看板里根本没有延迟这一列。主指标涨不能抵消护栏崩。门禁要同时管延迟。
3. **子群退化被均值掩盖**：多跳类点踩 +18pp，说明是多跳场景退化；但整体 correctness 被易题拉高。必须**分层看指标**，别只看全局平均。
4. **漏拒率上升**：不可答题开始「给答案」，说明拒答阈值被间接调松了。这条要单列在不可答子集上度量，全局指标看不出来。
5. **评测集不代表线上分布**：离线集里长尾/多跳覆盖不足，所以「线上出问题的那类题」在离线里根本没有，指标自然照涨。

一句话结论：**离线指标涨、线上体验降，几乎总是「指标口径错位 + 护栏失守 + 子群被平均掩盖 + 评测集分布不符」的组合**，而不是模型退步。

</details>

### 最后：把口径压成一句话

无论哪一档，结束前必须能填出这句——填不出说明指标还是「感觉」：

> 「本项目主指标是 **__**，护栏指标是 **__（延迟/误拒率/漏拒率）**；两者的分母分别是 **__**；judge 与人工的一致率 κ = **__**，达到 **__** 才允许用于门禁。」

---

## 交付物验收清单

| 交付物 | 通过标准 | 你的产出 |
|---|---|---|
| 检索侧评测 | 输出 recall@k / MRR / nDCG@k，且分母口径正确、可按类型分层 | |
| 生成侧评测 | 输出正确性 / 忠实度 / 引用覆盖率，拒答三率在各自子集上分开算 | |
| judge 偏差控制 | 说明位置/长度/自偏好/不可复现四类偏差的缓解；给出与人工的一致率 | |
| CI 门禁 | 含硬门槛、相对门槛、噪声带；阻断时给出失败题清单 | |
| 归档与看板 | 记录评测集/代码/模型/提示词四版本；能看趋势而非单点 | |
| A/B 结论口径 | 单变量、预写主指标+护栏、报置信区间而非点估计 | |
