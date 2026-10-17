---
title: 解析与清洗：版面、表格、层级与噪声
---

# 里程碑 4 · 解析与清洗：版面、表格、层级与噪声

> **本里程碑的交付物**：① 按文档类型的解析选型说明 ② 版面层级保留方案 ③ 噪声清洗规则表 ④ 解析失败探测与降级告警路径 ⑤ 抽样验收方法与通过标准 ⑥ 必须人工兜底的文档类型清单。
> **验收标准**：同事拿任意一份语料给你，你能说出它走哪条解析链路、预期拿到什么结构、解析失败时触发什么动作——且抽样表上有数字支撑。

## 4.1 解析质量是检索质量的上限

解析里丢的层级、混进的噪声，会让后面每个环节都在**处理垃圾**。**目标不是「把 PDF 读成文本」，而是「读成有结构、可定位、可判废的中间表示」**——它要回答：这段出自哪页、归属哪个章节（供引用锚点）；属于正文/标题/表格/代码哪一类（供切分）；可信还是需兜底（供降级）。

## 4.2 先分类，再选工具

| 文档类型 | 判断特征 | 首选链路 | 代价 / 风险 |
|---|---|---|---|
| 有文本层电子 PDF | `pdffonts` 有嵌入字体 | `pdftotext -layout` / PyMuPDF / pdfplumber | 便宜；多栏与表格易串行 |
| 扫描件（无文本层） | 无字体、文本量极小 | OCR：`ocrmypdf`+`tesseract` 或 PaddleOCR | 慢且贵；有识别错字 |
| 表格密集 | 大量规整行列 | `pdfplumber.extract_tables` / camelot | 合并单元格还原率低 |
| 图文混排 / 多栏 | 图片、分栏、脚注 | 版面分析：`unstructured`(hi_res)、Docling、LayoutParser | 最慢；依赖重 |
| Office（docx/xlsx） | 直接可解析 | python-docx / openpyxl | 能拿真实层级 |
| HTML | 标签即结构 | trafilatura / readability-lxml | 需处理导航噪声 |

**选型第一条判据是「有没有文本层」**：有就直接抽，没有才 OCR——OCR 只在必要时用，成本翻倍不止。

## 4.3 可抄的调用方式

**探测与快抽（先跑通再上库）：**

```bash
# 有无文本层？无嵌入字体基本即扫描件
pdffonts report.pdf | head
pdfinfo report.pdf | grep -E 'Pages|Encrypted|Producer'
# 抽前 3 页；-layout 保留对齐，-nopgbrk 不插分页符
pdftotext -layout -f 1 -l 3 -nopgbrk report.pdf -
```

**用字号推断标题层级（PyMuPDF）：**

```python
import fitz
doc = fitz.open("report.pdf")
d = doc[0].get_text("dict")            # blocks → lines → spans
for blk in d["blocks"]:
    for line in blk.get("lines", []):
        for sp in line["spans"]:
            print(round(sp["size"], 1), sp["font"], sp["text"][:24])
# 明显更大 / 加粗的 span 集群 → 标题候选
```

**正文与表格分链路（pdfplumber）：**

```python
import pdfplumber
with pdfplumber.open("price.pdf") as pdf:
    pg = pdf.pages[0]
    tables = pg.extract_tables()   # 逐表存为结构块
    body   = pg.extract_text()     # 正文走文本链路
```

**扫描件：先 OCR 成带文本层的 PDF，再回到「有文本层」链路：**

```bash
# 生成可检索 PDF；--deskew 纠偏、--rotate-pages 转正
ocrmypdf -l chi_sim+eng --deskew --rotate-pages scan.pdf scan_ocr.pdf
# 或单页图 OCR：--psm 6 假设单栏；hocr 保留版面框
tesseract page.png page -l chi_sim+eng --psm 6 hocr
```

## 4.4 版面与层级：标题层级决定切分质量

结构感知切分（见 m05）依赖解析阶段恢复标题层级：**按字号聚类**（结合加粗）把明显大于正文的 span 映射成 `h1/h2/h3`。每块须携带 `doc_id`、`page`、`section_path`（如 `["3 计费","3.2 费率"]`）、`type`（title/body/table/code）。**`section_path` 是引用锚点与「按节切分」的公共输入**，解析阶段丢了补不回来。

## 4.5 表格与代码：解析阶段就标成不可分单元

表格与代码块**绝不能被按长度硬切**（m05 详述），前提是解析阶段就**单独成块**：表格序列化成 Markdown/HTML（保留表头行），代码块保留缩进与语言标记，均标 `type=table/code`、整块不拆。跨页表格**按表头续接**；合并失败宁可标 `table_split=true` 交告警，不要静默拼接。

## 4.6 噪声清洗：规则要写成表，不能靠临时手感

| 噪声 | 识别方式 | 处理 |
|---|---|---|
| 页眉页脚 | 同一文本在多页重复出现（阈值如 >60% 页） | 整段删除 |
| 水印 | 低透明度/旋转/重复但无信息文本 | 删除 |
| 目录页 | 大量「标题…页码」点线 | 可删或转结构提示，不进正文 |
| 乱码/控制字符 | 非预期字符比例高、替换符 `�` | 丢弃并计入告警 |
| 断词连字符 | 行尾 `-` 后接小写字母 | 合并，注意别误伤编号/化学式 |

## 4.7 解析失败探测与降级：宁可标记，不可静默丢

静默丢内容是解析最危险的失败——检索层永远不知道少了东西。**给每份文档一个 `parse_status`，让状态驱动动作：**

| 状态 | 触发信号 | 动作 |
|---|---|---|
| ok | 文本量正常、乱码率低 | 正常入库 |
| low_text | 字符/页 远低于阈值 | 升级到 OCR 重试 |
| ocr_low_conf | OCR 平均置信度低 | 标记 `needs_human`，不入主库 |
| encrypted | `pdfinfo` 显示加密且无口令 | 隔离 + 告警，人工处理 |
| failed | 解析抛错/零内容 | 隔离 + 告警，**绝不产出空块** |

信号至少含字符/页、乱码率、OCR 置信度（`tesseract` tsv 的 `conf` 列）。**「标记不可用」远好于「悄悄给出残缺文本」**——后者会以低质结果污染整条链路。

## 4.8 抽样验收：怎么抽、看什么、通过标准

抽样不能只抓容易的。**分层抽样**：按「源 × 类型 × 页数档」分层，每层抽若干，总量 ≥ 30 份。

| 指标 | 怎么量 | 通过标准（示例） |
|---|---|---|
| 文本完整度 | 字符/页 vs 人工读数 | 偏差 < 10% |
| 标题层级还原 | 抽样 5 份，标题数对比目视 | 主要章节标题召回 ≥ 90% |
| 表格还原 | 抽 10 张表，目视对行列 | 简单表 ≥ 95% 可读 |
| 噪声残留 | 页眉页脚残留条数 | 每份 ≤ 1 处 |
| 人工比对 | 随机 5 页逐字抽查 | 无整段丢失 |

**核心是找缺失而非找错误**：整段丢失不会报错，只能靠字符量与人工比对暴露。

## 4.9 本里程碑的判断力

- 有人交上「解析好了」的语料，先问：**字符/页 是多少？表格还原了吗？页眉页脚清了吗？**
- 看到异常被 `except: pass` 吞掉，判定为**会静默丢内容**，必须改成显式状态。
- 有人主张「全用 OCR 省事」，反问：**成本翻了几倍？OCR 错字会不会污染引用？**
- 解析产物没有 `section_path`，就先行不通——切分与引用都在等它。
