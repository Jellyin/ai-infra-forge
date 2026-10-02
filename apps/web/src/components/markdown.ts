/** 极简 markdown 渲染：支持标题/段落/代码块/列表/粗体/行内代码/表格/引用/<details> 折叠块。
 * 内容受控（zod 校验后进入），esc() 转义 & < > 阻断标签注入，无属性插值。
 * 表格渲染为真正的 <table>（连续 | 行收集成块，分隔行跳过）。
 * <details><summary>纯文本</summary> 独立成行 → 折叠块，内部按普通行渲染。 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** 一行 `| a | b |` → 单元格数组 */
function splitRow(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function renderMarkdown(md: string): string {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  const lines = body.split("\n");
  const out: string[] = [];
  let inCode = false, inList = false, inDetails = false;
  /** 收集中的表格行 */
  let tableRows: string[] = [];

  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows;
    tableRows = [];
    const cells0 = splitRow(rows[0] ?? "");
    const hasHeader = rows.length > 1 && /^\|[\s:|-]+\|?$/.test((rows[1] ?? "").trim());
    const bodyRows = hasHeader ? rows.slice(2) : rows;
    const t: string[] = ['<table class="md-table">'];
    if (hasHeader) {
      t.push("<thead><tr>");
      for (const c of cells0) t.push(`<th>${inline(c)}</th>`);
      t.push("</tr></thead>");
    }
    t.push("<tbody>");
    for (const r of bodyRows) {
      t.push("<tr>");
      for (const c of splitRow(r)) t.push(`<td>${inline(c)}</td>`);
      t.push("</tr>");
    }
    t.push("</tbody></table>");
    out.push(t.join(""));
  };

  for (const raw of lines) {
    const line = raw ?? "";
    if (line.trim().startsWith("```")) {
      flushTable();
      if (inCode) { out.push("</code></pre>"); inCode = false; }
      else { closeList(); out.push('<pre class="md-pre"><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }

    if (!inDetails) {
      const d = line.match(/^<details><summary>(.*)<\/summary>\s*$/);
      if (d) {
        flushTable(); closeList();
        out.push(`<details class="md-details"><summary class="md-details__summary">${inline(d[1] ?? "")}</summary>`);
        inDetails = true;
        continue;
      }
    } else if (line.trim() === "</details>") {
      flushTable(); closeList();
      out.push("</details>");
      inDetails = false;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      closeList();
      tableRows.push(line.trim());
      continue;
    }
    flushTable();

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = Math.min(h[1]!.length + 1, 6); // 正文 h1 降一级，避免与页面标题冲突
      out.push(`<h${lvl} class="md-h">${inline(h[2] ?? "")}</h${lvl}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote class="md-quote">${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul class="md-ul">'); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^(\d+)\.\s+/.test(line)) {
      if (!inList) { out.push('<ul class="md-ul md-ol">'); inList = true; }
      out.push(`<li>${inline(line.replace(/^(\d+)\.\s+/, ""))}</li>`);
      continue;
    }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p class="md-p">${inline(line)}</p>`);
  }
  flushTable();
  if (inCode) out.push("</code></pre>");
  if (inDetails) out.push("</details>");
  closeList();
  return out.join("\n");
}
