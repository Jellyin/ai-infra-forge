---
title: 实验十二 · 带评测红线地跑一次微调
---

# 🧪 动手实验 · Day 17

> **目标**：Day 13 的 lab 跑了微调，本实验补上「工程化」缺的两环——**held-out 评测**与**合并上线对照**。跑完这条链，微调 SFT 你就是「有实践」而非「会调 API」。
>
> 依赖 Day 13 lab 的 lora_sft.py（先跑过它）。

---

## 实操（接 Day 13 的产物）

### 1. 切分训练/评测集（红线的地基）

```python
# build_split.py —— 给玩具数据集做 90/10 切分
import json, random
random.seed(42)
rows = [{"text": f"问：{i}乘{random.randint(2,9)}等于几？答：{i*random.randint(2,9)}"} for i in range(200)]
random.shuffle(rows)
split = len(rows)//10
json.dump(rows[split:], open("train.jsonl","w"), ensure_ascii=False)
json.dump(rows[:split], open("eval.jsonl","w"), ensure_ascii=False)   # held-out！
```

### 2. 训练后立刻评测（对照 train loss）

```python
# eval.py —— 用同一个模型算 eval 集 loss
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
import json

model = AutoModelForCausalLM.from_pretrained("./merged")   # 或加 adapter
tok = AutoTokenizer.from_pretrained("Qwen/Qwen2.5-0.5B-Instruct")
losses = []
for line in open("eval.jsonl"):
    t = tok(json.loads(line)["text"], return_tensors="pt", truncation=True, max_length=128)
    with torch.no_grad():
        out = model(**t, labels=t["input_ids"])
    losses.append(out.loss.item())
print(f"eval loss 均值: {sum(losses)/len(losses):.4f}  (train loss 终值对照)")
```

**判读**：eval loss ≈ train loss → 健康；eval 明显高（>20%）→ 过拟合，回炉（减 epoch/补数据）。

### 3. 合并上线 + 20 题对照（发布验收）

```bash
# 合并 adapter → 独立模型目录
python -c "
from transformers import AutoModelForCausalLM
from peft import PeftModel
base = AutoModelForCausalLM.from_pretrained('Qwen/Qwen2.5-0.5B-Instruct')
m = PeftModel.from_pretrained(base, './out/checkpoint-*/')  # 你的 adapter 路径
m.merge_and_unload().save_pretrained('./merged')
"
vllm serve ./merged --port 8000
# 底座（8001）与微调（8000）同问 20 题，记录对照表
```

**记录**：微调后回答领域题的正确率变化 + TTFT 与底座差异（合并后应≈零——验证 Day 17 的知识点）。

## 纸上档

**发布 checklist 审计**：下面的微调发布流程缺了哪三步？

```
① 训练完成 → ② 直接 merge → ③ 全量切流量
```

<details><summary>对照</summary>

缺：**评测把关**（held-out + 业务指标达标才准 merge——红线位）、**灰度**（新旧模型按流量切分对照而非直接全量）、**回滚预案**（新模型出问题时切回底座的开关与时长承诺）。发布同构 Web 服务的核心：没有「评测=测试、灰度=金丝雀、回滚=回滚」三件套的模型发布不该上。
</details>

---

## ✅ 实验完成清单

- [ ] 我的微调带 held-out 评测集且 eval loss 已对照
- [ ] 我做过 20 题底座/微调对照表
- [ ] 我能说出模型发布三件套（评测/灰度/回滚）与 Web 发布的同构关系
