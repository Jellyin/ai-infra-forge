---
title: 实验四 · 调优参数的对照实验
---

# 🧪 动手实验 · Day 5

> **目标**：亲手做一次受控变量实验——同一负载、只改一个参数，看性能往哪动。做完你对每个参数「动了哪个瓶颈」的直觉就从「背的」变「测的」。这是面试讲调优时的底气。
>
> 三档：**真机**（完整对照实验）／**模拟**（CPU 上跑参数对比，看方向性）／**纸上**（解读三组实验数据）。

---

## 档位 A · 真机

### 实验设计（先想清楚再动手）

固定：模型（Qwen2.5-7B-Instruct）、压测数据集、request-rate。
每次只变一个参数。四组配置：

```bash
# ============ 基线 ============
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 8192 --gpu-memory-utilization 0.9 --max-num-seqs 64 --port 8000

# ============ 实验1：并发翻倍（测「吞吐 vs 延迟」的权衡）============
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 8192 --gpu-memory-utilization 0.9 --max-num-seqs 128 --port 8000

# ============ 实验2：开前缀缓存（测「算力复用」的收益）============
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 8192 --gpu-memory-utilization 0.9 --max-num-seqs 64 \
  --enable-prefix-caching --port 8000

# ============ 实验3：分块 prefill（测「长输入不阻塞」）============
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 8192 --gpu-memory-utilization 0.9 --max-num-seqs 64 \
  --enable-chunked-prefill --port 8000
```

每组起服后跑同一压测：

```bash
python benchmarks/benchmark_serving.py \
  --backend vllm --model Qwen/Qwen2.5-7B-Instruct \
  --dataset-name sharegpt \
  --dataset-path ShareGPT_V3_unfiltered_cleaned_split.json \
  --num-prompts 200 --request-rate 8
```

### 记录表

| 配置 | TTFT P50 | TPOT | 吞吐 | waiting 峰值 | prefix 命中率 |
|------|----------|------|------|--------------|--------------|
| 基线 (seqs=64) | | | | | — |
| seqs=128 | | | | | — |
| +prefix-caching | | | | | |
| +chunked-prefill | | | | | — |

### 预期方向（做完对答案，方向反了要查明原因）

| 实验 | 预期 | 为什么 |
|------|------|--------|
| seqs 64→128 | 吞吐↑（若显存够）、TTFT↑ | batch 更大 → GPU 更饱，但每步计算量更大 |
| prefix-caching | ShareGPT 负载下收益有限 | 真实对话前缀重叠少；**要换长 system prompt 负载才能看到翻倍收益** |
| chunked-prefill | TTFT 更稳（P99↓） | 长 prompt 不再一次性占满计算，decode 不被饿死 |

### 加餐：让 prefix-caching 的收益现形

ShareGPT 压不出缓存收益（前缀不重叠）。构造一个带公共 system prompt 的负载再跑：

```bash
# 把每个请求都加上同一段 2K 的 system prompt（模拟客服/知识库场景）
python - <<'EOF'
# 自造数据集：固定长 system prompt + 不同 user 问题
import json
data = json.load(open("ShareGPT_V3_unfiltered_cleaned_split.json"))
out = []
SYS = "你是一个严谨的运维知识助手。" + "背景知识请参考以下文档：" + ("K8s 调度、GPU 驱动、推理引擎原理。" * 100)
for d in data[:200]:
    if d.get("conversations"):
        q = d["conversations"][0].get("value", "你好")[:200]
        out.append({"messages": [{"role":"system","content":SYS},{"role":"user","content":q}]})
json.dump(out, open("prefix-heavy.json", "w"))
EOF
```

用 `prefix-heavy.json` 重跑实验 2（对比基线）——**这次 prefix 命中率会 >90%，吞吐收益数倍**。这就是「前缀缓存适合什么场景」的实测证据。

---

## 档位 B · 模拟（无 GPU）

CPU 上数字小，但**方向性对比可做**（小模型 + 小负载）：

```bash
# 基线 vs 并发翻倍（两轮）
vllm serve Qwen/Qwen2.5-0.5B-Instruct --max-model-len 2048 \
  --max-num-seqs 2 --port 8000 --device cpu
# 用 --num-prompts 20 --request-rate 0.5 压一轮记录数字

# 换 --max-num-seqs 4 重启再压一轮
```

记录两组的 TTFT / 吞吐变化方向。CPU 上 batch 收益往往更明显（计算单元少，聚批更划算）。

---

## 档位 C · 纸上（解读实验数据）

三组真实形态的实验结果，**先判断每组「哪个参数动了」，再说依据**：

**数据组 1**：TTFT P99 从 6.2s → 1.8s，吞吐基本不变，长输入请求占比 40% 的负载。
<details><summary>对照</summary>

**chunked-prefill 被开启**。特征：TTFT P99 显著改善而吞吐不变——不是变快了，是「公平了」（长 prompt 不再阻塞整个 step）。吞吐不变因为总计算量没变。
</details>

**数据组 2**：吞吐 1650 → 4200 tok/s（+155%），TTFT P50 反而 0.5s → 0.2s，负载特征是「每请求带 2K 相同 system prompt」。
<details><summary>对照</summary>

**prefix-caching 被开启**。公共前缀只算一次（命中直接复用 KV block），prefill 计算量骤减——吞吐和 TTFT 同时改善是其独特签名（其他优化通常是权衡）。
</details>

**数据组 3**：吞吐 1650 → 2200（+33%），TTFT P99 从 6.5s → 21s，`gpu_cache_usage` 顶到上限。
<details><summary>对照</summary>

**max-num-seqs 调大**。典型「吞吐换延迟」：batch 更满 → GPU 利用率↑ → 吞吐↑；但 KV Cache 池被更多并发摊薄+排队加深 → P99 恶化。**这是 MaaS 平台最常面对的权衡——你的 SLO 定 TTFT 还是定吞吐，答案就在这里**。
</details>

---

## ✅ 实验完成清单

- [ ] 我至少完成了一组「只改一个参数」的对照（真机/模拟），或纸上判对了 3 组数据
- [ ] 我能说出 seqs 调大「动了哪个瓶颈」（KV Cache 摊薄 + 排队加深）
- [ ] 我实测（或纸上理解）了 prefix-caching 需要什么负载才收益大
- [ ] 我能解释 chunked-prefill 是「公平性」优化而不是「速度」优化
