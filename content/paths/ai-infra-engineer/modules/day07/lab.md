---
title: 实验五 · 搭一个 LLM 网关并踩完它的坑
---

# 🧪 动手实验 · Day 7

> **目标**：把 APISIX 挡在你的 vLLM 前面，亲手踩完 LLM 网关的三个经典坑——SSE 被缓冲、慢推理被超时掐断、限流误杀长连接。踩完这三个坑，你在面试里讲的每一条都是「我踩过」而不是「我听说」。
>
> 三档：**真机/模拟同途**（本实验不需要 GPU——任何后端都行，甚至 nginx 返回假流）／**纸上**（排障决策题）。

---

## 档位 A/B · 实操（无 GPU 也能完整做）

网关实验的重点是「网关层行为」，后端用什么都行。有 GPU 用 vLLM，没有就先起一个假流式后端：

### 第 0 步：准备一个后端

```bash
# 有 GPU：起 vLLM
vllm serve Qwen/Qwen2.5-7B-Instruct --max-model-len 4096 --port 8000

# 无 GPU：起假流式后端（30 行，模拟逐 token SSE + 慢响应）
python - <<'EOF'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, time

class FakeLLM(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        n = 50  # 模拟 50 个 token
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for i in range(n):
            chunk = {"choices":[{"delta":{"content":f"字{i} "}}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
            time.sleep(0.2)  # 模拟 200ms/token 的慢推理
        self.wfile.write(b"data: [DONE]\n\n")

HTTPServer(('0.0.0.0', 8000), FakeLLM).serve_forever()
EOF
```

### 第 1 步：起 APISIX（Docker 一行）

```bash
# 注意：不用 STAND_ALONE 模式（standalone 会禁用 Admin API，后续 curl 配置全部失败——
# 这是本实验曾踩过的坑）。用默认模式 + Admin API 动态配置：
docker run -d --name apisix -p 9080:9080 -p 9180:9180 apache/apisix:3.11.0-debian
```

### 第 2 步：配路由（重点全在注释里的三个坑）

```bash
curl http://127.0.0.1:9180/apisix/admin/routes/1 -X PUT \
  -H "X-API-KEY: edd1c9f034035f112f017bc3e4f8d2ba" \
  -d '{
  "uri": "/v1/*",
  "upstream": { "type": "roundrobin", "nodes": { "host.docker.internal:8000": 1 } },
  "timeout": { "connect": 5, "send": 600, "read": 600 },
  "plugins": {
    "limit-conn": { "conn": 20, "burst": 5, "default_conn_delay": 1, "rejected_code": 429 }
  }
}'
# X-API-KEY 是默认 admin key（生产必改）；upstream 用 host.docker.internal
# 让容器访问宿主机的 vLLM（127.0.0.1 在容器里指容器自己）
```

**三个参数的含义（本实验的灵魂）**：
- `read: 600`——网关等后端响应的超时。**LLM 流式生成可能持续几分钟**，默认 60s 会把长生成掐断（坑 ②）
- `limit-conn` 限的是**并发连接数**不是 QPS——LLM 的容量瓶颈是显存决定的并发上限（坑 ③）
- SSE 透传需要网关不缓冲响应——APISIX 默认不缓冲，但**如果你换 nginx，必须关 proxy_buffering**（坑 ①）

### 第 3 步：验证三件事（每件都是一个坑的「踩+修」）

**验证 1 · SSE 流式透传**（坑①：被缓冲成「憋到最后一次性吐」）

```bash
curl -N http://localhost:9080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

✓ 通过标准：字一个一个出现（约 0.2s 间隔）。✗ 失败形态：卡 10 秒后一口气全出——这就是缓冲杀死了流式体验，用户会觉得「TTFT 巨慢」。

**验证 2 · 慢推理不被掐**（坑②：超时）

用假后端故意生成 60 秒以上（把 token 数调到 400）。如果被网关 502/截断，就是 read timeout 不够——回去把 `read` 调大。

**验证 3 · 并发限流生效且不误杀**（坑③：429 与长连接）

```bash
# 同时开 30 个长连接（超过 conn=20）
for i in $(seq 1 30); do
  curl -s -N http://localhost:9080/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"stream":true,"messages":[{"role":"user","content":"hi"}]}' \
    -o /dev/null -w "%{http_code}\n" &
done; wait
```

✓ 通过标准：约 20 个 200 + 10 个 429。**429 要发生在「新连接建立时」而不是「流到一半被掐」**——掐流一半说明限流实现在连接中途生效，那是事故级 bug。

### 第 4 步：对比限 QPS vs 限并发的差异

把 `limit-conn` 换成 `limit-req`（rate=5/s）重跑验证 3：观察长连接是否被中途误杀、429 分布。体感结论：**LLM 网关限「在飞的请求数」，不是「每秒新建数」**。

---

## 档位 C · 纸上（排障决策题）

三道线上事故题，**先给排查顺序，再展开对照**：

**事故 1**：用户反馈「生成到一半就断了」，服务日志无错误。
<details><summary>对照</summary>

排查顺序：① 网关 read timeout（最常见——默认 60s，长生成必死）→ ② LB 的空闲连接回收（SSE 两 token 间隔 > 空闲阈值被回收）→ ③ 显存 OOM 触发请求驱逐（vLLM 日志会有 record）→ ④ 客户端自己的超时。
**先查网关层，再查推理层**——日志在推理层干净，说明请求死在半路。
</details>

**事故 2**：网关加了一层 nginx 缓存后，用户反馈 TTFT 从 0.5s 变成 12s，吞吐监控却显示后端正常。
<details><summary>对照</summary>

**SSE 被 nginx 的 proxy_buffering 缓冲**：后端其实 0.5s 就吐首 token 了，全被 nginx 攒着，攒够 buffer 才转发。修：`proxy_buffering off`（或对 `text/event-stream` 类型禁用）。这个坑的迷惑性在于「后端指标一切正常」，只有用户体感坏了。
</details>

**事故 3**：限流配置 rate=10/s，压测时 429 正常，但线上高峰期「没到 10/s 也 429」。
<details><summary>对照</summary>

**限的是 QPS，而 LLM 请求平均耗时 30s+**：10 QPS 意味着同时在飞 10×30=300 个请求，显存早就爆了——429 来自后端的显存保护而不是网关。或者反之：并发限制=10 但请求耗时短，导致「远没到容量就 429」。**结论：LLM 网关的限流维度必须与「并发 × 平均耗时」对齐，纯 QPS 是错误抽象**。
</details>

---

## ✅ 实验完成清单

- [ ] 我的网关能正确透传 SSE（逐 token 可见）
- [ ] 我验证了长生成不被默认超时掐断
- [ ] 我看到了 429 发生在连接建立时而非流中途
- [ ] 我能说出「LLM 网关限并发不限 QPS」的原因
- [ ] （纸上档）三道事故题我至少答对排查顺序
