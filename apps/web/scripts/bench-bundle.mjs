#!/usr/bin/env node
/**
 * 构建产物体积基准：dist 里 JS/CSS 原始 + gzip 体积，以及构成占比。
 * 跑法：cd apps/web && node scripts/bench-bundle.mjs
 *   （先 pnpm build 产出 dist；脚本可重复跑，只读 dist，不改源码）
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const dist = join(process.cwd(), "dist");
if (!existsSync(dist)) {
  console.error("dist/ 不存在，先跑 pnpm build（在 apps/web 下）");
  process.exit(1);
}

const kb = (n) => (n / 1024).toFixed(2);
let totalRaw = 0, totalGzip = 0;
const rows = [];

for (const dir of ["", "assets"]) {
  const d = dir ? join(dist, dir) : dist;
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) continue;
    if (!/\.(js|css|html)$/.test(f)) continue;
    const buf = readFileSync(p);
    const gz = gzipSync(buf, { level: 6 }).length;
    rows.push({ file: (dir ? dir + "/" : "") + f, raw: buf.length, gzip: gz });
    totalRaw += buf.length;
    totalGzip += gz;
  }
}

console.log("\n[构建产物体积] dist/");
for (const r of rows.sort((a, b) => b.raw - a.raw)) {
  console.log(`  ${r.file.padEnd(30)} 原始 ${kb(r.raw).padStart(8)} kB │ gzip ${kb(r.gzip).padStart(8)} kB`);
}
console.log(`  ${"合计".padEnd(28 + "assets/".length)} 原始 ${kb(totalRaw).padStart(8)} kB │ gzip ${kb(totalGzip).padStart(8)} kB`);

/* JS 构成占比：内容数据字面量（虚拟模块注入的 paths）vs 其余（react/react-dom/业务）
   minify 后导出名被改写，用已知内容锚点（路径标题）+ 括号配对测字面量长度 */
const jsFile = rows.find((r) => r.file.endsWith(".js"));
if (jsFile) {
  const text = readFileSync(join(dist, jsFile.file), "utf8");
  const total = jsFile.raw;
  let contentLen = -1;
  const anchor = text.indexOf("30 天掌握计划");
  if (anchor > 0) {
    const assignTok = text.lastIndexOf("=[{", anchor);
    const start = text.indexOf("[", assignTok);
    let depth = 0, i = start;
    for (;; i++) {
      const c = text[i];
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      if (depth === 0) break;
    }
    contentLen = i - start + 1;
  }
  console.log("\n  JS 构成粗估（字符长度占比）:");
  if (contentLen > 0) {
    const rest = total - contentLen;
    console.log(`    内容数据(paths 字面量)      ~${kb(contentLen).padStart(7)} kB (${(contentLen / total * 100).toFixed(1)}%)`);
    console.log(`    react+react-dom+业务+样式注入 ~${kb(rest).padStart(7)} kB (${(rest / total * 100).toFixed(1)}%)`);
  }
}

/* 传输预算判断（3G fast ≈ 1.6Mbps；HTTP gzip 后传输） */
console.log(`\n  判定: gzip 总传输 ${kb(totalGzip)} kB → ${(totalGzip * 8 / 1.6e6).toFixed(1)}s @3G-fast(1.6Mbps) · ${(totalGzip * 8 / 10e6).toFixed(2)}s @10Mbps`);
console.log("  注: 内容数据静态注入主 JS（无独立 JSON chunk），guide+lab markdown 文本已内联。");
