---
title: 部署 vLLM + 读透指标
---

# Day 2 · 亲手部署 vLLM + 读透推理指标

## 2.1 环境准备

```bash
# 1. 确认 GPU 和驱动
nvidia-smi

# 2. 确认容器能用 GPU（跑不通就是 nvidia-container-toolkit 没装）
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi

# 3. 建 Python 虚拟环境（别污染系统环境，这是老运维的好习惯）
python3 -m venv ~/venvs/vllm && source ~/venvs/vllm/bin/activate
pip install vllm
```

## 2.2 部署第一个推理服务

```bash
# 起一个 7B 模型（首次会从 HuggingFace 下载权重，几 GB）
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.9 \
  --max-num-seqs 64 \
  --port 8000
```

**启动时观察什么**（这就是和传统服务的第一处不同）：
1. 先有一段「加载权重」的过程——模型从磁盘读进显存，**比传统进程启动慢一个量级**。
2. 加载完成后才监听 8000 端口。
3. 看 `nvidia-smi`：显存被吃掉一块，这就是模型权重 + 预留的 KV Cache 池。

## 2.3 发请求：感受流式输出

```bash
# 非流式（一次性返回完整 JSON）
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"用三句话介绍你自己"}]}'

# 流式（SSE，一行一个 token）—— 注意 -N 参数，关闭缓冲才能看到实时输出
curl -N http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"写一首五言绝句"}],"stream":true}'
```

**关键观察**：
- 接口是 **OpenAI 兼容格式**（`/v1/chat/completions`），这是 MaaS 平台的事实标准——所有推理引擎都兼容它，客户零迁移成本。
- 流式响应每行一个 `data: {...}`，是 SSE 协议。记住这点，Day 7 网关要处理它。

## 2.4 读透 vLLM 指标

```bash
# 看全部指标
curl -s localhost:8000/metrics

# 只看关键项
curl -s localhost:8000/metrics | grep -E "vllm:(time_to_first_token|time_per_output_token|num_requests|gpu_cache_usage|avg_.*throughput|prefix_cache)"
```

### 指标逐条解读（这是面试要能讲的）

| 指标 | 含义 | 怎么用 |
|------|------|--------|
| `vllm:time_to_first_token_seconds` | TTFT 直方图 | 算 P99/P50 首字延迟 |
| `vllm:time_per_output_token_seconds` | TPOT 直方图 | 算每字延迟 |
| `vllm:num_requests_running` | 正在推理的请求数 | 实时并发 |
| `vllm:num_requests_waiting` | **排队中的请求数** | **持续>0 说明要扩容或调并发** |
| `vllm:gpu_cache_usage_perc` | **KV Cache 使用率（显存水位）** | **接近100%是显存瓶颈** |
| `vllm:gpu_prefix_cache_hit_rate` | 前缀缓存命中率 | 长 system prompt 场景的关键收益 |
| `vllm:avg_prompt_throughput_toks_per_s` | 输入吞吐 | prefill 效率 |
| `vllm:avg_generation_throughput_toks_per_s` | 输出吞吐 | decode 效率 |
| `vllm:prompt_tokens_total` / `generation_tokens_total` | 累计 token 计数 | 计费基础 |

**关键认知**：`num_requests_waiting` 和 `gpu_cache_usage_perc` 是两个「水位计」，一个看排队压力，一个看显存压力。排查性能问题先看这两个。

## 2.5 压测：画出性能曲线

```bash
# 1. 下载标准 benchmark 数据集（ShareGPT 对话语料）
wget https://huggingface.co/datasets/anon8231489123/ShareGPT_Vicuna_unfiltered/resolve/main/ShareGPT_V3_unfiltered_cleaned_split.json

# 2. 官方压测脚本（在 vllm 源码 benchmarks/ 目录，git clone 下来）
python benchmarks/benchmark_serving.py \
  --backend vllm \
  --model Qwen/Qwen2.5-7B-Instruct \
  --dataset-name sharegpt \
  --dataset-path ShareGPT_V3_unfiltered_cleaned_split.json \
  --num-prompts 500 \
  --request-rate 4
```

**改 `--request-rate`（1/4/16/64）跑四遍，记录这张表**：

| request-rate | TTFT P50 | TTFT P99 | 输出吞吐(tok/s) | waiting 峰值 | gpu_cache_usage |
|--------------|----------|----------|-----------------|--------------|-----------------|
| 1 | | | | | |
| 4 | | | | | |
| 16 | | | | | |
| 64 | | | | | |

**读这张曲线的规律**（面试考点）：
- 并发↑ → 吞吐先升后平 → 显存打满后吞吐到顶，再往上只会增加排队和延迟。
- 找到「吞吐拐点」对应的并发数，就是**这个模型、这块卡、这个负载**的最优并发。

**老运维视角**：你原来压测看「QPS 和 CPU 曲线」，现在看「并发和 token 吞吐曲线」。压测方法论没变（逐步加压、找拐点、看 P99），变的只是指标。

## 2.6 今日作业

跑完上面的压测，产出一张真实的「并发 vs 吞吐 vs 延迟」曲线表。这就是你面试时「我有实战」的证据。

---
