/**
 * 学习进度状态：localStorage 持久化 + activity/streak 记录。
 * 所有学习动作都经过 recordActivity 驱动 streak。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { dateKey, type ActivityMap } from "@aiforge/logic";

const PREFIX = "aiforge:";

/** 每日新卡上限（Anki 式日节奏，防首日洪水）。仪表盘与闪卡页必须共用同一常量，
 *  否则一处改动会让两屏的「今日额度」口径分叉。 */
export const DAILY_NEW_LIMIT = 5;

/* ---------- 数据形状校验（读取路径与导入路径共用同一套规则） ---------- */

interface CardStateLite { reps: number; interval: number; ease: number; due: number }

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isGrade = (v: unknown): v is "known" | "unknown" => v === "known" || v === "unknown";
const isCardState = (v: unknown): v is CardStateLite => {
  if (v === null || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return isFiniteNum(c.reps) && isFiniteNum(c.interval) && isFiniteNum(c.ease) && isFiniteNum(c.due);
};

/** 逐条目字段级清洗。必须查 typeof 而非 Number() 强转——字符串 "2.5" 能过 Number()
 *  但会让 sm2Next 的 ease+0.1 变成字符串拼接 "2.50.1"（→ NaN due → 卡永久冻结）。
 *  宁丢脏数据，不留病数据。 */
function sanitizeMap(raw: unknown, ok: (v: unknown) => boolean): { clean: Record<string, unknown>; skipped: number } {
  const clean: Record<string, unknown> = {};
  let skipped = 0;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { clean, skipped: 0 };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (ok(v)) clean[k] = v;
    else skipped++;
  }
  return { clean, skipped };
}

/** 每个 localStorage key 的条目校验器 */
const VALIDATORS: Record<string, (v: unknown) => boolean> = {
  checklist: isBool, cards: isCardState, commands: isFiniteNum,
  quiz: isGrade, activity: isFiniteNum, newCardsByDay: isFiniteNum,
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    /* 形状兜底：JSON 合法但形状错（null / 数组 / 标量）的值直接进 state，会让子组件
       属性访问时抛错 → 整棵树卸载成白屏，连「数据」自救入口都没了。这里退回默认值。 */
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[aiforge] ${key} 数据形状异常，已回退默认值`);
      return fallback;
    }
    /* 再逐条目清洗：旧版本写坏 / 手工编辑过的条目不再放进来继续腐坏 */
    const validator = VALIDATORS[key];
    if (!validator) return parsed as T;
    const { clean, skipped } = sanitizeMap(parsed, validator);
    if (skipped) console.warn(`[aiforge] ${key} 有 ${skipped} 条格式异常，已跳过`);
    return clean as T;
  } catch { return fallback; }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // localStorage 不可用（隐私模式/配额满）时静默降级：本次会话内进度仍有效
    console.warn("[aiforge] localStorage 不可用，进度不会持久化");
  }
}

/** 学习进度总状态 hook（闪卡/命令/清单/面试/活动 全在这） */
export function useProgress() {
  const [checklist, setChecklist] = useState<Record<string, boolean>>(() => read("checklist", {}));
  const [cards, setCards] = useState<Record<string, CardStateLite>>(() => read("cards", {}));
  const [commands, setCommands] = useState<Record<string, number>>(() => read("commands", {}));
  const [quiz, setQuiz] = useState<Record<string, "known" | "unknown">>(() => read("quiz", {}));
  const [activity, setActivity] = useState<ActivityMap>(() => read("activity", {}));
  /** 每日新卡引入计数（dateKey → 数量）：真·按天限额，防止一天刷完然后次日复习山 */
  const [newCardsByDay, setNewCardsByDay] = useState<Record<string, number>>(() => read("newCardsByDay", {}));

  useEffect(() => write("checklist", checklist), [checklist]);
  useEffect(() => write("cards", cards), [cards]);
  useEffect(() => write("commands", commands), [commands]);
  useEffect(() => write("quiz", quiz), [quiz]);
  useEffect(() => write("activity", activity), [activity]);
  useEffect(() => write("newCardsByDay", newCardsByDay), [newCardsByDay]);

  /* 跨标签页同步：两个标签页同时学习时，后写的一方会静默覆盖另一方（数据丢失）。
     监听 storage 事件把内存态同步为磁盘态——最后写仍然获胜，但至少另一个标签页
     不会带着已过期的内存快照继续覆盖。（storage 事件只在「其它」标签页触发，不回环。） */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith(PREFIX) || e.newValue == null) return;
      let v: unknown;
      try { v = JSON.parse(e.newValue); } catch { return; }
      if (v === null || typeof v !== "object" || Array.isArray(v)) return;
      switch (e.key.slice(PREFIX.length)) {
        case "checklist": setChecklist(v as Record<string, boolean>); break;
        case "cards": setCards(v as Record<string, CardStateLite>); break;
        case "commands": setCommands(v as Record<string, number>); break;
        case "quiz": setQuiz(v as Record<string, "known" | "unknown">); break;
        case "activity": setActivity(v as ActivityMap); break;
        case "newCardsByDay": setNewCardsByDay(v as Record<string, number>); break;
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const todayNewCardCount = newCardsByDay[dateKey(new Date())] ?? 0;

  const recordNewCard = useCallback(() => {
    setNewCardsByDay((prev) => {
      const k = dateKey(new Date());
      return { ...prev, [k]: (prev[k] || 0) + 1 };
    });
  }, []);

  /** 撤销一次新卡引入（当日额度回补，防幽灵消耗） */
  const undoNewCard = useCallback(() => {
    setNewCardsByDay((prev) => {
      const k = dateKey(new Date());
      const n = (prev[k] || 0) - 1;
      const next = { ...prev };
      if (n > 0) next[k] = n; else delete next[k];
      return next;
    });
  }, []);

  const recordActivity = useCallback(() => {
    setActivity((prev) => {
      const k = dateKey(new Date());
      return { ...prev, [k]: (prev[k] || 0) + 1 };
    });
  }, []);

  const toggleCheck = useCallback((key: string) => {
    setChecklist((prev) => ({ ...prev, [key]: !prev[key] }));
    recordActivity();
  }, [recordActivity]);

  const gradeCard = useCallback((key: string, next: CardStateLite) => {
    setCards((prev) => ({ ...prev, [key]: next }));
    recordActivity();
  }, [recordActivity]);

  const completeCommand = useCallback((key: string) => {
    setCommands((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
    recordActivity();
  }, [recordActivity]);

  const gradeQuiz = useCallback((key: string, g: "known" | "unknown") => {
    setQuiz((prev) => ({ ...prev, [key]: g }));
    recordActivity();
  }, [recordActivity]);

  /* ---------- 进度导出/导入（防丢失 + 换机 + 用户研究数据回收） ---------- */

  const exportData = useCallback((): string => {
    return JSON.stringify({
      schema: 1,                       // 版本字段：未来结构变更时迁移用
      exportedAt: new Date().toISOString(),
      checklist, cards, commands, quiz, activity, newCardsByDay,
    }, null, 2);
  }, [checklist, cards, commands, quiz, activity, newCardsByDay]);

  const importData = useCallback((json: string): { ok: boolean; message: string } => {
    try {
      const parsed = JSON.parse(json) as {
        schema?: number;
        checklist?: Record<string, boolean>;
        cards?: Record<string, CardStateLite>;
        commands?: Record<string, number>;
        quiz?: Record<string, "known" | "unknown">;
        activity?: Record<string, number>;
        newCardsByDay?: Record<string, number>;
      };
      if (typeof parsed !== "object" || parsed === null) return { ok: false, message: "不是有效的导出文件" };
      if (parsed.schema !== 1) return { ok: false, message: `未知的 schema 版本: ${String(parsed.schema)}` };
      /* 用「有效条目数」判断，而不是对象真值：{} 是 truthy，而真实导出里六个键恒存在，
         原判断等于永远放行「空进度文件」——恰恰是最该拦、且会静默清空全部进度的情况；
         反过来它又会误杀只含 quiz/activity 的文件。 */
      const entryCount = [parsed.checklist, parsed.cards, parsed.commands, parsed.quiz, parsed.activity, parsed.newCardsByDay]
        .reduce((n, m) => n + (m && typeof m === "object" ? Object.keys(m).length : 0), 0);
      if (!entryCount) return { ok: false, message: "文件里没有进度数据" };

      /* 字段级校验：复用与读取路径同一套规则（此前读取路径完全没有这层防护） */
      const cardsRes = sanitizeMap(parsed.cards, isCardState);
      const checksRes = sanitizeMap(parsed.checklist, isBool);
      const quizRes = sanitizeMap(parsed.quiz, isGrade);
      const cmdsRes = sanitizeMap(parsed.commands, isFiniteNum);
      const actRes = sanitizeMap(parsed.activity, isFiniteNum);
      const newRes = sanitizeMap(parsed.newCardsByDay, isFiniteNum);
      const skipped = cardsRes.skipped + checksRes.skipped + quizRes.skipped
        + cmdsRes.skipped + actRes.skipped + newRes.skipped;

      setChecklist(checksRes.clean as Record<string, boolean>);
      setCards(cardsRes.clean as Record<string, CardStateLite>);
      setCommands(cmdsRes.clean as Record<string, number>);
      setQuiz(quizRes.clean as Record<string, "known" | "unknown">);
      setActivity(actRes.clean as ActivityMap);
      setNewCardsByDay(newRes.clean as Record<string, number>);
      return {
        ok: true,
        message: skipped > 0 ? `导入成功（跳过 ${skipped} 条格式异常的数据）` : "导入成功",
      };
    } catch {
      return { ok: false, message: "JSON 解析失败" };
    }
  }, []);

  /* 返回对象 memo 化：否则每次渲染都是新的对象字面量，App 因任何原因重渲染
     （切 tab、开面板、任意学习动作）时，五个 tab 组件都会全部重渲染。 */
  return useMemo(() => ({
    checklist, cards, commands, quiz, activity, newCardsByDay, todayNewCardCount,
    recordNewCard, undoNewCard, toggleCheck, gradeCard, completeCommand, gradeQuiz, exportData, importData,
  }), [
    checklist, cards, commands, quiz, activity, newCardsByDay, todayNewCardCount,
    recordNewCard, undoNewCard, toggleCheck, gradeCard, completeCommand, gradeQuiz, exportData, importData,
  ]);
}

/** 主题 hook：dark/light/system 三态，localStorage 记忆。
 *  "system" 会解析成显式的 data-theme —— 与 index.html 的 pre-paint 脚本同一套规则，
 *  因此 CSS 只需要维护一份浅色 token，且 theme-color 会跟随手动选择。 */
export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light" | "system">(() => {
    try {
      const t = localStorage.getItem(PREFIX + "theme");
      return t === "light" || t === "dark" || t === "system" ? t : "dark";
    } catch { return "dark"; }
  });

  useEffect(() => {
    try { localStorage.setItem(PREFIX + "theme", theme); } catch { /* 隐私模式降级 */ }
    const apply = () => {
      const resolved: "dark" | "light" = theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
        : theme;
      document.documentElement.setAttribute("data-theme", resolved);
      document.querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", resolved === "light" ? "#f9f9f7" : "#0d0d0d");
    };
    apply();
    if (theme !== "system") return;
    // 跟随系统时要实时响应系统主题切换
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  return { theme, setTheme };
}
