---
title: 实验三 · 显存预算师的算账课
---

# 🧪 动手实验 · Day 3

> **目标**：做完本实验，任何面试官给你一个「模型 × 卡型」的组合，你能在白板上 5 分钟算出能不能部署、怎么部署。这是纸上是主场的实验——**算账能力不分真机模拟，必须人人过关**。
>
> 三档：**真机**（用实际卡验证你的账算得准不准）／**模拟**（无 GPU，用 nvidia-smi 数据做验证题）／**纸上**（核心档，五道面试原题）。

---

## 核心公式（先抄在便签上）

```
权重显存 = 参数量 × 精度字节     (FP16=2, FP8=1, INT4=0.5)

每 token KV Cache ≈ 2 × 层数 × KV头数 × 头维度 × 精度字节

总预算 = 权重 + KV Cache池 + 激活/开销(≈2GB余量)
```

常用速查：Llama-70B（80 层 / 8 KV 头 / head_dim 128）FP16 每 token ≈ 0.31MB → **1M token ≈ 310GB**。

---

## 档位 C · 纸上（核心档，先做这个）

五道面试原题。**每道先自己算 3 分钟再展开对照**。

### 第 1 题（经典中的经典）

> 70B 模型 FP16，两块 A100-80G，能部署吗？KV Cache 能留多少？

<details><summary>对照</summary>

- 权重：70×2 = **140GB**；两卡 160GB。
- 勉强装得下，但剩 160-140 = 20GB 作 KV Cache + 激活开销，**几乎无法服务并发**（1M 上下文就需 310GB KV）。
- 结论：**不可用方案**。正确姿势是 FP8+TP=2（每卡 35GB，余 45GB/卡）或 INT4（总 35GB）。
- **面试加分点**：先说「FP16 能装但没意义」，再给量化方案——展示的是决策链而不是背数字。
</details>

### 第 2 题（边界判断）

> 13B 模型 INT4，一块 RTX 4090（24GB），能部署吗？

<details><summary>对照</summary>

- 权重：13×0.5 = **6.5GB**；4090 有 24GB。
- KV Cache 池可留 ~15GB。13B 模型（40 层/40 KV头/128 维）FP16 KV 每 token ≈ 2×40×40×128×2 = 1.6MB。
- 15GB ÷ 1.6MB ≈ **9000 token 总量**——比如 4 并发 × 2K 上下文。
- 结论：**能部署，但并发/上下文受限**。消费卡跑小模型量化是可行的省钱方案（代价：无 NVLink、无 ECC）。
</details>

### 第 3 题（长上下文爆炸）

> 7B 模型，要单请求 1M token 上下文，KV Cache 要多少显存？

<details><summary>对照</summary>

7B 级（32 层 / 32 KV 头 / 128 维）FP16：每 token ≈ 2×32×32×128×2 = **1MB**。
1M token → **1TB KV Cache**。
这就是为什么「1M 上下文」必然依赖：KV 量化（FP8 减半）、MLA 压缩（DeepSeek 路线）、稀疏注意力——**没有任何硬件能裸扛**。
</details>

### 第 4 题（并发预算）

> 7B FP16、24GB 卡、权重已吃 14GB，要支持 32 并发 × 4K 上下文，KV Cache 够吗？

<details><summary>对照</summary>

- KV 池 ≈ 0.9×24 - 14 = 7.6GB（gpu-mem-util 0.9）。
- 需求：32 并发 × 4096 token × 1MB/token = **128GB**。
- 差 17 倍。可行解：① 降并发到 2（7.6GB≈2×4K）② INT4 权重（省 7GB → 池 14.6GB，支持 3 并发）③ 换 80G 卡 ④ 多卡 DP。
- **体感结论**：7B 看似小，KV Cache 才是并发预算的真正大头。
</details>

### 第 5 题（反向出题）

> 你只有 4 块 A100-80G（共 320GB），要服务 70B 模型，给用户承诺「16 并发 × 8K 上下文」。选什么量化+并行方案？

<details><summary>对照</summary>

- INT4 权重 35GB → **TP=2 每卡 17.5GB**，单副本 2 卡；4 卡可跑 **2 个 DP 副本**。
- 每副本 KV 池：80-17.5-2 ≈ 60GB/卡 × 2 = 120GB/副本。
- 70B KV 每 token ≈ 0.31MB（FP16）或 0.155MB（FP8 KV）：INT4 权重下 KV 通常保持 FP16 → 0.31MB。
- 单副本支持 8K×16 = 128K token × 0.31MB ≈ 40GB < 120GB ✓ **两副本轻松承载 32 并发**。
- 还能留余量应对突发——这就是一份可以直接开口向面试官讲的部署设计。
</details>

---

## 档位 A · 真机（验证你的账）

有 GPU 就实测验证，让数字从「算的」变「见的」：

```bash
# 1. 空载基线
nvidia-smi --query-gpu=memory.total,memory.used --format=csv

# 2. 起 7B FP16（预算：权重 14GB）
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 8192 --gpu-memory-utilization 0.9 --port 8000 &
sleep 60  # 等加载完

# 3. 对账：实际显存 vs 你的预算
nvidia-smi --query-gpu=memory.used --format=csv,noheader
# 期望 ≈ 0.9×卡容量。偏差在哪？（提示：激活/上下文缓冲——你算的「2GB 余量」就是干这个的）

# 4. 起一个 INT4 版本对账（AWQ 权重）
vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ --quantization awq \
  --max-model-len 8192 --gpu-memory-utilization 0.9 --port 8001 &
# 显存差值 ≈ 7GB = 量化省下的权重（14 → 3.5 之后池子变大 → 可观察 gpu_cache_usage 水位差异）
```

**对账目标**：你纸上的每一笔预算，和 nvidia-smi 实测差 < 15%。

---

## 档位 B · 模拟（无 GPU）

用 DCGM-exporter 或任何有 GPU 机器的输出练「读数」：

```bash
# 如果装了 docker（有 GPU 的同事机器/云测试机）：
docker run --rm --gpus all -p 9400:9400 nvcr.io/nvidia/k8s/dcgm-exporter:3.3.5-3.4.1-ubuntu22.04 &
curl -s localhost:9400/metrics | grep -E "DCGM_FI_DEV_(FB_USED|FB_FREE|GPU_UTIL)" | head -6
```

练习题：从 `FB_USED/FB_TOTAL` 反推「这块卡还能起多大模型」——把纸上公式套到真实读数上。

---

## ✅ 实验完成清单

- [ ] 五道纸上题我至少独立算对 3 道（含第 1 题和第 4 题）
- [ ] 我能默写两个核心公式（权重 / KV Cache 每 token）
- [ ] 我理解「KV Cache 是并发预算的大头」这个反直觉结论
- [ ] （真机档）我的账和 nvidia-smi 实测偏差 < 15%
