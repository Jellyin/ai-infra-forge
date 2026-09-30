---
title: GPU 可观测性
---

# Day 8 · GPU 可观测性（双层指标 + SLO）

## 8.1 监控链路（架构你熟，指标是新的）

```
DCGM → dcgm-exporter → Prometheus → Grafana   （硬件层）
vLLM → /metrics → Prometheus → Grafana          （服务层）
```

## 8.2 双层指标体系（核心）

### 硬件层（DCGM，看 GPU 健康）

```bash
docker run -d --gpus all --rm -p 9400:9400 \
  nvcr.io/nvidia/k8s/dcgm-exporter:3.3.5-3.4.1-ubuntu22.04
curl -s localhost:9400/metrics | grep DCGM_FI_DEV
```

| 指标 | 含义 | 告警 |
|------|------|------|
| `DCGM_FI_DEV_GPU_UTIL` | GPU 利用率 | 长期过低=浪费 |
| `DCGM_FI_DEV_FB_USED/FREE` | 显存占用/空闲 | >95%=危险 |
| `DCGM_FI_DEV_GPU_TEMP` | 温度 | >85°C |
| `DCGM_FI_DEV_POWER_USAGE` | 功耗 | 功耗墙 |
| `DCGM_FI_DEV_XID_ERRORS` | **XID 硬件错误** | 任何值=硬件故障 |
| `DCGM_FI_DEV_ECC_SBE_VOL_TOTAL` | **ECC 错误** | 增长=硬件劣化 |

**老运维新认知**：GPU 会「坏」。XID 错误（如 79、48）代表显存/硬件故障，需要**下线节点**——这是传统 CPU 运维没有的心智。

### 服务层（vLLM，看推理质量）

就是 Day 2 那张指标表：TTFT、TPOT、排队深度、KV Cache 水位、前缀缓存命中率、token 吞吐。

### 两层指标如何关联（排障关键）

**场景**：TTFT P99 飙升，怎么定位？
1. 看服务层 `num_requests_waiting` → 是不是排队。
2. 看服务层 `gpu_cache_usage_perc` → 是不是显存打满。
3. 看硬件层 GPU 利用率 vs 显存带宽 → 算力瓶颈还是带宽瓶颈。
4. 看硬件层 XID/温度/降频 → 是不是硬件问题。

**这就是「从应用指标下钻到硬件指标」的完整链路**，是 AI SRE 和普通 SRE 的分水岭。

## 8.3 告警规则（面试能默写几条）

```yaml
# 关键告警（Prometheus AlertManager 规则）
- alert: GPUMemoryAlmostFull
  expr: DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL > 0.95

- alert: GPUXIDError
  expr: increase(DCGM_FI_DEV_XID_ERRORS[1m]) > 0

- alert: GPUECCError
  expr: increase(DCGM_FI_DEV_ECC_SBE_VOL_TOTAL[5m]) > 0

- alert: InferenceQueueBacklog
  expr: vllm:num_requests_waiting > 10 for 5m

- alert: TTFTDegraded
  expr: histogram_quantile(0.99, vllm:time_to_first_token_seconds) > 5
```

## 8.4 SLO 设计（SRE 内核，方法论直接复用）

你熟悉的 SLO/SLI/Error Budget **完全适用**，只是 SLI 换了：

| SLO 类型 | SLI | 目标 |
|----------|-----|------|
| 可用性 | 推理服务可用率 | 99.9% |
| 性能 | TTFT P99、TPOT P99 | 分档承诺 |
| 容量 | GPU 利用率、排队深度 | 利用率>60%，排队<10 |

**面试答案**：传统 SRE 方法论（SLO/Error Budget/on-call）直接迁移，只是把 SLI 从「延迟/错误率」换成「TTFT/TPOT/token 吞吐/显存水位」。

## 8.5 今日作业

搭一套 Prometheus + Grafana，把 DCGM 和 vLLM 两层指标都接进来，做一张「硬件 + 服务」双层的 Dashboard。列出 5 条你会上线的告警规则。

---
