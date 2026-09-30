/** 极简 markdown 渲染：支持标题/段落/代码块/列表/粗体/行内代码/表格/引用。
 * 不引入外部 md 库（内容受控，够用即可；表格转 <pre> 保持信息不丢）。 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function renderMarkdown(md: string): string {
  // 去 frontmatter
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  const lines = body.split("\n");
  const out: string[] = [];
  let inCode = false, inList = false;

  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  for (const raw of lines) {
    const line = raw ?? "";
    if (line.trim().startsWith("```")) {
      if (inCode) { out.push("</code></pre>"); inCode = false; }
      else { closeList(); out.push('<pre class="md-pre"><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }

    if (/^\|/.test(line.trim())) {
      // 表格行：逐行转 <pre> 太碎，攒到统一处理简化为文本块
      if (out[out.length - 1] !== '<pre class="md-table-pre">') { closeList(); out.push('<pre class="md-table-pre">'); }
      out.push(esc(line));
      continue;
    } else if (out[out.length - 1] === '<pre class="md-table-pre">') {
      out.push("</pre>");
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = Math.min(h[1]!.length + 1, 6); // 正文里 h1 降一级，避免与页面标题冲突
      out.push(`<h${lvl} class="md-h">${inline(h[2]!)}</h${lvl}>`);
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
  if (inCode) out.push("</code></pre>");
  closeList();
  if (out[out.length - 1] === '<pre class="md-table-pre">') out.push("</pre>");
  return out.join("\n");
}
