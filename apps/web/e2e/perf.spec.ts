import { test, expect, type Page } from "@playwright/test";

/**
 * 性能基准（dev server 5179，Playwright + chromium，无 CPU/网络节流 —— 本机条件下的数字）
 *
 * 测什么：
 *  1. 首屏加载：goto("/") → app-header 渲染（dev 未打包 ESM，数字天然比生产大）
 *  2. 闪卡评分交互延迟：点击评分按钮 → 下一张卡内容上屏（含翻面状态切换）
 *  3. 1000 卡压力：
 *     3a. 逻辑层：页面上下文直接跑 buildCardQueue(1000 卡)（与组件 useMemo 同一份源码）
 *     3b. React 层：向 localStorage 注入 990 张卡的 SM-2 状态 → 真实评分链路
 *         （useProgress setCards → 五 tab 消费者重渲染 → queue 重建 → spread 大对象）
 *     3c. rAF 帧时间采样
 *     注：不改源码约束下无法把「内容」本身换成 1000 卡（内容由 vite 虚拟模块构建期注入），
 *     3b 测的是「状态规模 × 组件重渲染」，与内容 1000 卡在 buildCardQueue/flat.map
 *     成本路径上同构；3a 直接给出 1000 卡纯逻辑的浏览器数字。
 *  4. tab 切换耗时（display:none 切换 + React 状态更新）
 *  5. 勾选清单 → 全组件重渲染成本（checklist 变化 → Dashboard stats useMemo 失效重算）
 *  6. markdown 单次 parse 耗时（页面上下文 import renderMarkdown 源码模块）
 *
 * 方法论：每个场景多轮采样取中位数 + p95；诚实报告（含失败场景）。
 */

const N = 10;
const PREFIX = "aiforge:";

/* ---------- 工具 ---------- */

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
}
function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(1)} ms`;
}
function reportLine(name: string, xs: number[]) {
  console.log(`  ${name.padEnd(40)} 中位 ${fmt(median(xs)).padStart(10)}  p95 ${fmt(p95(xs))}  (n=${xs.length})`);
}

async function resetProgress(page: Page) {
  await page.evaluate((prefix) => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(prefix)) localStorage.removeItem(k);
    }
  }, PREFIX);
}

async function gotoTab(page: Page, tab: string) {
  await page.click(`nav.tabs button:has-text("${tab}")`);
  await page.waitForTimeout(150);
}

function visibleScope(page: Page) {
  return page.locator("main > div:visible");
}

/** 生成 1000 卡的 mock PathContent（页面内 eval 构造） */
const MOCK_1000_SRC = `(() => {
  const modules = [];
  for (let m = 0; m < 10; m++) {
    const flashcards = [];
    for (let c = 0; c < 100; c++) {
      flashcards.push({ id: 'p' + m + '-c' + c, front: '模块' + m + ' 卡 ' + c + '：' + '比较长的问题 '.repeat(4), back: '答案内容：' + '比较长的答案 '.repeat(8) });
    }
    modules.push({ id: 'day' + m, title: '压力模块 ' + m, goal: 'goal', order: m + 1, read: 10, lab: 10,
      concepts: [], checklist: ['项一', '项二', '项三', '项四'],
      guideMd: '# 指南\\n\\n' + '段落正文文字。 '.repeat(100) + '\\n\\n- 列表项\\n- 列表项\\n',
      labMd: '', flashcards, commands: [], quiz: [] });
  }
  return { id: 'bench-path', title: '压力路径', subtitle: '1000 卡', version: '0.0.0', modules };
})()`;

/* ============================================================ */

test("P1 · dev 首屏加载（goto → app-header 渲染）", async ({ page }) => {
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    await page.goto("about:blank");
    const t0 = Date.now();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator(".app-header__title").waitFor({ state: "visible" });
    times.push(Date.now() - t0);
  }
  const nav = await page.evaluate(() => {
    const [n] = performance.getEntriesByType("navigation");
    return n ? { ttfb: n.responseStart - n.startTime, dcl: n.domContentLoadedEventEnd - n.startTime } : null;
  });
  reportLine("dev goto → app-header 可见", times);
  if (nav) console.log(`  导航 timing（末轮）: TTFB ${nav.ttfb.toFixed(0)}ms · DCL ${nav.dcl.toFixed(0)}ms`);
  await resetProgress(page);
});

test("P2 · 闪卡评分交互延迟（真实内容 39 卡）", async ({ page }) => {
  await page.goto("/");
  await resetProgress(page);
  await page.reload();          // 清掉已挂载组件里的旧 state（localStorage 清空后必须重读）
  await resetProgress(page);    // reload 落地后组件重新挂载会再写回空 state；再清一次保证零状态
  await page.reload();
  await gotoTab(page, "闪卡复习");

  // Long Tasks 观察器：交互期间主线程 >50ms 的任务（被用户感知为卡顿）
  await page.evaluate(() => {
    (window as unknown as { __longTasks: number[] }).__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          (window as unknown as { __longTasks: number[] }).__longTasks.push(e.duration);
        }
      }).observe({ entryTypes: ["longtask"] });
    } catch { /* longtask 不支持时静默 */ }
  });

  const times: number[] = [];
  const inPageTimes: number[] = [];
  let round = 0;
  while (times.length < 8) {
    const scope = visibleScope(page);
    const hasCard = await scope.locator(".flashcard").count();
    if (!hasCard) {
      // 限额耗尽：清计数 + 清已评卡状态 → reload 重读 → 重新进闪卡 tab
      await page.evaluate(() => {
        const today = new Date();
        const k = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        localStorage.setItem("aiforge:newCardsByDay", JSON.stringify({ [k]: 0 }));
        localStorage.removeItem("aiforge:cards");
      });
      await page.reload();
      await gotoTab(page, "闪卡复习");
      continue;
    }
    // 双测一轮：in-page 自驱 + e2e 口径（各消耗一张卡/一次额度，限额 5 张 → 最多 2 轮 +
    // reload 续采；hasCard 检查兜底）
    for (const mode of ["inpage", "e2e"] as const) {
      const scope2 = visibleScope(page);
      if (!(await scope2.locator(".flashcard").count())) break;
      await scope2.locator(".flashcard").click();
      await scope2.locator(".btn--good:enabled").waitFor({ state: "visible" });
      const before = await scope2.locator(".flashcard__front-text").textContent();

      if (mode === "inpage") {
        // 页面内自驱：在页面上下文 dispatch click + MutationObserver 抓 DOM 变化，
        // 剔除 Playwright 驱动往返（evaluate/click 各 ~10-15ms）后的「真实应用延迟」
        const dtInPage = await page.evaluate((prev) => {
          return new Promise<number>((resolve) => {
            const container = document.querySelector("main > div:not([style*='none'])");
            const target = container?.querySelector(".btn--good");
            if (!target || !container) { resolve(-1); return; }
            let t0 = 0;
            const done = () => {
              observer.disconnect();
              resolve(performance.now() - t0);
            };
            const observer = new MutationObserver(() => {
              const el = container.querySelector(".flashcard__front-text");
              if (!el || el.textContent !== prev) done();
            });
            observer.observe(container, { childList: true, subtree: true, characterData: true });
            t0 = performance.now();
            target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            setTimeout(done, 800);   // 兜底：800ms 无变化结束
          });
        }, before ?? "");
        if (dtInPage >= 0) inPageTimes.push(dtInPage);
      } else {
        const t0 = await page.evaluate(() => performance.now());
        await scope2.locator(".btn--good").click();
        await page.waitForFunction((prev) => {
          const el = document.querySelector("main > div:not([style*='none']) .flashcard__front-text");
          return !el || el.textContent !== prev;
        }, before ?? "", { timeout: 5000 });
        times.push(await page.evaluate(() => performance.now()) - t0);
      }
      round++;
      if (times.length >= 8 && inPageTimes.length >= 8) break;
    }
  }
  reportLine("点击「认识」→ 新卡 DOM 上屏（e2e 口径）", times);
  if (inPageTimes.length) reportLine("同上 · 页面内自驱（剔驱动开销）", inPageTimes);
  const longTasks = await page.evaluate(() => (window as unknown as { __longTasks?: number[] }).__longTasks ?? []);
  console.log(`  交互期间 longtask(>50ms): ${longTasks.length} 个${longTasks.length ? " · 最大 " + Math.max(...longTasks).toFixed(0) + "ms" : ""}`);
  await resetProgress(page);
});

/* ---------- 3. 1000 卡压力 ---------- */

test("P3a · 逻辑层：页面内 buildCardQueue · 1000 卡", async ({ page }) => {
  await page.goto("/");
  const q = await page.evaluate(async (mockSrc) => {
    const mock = (0, eval)(mockSrc);
    // vite dev 下 /@fs 可加载仓库内任意源码模块（与组件 import 的是同一份 TS 源码）
    const mod = await import("/@fs/Users/lv/ai-infra-forge/packages/logic/src/index.ts");
    const flat = [];
    for (const m of mock.modules) for (const c of m.flashcards) {
      flat.push({ key: "bench-path:" + m.id + ":" + c.id, front: c.front, back: c.back, moduleTitle: m.title });
    }
    // due 随机分散（与 node 侧基准同分布：1/3 新卡、1/3 到期随机、1/3 未到期随机）
    const states = flat.map((_, i) => i % 3 === 0 ? undefined
      : (i % 3 === 1 ? { reps: 3, interval: 6, ease: 2.5, due: Date.now() - Math.random() * 86400000 * 7 }
        : { reps: 3, interval: 30, ease: 2.5, due: Date.now() + Math.random() * 86400000 * 30 }));
    mod.buildCardQueue(states, undefined, { dailyNewLimit: 5 }); // warmup
    const out = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      mod.buildCardQueue(states, undefined, { dailyNewLimit: 5 });
      out.push(performance.now() - t0);
    }
    out.sort((a, b) => a - b);
    return { median: out[50], p95: out[95], n: flat.length };
  }, MOCK_1000_SRC).catch((e: unknown) => ({ error: String(e) }));
  if ("error" in q) console.log(`  [3a] FAILED: ${q.error}`);
  else console.log(`  [3a] buildCardQueue · ${q.n} 卡: 中位 ${q.median.toFixed(3)}ms · p95 ${q.p95.toFixed(3)}ms`);
  await resetProgress(page);
});

test("P3b · React 层：990 卡状态注入 → 真实评分链路重渲染 + 帧时间", async ({ page }) => {
  // P1 末尾已 reset（但组件内 state 未重读）：先清 + reload 得到零状态基线
  await page.goto("/");
  await resetProgress(page);
  await page.reload();
  await resetProgress(page);

  // 注入 990 张卡的真实 SM-2 状态（走 localStorage → useProgress 读入 → 全组件树拿到
  // 990 键的 cards 对象；评分时 setCards spread 重建该对象 + 五 tab 全部重渲染）
  // 新卡限额置 5（顶格）→ flat 39 张真实内容卡中仍有 due 到期卡可评吗？
  // 注入的 990 键不属于真实内容 path（bench-path: 前缀），Flashcards 只按真实 flat 的
  // key 取状态 → 990 张注入卡全部是 waiting 侧的状态、不进队列——但 cards 对象本身
  // 的规模（990 键）与 setCards 的 spread 成本是真实进入链路的。这就是要测的。
  await page.evaluate((mockSrc) => {
    const mock = (0, eval)(mockSrc);
    const cards = {};
    const now = Date.now();
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    for (const m of mock.modules) {
      for (const c of m.flashcards.slice(0, 99)) {
        cards["bench-path:" + m.id + ":" + c.id] = { reps: 3, interval: 6, ease: 2.5, due: now + 86400000 * 7 };
      }
    }
    // 真实内容 39 卡保持全新（不注入 bench-path 状态），评分走新卡链路
    localStorage.setItem("aiforge:cards", JSON.stringify(cards));
    localStorage.setItem("aiforge:activity", JSON.stringify({ [key]: 1 }));
    localStorage.setItem("aiforge:newCardsByDay", JSON.stringify({ [key]: 0 }));
  }, MOCK_1000_SRC);

  await page.reload();
  await gotoTab(page, "闪卡复习");

  const times: number[] = [];
  const frameGaps: number[] = [];
  while (times.length < 6) {
    const scope = visibleScope(page);
    const hasCard = await scope.locator(".flashcard").count();
    if (!hasCard) {
      // 限额耗尽：保留 990 卡状态（压力数据），只清计数 + 真实卡状态 → reload 续采
      await page.evaluate(() => {
        const today = new Date();
        const k = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        localStorage.setItem("aiforge:newCardsByDay", JSON.stringify({ [k]: 0 }));
        const cards = JSON.parse(localStorage.getItem("aiforge:cards") || "{}");
        for (const key of Object.keys(cards)) {
          if (!key.startsWith("bench-path:")) delete cards[key];
        }
        localStorage.setItem("aiforge:cards", JSON.stringify(cards));
      });
      await page.reload();
      await gotoTab(page, "闪卡复习");
      continue;
    }
    await scope.locator(".flashcard").click();
    await scope.locator(".btn--good:enabled").waitFor({ state: "visible" });
    // rAF 帧采样：点击后约 2 秒窗口
    await page.evaluate(() => {
      (window as unknown as { __frames: number[] }).__frames = [];
      requestAnimationFrame(function loop(t: number) {
        const w = window as unknown as { __frames: number[] };
        w.__frames.push(t);
        if (w.__frames.length < 130 && t - w.__frames[0]! < 2000) requestAnimationFrame(loop);
      });
    });
    const before = await scope.locator(".flashcard__front-text").textContent();
    const t0 = await page.evaluate(() => performance.now());
    await scope.locator(".btn--good").click();
    await page.waitForFunction((prev) => {
      const el = document.querySelector("main > div:not([style*='none']) .flashcard__front-text");
      return !el || el.textContent !== prev;
    }, before ?? "", { timeout: 5000 });
    times.push(await page.evaluate(() => performance.now()) - t0);
    const gaps = await page.evaluate(() => {
      const f = (window as unknown as { __frames?: number[] }).__frames ?? [];
      const gaps: number[] = [];
      for (let j = 1; j < f.length; j++) gaps.push(f[j]! - f[j - 1]!);
      return gaps;
    });
    frameGaps.push(...gaps);
    await page.waitForTimeout(250);
  }
  reportLine("990 卡状态 · 评分 → 新卡上屏", times);
  const sorted = [...frameGaps].sort((a, b) => a - b);
  if (sorted.length) {
    const janky = sorted.filter((g) => g > 50).length;
    console.log(`  帧间隔: 中位 ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)}ms · 最大 ${sorted[sorted.length - 1]!.toFixed(1)}ms · >50ms 帧占 ${(janky / sorted.length * 100).toFixed(1)}%`);
  }
  await resetProgress(page);
  await page.reload();
});

test("P4 · 五 tab 常驻挂载：切换耗时", async ({ page }) => {
  await page.goto("/");
  await resetProgress(page);
  await page.waitForTimeout(300);

  const tabs = ["学习路径", "闪卡复习", "命令训练", "面试自测", "仪表盘"];
  const detail: string[] = [];
  const all: number[] = [];
  for (let round = 0; round < 3; round++) {
    for (const tab of tabs) {
      const t0 = await page.evaluate(() => performance.now());
      await page.click(`nav.tabs button:has-text("${tab}")`);
      await page.waitForFunction((label) => {
        const btn = Array.from(document.querySelectorAll("nav.tabs button")).find((b) => b.textContent?.includes(label));
        return btn?.getAttribute("aria-current") === "page";
      }, tab, { timeout: 5000 });
      const dt = await page.evaluate(() => performance.now()) - t0;
      all.push(dt);
      if (round === 0) detail.push(`${tab} ${dt.toFixed(1)}ms`);
    }
  }
  console.log("  首轮: " + detail.join(" · "));
  reportLine("tab 切换（3 轮 × 5 tab）", all);
});

test("P5 · 勾选清单 → 组件树重渲染（勾选 → checked 上屏）", async ({ page }) => {
  await page.goto("/");
  await resetProgress(page);
  await gotoTab(page, "学习路径");

  const scope = visibleScope(page);
  const boxes = scope.locator(".checklist__box");
  const nBoxes = await boxes.count();
  expect(nBoxes).toBeGreaterThan(0);

  const times: number[] = [];
  const seq = Math.min(N, nBoxes, 12);
  for (let i = 0; i < seq; i++) {
    const t0 = await page.evaluate(() => performance.now());
    await boxes.nth(i).click();
    await page.waitForFunction((idx) => {
      const el = document.querySelectorAll("main > div:not([style*='none']) .checklist__box")[idx];
      return el?.checked === true;
    }, i, { timeout: 5000 });
    times.push(await page.evaluate(() => performance.now()) - t0);
  }
  reportLine("勾选项 → checked 上屏", times);
  await resetProgress(page);
});

test("P6 · renderMarkdown 单次 parse（页面上下文）", async ({ page }) => {
  await page.goto("/");
  const res = await page.evaluate(async () => {
    const mod = await import("/src/components/markdown.ts");
    const block = [
      "## 小节标题",
      "正文段落 " + "文字内容 ".repeat(30),
      "- 列表项 " + "文字 ".repeat(20),
      "- 列表项 " + "文字 ".repeat(20),
      "| 列A | 列B |",
      "| --- | --- |",
      "| 单元格 " + "文字 ".repeat(10) + " | 单元格 |",
      "```bash",
      "echo " + "命令参数 ".repeat(40),
      "```",
    ].join("\n");
    const typical = block;                 // ~3.7KB，接近真实 guide 均值
    const big = block.repeat(10);          // ~37KB
    const run = (s: string, n: number) => {
      mod.renderMarkdown(s); mod.renderMarkdown(s); // warmup
      const t0 = performance.now();
      for (let i = 0; i < n; i++) mod.renderMarkdown(s);
      return (performance.now() - t0) / n;
    };
    return {
      typicalBytes: typical.length, typicalMs: run(typical, 200),
      bigBytes: big.length, bigMs: run(big, 20),
    };
  });
  console.log(`  典型 guide ~${(res.typicalBytes / 1024).toFixed(1)}KB: ${res.typicalMs.toFixed(2)} ms/parse`);
  console.log(`  压力文档 ~${(res.bigBytes / 1024).toFixed(1)}KB: ${res.bigMs.toFixed(2)} ms/parse`);
});

/* ============================================================
 * 构建产物体积（独立脚本 scripts/bench-bundle.mjs 负责，此处不测）
 * ============================================================ */
