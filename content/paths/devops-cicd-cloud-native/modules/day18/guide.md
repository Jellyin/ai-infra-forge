---
title: 推理服务交付与发布
---

# Day 18 · 推理服务交付与发布

## 18.1 职责边界：vLLM 是引擎，KServe 是编排与协议层

| | 推理**引擎**（vLLM 等） | 服务**编排层**（KServe 等） |
|---|---|---|
| 管什么 | 模型怎么算 | 服务怎么部署、路由、伸缩、灰度 |
| 具体职责 | 加载权重、continuous batching、PagedAttention/KV Cache 管理、OpenAI 兼容 HTTP、导出 Prometheus 指标 | `InferenceService` CRD、predictor/transformer 拓扑、revision 管理、流量切分（`canaryTrafficPercent`）、自动伸缩、协议 v1/v2 |
| 典型问题 | 「为什么吞吐上不去 / 显存不够」 | 「怎么切 10% 流量 / 怎么按队列扩容」 |

**判据**：模型怎么算 → 引擎；上线、切流、伸缩 → 编排层。KServe 用「带 vLLM 的 serving runtime」封装两者。

## 18.2 GPU 调度、配额与多租户

- `nvidia.com/gpu` 是**扩展资源**：整数分配、不可超卖、只可在 `limits`。
- **切分**：MIG 把一张卡切成若干实例，资源名形如 `nvidia.com/mig-…`。
- **配额**：按 namespace 用 `ResourceQuota` 限 GPU 总量；多租户用 namespace + `PriorityClass` + 队列（Volcano/Kueue）。
- **隔离**：GPU 默认独占；用 taint/toleration 隔开 GPU 与通用节点。
- **落点**：用 `nodeSelector`/亲和性把推理钉到 GPU 节点（`nvidia.com/gpu.present: "true"`），**必须**查架构（18.5）。

## 18.3 弹性：CPU 利用率为什么不是推理的正确指标

推理瓶颈是 **GPU 排队与 KV Cache**，不是 CPU。

- **队列长度**是**领先指标**：等待请求数一涨就该扩容。
- **CPU 利用率**是**滞后且不相关**的错误信号：Decode 显存带宽密集，GPU 打满时 CPU 常只 20%（扩容无动作）；Prefill 时 CPU 高、GPU 未必满（误扩容）。

正确信号（vLLM 导出）：

| 指标 | 含义 | 用途 |
|---|---|---|
| `vllm:num_requests_waiting` | 排队等待的请求数 | 扩容信号（领先） |
| `vllm:num_requests_running` | 正在处理的请求数 | 结合 batch 上限判断 |
| `vllm:kv_cache_usage_perc` | KV Cache 使用率 | 接近 1 说明显存吃紧（旧版名为 `gpu_cache_usage_perc`） |
| `vllm:time_to_first_token_seconds` | TTFT 直方图 | 用户体验（首字延迟） |
| `vllm:time_per_output_token_seconds` | TPOT 直方图 | 生成速度 |

用 **HPA external metrics（Prometheus adapter）** 或 **KEDA prometheus scaler** 按队列/TTFT 扩容。缩容要慢；GPU 冷启动/加载模型**分钟级**，`minReplicas` 一般不为 0。

**TTFT ≠ 总延迟**：总耗时 ≈ **排队 + TTFT + TPOT × 生成 token 数**。

```yaml
# KServe 自动伸缩注解（依赖 KServe 版本）
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: llm-svc
  annotations:
    autoscaling.knative.dev/min-scale: "2"
    autoscaling.knative.dev/max-scale: "8"
spec:
  predictor:
    minReplicas: 2
    maxReplicas: 8
    model:
      runtime: <已安装的 vLLM ServingRuntime 名称>
      storageUri: oci://registry.example.com/models/llm-sft@sha256:REPLACE_ME   # 协议随版本演进
```

## 18.4 金丝雀与流量切换：模型版本切换的灰度

模型换版 = 一次发布（Day 14 机制）：

- **KServe**：`canaryTrafficPercent` 把小部分流量切到新 revision。
- **Argo Rollouts**：`Rollout` 按 `steps` 逐步放量并做指标分析。

判据用**推理专属指标**：5xx、**TTFT/TPOT P95**，再加输出质量抽样。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: llm-svc
spec:
  replicas: 4
  strategy:
    canary:
      canaryService: llm-svc-canary
      stableService: llm-svc-stable
      steps:
        - setWeight: 10
        - pause: { duration: 10m }
        - analysis:
            templates: [{ templateName: ttft-slo }]
        - setWeight: 50
        - pause: { duration: 10m }
```

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: ttft-slo
spec:
  metrics:
    - name: ttft-p95
      interval: 1m
      failureLimit: 2
      successCondition: result[0] < 0.8        # P95 首字延迟 < 800ms
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            histogram_quantile(0.95,
              sum(rate(vllm:time_to_first_token_seconds_bucket[2m])) by (le))
```

> 指标名/标签随引擎版本演进（**以官方文档为准**），上线前用真实数据验证查询口径。

## 18.5 多架构推理：arm64 与 GPU 节点并存

集群可能**同时**有 arm64（Graviton/Ampere）与 amd64 GPU 节点，一个会静默坑人：

**调度成功 ≠ 容器能跑。** 单架构镜像（仅 amd64）落到 arm64 节点会 `exec format error`（Pod 表现为 `CreateContainerError`）——**kube-scheduler 不因架构不匹配拒绝调度**，它只看资源与亲和性：

- 镜像要么是**多架构 manifest**，要么按目标架构分别构建：

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t registry.example.com/llm/serve:v3 --push .
docker buildx imagetools inspect registry.example.com/llm/serve:v3   # 确认 manifest list platform
```

- 让 `nodeSelector`/亲和性与镜像架构**对齐**：

```yaml
      nodeSelector:
        kubernetes.io/arch: arm64          # 调度与镜像架构必须一致
```

- **训练镜像同理**（Day 16 `trainer` 也要双架构或匹配）。
- 典型布局：**arm64 节点跑 CPU 推理**（embedding、小模型）成本更低；**GPU 节点通常 amd64**。

## 18.6 与轨道 3 打通：ArgoCD + Rollouts 发布推理服务

推理纳入 GitOps：**Git 是唯一事实源**（Day 12）。

- Git 里放 `InferenceService`/`Rollout`/`Service` 清单，ArgoCD 同步。
- **模型换版 = 改清单里的 digest**（`storageUri` 的 `sha256:` 或镜像 digest）→ 提交 → ArgoCD 同步 → Rollouts 灰度。
- `AnalysisTemplate` 查 TTFT/错误率，超阈值 → **自动回滚**（Day 14）。

一句话：**CI 产出 digest 化制品并提交清单 → ArgoCD 同步 → Rollouts 按指标灰度 → 不达标自动回滚。**

## 18.7 成本优化清单

- **量化**（INT8/FP8/INT4）降权重与 KV Cache 显存。
- 调 `max_num_seqs`/`max_model_len` 匹配显存与 SLA。
- **前缀缓存**：多请求共享前缀时复用 KV block。
- **架构分工**：arm64 跑 CPU 推理、GPU 节点只跑 GPU 推理，镜像匹配。
- **Spot GPU + 多副本**，配合优雅缩容；注意冷启动时间。
- **按队列/TTFT 弹性**而非 CPU。
- **在线/离线分区**：在线延迟优先、离线吞吐优先。

## 18.8 今天的判断力

- 看到推理按 CPU 扩容：**瓶颈在 GPU 排队，还是 CPU？**
- 看到延迟变差：**是 TTFT 还是 TPOT，还是纯排队？**
- 看到 `CrashLoopBackOff` + `exec format error`：**镜像架构和节点架构对上了吗？**
- 看到模型换版：**改 digest 走灰度，还是有人直接 `kubectl set image`？**
