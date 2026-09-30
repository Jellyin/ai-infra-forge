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

  useEffect(() => write("checklist", checklist), [checklist]);
  useEffect(() => write("cards", cards), [cards]);
  useEffect(() => write("commands", commands), [commands]);
  useEffect(() => write("quiz", quiz), [quiz]);
  useEffect(() => write("activity", activity), [activity]);

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
      checklist, cards, commands, quiz, activity,
    }, null, 2);
  }, [checklist, cards, commands, quiz, activity]);

  const importData = useCallback((json: string): { ok: boolean; message: string } => {
    try {
      const parsed = JSON.parse(json) as {
        schema?: number;
        checklist?: Record<string, boolean>;
        cards?: Record<string, CardStateLite>;
        commands?: Record<string, number>;
        quiz?: Record<string, "known" | "unknown">;
        activity?: Record<string, number>;
      };
      if (typeof parsed !== "object" || parsed === null) return { ok: false, message: "不是有效的导出文件" };
      if (parsed.schema !== 1) return { ok: false, message: `未知的 schema 版本: ${String(parsed.schema)}` };
      if (!parsed.checklist && !parsed.cards && !parsed.commands) return { ok: false, message: "文件里没有进度数据" };
      setChecklist(parsed.checklist ?? {});
      setCards(parsed.cards ?? {});
      setCommands(parsed.commands ?? {});
      setQuiz(parsed.quiz ?? {});
      setActivity(parsed.activity ?? {});
      return { ok: true, message: "导入成功" };
    } catch {
      return { ok: false, message: "JSON 解析失败" };
    }
  }, []);

  return { checklist, cards, commands, quiz, activity, toggleCheck, gradeCard, completeCommand, gradeQuiz, exportData, importData };
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
