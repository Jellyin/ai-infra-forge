/**
 * 补全测试：钉住实现里「有分支/边界但旧测试没覆盖」的行为。
 * 每条对应盲区审计中的一个高优先级项（含历史 bug 防回归）。
 *
 * 覆盖清单：
 * - sm2Next: ease 无上限增长 / 脏 NaN / 负 interval / reps 回退 / again 从 bad state / due 边界
 * - buildCardQueue: due=0 边界 / limit=0 / 负数 / Infinity / 乱序 due 升序 / 稀疏 undefined
 * - scoreCommand: 空串 / typed 长于 target / 超长输入 / 中文多字节
 * - computeStreak: 昨天最后一天 / 跨月 / 零长月 / today 未活动 / activity=0
 * - dateKey: 本地时区 pad
 * - computeOverallProgress: 负权重 / NaN / 空权重表
 * - evaluateCompletion: 恰好在阈值 / 超出 100% / 缺失维度计 0 分 / hasAnyData 语义
 * - cardMastery: undefined / 部分字段 / 脏数据
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAY_MS, newCardState, sm2Next, cardMastery, buildCardQueue,
  scoreCommand, computeOverallProgress, isStreakDay, computeStreak, dateKey,
  evaluateCompletion,
} from "../src/index.ts";

const T0 = 1_000_000_000_000; // 固定时间基准，2001-09-09T01:46:40Z

/* ================= sm2Next 边界 ================= */

test("SM2 边界: good 链条 50 次 ease 无上限增长（interval 爆炸至 >1 天 * 数千倍）", () => {
  let s = newCardState();
  for (let i = 0; i < 50; i++) s = sm2Next(s, "good", T0);
  assert.ok(s.ease > 2.5 + 5 * 0.1, `ease=${s.ease} 应超过 5 次 good 后的加成上限`);
  assert.ok(s.interval > 1000, `interval=${s.interval} 复利后应爆表`);
  assert.ok(s.due === T0 + s.interval * DAY_MS);
});

test("SM2 边界: again 从 reps=5 的成熟态回退，reps 归 0，due=now", () => {
  let s = newCardState();
  for (let i = 0; i < 5; i++) s = sm2Next(s, "good", T0);
  const lapsed = sm2Next(s, "again", T0 + 12345);
  assert.equal(lapsed.reps, 0);
  assert.equal(lapsed.interval, 0);
  assert.equal(lapsed.due, T0 + 12345);
  assert.ok(lapsed.ease < s.ease);
  assert.ok(lapsed.ease >= 1.3);
});

test("SM2 边界: hard 首评 reps=0 → interval=1（不被 interval*1.2=0 卡死）", () => {
  const s = sm2Next(newCardState(), "hard", T0);
  assert.equal(s.interval, 1);
  assert.equal(s.reps, 0);
  assert.equal(s.due, T0 + DAY_MS);
});

test("SM2 边界: good 链条的 ease 无上限（15 次后 ≈4.0）——钉住当前语义，防止静默变更", () => {
  let s = newCardState();
  for (let i = 0; i < 15; i++) s = sm2Next(s, "good", T0);
  // 15 次 good：ease ≈ 2.5 + 15*0.1 = 4.0（浮点累加有 ε，用近似比较）
  assert.ok(Math.abs(s.ease - 4.0) < 1e-9, `ease=${s.ease}`);
});

test("已知缺陷钉子: NaN ease 会把 due 腐坏成 NaN（不崩但静默劣化）", () => {
  // 历史缺陷（未修）：importData 对脏 cards 数据不校验。ease=NaN 时
  // sm2Next 不抛错，但 interval*NaN → due=NaN——而 NaN <= now 恒为 false，
  // 卡从此永远冻结在 buildCardQueue 的 waiting 分支（不再出现，也不算到期）。
  // 本测试钉住当前行为作为回归 tripwire：若未来加 Number(ease) 归一化
  // 或导入校验，需同步更新预期。
  const dirty = { ...newCardState(), reps: 3, interval: 10, ease: Number.NaN, due: 100 };
  const out = sm2Next(dirty, "good", T0);
  assert.ok(Number.isNaN(out.due), "NaN ease 经 good 后 due=NaN（当前行为）");
  // 佐证下游后果：NaN due 的卡既不到期（NaN<=now 为 false）也不算新卡 → 冻结在 waiting
  const q = buildCardQueue([out], T0, { dailyNewLimit: Infinity });
  assert.deepEqual(q.due, []);
  assert.deepEqual(q.fresh, []);
  assert.deepEqual(q.waiting, [0]);
});

test("SM2 脏数据: ease 为字符串 '2.5' 也能推进（导入的历史导出文件被手改）", () => {
  const dirty = { ...newCardState(), reps: 3, interval: 10, ease: "2.5" as unknown as number, due: 100 };
  const out = sm2Next(dirty, "good", T0);
  // interval = round(10 * '2.5') = round(25) = 25 —— JS 强转字符串乘法
  assert.ok(Number.isFinite(out.interval) && out.interval >= 1);
  assert.ok(Number.isFinite(out.due));
});

test("SM2 脏数据: interval 为负数，good/hard 后不产出负 due / NaN", () => {
  const dirty = { ...newCardState(), reps: 3, interval: -5, ease: 2.5, due: 100 };
  const good = sm2Next(dirty, "good", T0);
  assert.ok(Number.isFinite(good.interval));
  assert.equal(good.due, T0 + good.interval * DAY_MS);
  const hard = sm2Next(dirty, "hard", T0);
  assert.equal(hard.interval, Math.max(1, Math.round(-5 * 1.2)));
  assert.ok(hard.due > T0);
});

test("SM2 边界: 非法 grade 抛错（ts 之外的世界：JS 调用方传了奇怪字符串）", () => {
  assert.throws(() => sm2Next(newCardState(), "perfect" as never, T0), /unknown grade/);
});

test("SM2 边界: reps=1 的 good → interval=6（不是 1*ease）", () => {
  let s = sm2Next(newCardState(), "good", T0); // reps=1, interval=1
  s = sm2Next(s, "good", T0);
  assert.equal(s.reps, 2);
  assert.equal(s.interval, 6);
});

/* ================= buildCardQueue 边界 ================= */

test("Queue 边界: due=0 的卡（脏数据/时间纪元）算到期，不算新卡", () => {
  const states = [{ ...newCardState(), reps: 1, interval: 1, ease: 2.5, due: 0 }];
  const q = buildCardQueue(states, T0, { dailyNewLimit: Infinity });
  assert.deepEqual(q.due, [0]);
  assert.deepEqual(q.fresh, []);
  assert.deepEqual(q.waiting, []);
});

test("Queue 边界: limit=0 → fresh 全空、cappedFresh 全量（今日额度用尽的真实语义）", () => {
  const states = [newCardState(), newCardState()];
  const q = buildCardQueue(states, T0, { dailyNewLimit: 0 });
  assert.deepEqual(q.fresh, []);
  assert.deepEqual(q.cappedFresh, [0, 1]);
  assert.deepEqual(q.order, []);
});

test("Queue 边界: 负数 limit 当作 0 处理（不抛错、不产出负 slice）", () => {
  const states = [newCardState(), newCardState()];
  const q = buildCardQueue(states, T0, { dailyNewLimit: -3 });
  assert.deepEqual(q.fresh, []);
  assert.deepEqual(q.order, []);
});

test("Queue 边界: limit=1 只放一张，其余推迟（粒度=单卡）", () => {
  const states = [newCardState(), newCardState(), newCardState()];
  const q = buildCardQueue(states, T0, { dailyNewLimit: 1 });
  assert.deepEqual(q.fresh, [0]);
  assert.deepEqual(q.cappedFresh, [1, 2]);
});

test("Queue 边界: Infinity 不封顶、cappedFresh 恒空（对照分支）", () => {
  const states = [newCardState(), newCardState()];
  const q = buildCardQueue(states, T0, { dailyNewLimit: Infinity });
  assert.deepEqual(q.fresh, [0, 1]);
  assert.deepEqual(q.cappedFresh, []);
});

test("Queue 边界: due 值乱序时仍按 due 升序出卡（复习优先级）", () => {
  const mk = (due: number) => ({ ...newCardState(), reps: 2, interval: 6, ease: 2.5, due });
  const q = buildCardQueue([mk(500), mk(100), mk(300), mk(200)], T0, { dailyNewLimit: 0 });
  assert.deepEqual(q.due, [1, 3, 2, 0]);
});

test("Queue 边界: 稀疏数组里的 undefined/空对象都算新卡（默认填充语义）", () => {
  // states 数组有洞：React 里 flat.map(c => cards[c.key]) 会产出 undefined
  const q = buildCardQueue([undefined, {} as Partial<CardStateLike>, newCardState()], T0, { dailyNewLimit: Infinity });
  assert.deepEqual(q.fresh, [0, 1, 2]);
});

type CardStateLike = { reps: number; interval: number; ease: number; due: number };

test("Queue 边界: 空 states → 全空结果（空内容路径）", () => {
  const q = buildCardQueue([], T0);
  assert.deepEqual(q, { due: [], fresh: [], waiting: [], order: [], cappedFresh: [] });
});

/* ================= scoreCommand 边界 ================= */

test("scoreCommand 边界: 空 target 与空 typed", () => {
  const r = scoreCommand("", "");
  assert.deepEqual(r.states, []);
  assert.equal(r.accuracy, 0);
  assert.equal(r.complete, true);
  assert.equal(r.typedCount, 0);
});

test("scoreCommand 边界: typed 比 target 长 → complete=false、typedCount 钳到 target 长度", () => {
  const r = scoreCommand("abc", "abcX");
  assert.equal(r.complete, false);
  assert.equal(r.typedCount, 3);
  assert.deepEqual(r.states, ["correct", "correct", "correct"]);
  // 前缀完全一致但多敲了一个空格 → 仍不 complete（尾随空格防作弊）
  assert.equal(scoreCommand("ls -l", "ls -l ").complete, false);
  // 已有测试钉的是「完全一致」，这里钉「前缀一致≠完成」
  assert.ok(scoreCommand("ab", "ab").complete);
});

test("scoreCommand 边界: 全错的 typed → accuracy=0 且不抛", () => {
  const r = scoreCommand("abc", "zzz");
  assert.equal(r.accuracy, 0);
  assert.deepEqual(r.states, ["wrong", "wrong", "wrong"]);
  assert.equal(r.complete, false);
});

test("scoreCommand 性能: 2000 字符命令在 50ms 内完成（超大命令不炸）", () => {
  const long = "a".repeat(2000);
  const t = performance.now();
  const r = scoreCommand(long, long);
  const dt = performance.now() - t;
  assert.equal(r.complete, true);
  assert.equal(r.states.length, 2000);
  assert.ok(dt < 50, `耗时 ${dt.toFixed(1)}ms`);
});

test("scoreCommand 边界: 中文/多字节字符按码点逐位比对（不是按字节）", () => {
  // typed「显示模 型」= 显/示/模/空格/型（5 字符）vs target 6 字符
  const r = scoreCommand("显示模型列表", "显示模 型");
  assert.deepEqual(r.states, ["correct", "correct", "correct", "wrong", "wrong", "pending"]);
  assert.equal(r.accuracy, 0.5);
});

test("scoreCommand 边界: target 含特殊正则字符与换行，逐字符比对仍准确", () => {
  const target = "jq '.items[0].*?' | wc -l";
  const r = scoreCommand(target, target);
  assert.equal(r.complete, true);
  const r2 = scoreCommand(target, target.replace("wc", "xx"));
  assert.equal(r2.complete, false);
  assert.equal(r2.states.filter((s) => s === "wrong").length, 2);
});

/* ================= streak / dateKey 边界 ================= */

test("computeStreak 边界: 今天没学但昨天是最后一天 → streak=0（断签真实语义）", () => {
  const today = new Date(2026, 8, 30);
  const act: Record<string, number> = {
    "2026-09-28": 1, "2026-09-29": 2, // 截止昨天
  };
  assert.equal(computeStreak(act, today), 0);
});

test("computeStreak 边界: 今天有学 → 包含今天计数（跨午夜刷题回看）", () => {
  const today = new Date(2026, 8, 30);
  const act: Record<string, number> = { "2026-09-30": 3, "2026-09-29": 1 };
  assert.equal(computeStreak(act, today), 2);
});

test("computeStreak 边界: 跨月连续（9-30 → 10-01 → 10-02）", () => {
  const today = new Date(2026, 9, 2);
  const act: Record<string, number> = { "2026-10-02": 1, "2026-10-01": 1, "2026-09-30": 1 };
  assert.equal(computeStreak(act, today), 3);
});

test("computeStreak 边界: 跨年连续（2026-12-31 → 2027-01-01）", () => {
  const today = new Date(2027, 0, 1);
  const act: Record<string, number> = { "2027-01-01": 1, "2026-12-31": 1 };
  assert.equal(computeStreak(act, today), 2);
});

test("computeStreak 边界: activity 值为 0 的天不算学习（记了但没动作）", () => {
  const today = new Date(2026, 8, 30);
  const act: Record<string, number> = { "2026-09-30": 0, "2026-09-29": 1 };
  assert.equal(computeStreak(act, today), 0);
  assert.equal(isStreakDay(act, "2026-09-30"), false);
});

test("computeStreak 边界: 无 activity / undefined 输入 → 0 不抛", () => {
  assert.equal(computeStreak(undefined, new Date(2026, 8, 30)), 0);
  assert.equal(computeStreak({}, new Date(2026, 8, 30)), 0);
});

test("dateKey 边界: 本地日期补零（与 UTC 日期键的一致性基础）", () => {
  assert.equal(dateKey(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(dateKey(new Date(2026, 10, 20)), "2026-11-20");
  // 23:59 本地 → 仍是当天键（本地时区语义，防 UTC/本地漂移回归）
  const lateNight = new Date(2026, 8, 30, 23, 59, 59);
  assert.equal(dateKey(lateNight), "2026-09-30");
});

/* ================= computeOverallProgress 边界 ================= */

test("computeOverallProgress 边界: 值超 1 / 负值 / 空权重 / NaN 被静默吞 0", () => {
  assert.equal(computeOverallProgress({ a: 2 }), 2);        // 超 1 不钳制——钉住当前语义
  assert.equal(computeOverallProgress({ a: -1 }), -1);       // 负值不钳制
  const allZeroW = computeOverallProgress({ a: 1 }, { a: 0 });
  assert.equal(allZeroW, 0);                                 // wsum=0 兜底分支
  // NaN 是 falsy：parts[k] || 0 把 NaN 静默转成 0（当前行为，钉住——
  // 这意味着脏进度数据在聚合层被吞掉而不是暴露）
  assert.equal(computeOverallProgress({ a: Number.NaN }), 0);
});

/* ================= evaluateCompletion 边界 ================= */

test("evaluateCompletion 边界: 恰好等于阈值算达标（边界含等号）", () => {
  const r = evaluateCompletion({
    quizKnown: 8, quizTotal: 10,         // 恰好 80%
    cardsGood: 6, cardsTotal: 10,        // 恰好 60%
    commandsDone: 6, commandsTotal: 10,  // 恰好 60%
    checklistDone: 8, checklistTotal: 10, // 恰好 80%
  });
  assert.equal(r.passed, true);
});

test("evaluateCompletion 边界: just below 阈值（差一格）不达标", () => {
  const r = evaluateCompletion({
    quizKnown: 7, quizTotal: 9,          // 77.8% < 80%
    cardsGood: 6, cardsTotal: 10,
    commandsDone: 6, commandsTotal: 10,
    checklistDone: 8, checklistTotal: 10,
  });
  assert.equal(r.passed, false);
  assert.equal(r.parts.find((p) => p.key === "quiz")!.ok, false);
});

test("evaluateCompletion 边界: 分母 0 的维度 ratio=0 但 ok=true（不挡门也不送分）", () => {
  const r = evaluateCompletion({
    quizKnown: 9, quizTotal: 10, cardsGood: 0, cardsTotal: 0,
    commandsDone: 0, commandsTotal: 0, checklistDone: 0, checklistTotal: 0,
  });
  const cards = r.parts.find((p) => p.key === "cards")!;
  assert.equal(cards.ok, true);
  assert.equal(cards.ratio, 0);
  // 只有 quiz 一路：0.9 × 权重 0.3 → score = 27
  assert.equal(r.score, 27);
});

test("evaluateCompletion 边界: 分子超过分母（脏导入计数溢出）score 仍有限", () => {
  const r = evaluateCompletion({
    quizKnown: 15, quizTotal: 10,
    cardsGood: 39, cardsTotal: 39,
    commandsDone: 12, commandsTotal: 10,
    checklistDone: 50, checklistTotal: 41,
  });
  assert.ok(r.score > 100, `score=${r.score} 超 100% 也不崩`);
  assert.equal(r.passed, true);
});

test("evaluateCompletion 边界: 缺失维度计 0 分——仅 quiz 达标时 score 只有 30 分", () => {
  // 防白板毕业的反面：只有 30% 的掌握深度，即便 passed 也不该看起来接近满分
  const r = evaluateCompletion({
    quizKnown: 10, quizTotal: 10,
    cardsGood: 0, cardsTotal: 0, commandsDone: 0, commandsTotal: 0, checklistDone: 0, checklistTotal: 0,
  });
  assert.equal(r.passed, true);
  assert.equal(r.score, 30);
});

test("evaluateCompletion 边界: 负数分子 ratio 为负但不抛（脏数据防御）", () => {
  const r = evaluateCompletion({
    quizKnown: -1, quizTotal: 10, cardsGood: 0, cardsTotal: 0,
    commandsDone: 0, commandsTotal: 0, checklistDone: 0, checklistTotal: 0,
  });
  assert.ok(Number.isFinite(r.score));
  assert.equal(r.passed, false);
});

/* ================= cardMastery 脏数据 ================= */

test("cardMastery 边界: undefined / 部分字段 / 脏数据路径", () => {
  assert.equal(cardMastery(undefined), "new");
  assert.equal(cardMastery(null), "new");
  // 部分字段（导入文件缺字段）：reps 缺省 0 → 不满足 good 档 → learning（有 due 痕迹）
  assert.equal(cardMastery({ ease: 3, due: 123 }), "learning");
  // 只有 reps：reps>=2 但 ease 缺省 0 < 2.5 → learning
  assert.equal(cardMastery({ reps: 5 }), "learning");
  // good 档需要 reps>=2 且 ease>=2.5 同时成立
  assert.equal(cardMastery({ reps: 2, ease: 2.5, interval: 6, due: 1 }), "good");
  // reps=3、ease=2.5：恰好卡线仍 good
  assert.equal(cardMastery({ reps: 3, ease: 2.5 }), "good");
  // 脏：reps 是字符串 "3"（导入手改文件）→ 强转 3，与 ease 3.5 组成 good
  assert.equal(cardMastery({ reps: "3" as unknown as number, ease: 3.5, interval: 6, due: 1 }), "good");
});

/* ================= sm2Next + buildCardQueue 集成（脏数据端到端） ================= */

test("集成: 脏 cards 状态过整条流水线（sm2Next → buildCardQueue → cardMastery）不抛", () => {
  const dirtyStates = [
    { reps: 1, interval: 3, ease: 2.1, due: 50 },        // 正常学习中
    { reps: 2.7, interval: 6.3, ease: 2.5, due: 20 },    // 脏：小数 reps/interval
    { reps: 0, interval: 0, ease: 2.5, due: 0 },         // 纯新卡
  ] as Array<Partial<CardStateLike>>;
  const q = buildCardQueue(dirtyStates, T0, { dailyNewLimit: Infinity });
  // 卡 0/1 有学习痕迹 → 不算 fresh；卡 2 是 fresh
  assert.ok(!q.fresh.includes(0) && !q.fresh.includes(1));
  assert.deepEqual(q.fresh, [2]);
  // due 排序不抛
  const order = [...q.due];
  const dues = order.map((i) => dirtyStates[i]!.due ?? 0);
  for (let i = 1; i < dues.length; i++) assert.ok(dues[i - 1]! <= dues[i]!, "due 升序");
  // 每个脏状态都能被评分且产出有限值（JS 强转不炸）
  for (const st of dirtyStates) {
    for (const g of ["again", "hard", "good"] as const) {
      const next = sm2Next(st, g, T0);
      assert.ok(Number.isFinite(next.due), `grade=${g}`);
      assert.ok(Number.isFinite(next.interval), `grade=${g}`);
      assert.ok(Number.isFinite(next.ease), `grade=${g}`);
      assert.equal(typeof cardMastery(next), "string");
    }
  }
});

test("已知缺陷钉子: 字符串 ease 经 good 评分后劣化为 NaN（不崩但静默腐坏）", () => {
  // 历史缺陷（未修）：importData 对脏 cards 数据不校验，sm2Next 对 ease='2.5' 这类
  // JS 强转不崩但劣化，链条：
  //   1st good: interval = round(10 * '2.5') = 25（数值强转侥幸正确），
  //             但 ease + 0.1 对字符串是拼接 → '2.50.1'
  //   2nd good: interval = round(25 * '2.50.1') = NaN，due = NaN
  //             → 卡永久冻结在 buildCardQueue 的 waiting 分支
  // 本测试钉住当前行为作为回归 tripwire：若未来在 importData/sm2Next 加了
  // 数字归一化，本断言会失败提醒同步更新预期。
  const dirty = { ...newCardState(), reps: 3, interval: 10, ease: "2.5" as unknown as number, due: 100 };
  const out = sm2Next(dirty, "good", T0);
  assert.equal(out.interval, 25);
  assert.equal(out.ease, "2.50.1" as unknown as number);
  const out2 = sm2Next({ ...out, reps: 4 } as Partial<CardStateLike>, "good", T0);
  assert.ok(Number.isNaN(out2.interval), "第二次 good 后 interval=NaN");
  assert.ok(Number.isNaN(out2.due), "第二次 good 后 due=NaN");
  const q = buildCardQueue([out2], T0, { dailyNewLimit: Infinity });
  assert.deepEqual(q.waiting, [0]);   // NaN due → 永久 waiting，静默消失于复习流
});
