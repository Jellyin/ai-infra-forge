---
title: 自动评测与回归门禁
---

# 里程碑 14 · 自动评测与回归门禁

> **本里程碑的交付物**：① 检索侧 + 生成侧两套自动评测脚本 ② 指标口径说明（定义、分母、适用子集）③ LLM-as-judge 配置与偏差控制 ④ 一份 CI 门禁配置（退步即阻断）⑤ 评测归档与对比看板。
> **验收标准**：任意一次代码/提示词改动都能在 CI 上跑出与基线可比的数字并判定「通过 / 阻断」；且你能指出本套 judge 何时不可信。

## 14.1 两套评测分开跑

检索错别怪模型，答错才怪提示词/模型；故分开评。检索标注 `gold_doc_ids`，生成 `gold_answer`。

## 14.2 检索侧指标：定义与计算口径

```
recall@k    = |Top-k ∩ Rel| / |Rel|      # |Rel| 是黄金集标注的相关文档数
precision@k = |Top-k ∩ Rel| / k          # 分母是 k
MRR         = (1/|Q|) · Σ_q 1 / rank_q   # rank_q 是第一个相关结果的位置，前 k 内无则计 0
```

- **recall@k 分母固定为 |Rel|、不随 k 变**——k 只决定分子能装下多少相关项；分母写成 k 会让 recall 恒为 1。
- **MRR 只奖励第一个相关结果尽早出现**，不管后续是否被召回，故「MRR 高、recall 低」常见。

**nDCG@k**（需分级相关度 `rel_i ∈ {0,1,2,3}`）：

```
增益 g_i = 2^{rel_i} − 1        折损 d_i = 1 / log2(i + 1)
DCG@k   = Σ_{i=1..k} g_i · d_i
IDCG@k  = 理想排序（rel 从高到低）下的 DCG@k，同样截断到 k
nDCG@k  = DCG@k / IDCG@k   ∈ [0, 1]
```

增益 `2^rel − 1` 让高相关度更值钱；折损 `1/log2(i+1)` 随位置非线性；**分母是 IDCG**，归一化后满分为 1 才能比较。

易混点：

1. **忠实度 ≠ 正确性**：前者只问答案是否忠于检索证据，`faithfulness = 被支持 claim / 总 claim`。**忠实度低必是幻觉**；100% 但正确性低＝证据有问题。
2. **引用覆盖率 ≠ 引用正确率**：前者问有没有引，后者问引得对不对；可能覆盖率 100% 而正确率 30%。
3. **拒绝率 ≠ 误拒率**：拒绝率分母是全部提问、不分好坏；误拒在可答、漏拒在不可答子集。

## 14.3 生成侧指标

| 指标 | 定义 | 分母 |
|---|---|---|
| 正确性 correctness | 与 gold_answer 事实一致 | 可答子集 |
| 忠实度 faithfulness | 每条陈述能否由**检索证据**推出 | 可答子集 |
| 引用覆盖率 citation coverage | 带引用的陈述数 / 总陈述数 | 可答子集 |
| 引用正确率 citation precision | 引用确实支持该陈述的比例 | 有引用的回答 |
| 拒绝率 refusal rate | 输出拒答的比例 | 全部提问 |
| 误拒率 false refusal rate | 该答却拒的比例 | 可答子集 |
| 漏拒率 missed refusal rate | 不可答却答的比例 | 不可答子集 |

## 14.4 LLM-as-judge 的提示词骨架（可抄）

```text
# 角色
你是严格的评测员，只做判定，不改写答案、不解释评分标准。

# 输入
问题: {question}
标准答案: {gold_answer}
候选答案: {candidate}
检索证据: {evidence}          # 仅在忠实度判定时提供

# 判定维度（逐项独立判定）
1. CORRECT  候选与标准答案在事实（数值/日期/编号/主体）上是否一致？
2. FAITHFUL 候选的每条事实陈述能否由【检索证据】推出？（不比较标准答案）
3. CITED    候选的每条事实陈述是否带了引用标记？
4. REFUSE   候选是否为拒答？

# 输出（严格 JSON）
{"correct":"yes|partial|no","faithful":"yes|no",
 "unsupported_claims":["..."],"cited":"yes|partial|no",
 "is_refusal":true|false,"reason":"不超过20字"}
```

规则：固定 rubric、固定维度顺序、temperature=0、强制结构化输出。

## 14.5 可靠性边界（必须如实对待）

LLM-as-judge 是有偏差的仪器，不是会判断的专家：

| 偏差 | 表现 | 缓解 |
|---|---|---|
| 位置偏差 | 偏好第一/最后一个 | 交换 A/B 各评一次，不一致记平局 |
| 长度偏差 | 偏好更长更啰嗦 | 声明「简洁不加分、啰嗦不扣分」；限长 |
| 自偏好 | 偏爱同源/同风格输出 | 换**不同族**判官；或双判官投票 |
| 不可复现 | temp>0 同输入判定不同 | temp=0；重复 N 次取**一致率** |
| 提示词敏感 | 顺序/格式/措辞改变结果 | 冻结 rubric 与提示词版本 |
| 校准漂移 | 严格度随版本/时间变化 | 保留**锚点题**（人工标定），每次先跑 |

**结论**：它**适合相对比较与粗筛，不适合单独做发布门禁的绝对分**。下绝对结论前须人工校准（抽 50–100 题算与 judge 的 κ，κ < 0.6 不可阻断）。人机配比：自动跑全量，人工全看与规则冲突题与高代价类别（多跳/权限/不可答），每轮抽 5–10% 校准。

## 14.6 接进 CI 作为回归门禁

```yaml
# .github/workflows/rag-eval-gate.yml
name: rag-eval-gate
on:
  pull_request:
    paths: ["src/**", "prompts/**", "configs/**", "evalset/**"]
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python scripts/fetch_evalset.py --version ${{ vars.EVALSET_VERSION }}
      - run: python -m eval.retrieval --evalset data/gold-v1.jsonl --k 10 --out reports/retrieval.json
      - run: python -m eval.generation --evalset data/gold-v1.jsonl --judge configs/judge.yaml --repeat 3 --out reports/generation.json
      - run: python -m eval.gate --baseline reports/baseline.json --current reports/retrieval.json reports/generation.json --config configs/gate.yaml
```

```yaml
# configs/gate.yaml
hard_gates:                 # 绝对硬门槛，不满足即失败
  faithfulness: ">= 0.90"
  citation_coverage: ">= 0.85"
  false_refusal_rate: "<= 0.10"
  missed_refusal_rate: "<= 0.05"
regression_gates:           # 相对基线允许的退步容差
  recall@10: "-0.02"        # 比基线低超过 2pp 就阻断
  mrr: "-0.02"
  ndcg@10: "-0.02"
  correctness: "-0.02"
noise_band: 0.01            # 小于 1pp 视为噪声，不判退步
```

要点：**硬门槛管下限、相对门槛管退步**；要有**噪声带**否则 judge 抖动能把 CI 刷红；生成侧 `--repeat 3` 取中位数。

## 14.7 归档、看板与 A/B 的结论口径

归档四版本（评测集/代码/模型/提示词）+ 指标 + 失败题清单，看板画**时间序列**。A/B：**单变量**、**提前写死结论口径**、报**置信区间**。

**「指标涨了但用户更不满意」**：评测集不代表线上、指标与价值错位、护栏被忽略、judge 偏差。

## 14.8 本里程碑的判断力

- 见「准确率 85%→88%」，先问：**口径、子集、样本量、置信区间**。
- recall 高但答不对，追问：**MRR 是否低——召回但排太后**。
- faithfulness 100% 但 correctness 低：**问题在检索，不在生成**。
- 拿 judge 绝对分做门禁？反问：**与人工一致率多少？锚点跑了吗？**

下一里程碑：把线上反馈接成持续改进的闭环。
