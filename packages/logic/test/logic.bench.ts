/**
 * @aiforge/logic 微基准（手写计时循环；node --experimental-strip-types 跑 TS 源码）
 * 跑法：cd packages/logic && node --experimental-strip-types test/logic.bench.ts
 *
 * 方法论：每个指标先 warmup（触发 JIT 稳定），再 N 轮采样，报告中位数 + p95。
 *   用中位数而非均值：抗离群值（GC pause / 系统抖动）。
 *   单次耗时 < 计时器分辨率时用「外层循环批量」：报每 op 均值并注明批处理。
 *
 * 测什么：
 *  - buildCardQueue：100 / 1_000 / 10_000 张卡（多路径内容扩展性）
 *  - sm2Next：单次耗时，外推 × 100,000 次的累计成本（单用户长期使用）
 *  - scoreCommand：50 / 200 / 1000 字符命令
 */
import {
  sm2Next, buildCardQueue, scoreCommand,
  type CardState,
} from "../src/index.ts";

/* ---------- 计时工具 ---------- */

const LOOPS = 200; // 采样轮数（每轮内部批量调用）

/** f(batch) 执行 batch 次 op；返回每轮 ms 数组 */
function sample(batch: number, f: (n: number) => void, loops = LOOPS): number[] {
  // warmup：两轮全速跑，等 JIT 优化到位
  f(batch); f(batch);
  const out: number[] = [];
  for (let i = 0; i < loops; i++) out.push(timeIt(batch, f));
  return out;
}

function timeIt(batch: number, f: (n: number) => void): number {
  const t0 = performance.now();
  f(batch);
  return performance.now() - t0;
}

function stats(times: number[], batch: number) {
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  return {
    perOpUs: (median / batch) * 1000,            // 微秒/op（中位数）
    perOpUsP95: (p95 / batch) * 1000,
    totalBatchMs: median,
  };
}

function report(name: string, batch: number, times: number[]) {
  const s = stats(times, batch);
  const perOp = s.perOpUs < 1000 ? `${s.perOpUs.toFixed(2)} µs/op` : `${(s.perOpUs / 1000).toFixed(2)} ms/op`;
  console.log(
    `  ${name.padEnd(34)} 中位 ${perOp.padEnd(14)} p95 ${s.perOpUsP95 < 1000 ? s.perOpUsP95.toFixed(2) + " µs" : (s.perOpUsP95 / 1000).toFixed(2) + " ms"}`,
  );
  return s;
}

/* ---------- 测试数据 ---------- */

const now = 1_700_000_000_000;

/** 1/3 新卡、1/3 到期、1/3 未到期，due 随机分散 → 最接近真实分布 */
function makeStates(n: number): Array<Partial<CardState> | undefined> {
  const states: Array<Partial<CardState> | undefined> = [];
  for (let i = 0; i < n; i++) {
    const r = i % 3;
    if (r === 0) states.push(undefined); // 新卡
    else if (r === 1) states.push({ reps: 3, interval: 6, ease: 2.5, due: now - Math.random() * 86400000 * 7 });
    else states.push({ reps: 3, interval: 30, ease: 2.5, due: now + Math.random() * 86400000 * 30 });
  }
  return states;
}

const states100 = makeStates(100);
const states1k = makeStates(1_000);
const states10k = makeStates(10_000);
const opts = { dailyNewLimit: 5 };

const midState: CardState = { reps: 5, interval: 20, ease: 2.4, due: now };

const base = "docker run --rm --gpus all -e MODEL=llama3-70b -p 8000:8000 vllm/vllm-openai --tensor-parallel-size 2 --max-model-len 32768 ";
const cmd50 = base.slice(0, 50);
const cmd200 = base.repeat(2).slice(0, 200);
const cmd1000 = base.repeat(10).slice(0, 1000);

/* ---------- 1. buildCardQueue ---------- */

console.log("\n[1] buildCardQueue（内容规模扩展性）");
const q100 = report("100 卡", 1_000, sample(1_000, (n) => {
  for (let i = 0; i < n; i++) buildCardQueue(states100, now, opts);
}));
const q1k = report("1_000 卡", 200, sample(200, (n) => {
  for (let i = 0; i < n; i++) buildCardQueue(states1k, now, opts);
}));
const q10k = report("10_000 卡", 50, sample(50, (n) => {
  for (let i = 0; i < n; i++) buildCardQueue(states10k, now, opts);
}));
// 校验线性外推与实测的偏差（说明复杂度是否超线性）
console.log(`  → 1k→10k 线性外推预期 ~${(q1k.perOpUs * 10).toFixed(2)} µs，实测 ${q10k.perOpUs.toFixed(2)} µs`);

/* ---------- 2. sm2Next ---------- */

console.log("\n[2] sm2Next（单次调度成本）");
const sGood = report("grade=good", 100_000, sample(100_000, (n) => {
  for (let i = 0; i < n; i++) sm2Next(midState, "good", now);
}));
report("grade=again", 100_000, sample(100_000, (n) => {
  for (let i = 0; i < n; i++) sm2Next(midState, "again", now);
}));
report("grade=hard", 100_000, sample(100_000, (n) => {
  for (let i = 0; i < n; i++) sm2Next(midState, "hard", now);
}));
console.log(`  → 单用户 10 万次评分累计 = ${(sGood.perOpUs * 100_000 / 1000).toFixed(1)} ms（纯 CPU 累计）`);

/* ---------- 3. scoreCommand ---------- */

console.log("\n[3] scoreCommand（命令长度扩展性）");
const c50 = report("50 字符 · 输入 90%", 100_000, sample(100_000, (n) => {
  for (let i = 0; i < n; i++) scoreCommand(cmd50, cmd50.slice(0, 45));
}));
const c200 = report("200 字符 · 输入 90%", 20_000, sample(20_000, (n) => {
  for (let i = 0; i < n; i++) scoreCommand(cmd200, cmd200.slice(0, 180));
}));
const c1000 = report("1000 字符 · 输入 90%", 10_000, sample(10_000, (n) => {
  for (let i = 0; i < n; i++) scoreCommand(cmd1000, cmd1000.slice(0, 900));
}));
console.log(`  → 50→1000 字符耗时比 ${((c1000.perOpUs / c50.perOpUs)).toFixed(1)}x（字符数 20x）`);

/* ---------- 输出 JSON（供 CI 记录/对比） ---------- */
const results = {
  meta: { node: process.version, date: new Date().toISOString(), loops: LOOPS },
  buildCardQueue: {
    n100: q100, n1000: q1k, n10000: q10k,
  },
  sm2Next: sGood,
  scoreCommand: { c50, c200, c1000 },
};
if (process.env.BENCH_JSON) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.BENCH_JSON, JSON.stringify(results, null, 2));
  console.log(`\nJSON 结果已写入 ${process.env.BENCH_JSON}`);
}
