---
title: 推理引擎原理
---

# Day 5 · 推理引擎原理（核心中的核心）

## 5.1 三个决定性能的机制，逐个吃透

### ① Continuous Batching（连续批处理）

**解决的问题**：静态 batching 的「木桶效应」——一批里最快的要等最慢的。

**做法**：维护一个动态 batch，每个迭代：
- 有新请求 → 加入 batch。
- 有请求生成完毕 → 移出 batch。
- 每步处理 batch 内所有 token。

**收益**：GPU 利用率从 ~30% 提到 ~70%+。

**对应参数**：
- `--max-num-seqs`：batch 内最多多少并发序列（显存够就往高调，但延迟会涨）。
- `--max-num-batched-tokens`：每步最多处理多少 token（防止长 prompt 抢占）。

### ② PagedAttention（分页注意力）

**解决的问题**：KV Cache 连续分配导致的显存碎片。

**做法**：KV Cache 按固定大小 block（如 16 token）切分，用一张页表管理「逻辑位置 → 物理 block」的映射，像 OS 分页。

**收益**：
- 显存利用率 ~50% → ~90%。
- 天然支持**前缀缓存**：多个请求共享相同前缀，共用同一批 block。

**对应参数**：`--gpu-memory-utilization`（控制预留多少显存给 KV Cache 池）。

### ③ Prefix Caching（前缀缓存）

**解决的问题**：多轮对话、RAG、Agent 场景，每个请求都带一个很长的相同 system prompt，重复计算浪费。

**做法**：检测到相同前缀，直接复用之前算好的 KV Cache block。

**收益**：长 system prompt + 多轮对话场景，吞吐可提升数倍。

**对应参数**：`--enable-prefix-caching`，监控 `gpu_prefix_cache_hit_rate`。

## 5.2 调优参数全景 + 实战对照

| 参数 | 动了哪个瓶颈 | 调大后果 | 调小后果 |
|------|-------------|---------|---------|
| `--max-model-len` | 显存 | 显存↑，能吃长上下文 | 长输入报错 |
| `--max-num-seqs` | 并发 | 吞吐↑ 但 TTFT/TPOT↑ | 并发低，GPU 空转 |
| `--max-num-batched-tokens` | 单步算力 | 长 prompt 更顺，但延迟波动↑ | 限制吞吐 |
| `--gpu-memory-utilization` | 显存水位 | 省显存空间但易 OOM | 浪费显存 |
| `--tensor-parallel-size` | 跨卡 | 模型能放多卡，但通信开销 | 单卡放不下 |
| `--enable-prefix-caching` | 算力复用 | 前缀场景大赚 | 无前缀场景无收益 |

**核心心法**：这些参数本质是在 **显存 / 算力 / 延迟 / 吞吐** 四个变量之间做权衡。没有万能配置，只有「针对你的负载调出来的配置」。

## 5.3 动手：调优对照实验

用 Day 2 的压测脚本，**只改参数，跑同一份数据，对比结果**：

```bash
# 基线
vllm serve Qwen/Qwen2.5-7B-Instruct --max-model-len 8192 --gpu-memory-utilization 0.9 --max-num-seqs 64

# 实验1：并发翻倍，看吞吐和 TTFT 的变化
vllm serve Qwen/Qwen2.5-7B-Instruct --max-model-len 8192 --gpu-memory-utilization 0.9 --max-num-seqs 128

# 实验2：开前缀缓存，构造长 system prompt 的压测数据，看命中率
vllm serve Qwen/Qwen2.5-7B-Instruct --max-model-len 8192 --gpu-memory-utilization 0.9 --max-num-seqs 64 --enable-prefix-caching

# 实验3：开分块 prefill，看长 prompt 下的流式 TTFT
vllm serve Qwen/Qwen2.5-7B-Instruct --max-model-len 8192 --gpu-memory-utilization 0.9 --max-num-seqs 64 --enable-chunked-prefill
```

**产出**：一张「参数 → 影响 → 适用场景」的对照表。面试官要的不是你背参数，而是你能讲清「这个参数动了哪个瓶颈、我的业务为什么需要它」。

## 5.4 SGLang vs TensorRT-LLM vs vLLM（面试对比题）

| 引擎 | 特点 | 适用 |
|------|------|------|
| vLLM | 生态最大、上手快、PagedAttention 开创者 | 通用首选 |
| SGLang | RadixAttention 前缀缓存更强、编程模型灵活（结构化输出/Agent） | Agent、多轮、结构化输出 |
| TensorRT-LLM | NVIDIA 官方、极致优化、但配置复杂 | 极致性能、NVIDIA 深度绑定 |
| TGI | HuggingFace 官方、易用 | HF 生态深度用户 |

**一句话答案**：vLLM 是事实标准默认选，SGLang 在 Agent/长前缀场景有优势，TensorRT-LLM 追求极致但要付配置复杂度成本。MaaS 平台通常多引擎并存，统一封装成 OpenAI 接口。

## 5.5 今日作业

完成调优对照实验，产出一张「参数 → 瓶颈 → 效果」表。再想清楚一个问题：**如果你的业务是「长文档摘要」和「短问答」混合，你会怎么给这两种负载分别调参？**

---
