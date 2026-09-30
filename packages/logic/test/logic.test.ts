import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newCardState, sm2Next, cardMastery, buildCardQueue,
  scoreCommand, computeOverallProgress, isStreakDay, computeStreak, dateKey,
} from "../src/index.ts";

/* ---------- SM-2 ---------- */
test("SM2: good 评分按 1/6/*ease 推进", () => {
  let s = newCardState();
  s = sm2Next(s, "good", 0);
  assert.equal(s.reps, 1); assert.equal(s.interval, 1);
  s = sm2Next(s, "good", 0);
  assert.equal(s.reps, 2); assert.equal(s.interval, 6);
  const iv = s.interval, ease = s.ease;
  s = sm2Next(s, "good", 0);
  assert.equal(s.interval, Math.round(iv * ease));
});

test("SM2: again 重置 reps、ease 降到下限 1.3", () => {
  let s = sm2Next(newCardState(), "good", 0);
  s = sm2Next(s, "again", 1000);
  assert.equal(s.reps, 0);
  assert.equal(s.interval, 0);
  assert.equal(s.due, 1000);
  for (let i = 0; i < 10; i++) s = sm2Next(s, "again", 0);
  assert.equal(s.ease, 1.3);
});

test("SM2: hard 不增 reps 且 ease 微降", () => {
  let s = sm2Next(newCardState(), "good", 0);
  const reps = s.reps;
  const s2 = sm2Next(s, "hard", 0);
  assert.equal(s2.reps, reps);
  assert.ok(s2.ease < s.ease);
  assert.equal(s2.interval, Math.max(1, Math.round(s.interval * 1.2)));
});

test("Mastery: reps>=2 且 ease>=2.5 才算掌握", () => {
  let s = newCardState();
  assert.equal(cardMastery(s), "new");
  s = sm2Next(s, "good", 0);
  assert.equal(cardMastery(s), "learning");
  s = sm2Next(s, "good", 0);
  assert.equal(cardMastery(s), "good");
});

test("Mastery: again 过的卡是 learning 不是 new（lapse ≠ never started）", () => {
  let s = sm2Next(newCardState(), "good", 1000);
  const lapsed = sm2Next(s, "again", 2000);  // reps=0, interval=0, due=2000
  assert.equal(cardMastery(lapsed), "learning");
});

test("Queue: 到期卡优先(升序) → 新卡", () => {
  const states = [
    { ...newCardState(), reps: 2, interval: 6, due: 50 },
    newCardState(),
    { ...newCardState(), reps: 3, interval: 10, due: 30 },
    { ...newCardState(), reps: 5, interval: 20, due: 9999 },
  ];
  const q = buildCardQueue(states, 100, { dailyNewLimit: Infinity });
  assert.deepEqual(q.due, [2, 0]);
  assert.deepEqual(q.fresh, [1]);
  assert.deepEqual(q.order, [2, 0, 1]);
});

test("Queue: 每日新卡上限默认 5，超出进 cappedFresh", () => {
  const states = Array.from({ length: 8 }, () => newCardState()); // 8 张全新卡
  const q = buildCardQueue(states, 100);
  assert.deepEqual(q.fresh, [0, 1, 2, 3, 4]);
  assert.deepEqual(q.cappedFresh, [5, 6, 7]);
  assert.equal(q.order.length, 5);

  const qAll = buildCardQueue(states, 100, { dailyNewLimit: Infinity });
  assert.equal(qAll.fresh.length, 8);
});

test("Queue: again 当天重学(due=now) 应进到期队列，不再算新卡", () => {
  const s = sm2Next(newCardState(), "good", 1000);   // 学过一次
  const again = sm2Next(s, "again", 2000);            // 然后忘了 → due=2000
  const q = buildCardQueue([again], 2000, { dailyNewLimit: Infinity });
  assert.deepEqual(q.due, [0]);
  assert.deepEqual(q.fresh, []);
  // 已开始学但未到期的卡不算新卡
  const future = sm2Next(newCardState(), "good", 0); // due = now+1day
  const q2 = buildCardQueue([future], 0, { dailyNewLimit: Infinity });
  assert.deepEqual(q2.fresh, []);
  assert.deepEqual(q2.waiting, [0]);
});

/* ---------- 命令比对 ---------- */
test("scoreCommand: 逐字符状态与完成判定", () => {
  const r = scoreCommand("ab cd", "ab xd");
  // a✓ b✓ 空格✓ x✗(target是空格) d✓(target是d)
  assert.deepEqual(r.states, ["correct", "correct", "correct", "wrong", "correct"]);
  assert.equal(r.complete, false);
  assert.ok(scoreCommand("ls -l", "ls -l").complete);
  assert.equal(scoreCommand("ls -l", "ls -l ").complete, false);
  assert.deepEqual(scoreCommand("abc", "ab").states, ["correct", "correct", "pending"]);
});

/* ---------- 进度 & streak ---------- */
test("computeOverallProgress: 加权平均", () => {
  assert.equal(computeOverallProgress({ a: 1, b: 0.5 }), 0.75);
  assert.equal(computeOverallProgress({ a: 1, b: 0 }, { a: 1, b: 3 }), 0.25);
  assert.equal(computeOverallProgress({}), 0);
});

test("computeStreak: 连续天数", () => {
  const today = new Date(2026, 8, 30);
  const act: Record<string, number> = {};
  act[dateKey(new Date(2026, 8, 30))] = 2;
  act[dateKey(new Date(2026, 8, 29))] = 1;
  act[dateKey(new Date(2026, 8, 28))] = 5;
  act[dateKey(new Date(2026, 8, 25))] = 1;
  assert.equal(computeStreak(act, today), 3);
  assert.equal(isStreakDay(act, dateKey(new Date(2026, 8, 29))), true);
  assert.equal(isStreakDay(act, "2026-09-27"), false);
});
