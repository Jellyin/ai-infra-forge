#!/usr/bin/env node
/**
 * 生产构建首屏加载基准（vite preview 4173 + playwright chromium，无 CPU/网络节流）
 * 跑法：cd apps/web && node scripts/bench-prod-load.mjs
 *   （先 pnpm build；脚本自起 vite preview，跑完自动清理进程）
 *
 * 测什么：冷缓存 goto("/") → app-header 可见 + navigation timing（TTFB/DCL/Load）
 *          以及网络传输资源统计。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const DIST = join(process.cwd(), "dist");
if (!existsSync(DIST)) {
  console.error("dist/ 不存在，先 pnpm build");
  process.exit(1);
}

const PORT = 4173;
const N = 10;

// 起 vite preview
const proc = spawn("pnpm", ["exec", "vite", "preview", "--port", String(PORT), "--strictPort"], {
  stdio: "ignore",
  detached: true,           // 独立进程组：杀得干净（pnpm→node 的孙进程链）
});
const cleanup = () => {
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already gone */ }
  try { proc.kill("SIGTERM"); } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

// 等服务就绪
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("vite preview 未就绪");
}
await waitReady();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: "block" });
const page = await context.newPage();

const times = [];
let navInfo = null;
let resourceInfo = null;
const page2 = await context.newPage();   // 末轮专用（禁缓存测传输字节数）
for (let i = 0; i < N; i++) {
  await page.goto("about:blank");
  if (i === N - 1) {
    // 末轮：全新 page + 同 page 的 CDP 禁缓存（普通模式下 disk cache 命中后 transferSize=0）
    // 注：末轮不计入加载时间样本（与常规轮不同：新 page 无预热）——时间样本取前 N-1 轮
    const cdp2 = await context.newCDPSession(page2);
    await cdp2.send("Network.setCacheDisabled", { cacheDisabled: true });
    await page2.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    navInfo = await page2.evaluate(() => {
      const [n] = performance.getEntriesByType("navigation");
      return n ? { ttfb: n.responseStart - n.startTime, dcl: n.domContentLoadedEventEnd - n.startTime, load: n.loadEventEnd - n.startTime } : null;
    });
    resourceInfo = await page2.evaluate(() => {
      const res = performance.getEntriesByType("resource");
      return {
        count: res.length,
        transfer: res.reduce((s, r) => s + (r.transferSize || 0), 0),
        decoded: res.reduce((s, r) => s + (r.decodedBodySize || 0), 0),
      };
    });
    break;
  }
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "commit" });
  await page.locator(".app-header__title").waitFor({ state: "visible" });
  times.push(Date.now() - t0);
  await page.evaluate(() => {
    try { localStorage.clear(); } catch { /* ok */ }
  });
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)];
console.log(`\n[生产首屏] vite preview · 冷缓存 goto → app-header 可见`);
console.log(`  中位 ${med(times).toFixed(0)} ms · p95 ${p95(times).toFixed(0)} ms · (n=${N})`);
if (navInfo) console.log(`  navigation timing: TTFB ${navInfo.ttfb.toFixed(0)}ms · DCL ${navInfo.dcl.toFixed(0)}ms · Load ${navInfo.load.toFixed(0)}ms`);
if (resourceInfo) console.log(`  资源: ${resourceInfo.count} 个 · 解码后 ${(resourceInfo.decoded / 1024).toFixed(1)} kB（gzip 传输量见 bench-bundle.mjs）`);

await browser.close();
cleanup();
console.log("  (preview 进程已清理)");
