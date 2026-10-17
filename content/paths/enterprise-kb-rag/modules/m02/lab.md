---
title: 实验二 · 定下元数据、权限与切分粒度的三张表
---

# 🧪 动手实验 · 里程碑 2

> **本里程碑的交付物**：① 文档类型→解析→切分映射表 ② 元数据字段表 ③ 权限模型（检索期过滤条件）④ 引用锚点方案 ⑤ 第一份 ADR。
> **验收标准**：把元数据字段表交给一位同事，他能指着任一个字段说出「它进不进 payload、在检索期做什么过滤、缺了会出什么问题」；你的权限表达能落成一条真实可跑的过滤条件。
>
> 三档任选：**档位 A 真实项目**（有真实语料库）／**档位 B 本地练习**（无真实语料，用公开文档集 + docker 起 Qdrant）／**档位 C 纸上评审**（30 分钟，判断力训练）。

---

## 档位 A · 真实项目（推荐）

### 1. 抽 20 个文件，把「类型→解析→切分」跑通一遍

别一上来就上全量。随机抽 20 个文件，逐个记录类型、打算用的解析器、切分边界：

| 文件 | 类型 | 解析器 | 切分边界 | 是否有结构 |
|---|---|---|---|---|
| | md/pdf/docx/faq/table/code | | 标题/节/问答对/符号 | 是/否 |

**关键动作**：把「扫描件」和「无标题层级的 PDF」单独标红——它们决定你是否需要 OCR、锚点能不能做到「页+段」。

### 2. 元数据字段表（本里程碑核心交付物）

逐个字段问三个问题：进不进 payload？检索期过滤还是展示？缺了会怎样？判据：**能在检索期变成过滤条件、或能变成引用展示的，才进 payload**。

```text
字段名 | 示例值 | 类型 | 进 payload? | 检索期用途 | 缺了会怎样
```

### 3. 权限模型落成一条真过滤条件

写出你场景里的一句话：「部门 = 用户部门 ∨ 文档在某用户可见列表里，且密级 ≤ 用户密级，且未过期」。翻成后端可执行形式（Qdrant filter / Milvus 表达式 / Postgres RLS 任选），并**在本地真跑一次**（见档位 B）。

### 4. 引用锚点定稿并按代价分级背书

| 问题类型 | 答错代价 | 锚点粒度 | 需要的解析产物 |
|---|---|---|---|
| | 低/中/高 | 文档/章节/页+段 | |

### 5. 写 ADR-001

按 guide 2.7 模板产出，**「后果」一节必须写至少一条负面代价**——写不出负面代价，说明还没真正做取舍。

---

## 档位 B · 本地练习（无真实语料，可完整复现）

用任意开源项目的 `docs/` 当语料，本地起 Qdrant，把「元数据 + 权限过滤」跑通：

```bash
# 1) 造语料（有层级、有多个「部门」目录最好）
git clone --depth=1 https://github.com/prometheus/prometheus /tmp/kb-corpus

# 2) 起 Qdrant
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 \
  -v "$PWD/qdrant_storage:/qdrant/storage" qdrant/qdrant

# 3) 建集合（payload_m 让过滤时也从载荷图检索，减少过滤导致的召回损失）
curl -s -X PUT 'http://localhost:6333/collections/kb_docs' \
  -H 'Content-Type: application/json' \
  -d '{"vectors":{"size":4,"distance":"Cosine"},"hnsw_config":{"m":16,"ef_construct":128,"payload_m":16}}'

# 4) 给权限字段建 keyword 载荷索引（否则过滤是线性扫描）
curl -s -X PUT 'http://localhost:6333/collections/kb_docs/index?wait=true' \
  -H 'Content-Type: application/json' \
  -d '{"field_name":"department","field_schema":"keyword"}'

# 5) 插入带 payload 的点（向量用占位即可，本实验练建模不是召回）
curl -s -X PUT 'http://localhost:6333/collections/kb_docs/points?wait=true' \
  -H 'Content-Type: application/json' \
  -d '{"points":[
        {"id":1,"vector":[0.1,0.2,0.3,0.4],"payload":{"doc_id":"d1","department":"hr","classification":"internal"}},
        {"id":2,"vector":[0.2,0.1,0.4,0.3],"payload":{"doc_id":"d2","department":"legal","classification":"confidential"}}
      ]}'

# 6) 带权限过滤的检索：只应命中 department=hr 且非高密级的点
curl -s -X POST 'http://localhost:6333/collections/kb_docs/points/search' \
  -H 'Content-Type: application/json' \
  -d '{"vector":[0.1,0.2,0.3,0.4],"limit":5,
       "filter":{"must":[{"key":"department","match":{"value":"hr"}}],
                 "must_not":[{"key":"classification","match":{"value":"confidential"}}]}}'
```

**关键观察点**：把 `department` 换成不存在的值，结果应为空——这证明过滤发生在**检索期**（候选集就被裁掉），而不是检索后再筛。

---

## 档位 C · 纸上评审（30 分钟）

下面是一份**看起来齐全、实际埋了雷**的元数据与权限设计，找出它的 6 个问题：

```text
集合名：kb
每个块 payload 字段：
  dept    : "人事部,行政部"     # 字符串，多部门用逗号拼
  level   : "内部"              # 中文描述
  content : 块正文
  doc     : 文档标题

权限流程：1 用户提问 → 2 检索 TopK → 3 生成答案 → 4 生成后过滤掉无权限的块再返回
切分：所有文档统一按 512 token 切，overlap=0
引用：答案末尾附上文档标题
版本：文档更新时直接覆盖旧块
```

<details><summary>对照答案（先写完再看）</summary>

1. **多部门用逗号串**：`"人事部,行政部"` 无法做数组 `any` 匹配，只能字符串包含，慢且易误判（「人事部」会匹配到「人事部门」）。应为**数组字段**。
2. **密级用中文描述**：`"内部"` 无法排序比较（`≤ 用户密级` 需要可排序枚举）。应用 `public/internal/confidential` 之类的**有序枚举**。
3. **权限在生成后过滤**：第 4 步是致命错误——越权内容**已经进了模型上下文**，模型可能已复述。必须在**检索期**过滤（第 2 步）。
4. **锚点只到文档标题**：高代价场景无法核验「这句话出自哪一页哪一段」，至少要能到页/段。
5. **没有时效/版本字段**：更新直接覆盖，旧版无法回溯、过期文档无法过滤。缺 `valid_to`、`version`、`status`。
6. **统一 512 token 且 overlap=0**：FAQ、表格、代码会被拦腰截断，overlap=0 让跨边界语义彻底丢失。切分应按类型定，超长再二次切。

补充：还缺 `content_hash`（幂等）与 `doc_id`（删除传播）——接增量接入时就会重复块、删不掉。

</details>

### 最后：把三张表压成一页 ADR

无论哪一档，收尾前必须产出 ADR-001（guide 2.7 模板），并在「后果」里写清至少一条你为此付出的代价。

---

## 交付物验收清单

| 交付物 | 通过标准 | 你的产出 |
|---|---|---|
| 类型→解析→切分映射表 | 覆盖语料全部文档类型，每行给出切分边界与理由 | |
| 元数据字段表 | 每字段标注是否进 payload、检索期用途、缺失后果 | |
| 权限模型 | 能落成一条真实可执行的过滤条件，且过滤发生在检索期 | |
| 引用锚点方案 | 按答错代价分级给出粒度，并说明所需解析产物 | |
| ADR-001 | 含状态/背景/决策/后果四节，后果里至少一条负面代价 | |

> **收束**：知识建模不是一个文档规范，而是三个「一旦灌了数据就回不去」的决策——把它写进 ADR，才有资格进入接入管道。
