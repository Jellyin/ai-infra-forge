/**
 * 学习科学核心逻辑 · 纯函数（不碰 DOM，可 node 单测）
 * 移植自已验证的 ai-infra-maas-trainer/js/logic.js，补全 TS 类型。
 */

export const DAY_MS = 86400000;

/* ---------------- 1. SM-2 间隔重复 ---------------- */

export type Grade = "again" | "hard" | "good";

export interface CardState {
  reps: number;      // 连续答对次数
  interval: number;  // 当前间隔（天）
  ease: number;      // 难度因子，初始 2.5，最低 1.3
  due: number;       // 下次到期时间戳(ms)
}

export const newCardState = (): CardState => ({ reps: 0, interval: 0, ease: 2.5, due: 0 });

/** SM-2 评分推进，返回新状态。now 可注入以便测试。 */
export function sm2Next(state: Partial<CardState>, grade: Grade, now: number = Date.now()): CardState {
  const s: CardState = { ...newCardState(), ...state };
  let { reps, interval, ease } = s;

  if (grade === "again") {
    reps = 0;
    interval = 0; // 今天内立刻重学
    ease = Math.max(1.3, ease - 0.2);
  } else if (grade === "hard") {
    interval = reps === 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
    ease = Math.max(1.3, ease - 0.15);
  } else if (grade === "good") {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(interval * ease);
    ease = ease + 0.1;
  } else {
    throw new Error("unknown grade: " + grade);
  }

  const due = grade === "again" ? now : now + interval * DAY_MS;
  return { reps, interval, ease, due };
}

export type Mastery = "good" | "learning" | "new";

/** 掌握度分档。注意与 buildCardQueue 的 fresh 判定对齐：
 *  again 过的卡 reps=0 但 due≠0，是「学习中」不是「未开始」（lapse ≠ never started） */
export function cardMastery(state?: Partial<CardState> | null): Mastery {
  if (!state) return "new";
  if (state.reps === 0 && state.interval === 0 && state.due === 0) return "new";
  if ((state.reps ?? 0) >= 2 && (state.ease ?? 0) >= 2.5) return "good";
  return "learning";
}

export interface CardQueue {
  due: number[];         // 到期索引（按 due 升序）
  fresh: number[];       // 新卡索引（受每日上限约束）
  waiting: number[];     // 未到期索引
  order: number[];       // 出卡顺序：due → fresh(限额内)
  cappedFresh: number[]; // 因今日限额被推迟的新卡
}

export interface QueueOptions {
  /** 每日新卡上限（Anki 式日节奏；默认 5，Infinity 不限制） */
  dailyNewLimit?: number;
}

/** 出卡队列：先到期(按 due 升序) → 新卡（受每日上限） */
export function buildCardQueue(
  states: Array<Partial<CardState> | undefined>,
  now: number = Date.now(),
  opts: QueueOptions = {},
): CardQueue {
  const limit = opts.dailyNewLimit ?? 5;
  const due: number[] = [], freshAll: number[] = [], waiting: number[] = [];
  states.forEach((st, i) => {
    const s: CardState = { ...newCardState(), ...st };
    // 新卡 = 从未有过任何复习痕迹；否则只要 due<=now（含 due=now 的 same-day 重学）就算到期
    const isFresh = s.reps === 0 && s.interval === 0 && s.due === 0;
    if (isFresh) freshAll.push(i);
    else if (s.due <= now) due.push(i);
    else waiting.push(i);
  });
  const dueOf = (i: number): number => states[i]?.due ?? 0;
  due.sort((a, b) => dueOf(a) - dueOf(b));
  const fresh = limit === Infinity ? freshAll : freshAll.slice(0, limit);
  const cappedFresh = limit === Infinity ? [] : freshAll.slice(limit);
  return { due, fresh, waiting, order: [...due, ...fresh], cappedFresh };
}

/* ---------------- 2. 命令逐字符比对 ---------------- */

export type CharState = "correct" | "wrong" | "pending";

export interface CommandScore {
  states: CharState[];
  accuracy: number;   // 已输入正确率
  complete: boolean;  // 完全一致（含空格）
  typedCount: number;
}

export function scoreCommand(target: string, typed: string): CommandScore {
  const states: CharState[] = [];
  let correct = 0;
  for (let i = 0; i < target.length; i++) {
    if (i >= typed.length) states.push("pending");
    else if (typed[i] === target[i]) { states.push("correct"); correct++; }
    else states.push("wrong");
  }
  const typedCount = Math.min(typed.length, target.length);
  return {
    states,
    accuracy: target.length ? correct / target.length : 0,
    complete: typed === target,
    typedCount,
  };
}

/* ---------------- 3. 进度聚合 & 连续学习 ---------------- */

/** 各模块完成度（0~1）加权平均 → 总进度 0~1 */
export function computeOverallProgress(parts: Record<string, number>, weights?: Record<string, number>): number {
  const keys = Object.keys(parts);
  if (!keys.length) return 0;
  let sum = 0, wsum = 0;
  for (const k of keys) {
    const w = weights?.[k] ?? 1;
    sum += (parts[k] || 0) * w;
    wsum += w;
  }
  return wsum ? sum / wsum : 0;
}

/** YYYY-MM-DD 本地日期串 */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type ActivityMap = Record<string, number>;

export function isStreakDay(activity: ActivityMap | undefined, dateStr: string): boolean {
  return !!(activity && (activity[dateStr] ?? 0) > 0);
}

/** 从 fromDate 往前连续 activity>0 的天数 */
export function computeStreak(activity: ActivityMap | undefined, fromDate: Date = new Date()): number {
  let streak = 0;
  const d = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  for (;;) {
    const key = dateKey(d);
    if (activity && (activity[key] ?? 0) > 0) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

/* ---------------- 4. 通关判定（多源，绝不用单一自评） ---------------- */

export interface CompletionInput {
  /** 面试题掌握数/总数 */
  quizKnown: number; quizTotal: number;
  /** 闪卡掌握（good 档）数/总数 */
  cardsGood: number; cardsTotal: number;
  /** 命令完成数/总数 */
  commandsDone: number; commandsTotal: number;
  /** 清单勾选数/总数 */
  checklistDone: number; checklistTotal: number;
}

export interface CompletionPart {
  key: "quiz" | "cards" | "commands" | "checklist";
  ratio: number;   // 0~1
  ok: boolean;
  label: string;
}

export interface CompletionResult {
  passed: boolean;
  score: number;              // 0~100 综合分
  parts: CompletionPart[];
}

/** 通关门槛：四路全部 ≥ 阈值（任一不达标即未通关）。
 *  刻意苛刻：这是「可证明的掌握」，不是参与奖。
 *  内容缺失的维度（total=0，如路径无命令数据）视为不构成门槛——
 *  否则该维度永久 ✗，多路径内容永远无法通关。 */
export function evaluateCompletion(input: CompletionInput): CompletionResult {
  // 三套语义：门（ok）在「有数据的维度」按阈值判定、缺失维度不挡；分数缺失计 0。
  // 全维度缺失（用户什么都没学）→ 不通关（必须有学习证据才可能毕业）。
  const part = (
    key: CompletionPart["key"], a: number, b: number, threshold: number, label: string,
  ): CompletionPart => ({
    key, ratio: b > 0 ? a / b : 0, ok: b === 0 ? true : a / b >= threshold, label,
  });
  const parts: CompletionPart[] = [
    part("quiz", input.quizKnown, input.quizTotal, 0.8, "面试掌握 ≥ 80%"),
    part("cards", input.cardsGood, input.cardsTotal, 0.6, "闪卡掌握 ≥ 60%"),
    part("commands", input.commandsDone, input.commandsTotal, 0.6, "命令完成 ≥ 60%"),
    part("checklist", input.checklistDone, input.checklistTotal, 0.8, "清单勾选 ≥ 80%"),
  ];
  const hasAnyData = input.quizTotal > 0 || input.cardsTotal > 0
    || input.commandsTotal > 0 || input.checklistTotal > 0;
  const total = Math.round(
    (parts[0]!.ratio * 0.3 + parts[1]!.ratio * 0.35 + parts[2]!.ratio * 0.2 + parts[3]!.ratio * 0.15) * 100,
  );
  return { passed: hasAnyData && parts.every((p) => p.ok), score: total, parts };
}

const Logic = {
  DAY_MS, newCardState, sm2Next, cardMastery, buildCardQueue,
  scoreCommand, computeOverallProgress, isStreakDay, computeStreak, dateKey,
  evaluateCompletion,
};
export default Logic;
