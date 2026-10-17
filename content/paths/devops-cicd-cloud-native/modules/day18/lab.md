---
title: 实验十八 · 用推理指标做一次模型灰度
---

# 🧪 动手实验 · Day 18

> **目标**：不是学 KServe 或 Rollouts 的语法，而是**亲手用「推理专属指标」判定一次模型换版该不该继续放量**。这是 Day 14 的渐进式发布在推理场景的落地——判据从「HTTP 错误率」升级成「队列、TTFT、TPOT」。
>
> 三档任选：**档位 A 真环境**（有 GPU + vLLM/KServe）／**档位 B 本地**（无 GPU，小模型 CPU 推理，或只做清单/diff 演练）／**档位 C 纸上**（10 分钟，纯推理）。

---

## 档位 A · 真环境（有 GPU + vLLM / KServe）

### 1. 起一个推理服务并探活

```bash
# 直接起 vLLM（OpenAI 兼容端点）
kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: llm-svc-v3
spec:
  replicas: 2
  selector: { matchLabels: { app: llm-svc, ver: v3 } }
  template:
    metadata: { labels: { app: llm-svc, ver: v3 } }
    spec:
      nodeSelector:
        kubernetes.io/arch: amd64          # 与镜像架构一致（GPU 节点通常 amd64）
      containers:
        - name: vllm
          image: vllm/vllm-openai@sha256:REPLACE_ME
          args: ["--model", "/models/llm-sft", "--max-model-len", "4096"]
          ports: [{ containerPort: 8000 }]
          resources:
            limits:
              nvidia.com/gpu: "1"
YAML

kubectl get pods -l app=llm-svc -o wide
kubectl port-forward deploy/llm-svc-v3 8000:8000 &
curl -s localhost:8000/v1/models | head
```

### 2. 抓「推理专属指标」

```bash
curl -s localhost:8000/metrics | grep -E 'num_requests_waiting|gpu_cache_usage_perc|time_to_first_token'
```

| 观察项 | 你的记录 |
|---|---|
| `vllm:num_requests_waiting` 在压测下会不会涨？ | |
| `vllm:kv_cache_usage_perc` 随并发如何变化？（旧版叫 `vllm:gpu_cache_usage_perc`） | |
| 同时 `top` 看 CPU 利用率——它和队列长度同步吗？ | |

**关键观察**：逐渐加压，队列长度先涨、TTFT 先恶化，而 **CPU 利用率可能纹丝不动**——这就是「CPU 不是推理伸缩指标」的直接证据。

### 3. 用 Rollouts 做一次 10% 灰度

```bash
kubectl argo rollouts get rollout llm-svc -n serving --watch
# 另开终端，把新版本（改 digest）合入 Git 后由 ArgoCD 同步，或直接 patch：
kubectl argo rollouts promote llm-svc -n serving
```

记录灰度每一步的 TTFT P95 与错误率：

| 权重 | 5xx 错误率 | TTFT P95 (ms) | TPOT P95 (ms) | 是否继续 |
|---|---|---|---|---|
| 10% | | | | |
| 50% | | | | |
| 100% | | | | |

---

## 档位 B · 本地（无 GPU）

### 1. 小模型 CPU 推理（能跑就跑）

用一个 CPU 可跑的 OpenAI 兼容小模型服务做冒烟（具体可用性随镜像与版本而变，**以官方文档为准**；跑不起来直接走 B-2）：

```bash
docker run --rm -p 8000:8000 <cpu-openai-compatible-server>:<tag> --model <tiny-model>
curl -s localhost:8000/v1/models | head
```

重点是打通「**探活 → 看 `/metrics` → 判断口径**」这条链路，不在于模型多大。

### 2. 清单 / diff 演练（一定做）

**练习一：多架构检查。** 对两个镜像确认 platform 列表，判断能否落到 arm64 节点：

```bash
docker buildx imagetools inspect registry.example.com/llm/serve:v2
docker buildx imagetools inspect registry.example.com/llm/serve:v3
```

| 镜像 | manifest 里的 platform | 能否在 arm64 节点起？ |
|---|---|---|
| serve:v2 | | |
| serve:v3 | | |

**练习二：换版 diff。** 用两个 `InferenceService`/`Rollout` 清单（v2 / v3），只改**模型 digest**，`diff` 出差异，确认「换版 = 改引用」而不是「手工改副本数」。

```bash
diff -u rollout-v2.yaml rollout-v3.yaml
```

---

## 档位 C · 纸上（无需环境，10 分钟）

一次模型换版灰度，10% 权重阶段的指标如下。请判断：**该继续放量到 50%，还是回滚？**

```
基线（当前稳定版，100% 流量）:
  5xx 错误率        0.02%
  TTFT P95          420 ms
  TPOT P95           28 ms
  gpu_cache_usage_perc  0.55

候选版 @ 10% 流量（同集群、同机型）:
  5xx 错误率        0.03%
  TTFT P95          880 ms    ← 注意
  TPOT P95           27 ms
  gpu_cache_usage_perc  0.54
  输出质量抽样（人工）  正常
```

问题：

1. 哪个指标在报警？它是 TTFT 还是 TPOT 的问题？还是纯排队？
2. 该继续放量吗？为什么？
3. 如果不放量，下一步排查什么？

<details><summary>参考答案（先写完再看）</summary>

1. **TTFT P95 从 420ms 翻倍到 880ms** 是唯一显著信号；**TPOT 几乎没变**（28→27ms），错误率与 KV Cache 使用率也正常。TTFT 只含「到第一个 token」，所以这是 **Prefill/首字** 侧的退化（或候选版 prefill 变慢、或新版本在前缀处理/调度上更重），**不是纯排队**——纯排队通常同时抬高 TTFT 和 TPOT 且 `num_requests_waiting` 上涨（本例未给该指标，应补看）。
2. **不该继续放量**。首字延迟是流式体验的核心 SLA，翻倍属于明显回退，且与换版强相关。正确动作是**停在 10%（或回滚），先定位**，而不是「看着错误率没涨就放量」。
3. 排查方向：候选版的引擎/镜像是否有改动导致 prefill 变慢；是否换了注意力后端或并行配置；`max_num_seqs`/`max_model_len` 是否变化；补看 `vllm:num_requests_waiting` 与 `vllm:time_to_first_token_seconds` 的分桶，确认是排队还是单次 prefill 变慢。

（这正是「TTFT 与总延迟不是一回事」的价值：如果只看总延迟或只看错误率，这次退化会被漏掉。）

</details>

### 最后一问

如果让你给这条推理服务的弹性策略只留**一个**伸缩指标，你选哪个？写下指标名和理由：

指标：____________________
理由：____________________________________________

<details><summary>参考思路</summary>

多数场景选 **`vllm:num_requests_waiting`（队列长度）**——它是领先指标，直接反映「需求超过算力」，扩容能立刻缓解排队。次选是 TTFT P95（更贴用户体验，但更滞后、更噪声）。CPU 利用率排除在外：Decode 阶段它根本不反映瓶颈。实际会「队列长度扩容 + TTFT P95 作为 SLO 报警」组合使用。
</details>
