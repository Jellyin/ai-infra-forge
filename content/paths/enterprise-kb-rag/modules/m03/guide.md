---
title: 数据接入管道：多源、增量、可重跑
---

# 里程碑 3 · 数据接入管道：多源、增量、可重跑

> **本里程碑的交付物**：① 接入管道数据流图 ② 各源的增量识别方案与水位线 ③ 幂等键设计 ④ 删除/更新传播方案 ⑤ 失败隔离与断点续跑机制 ⑥ 接入作业可观测指标。
> **验收标准**：随机删掉源站一个文件、再跑一次作业，你能说清「向量库里对应的块靠什么机制被发现、多久消失、失败清单在哪看」；把同一批语料接入两遍，块数不翻倍。

## 3.1 数据流：五步，每步都要能单独重跑

```
源（文件系统 / Confluence / 工单 / 代码库）
   │ ① 取数（算出「变更集」）
   ▼  ② 解析（原件 → 结构化文本 + 锚点）
   ▼  ③ 切分（块 + 元数据）
   ▼  ④ 索引（embedding → 向量库 upsert）
   ▼  ⑤ 登记（写登记表：doc_id / 指纹 / 版本 / 状态 / 时间）
```

五步用**可持久化的中间态**（原件归档 + 登记表）连接，任一步失败都能从上游重跑；⑤ 登记是管道的大脑，**没有它就没有增量、删除检测与幂等**。

## 3.2 多源取数：先解决「变更集怎么得到」

| 源 | 取数方式 | 增量识别 | 删除识别 |
|---|---|---|---|
| 文件系统 | 遍历目录 | 内容哈希（可靠） | **清单比对**（源清单 vs 登记表） |
| Git 仓库 | `git log` / `git diff` | commit 水位线（记录上次 SHA） | diff 中的 `D` 状态 |
| Confluence | REST API | `last-modified` 游标 | 空间清单比对 |
| 工单系统 | DB / API | `updated_at` 游标 | `deleted_at` 或状态字段 |

**增量陷阱**：`mtime` 会被 `cp`、`rsync`、解压改动、与内容无关，**内容哈希才可靠**；哈希要算在**解析后的规范文本**上。
**水位线必须持久化**：记录「上次处理到哪」（git SHA / 时间戳 / 最大 `updated_at`），存进登记表或 checkpoint 表，否则每次重跑都全量。

## 3.3 幂等：同一文档重复接入不能产生重复块

幂等的核心是**确定性 ID**：

```
doc_fingerprint = sha256( 规范文本 + parser_version + chunker_version )
chunk_uid       = sha256( doc_id + chunk_index + chunk_text_hash )
```

**为什么掺入 `parser_version` / `chunker_version`**：解析器升级会改变切分结果，新旧块应算不同代，否则升级后混在一起分不清该清哪些。
**为什么用内容哈希**：文件名会改、时间戳会抖，只有内容规范形式稳定。规范文本要**归一化**：统一换行、去掉随渲染变化的空白、剔除易变字段。

写入时按确定性 ID 做 upsert：

```sql
-- pgvector：确定性主键 + ON CONFLICT upsert
INSERT INTO chunks (chunk_uid, doc_id, content, embedding, metadata)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (chunk_uid)
DO UPDATE SET content = EXCLUDED.content,
              embedding = EXCLUDED.embedding,
              metadata = EXCLUDED.metadata;
```

```bash
# Qdrant：显式指定稳定 id（由 chunk_uid 派生），同 id 覆盖即幂等
curl -s -X PUT 'http://localhost:6333/collections/kb_docs/points?wait=true' \
  -H 'Content-Type: application/json' \
  -d '{"points":[{"id":"8f0a...","vector":[...],"payload":{"doc_id":"kb-0042","chunk_index":7}}]}'
```

## 3.4 删除与更新传播：企业级最难的一步

删除必须**从源一路传到向量库**，否则用户能检索到已撤下的内容。三条通道缺一不可：

| 变化 | 检测 | 传播动作 |
|---|---|---|
| 文档更新 | 内容哈希变了 | 先删该 `doc_id` 的旧块，再写新块 |
| 文档删除 | 清单比对 / `D` 状态 / `deleted_at` | **按 `doc_id` 过滤删除**该文档全部块 |
| 权限变更 | ACL 变更事件 | 更新块 payload 里的权限字段（最常被漏！） |

```bash
# Qdrant：按 doc_id filter 删除该文档全部块
curl -s -X POST 'http://localhost:6333/collections/kb_docs/points/delete?wait=true' \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"must":[{"key":"doc_id","match":{"value":"kb-0042"}}]}}'
```

```python
# Milvus：按表达式删除
coll.delete(expr='doc_id == "kb-0042"')
```

**权限变更最易漏**：文档还在、内容没变，只是可见范围变了；管道若只按内容哈希判「没变」，权限就永不更新——**指纹要么含 ACL 版本，要么单独监听 ACL 事件**。
**更新**：块数会变，纯 upsert 会残留旧块；**先按 doc_id 删整篇、再写新版**，同批次完成。

## 3.5 失败隔离与断点续跑

**单文档失败不能阻塞全量**——一个畸形 PDF 不该拖垮整批作业：

```python
for doc in change_set:
    try:
        process(doc)                       # 解析 → 切分 → 嵌入 → upsert
        registry.mark(doc.id, "ok", fingerprint=doc.fingerprint)
    except Exception as e:
        registry.mark(doc.id, "failed", error=str(e))
        failed_log.append(doc.id)
        continue                            # 隔离：继续下一篇
report_failures(failed_log)                 # 作业结束输出失败清单
```

**失败也要登记**：否则下次增量会当它没处理过而反复重试，或更糟——被当「已处理」而永久遗漏。登记失败态，重试才有依据（配最大重试 + 死信队列）。
**断点续跑**：作业状态（水位线 + 已完成 doc_id 集合）落库，中断后从水位线继续，已完成的靠幂等跳过。

## 3.6 原始件归档、调度与可观测

解析结果要能回溯到**原件版本**：归档原件（或不可变引用 + 指纹），登记表记录「这块来自哪个原件指纹、哪个解析器版本」，以便还原错误回答时喂给模型的确切文本。

把接入做成**可观测的作业**，最小指标集：

| 指标 | 含义 | 告警阈值示例 |
|---|---|---|
| 吞吐 | 块/秒、文档/分钟 | 突降→可能卡在解析或限流 |
| 失败率 | 失败文档 / 处理文档 | > 1% 告警 |
| 滞后（lag） | 源变更时间 → 索引可见时间 | 超过 SLA 告警 |
| 队列深度 | 待处理文档数 | 持续增长→消费跟不上 |
| 重试 / 死信 | 反复失败的文档数 | 有新增即需人看 |

**并发**：解析常是 CPU/IO 密集、嵌入是网络/GPU 密集，要分开限流；嵌入并发过高会触发限流，反而降低吞吐。

## 3.7 本里程碑的判断力

- 有人展示接入脚本时，先问：**删除怎么传播？权限变更怎么传播？**
- 听到「重跑一遍就行」，追问：**重复跑会不会产生重复块**（幂等键是什么）。
- 看到失败处理是整批 try/except，指出：**一篇坏文档会拖垮全量**。
- 接入作业没有滞后指标，等于不知道语料新不新鲜。
