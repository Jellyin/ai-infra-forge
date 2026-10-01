---
title: 实验一 · 推理服务与传统服务的五感对照
---

# 🧪 动手实验 · Day 1

> **目标**：不是学新命令，而是用你 5 年运维的直觉去「感受」一个推理服务和传统 Web 服务到底差在哪。这份体感是后面 9 天所有优化的地基。
>
> 没有也能做：本实验提供三档——**真机**（有 GPU）／**模拟**（无 GPU，用容器 + CPU 小模型）／**纸上**（纯预测对照，10 分钟）。

---

## 档位 A · 真机（有 NVIDIA GPU）

### 1. 起服务——观察「启动慢」这件事

```bash
# 起服务前，先记录当前显存状态
nvidia-smi --query-gpu=memory.used,memory.free --format=csv

# 起 vLLM（首次会下载权重，几 GB）
time vllm serve Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 8192 --gpu-memory-utilization 0.9 --max-num-seqs 64 --port 8000

# 另开终端：加载完成后对比显存变化
nvidia-smi --query-gpu=memory.used,memory.free --format=csv
```

**记录三行数据**（这是本实验的核心产出）：

| 观察项 | 数值 | 传统服务对照 |
|--------|------|-------------|
| 启动耗时（time 输出） | _____ 秒 | nginx/systemd 秒级 |
| 启动后显存占用 | _____ MB | 传统服务几乎不预占内存 |
| 停止服务后显存释放 | _____ | — |

### 2. 感受流式——同一个请求的两种形态

```bash
# 非流式：等全部生成完，一次性返回
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"数到二十"}]}'

# 流式：逐 token 推送（-N 关闭缓冲是关键）
curl -N http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"数到二十"}],"stream":true}'
```

**观察点**：流式请求里，第一个 `data:` 行出现的时间 vs 最后一个的时间——**前者就是 TTFT，差值÷token 数就是 TPOT**。你已经亲手测出了本课程最重要的两个指标。

### 3. 看「有状态」——并发如何吃显存

```bash
# 同时发 5 个长生成请求
for i in 1 2 3 4 5; do
  curl -s http://localhost:8000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"写一篇500字散文"}]}' &
done
# 立刻在另一个终端观察
watch -n 1 'nvidia-smi --query-gpu=memory.used --format=csv,noheader'
```

**观察点**：5 个请求并发生成时显存持续上涨（KV Cache 随 token 数增长）——这就是「并发上限由显存决定」的直接证据。传统服务的并发只吃 CPU。

### 4. 收尾实验

```bash
curl -s localhost:8000/metrics | grep -E "vllm:(num_requests|gpu_cache_usage|avg_generation)" | head -8
```

对照 [Day 2 指标表] 把看到的 3 个指标记下来。

---

## 档位 B · 模拟（无 GPU，任何机器可做）

目标不变：感受「慢启动、流式、指标」。用 CPU 跑一个 0.5B 小模型，牺牲速度换取完整体验：

```bash
pip install vllm

# CPU 模式起一个 0.5B 模型（慢，但链路完整）
time vllm serve Qwen/Qwen2.5-0.5B-Instruct \
  --max-model-len 2048 --max-num-seqs 4 --port 8000 --device cpu

# 流式请求（感受逐 token 输出；CPU 下 TPOT 明显更慢）
curl -N http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-0.5B-Instruct","messages":[{"role":"user","content":"数到十"}],"stream":true}'

# 指标端点照样有
curl -s localhost:8000/metrics | grep -E "vllm:num_requests" | head -4
```

**接受的速度差异**：启动约 1~2 分钟、生成约几 token/s——正好放大了「推理服务慢在哪」，体感更清晰。记录：启动耗时、首 token 出现时间。

---

## 档位 C · 纸上（10 分钟，无任何环境）

不敲命令也能完成本实验的核心——**先预测，再对照**（这是纸上档的灵魂，不许先看答案）：

### 第一题：预测启动顺序

一个 vLLM 服务从 `vllm serve` 到能接请求，写下你预测的内部步骤顺序（3 步）：

1. ________________
2. ________________
3. ________________

<details><summary>对照参考（先写完再看）</summary>

1. 读配置/解析参数 → 2. **把权重从磁盘加载进显存**（占启动时间 90%）→ 3. 初始化 KV Cache 池（按 gpu-memory-utilization 预留）→ 监听端口
</details>

### 第二题：预测显存账单

7B 模型、FP16 权重、`--gpu-memory-utilization 0.9` 在一块 24GB 卡上：权重吃多少？KV Cache 池多大？

<details><summary>对照</summary>

权重 = 7×2 = **14GB**；0.9×24 = 21.6GB 预算 → KV Cache 池 ≈ 21.6-14 ≈ **7.6GB**。显存不够时这个池先被牺牲。
</details>

### 第三题：判断题（传统运维直觉迁移测试）

1. 「服务 OOM 了，加 swap 能救」——对推理服务还对吗？
2. 「加副本就能线性扩容」——对吗？
3. 「响应慢就加 CPU」——对吗？

<details><summary>对照</summary>

1. **错**。权重在显存（HBM），swap 帮不上；CPU offload 慢一个数量级。
2. **半对**。每个副本都要完整加载一份权重（显存成本线性）+ 分钟级冷启动。
3. **错**。Decode 瓶颈是显存带宽，不是 CPU。
</details>

---

## ✅ 实验完成清单

- [ ] 我记录了启动耗时 / 显存占用的具体数字
- [ ] 我亲眼看到了流式输出（或纸上完成了三道预测题）
- [ ] 我能说出 TTFT 和 TPOT 分别在刚才哪一步被测到
- [ ] 我能向同事解释「为什么并发上限由显存决定」
