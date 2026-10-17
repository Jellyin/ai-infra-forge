---
title: 实验十六 · 把多租户与权限真正落地并验证
---

# 🧪 动手实验 · 里程碑 16

> **交付物**：① 三层隔离选型（含升级条件）② 二维权限模型 ③ 过滤表达式实现 ④ 不可绕过验证清单与测试 ⑤ 权限变更传播 + 生效 SLO 与验证脚本 ⑥ 删除请求端到端传播与反查 ⑦ 审计日志表 + 隐私边界声明。
> **验收标准**：两个租户共用一套索引，用 B 身份检索 A 的已知文档返回 0 命中；撤权后能在 SLO 内验证为 0；对一份文档发起删除并逐环验证（向量库/缓存/派生/备份）、反查为 0；审计能答出「谁在何时问了什么、命中了哪些文档」且不落入个体监控。
> 三档任选：**A 真实项目**（接你的 IAM 与检索服务）／**B 本地练习**（docker 起向量库，造多租户数据、验证隔离、跑删除传播）／**C 纸上评审**（30 分钟，给代码与权限模型找越权路径）。

---

## 档位 A · 真实项目（推荐）

1. **先写隔离选型 ADR**：对照 guide 16.1 写明选哪一层、为什么、**什么条件触发升级到物理隔离**（合同/监管/大客户）。没有升级触发条件的选型，迟早被合规客户逼到临时改架构。
2. **把权限翻译成过滤表达式**：按 guide 16.3 翻译 `visible(chunk,user)` 成你引擎的 DSL，**过滤与检索同一次下发**；用六项检查表逐条写自动化测试（尤其「把无权块向量当检索向量，断言 0 命中」）。
3. **定义「权限变更生效」SLO**：写下数字（如 ≤60 秒），实现强制刷新（失效缓存 + denylist），写验证脚本：**撤权 → 轮询 → 断言在 SLO 内变 0 命中**。
4. **跑一次删除请求端到端传播**：按 guide 16.5 五环清单逐环验证，写明备份/日志这类「保留期内不可删」的例外。

---

## 档位 B · 本地练习（完整走一遍隔离—传播—审计）

```bash
# 1) 起向量库，建集合与过滤字段索引
docker run -d --name kb-qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant
curl -s -X PUT localhost:6333/collections/kb -H 'Content-Type: application/json' \
  -d '{"vectors":{"size":4,"distance":"Cosine"}}'
curl -s -X PUT localhost:6333/collections/kb/index -H 'Content-Type: application/json' \
  -d '{"field_name":"tenant_id","field_schema":"keyword"}'

# 2) 造两个租户的数据
curl -s -X PUT 'localhost:6333/collections/kb/points?wait=true' \
  -H 'Content-Type: application/json' -d '{
  "points":[
    {"id":1,"vector":[0.1,0.2,0.3,0.4],"payload":{"tenant_id":"tenant-a","acl":["g-all"],"doc_id":"a-doc-1"}},
    {"id":2,"vector":[0.1,0.21,0.29,0.41],"payload":{"tenant_id":"tenant-a","acl":["g-hr"],"doc_id":"a-doc-2"}},
    {"id":3,"vector":[0.9,0.1,0.1,0.1],"payload":{"tenant_id":"tenant-b","acl":["g-all"],"doc_id":"b-doc-1"}}
  ]}'
```

### 验证隔离不可绕过

```bash
# 以 tenant-b 身份检索：只应看到 id=3，绝不含 A 公司的块
curl -s -X POST 'localhost:6333/collections/kb/points/search' \
  -H 'Content-Type: application/json' -d '{
  "vector":[0.1,0.2,0.3,0.4],"limit":5,"with_payload":true,
  "filter":{"must":[{"key":"tenant_id","match":{"value":"tenant-b"}},
                    {"key":"acl","match":{"any":["g-all"]}}]}}'

# 用 tenant-a 的向量（甚至 id=2 的向量）以 tenant-b 身份检索——应 0 命中
curl -s -X POST 'localhost:6333/collections/kb/points/search' \
  -H 'Content-Type: application/json' -d '{
  "vector":[0.1,0.21,0.29,0.41],"limit":5,"with_payload":true,
  "filter":{"must":[{"key":"tenant_id","match":{"value":"tenant-b"}}]}}'
```

再测两条：用户组置空 → 应 0 命中（白名单语义）；把 `must` 改 `should` → 观察是否误放行（测试要能捕获）。**拦截靠的是过滤而非语义相似度**——这正是要断言 0 命中的原因。

### 删除请求的端到端传播（被遗忘权）

```bash
# 按 doc_id 过滤批量删除（不是按 point id 一条条删）
curl -s -X POST 'localhost:6333/collections/kb/points/delete?wait=true' \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"must":[{"key":"doc_id","match":{"value":"a-doc-2"}}]}}'

# 反查：断言 0 命中
curl -s -X POST 'localhost:6333/collections/kb/points/scroll' \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"must":[{"key":"doc_id","match":{"value":"a-doc-2"}}]},"limit":10}'
```

**别停在向量库**：继续清点缓存（原查询重跑是否还能命中）、派生数据（摘要/实体）、以及**备份与审计日志**（如实标注保留期内不可删）。

### 审计日志落地

按 guide 16.6 建 `rag_audit` 表，检索前后各写一条（`retrieved_ids` 与 `returned_ids` 分开填），然后回答两个问题：**「谁在何时问了什么、命中了哪些文档」能查出来吗？这张表会不会被用来统计某个人问了多少次？** 后者就是你要守的隐私边界。

---

## 档位 C · 纸上评审（30 分钟）

给下面代码与权限模型，找出**至少 4 条越权/合规缺陷**：

```python
# 权限模型：块 payload = {tenant_id, acl:[组id], doc_id}；用户 {tenant, groups}（取自请求体）
def search(user, vec):
    flt = {"should": [                       # (1)
        {"key":"tenant_id","match":{"value":user["tenant"]}},
        {"key":"acl","match":{"any":user["groups"]}}]}
    hits = client.search("kb", query_vector=vec, query_filter=flt, limit=10)
    return [{"doc_id":h.payload["doc_id"],"text":h.payload["text"]} for h in hits]  # (2)

def delete_doc(doc_id):
    client.delete("kb", points_selector={"filter":{"must":[{"key":"id","match":{"value":doc_id}}]}})  # (3)

def log(req):
    db.insert("rag_audit", {"actor":req.user_email,"query":req.text,"ts":now()})  # (4)
```

<details><summary>对照答案（先写完再看）</summary>

1. **`should` 而非 `must`**：`should` 是「满足任一即可」，tenant-a 用户凭 acl 命中就能取到别的租户里同名的组块，租户边界形同虚设。
2. **身份取自请求体**：可被伪造。身份只能来自服务端已认证会话。
3. **删除按 `key:"id"` 匹配**：点主键不是 payload 字段 `id`，过滤匹配不到任何块——**删除静默失败**，文档其实还在。应按 `doc_id` 这个 payload 字段删，删后必须反查。
4. **审计记真实邮箱 + 查询明文**：既超出最小化，又埋下个体监控隐患；应记稳定假名 + `query_hash`，补上缺失的 `retrieved_ids`/`returned_ids`，并写明用途限定与访问控制。

**修复优先级**：先把 `should` 改 `must`、去掉客户端身份（1、2，直接越权），再修删除匹配与反查（3），最后重做审计字段与隐私边界（4）。

</details>

把「隔离验证 / 撤权生效 SLO 验证 / 删除反查」写成脚本，进 CI 或定期巡检——**权限和安全不怕设计复杂，怕的是没人验证它还在生效。**

---

## 交付物验收清单

| 交付物 | 通过标准 | 你的产出 |
|---|---|---|
| 三层隔离选型 | 选定一层 + 写明升级到物理隔离的触发条件 | |
| 二维权限模型 | 租户边界 + 主体可见集清晰，缺省拒绝 | |
| 过滤表达式实现 | 与检索同一次下发，用你引擎的 DSL（不臆造操作符） | |
| 不可绕过验证 | 六项检查（含语义绕过、must/should）都有自动化测试 | |
| 权限变更传播 | 有生效 SLO + 强制刷新 + 可自动验证 | |
| 删除端到端传播 | 五环清单逐环验证 + 反查为 0 + 保留期例外如实标注 | |
| 审计日志 | 含 retrieved/returned id 与 policy_ver；隐私边界声明齐全 | |

> **收束**：多租户的分水岭不在「能不能隔离」，而在「能不能证明它**一直**在隔离」——权限会变、文档会删、身份会撤，**每一项都要能被验证，而不是被相信。**
