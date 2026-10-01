---
title: 实验八 · 微调一个真模型并读懂每个参数
---

# 🧪 动手实验 · Day 13

> **目标**：跑通一次 LoRA 微调（CPU/单卡均可跑 0.5B 级），重点是「每个参数为什么是这个值」——面试问的不是会不会跑，是为什么这么配。
>
> 三档：**真机**（GPU 微调 0.5-1.5B）／**模拟**（CPU 跑 0.5B，慢但完整）／**纸上**（配置审计题）。

---

## 档位 B/A · 实操（CPU 慢跑 / GPU 快跑，命令相同）

```bash
pip install transformers peft datasets

cat > lora_sft.py <<'EOF'
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
from peft import LoraConfig, get_peft_model
from datasets import Dataset

model_id = "Qwen/Qwen2.5-0.5B-Instruct"          # (A) 0.5B：CPU 也能跑完
tok = AutoTokenizer.from_pretrained(model_id)
model = AutoModelForCausalLM.from_pretrained(model_id)

# (B) LoRA：只训 0.5%~1% 的参数
lora = LoraConfig(r=8, lora_alpha=16, lora_dropout=0.05,
                  target_modules=["q_proj", "v_proj"])   # (C) 只挂注意力的 Q/V
model = get_peft_model(model, lora)
model.print_trainable_parameters()              # 可训参数占比——记下这个数！

# 造 200 条玩具数据（真实场景换成自己的 SFT 数据集）
import json, random
rows = [{"text": f"问：{i}加{i}等于几？答：{2*i}"} for i in range(100)]
ds = Dataset.from_list(rows)

args = TrainingArguments(
    output_dir="./out", num_train_epochs=1,
    per_device_train_batch_size=4,             # (D) CPU 调小；GPU 可加大
    gradient_accumulation_steps=8,             # (E) 有效 batch = 4×8 = 32
    learning_rate=2e-4,                        # (F) LoRA 典型 1e-4~3e-4（比全参大 10 倍）
    logging_steps=5, save_strategy="steps", save_steps=50,   # (G) checkpoint
)
from transformers import Trainer, DataCollatorForLanguageModeling
def tok_fn(b): return tok(b["text"], truncation=True, max_length=128)
ds = ds.map(tok_fn, remove_columns=["text"])
Trainer(model=model, args=args, train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tok, mlm=False)).train()
EOF
python lora_sft.py
```

**跑的时候记录三行数**（实验核心产出）：
1. `print_trainable_parameters()` 输出——LoRA 可训占比（应 <1%）
2. 训练总时长与最终 loss
3. `./out` 里 checkpoint 的文件大小 vs 原模型大小（LoRA adapter 只有几 MB）

## 参数审计（面试问的就是这些「为什么」）

| 标记 | 参数 | 为什么是这个值 |
|---|---|---|
| (C) | `target_modules=["q_proj","v_proj"]` | 只挂注意力 Q/V 是「性价比档」；全模块（含 MLP）效果更好但显存↑ |
| (D)(E) | batch 4 × 梯度累积 8 | **有效 batch=32**：单卡装不下大 batch 时用累积凑——这是「显存换吞吐」的旋钮 |
| (F) | lr=2e-4 | LoRA 参数少，学习率比全参微调（2e-5）**大一个量级**还不炸 |
| (G) | save_steps=50 | checkpoint 频率 = 丢的步数 vs 存储成本的权衡（下 day15 详讲） |

---

## 档位 C · 纸上（配置审计题）

**同事给你这段配置说「训不动」，找问题**：

```python
lora = LoraConfig(r=256, lora_alpha=32, target_modules=["q_proj"])
args = TrainingArguments(per_device_train_batch_size=64, learning_rate=1e-5, ...)
```

<details><summary>对照（三个问题）</summary>

1. **r=256 过大**：LoRA 的意义是低秩——r 到 256 已接近全参微调的显存/速度，还失去 LoRA 优势（典型 r=8~64）
2. **lr=1e-5 太小**：LoRA 可训参数少，用全参档的学习率会让 loss 几乎不动（应为 1e-4 量级）
3. **batch=64 无梯度累积**：显存大概率爆——应该降 per_device batch + 加 gradient_accumulation 凑有效 batch
</details>

**第二题**：LoRA 训完保存的 adapter 只有 20MB，为什么推理时要「合并回原模型」？合并和不合并的部署差异是什么？

<details><summary>对照</summary>

LoRA 是「原权重冻结 + 低秩旁路」，adapter 只存旁路。**合并**（merge_and_unload）= 旁路算进权重 → 推理零额外延迟，部署与原模型无差异；**不合并** → 推理时每层多一次旁路计算（延迟小增），但可以在服务里**热切换多个 adapter**（一个底座 + N 个任务包）——多租户场景反而有用。
</details>

---

## ✅ 实验完成清单

- [ ] 我跑通了一次 LoRA 微调并记下可训参数占比（<1%）
- [ ] 我能解释 (C)-(G) 每个参数的「为什么」
- [ ] 我知道 LoRA 学习率比全参大一个量级的原因
- [ ] 我能说清 adapter 合并/不合并的部署权衡
