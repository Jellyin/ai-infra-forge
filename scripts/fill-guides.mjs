#!/usr/bin/env node
/**
 * 教程正文填充：把完整版教程按 Day 切分，写进 content/.../dayNN/guide.md。
 * 保留 frontmatter(title) + 标题 + 全文正文。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "/Users/lv/Desktop/ai_infra_maas_10day_full_tutorial.md";
const md = readFileSync(SRC, "utf8");

// 按 "# Day N · " 切（跳过目录区，从第一个 Day 段开始）
const lines = md.split("\n");
const starts = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line && /^# Day (\d+)/.test(line)) starts.push(i);
}
if (starts.length < 10) { console.error(`只找到 ${starts.length} 个 Day 标题`); process.exit(1); }

// 结束边界：附录从 "# 附录" 或 "## 附录" 开始
let end = lines.length;
const appendixIdx = lines.findIndex((l) => /^#+ .*附录/.test(l));
if (appendixIdx > 0) end = appendixIdx;

const moduleTitles = {};
for (let d = 1; d <= 10; d++) {
  const s = starts[d - 1];
  const e = d < 10 ? starts[d] : end;
  if (s == null) { console.error(`day${d} 起点缺失`); process.exit(1); }
  const body = lines.slice(s, e).join("\n").trim();
  const dir = join(root, "content", "paths", "ai-infra-engineer", "modules", `day${String(d).padStart(2, "0")}`);

  // module.yaml 里的 title 作 frontmatter
  const my = readFileSync(join(dir, "module.yaml"), "utf8");
  const title = my.match(/title:\s*(.+)/)?.[1]?.trim() ?? `Day ${d}`;

  const out = `---\ntitle: ${title}\n---\n\n${body}\n`;
  writeFileSync(join(dir, "guide.md"), out);
  moduleTitles[d] = { title, bytes: out.length };
}
console.log("✓ 10 天教程正文已填充:");
for (const [d, t] of Object.entries(moduleTitles)) console.log(`  day${String(d).padStart(2, "0")} ${t.title} (${(t.bytes / 1024).toFixed(1)}KB)`);
