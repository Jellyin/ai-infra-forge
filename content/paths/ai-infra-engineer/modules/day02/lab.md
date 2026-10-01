---
title: 实验二 · 亲手压测并画出你的性能曲线
---

# 🧪 动手实验 · Day 2

> **目标**：跑一次正经的推理服务压测，产出一张「并发 vs 吞吐 vs 延迟」的实测曲线表。这张表是你面试时「我有实战」的证据，也是一切调优决策的依据。
>
> 三档：**真机**（GPU 压测出真实曲线）／**模拟**（CPU 慢但流程完整）／**纸上**（解读一份给定的曲线数据）。

---

## 档位 A · 真机

### 1. 准备压测环境

```bash
git clone https://github.com/vllm-project/vllm.git
cd vllm

# 标准压测数据集（ShareGPT 真实对话语料）
wget https://huggingface.co/datasets/anon8231489123/ShareGPT_Vicuna_unfiltered/resolve/main/ShareGPT_V3_unfiltered_cleaned_split.json
```

### 2. 起服务（基线配置，记住这组参数）

```bash
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 8192 --gpu-memory-utilization 0.9 \
  --max-num-seqs 64 --port 8000
```

### 3. 梯度压测——同一服务跑 4 轮

```bash
for RATE in 1 4 16 64; do
  echo "===== request-rate=$RATE ====="
  python benchmarks/benchmark_serving.py \
    --backend vllm --model Qwen/Qwen2.5-7B-Instruct \
    --dataset-name sharegpt \
    --dataset-path ShareGPT_V3_unfiltered_cleaned_split.json \
    --num-prompts 200 --request-rate $RATE
done
```

每轮记录四个数（脚本输出 + 服务端指标）：

| request-rate | TTFT P50 | TTFT P99 | 吞吐 tok/s | waiting 峰值 |
|--------------|----------|----------|------------|--------------|
| 1 | | | | |
| 4 | | | | |
| 16 | | | | |
| 64 | | | | |

### 4. 会话中观察两个水位计

压测同时在另一终端：

```bash
watch -n 2 'curl -s localhost:8000/metrics | grep -E "vllm:(num_requests_waiting|gpu_cache_usage_perc)"'
```

**关键判断**（写进你的实验记录）：
- `num_requests_waiting` 持续 > 0 从哪个 rate 档开始？→ **那是排队起点**
- `gpu_cache_usage_perc` 到顶（≈gpu-memory-utilization）了吗？→ **那是显存瓶颈点**
- 吞吐拐点在排队起点之前还是之后？

### 5. 找拐点

在表中吞吐不再增长（或 P99 恶化 3 倍以上）的最小 rate = **本配置的容量上限**。你刚完成了一次标准的容量测试——和你在传统运维做 QPS 容量测试方法论完全同构，只是度量单位从 QPS 换成了 tokens/s。

---

## 档位 B · 模拟（无 GPU）

CPU 上压测数字没有参考价值，但**流程与指标观测完全可练**：

```bash
# 起 CPU 小模型
vllm serve Qwen/Qwen2.5-0.5B-Instruct \
  --max-model-len 2048 --max-num-seqs 4 --port 8000 --device cpu

# 小规模压测（CPU 上压小一点，别压死）
for RATE in 0.5 1 2; do
  python benchmarks/benchmark_serving.py \
    --backend vllm --model Qwen/Qwen2.5-0.5B-Instruct \
    --dataset-name sharegpt \
    --dataset-path ShareGPT_V3_unfiltered_cleaned_split.json \
    --num-prompts 20 --request-rate $RATE
done

# 观察指标（重点练「读」而不是数字本身）
curl -s localhost:8000/metrics | grep -E "vllm:(time_to_first_token_seconds|num_requests)" | head -6
```

重点练三件事：① 压测脚本怎么传参 ② waiting/running 指标怎么读 ③ TTFT 直方图怎么算 P99（提示：`histogram_quantile(0.99, ...)`）。

---

## 档位 C · 纸上（解读真实曲线）

下面是一份真实形态的压测结果（7B 模型 / 单卡 A100-80G / ShareGPT 负载）。**先自己回答问题，再展开对照**：

| request-rate | TTFT P50 | TTFT P99 | 吞吐 tok/s | waiting 峰值 |
|---|---|---|---|---|
| 1 | 0.4s | 0.9s | 210 | 0 |
| 4 | 0.5s | 1.2s | 780 | 0~2 |
| 16 | 1.8s | 6.5s | 1650 | 12 |
| 64 | 9.2s | 31s | 1700 | 240 |

**第一题**：容量拐点在哪个档？依据是什么？

<details><summary>对照</summary>

**16 → 64 之间**。吞吐从 1650 → 1700 几乎不涨（撞顶），但 TTFT P99 从 6.5s 恶化到 31s、waiting 从 12 暴涨到 240——容量已尽，增加的负载全部转化为排队和延迟。
</details>

**第二题**：16 档的 waiting=12，为什么吞吐还在涨？这说明 GPU 还有余量还是没余量？

<details><summary>对照</summary>

**有余量**。排队说明瞬时到达超过瞬时处理，但 batch 还有空位能吸收（continuous batching 边算边收）——吞吐继续涨说明 GPU 没打满。waiting 本身不是坏事，**waiting 持续增长且吞吐不涨**才是过载信号。
</details>

**第三题**：老板要求「TTFT P99 ≤ 3s」，这张表告诉你该承诺多大容量？

<details><summary>对照</summary>

**约 16 req/s 的入口速率**（16 档 P99=6.5s 已超；需在 4~16 之间细测，或下调 max-num-seqs 减少排队延迟——这就是 Day 5 参数调优的入口）。
</details>

---

## ✅ 实验完成清单

- [ ] 我产出了一张 4 档 rate 的实测（或纸上解读）曲线表
- [ ] 我能指出吞吐拐点在哪个档，依据是什么
- [ ] 我能说出 waiting 和 gpu_cache_usage_perc 各自预警什么
- [ ] 我理解「容量测试」的方法论从 QPS 迁移到了 tokens/s
