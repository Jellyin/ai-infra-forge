---
title: 阶段检查点·训练侧实战
---

# Day 20 · 阶段检查点——训练侧全链路实战

> 目标：端到端 mini 流水线：数据→微调→评测→部署——Phase 2 的毕业设计

## 今天不学新东西，只做一件事

把 day11-19 的知识焊成**一条真实的 mini 流水线**。跑通它，你就有了面试里「我搭过训练侧链路」的底气。

## 流水线全景（今天要亲手走完的）

```
数据准备 → LoRA 微调 → 评测把关 → 合并导出 → vLLM 上线 → 对照验收
(Day14)    (Day13/17)   (Day17红线)  (Day17)    (Day7回炉)   (发布同构)
```

### Step 1 · 数据（Day 14 的实践）

```bash
# 构造一个真实的小数据集（如「运维知识问答」100 条），做清洗三件套：
# 去重（_exact + 近似）→ 长度过滤（<2048 token）→ 格式化 chat template
python build_dataset.py --out data/train.jsonl --eval-ratio 0.1
# 关键：留 10% 做 held-out 评测集——没有它 Day17 的红线就守不住
```

### Step 2 · 微调（Day 13 的脚本）

```bash
python lora_sft.py --data data/train.jsonl --out ./out
# 记录：可训参数占比、train loss 终值、训练时长
```

### Step 3 · 评测（Day 17 的红线）

```bash
python eval.py --adapter ./out --data data/eval.jsonl
# 指标：eval loss + 抽样 20 条人工看回答质量
# 红线：eval loss 明显差于 train（过拟合）→ 回 Step 1 补数据/调 epoch
```

### Step 4 · 合并导出 + 上线（Day 7 的回炉）

```bash
# 合并 adapter 到底座 → 标准 HF 格式
python merge_export.py --base Qwen/Qwen2.5-0.5B-Instruct --adapter ./out --out ./merged
# 用你在 Day 7 学的方式起服务：
vllm serve ./merged --port 8000
curl -s localhost:8000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"merged","messages":[{"role":"user","content":"你的微调领域问题"}]}'
```

### Step 5 · 对照验收（发布同构）

- 底座模型与微调模型**同问 20 题**对比（服务的灰度思想在模型侧的缩影）
- 记录：TTFT/吞吐是否与底座一致（LoRA 合并后应零差异——Day 17 知识点验证）

## 毕业检查（Phase 2 通关标准）

对照 day11-19 的 checklist 自查，再补上本阶段的硬性项：

- [ ] 我的流水线一条命令能从数据跑到服务（哪怕很糙）
- [ ] 我有 held-out 评测集并且真的用它把过关
- [ ] 我能画出全链路的图并标注每步对应哪天学的什么
- [ ] 底座 vs 微调的 20 题对照表（效果证据）

## 纸上档（无 GPU 的替代）

用 CSV 记录一条「影子流水线」：给 5 个环节各写输入/输出/把关指标/翻车模式（格式参考 Day 13 lab 的审计表）——毕业设计交这份也认。

---

**下一阶段预告（Phase 3）**：生产化纵深——集群网络规划、故障演练体系、多模态推理、容量与采购决策、终极面试关。
