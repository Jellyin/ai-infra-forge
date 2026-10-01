/**
 * 学习进度状态：localStorage 持久化 + activity/streak 记录。
 * 所有学习动作都经过 recordActivity 驱动 streak。
 */
import { useState, useEffect, useCallback } from "react";
import { dateKey, type ActivityMap } from "@aiforge/logic";

const PREFIX = "aiforge:";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
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
      if (!parsed.checklist && !parsed.cards && !parsed.commands) return { ok: false, message: "文件里没有进度数据" };

      /* 字段级校验：类型不对的条目剔除并计数。注意必须检查 typeof 而非 Number() 强转——
       * 字符串 "2.5" 能通过 Number() 但会让 sm2Next 的 ease+0.1 变字符串拼接 "2.50.1"
       * （历史腐坏链条：→ NaN due → 卡永久冻结 waiting）。宁丢脏数据不留病数据 */
      let skipped = 0;
      const cleanCards: Record<string, CardStateLite> = {};
      for (const [k, v] of Object.entries(parsed.cards ?? {})) {
        const ok = v && typeof v.reps === "number" && typeof v.interval === "number"
          && typeof v.ease === "number" && typeof v.due === "number"
          && Number.isFinite(v.reps) && Number.isFinite(v.interval)
          && Number.isFinite(v.ease) && Number.isFinite(v.due);
        if (ok) cleanCards[k] = { reps: v.reps, interval: v.interval, ease: v.ease, due: v.due };
        else skipped++;
      }
      const cleanChecks: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed.checklist ?? {})) {
        if (typeof v === "boolean") cleanChecks[k] = v; else skipped++;
      }
      const cleanQuiz: Record<string, "known" | "unknown"> = {};
      for (const [k, v] of Object.entries(parsed.quiz ?? {})) {
        if (v === "known" || v === "unknown") cleanQuiz[k] = v; else skipped++;
      }
      const numMap = (m: Record<string, number> | undefined): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(m ?? {})) {
          if (typeof v === "number" && Number.isFinite(v)) out[k] = v; else skipped++;
        }
        return out;
      };

      setChecklist(cleanChecks);
      setCards(cleanCards);
      setCommands(numMap(parsed.commands));
      setQuiz(cleanQuiz);
      setActivity(numMap(parsed.activity));
      setNewCardsByDay(numMap(parsed.newCardsByDay));
      return {
        ok: true,
        message: skipped > 0 ? `导入成功（跳过 ${skipped} 条格式异常的数据）` : "导入成功",
      };
    } catch {
      return { ok: false, message: "JSON 解析失败" };
    }
  }, []);

  return { checklist, cards, commands, quiz, activity, newCardsByDay, todayNewCardCount, recordNewCard, undoNewCard, toggleCheck, gradeCard, completeCommand, gradeQuiz, exportData, importData };
}

interface CardStateLite { reps: number; interval: number; ease: number; due: number }

/** 主题 hook：dark/light/system 三态，localStorage 记忆 */
export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light" | "system">(() => {
    try {
      const t = localStorage.getItem(PREFIX + "theme");
      return t === "light" || t === "dark" || t === "system" ? t : "dark";
    } catch { return "dark"; }
  });
  useEffect(() => {
    try { localStorage.setItem(PREFIX + "theme", theme); } catch { /* 隐私模式降级 */ }
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return { theme, setTheme };
}
