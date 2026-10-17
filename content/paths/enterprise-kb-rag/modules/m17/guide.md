---
title: 服务化与 API 设计
---

# 里程碑 17 · 服务化与 API 设计

> **本里程碑的交付物**：① 接口契约（含流式与引用字段）② 并发/批处理配置说明 ③ 语义缓存键设计与失效策略 ④ 租户级限流配置 ⑤ 失败降级矩阵。
> **验收标准**：换个人接手，只看这五份文件就能把服务跑起来，并说清「一个租户刷爆会不会拖垮全站」「同样的问法第二次为什么不走模型」「模型挂了会发生什么」。

## 17.1 先冻结接口契约，再写服务

接口一旦发布就难改，所以第一个交付物是契约：

```yaml
POST /v1/qa
  request:
    tenant_id:  string      # 必填，隔离与归因的第一维度
    user_id:    string
    session_id: string?     # 有则会话管理，无则单轮无状态
    query:      string
    stream:     bool        # 默认 false
    filters:    object?
  response (stream=false):
    answer:    string
    citations:
      - { doc_id, chunk_id, title, span: "第3节/第2段", url, score }
    usage:  { prompt_tokens, completion_tokens, cached }
    trace_id: string        # 全链路追踪入口，必须回传
  response (stream=true) → SSE:
    event: citation  data: { citations: [...] }   # 先吐引用
    event: token     data: { delta: "..." }
    event: done      data: { usage, finish_reason, trace_id }
    event: error     data: { code, message, trace_id }
```

三个易漏点：**`tenant_id` 进请求体**（别只从鉴权头隐式推导，否则缓存/限流/审计三处都要重猜）；**流式先吐 `citation`**（先见证据再见答案，更可信）；**`trace_id` 必须回传**（里程碑 18 做追踪的唯一入口）。

## 17.2 并发模型：别把「加副本」当万能药

自建 vLLM 时吞吐与延迟是**同一根绳子的两端**，切点由 continuous batching 决定：调度器**按 token 轮**推进，短请求生成完即释放槽位、补进新请求，「批里有长请求」不再拖累所有人。但**批越大，单个请求的 TTFT 未必越低**（要先排队），必须把 **队列等待（queue wait）** 与 **生成耗时（decode）** 分开看：

| 现象 | GPU 利用率 | 队列等待 | 结论 |
|---|---|---|---|
| 加请求就变慢 | 接近打满 | 高 | 到容量墙，**加副本** |
| 加请求就变慢 | 明显偏低 | 高 | 调度/参数问题，加副本是浪费 |
| 偶发尖刺 | 均值不高 | 尖刺高 | 队列上限太小，先调调度 |

**副本不免费**：每个副本独立占显存装权重，副本间不共享 KV cache，同一问题打到不同副本前缀复用即失效。

```yaml
vllm:  # 按你的显存与 SLO 调，别照抄
  max_num_seqs: 64            # 并发序列上限，直接决定显存占用
  max_model_len: 8192
  enable_prefix_caching: true # prompt 前缀相同时复用 KV，压首字延迟
```

## 17.3 语义缓存：收益诱人，误命中致命

```
缓存月省    ≈ 命中率 × 日请求量 × 单次成本 × 30
误命中代价  ≈ 误命中率 × 日请求量 × 单次错误代价   ← 这一项通常没人算
```

**键设计（缺一即越权或误答）**：

```
cache_key = sha256(
    normalize(query)        # 去空白/大小写/标点，不动语义
  + "|" + tenant_id          # 必进：跨租户复用 = 数据泄漏
  + "|" + acl_scope          # 必进：该用户可访问文档集合的指纹
  + "|" + model_version
  + "|" + prompt_version
  + "|" + index_snapshot_id  # 语料/索引版本，重建即变
)
```

**阈值是取舍不是真理**：≥0.95 命中少近无收益；~0.90 常见折中；≤0.85 收益高但「怎么提离职」可能命中「怎么撤回离职」。**三类高风险误命中阈值挡不住**：① 意图相反（否定/撤回/加急）；② 时效敏感（「当前价格」）；③ 权限不同但文本相同。所以键里必须有 `acl_scope`。

**失效要三道防线一起上**：① 事件驱动——文档更新时反查「哪些缓存项引用了它」并失效，为此维护 **cache_key → 引用 doc_ids 的反向索引**（否则只能全量清空）；② TTL 兜底（如 1h）；③ 版本升维——版本进键，升级即自然全失效。

## 17.4 限流：让一个租户刷不垮全站

限流防的是**合法用户的异常行为**（批量脚本、旧客户端重试风暴）：

```yaml
rate_limit:
  dimensions: [global, tenant, user]
  global: { inflight_gpu: 64 }              # 保护自建推理后端
  tenant: { rpm: 600, tpm: 200000, concurrent: 20 }
  user:   { rpm: 30,  concurrent: 3 }
  overflow: reject_429_with_retry_after     # 明确拒绝，不静默排队
  fairness: weighted_fair_queueing_by_tenant
```

**用 tpm 而不只是 rpm**（一次 8k 上下文抵几十次短问答）；**超限显式 429 + Retry-After**，静默排队会让客户端超时重试、放大流量。

## 17.5 失败降级矩阵与版本回滚

| 失败环节 | 降级行为 | 用户可见 |
|---|---|---|
| 向量库超时 | 只走关键词/BM25 | 标注「检索降级」 |
| 生成超时 | 返回 Top 片段 + 提示 | 给证据不给总结 |
| 模型不可用 | 切小模型 / 503 + Retry-After | 明确告知，不假装成功 |
| 缓存不可用 | 旁路，走全链路 | 无感，延迟升高 |

**接口与提示词都要能回滚**：`prompt_version`/`model_version` 进上下文与响应，出问题一键切回上一版。

## 17.6 轻量 PromQL 与判断力

```promql
# P95 首字延迟按环节拆（指标名按你实际埋点替换）
histogram_quantile(0.95,
  sum by (le, stage) (rate(qa_stage_duration_seconds_bucket[5m])))
sum by (tenant_id) (qa_inflight_requests)   # 每租户在飞请求
```

- 提「加机器」前先问：**GPU 利用率和队列等待分别是多少**。
- 看语义缓存方案先问：**租户、权限、索引版本进键了吗**，失效是谁触发的。
- 缓存方案没有「反向索引 + TTL + 版本升维」三件套，就还没设计完。

下一里程碑：服务上线后的观测——链路追踪、成本归因与三张看板。
