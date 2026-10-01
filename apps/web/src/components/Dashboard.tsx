import { useMemo } from "react";
import type { PathContent } from "@aiforge/content-schema";
import { computeStreak, cardMastery, buildCardQueue, dateKey } from "@aiforge/logic";
import { cardKey, commandKey, quizKey } from "../lib/keys.ts";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;
type CardMastery = "good" | "learning" | "new";

interface Props { path: PathContent; progress: Progress; onGoTab?: (tab: string) => void; onOpenModule?: (id: string) => void }

export default function Dashboard({ path, progress, onGoTab, onOpenModule }: Props) {
  const { checklist, cards, commands, quiz, activity, todayNewCardCount } = progress;

  /* 全路径聚合：清单 / 闪卡 / 命令 / 面试 四路进度（key 走统一 keys.ts） */
  const stats = useMemo(() => {
    let totalChecks = 0, doneChecks = 0, totalCards = 0;
    const mastery: Record<CardMastery, number> = { good: 0, learning: 0, new: 0 };
    const cardStates: Array<Progress["cards"][string] | undefined> = [];
    let totalCmds = 0, doneCmds = 0, totalQuiz = 0, knownQuiz = 0;

    for (const m of path.modules) {
      for (let i = 0; i < m.checklist.length; i++) {
        totalChecks++;
        if (checklist[`${path.id}:${m.id}:${i}`]) doneChecks++;
      }
      for (const c of m.flashcards) {
        totalCards++;
        cardStates.push(cards[cardKey(path.id, m, c)]);
        mastery[cardMastery(cards[cardKey(path.id, m, c)])] += 1;
      }
      for (const c of m.commands) {
        totalCmds++;
        if ((commands[commandKey(path.id, m, c)] || 0) > 0) doneCmds++;
      }
      for (const q of m.quiz) {
        totalQuiz++;
        if (quiz[quizKey(path.id, m, q)] === "known") knownQuiz++;
      }
    }
    const p = (a: number, b: number) => (b ? a / b : 0);
    return {
      overall: (p(doneChecks, totalChecks) + p(mastery.good, totalCards) + p(doneCmds, totalCmds) + p(knownQuiz, totalQuiz)) / 4,
      check: [doneChecks, totalChecks], cmd: [doneCmds, totalCmds],
      quiz: [knownQuiz, totalQuiz], mastery, totalCards,
      streak: computeStreak(activity),
      // 与 Flashcards 页同口径：剩余额度 = 上限 - 今日已引入（否则评 5 张后
      // 闪卡页显示 0 而仪表盘仍显示 5，点击进去是空队列）
      dueToday: buildCardQueue(cardStates, undefined, {
        dailyNewLimit: Math.max(0, 5 - todayNewCardCount),
      }).order.length,
      totalChecks,
    };
  }, [path, checklist, cards, commands, quiz, activity, todayNewCardCount]);

  const pct = Math.round(stats.overall * 100);
  const days = 35; // 日历显示最近5周（本地日期键，与 activity 一致）
  const cells = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const k = dateKey(d);
    return { key: k, on: (activity[k] || 0) > 0, today: i === days - 1 };
  });
  const activeDays = cells.filter((c) => c.on).length;

  /* 零进度首屏：给新用户一个「从哪开始」的答案（评审 P0-1） */
  const isFresh = stats.check[0] === 0 && stats.totalCards === stats.mastery.new;
  const firstUndone = path.modules.find((m) => m.checklist.some((_, i) => !checklist[`${path.id}:${m.id}:${i}`]));

  return (
    <>
      {isFresh && (
        <div className="card" style={{ borderColor: "var(--series-1)" }}>
          <h2 className="card__title">从这里开始</h2>
          <p className="card__subtitle">
            每天 15 分钟：读教程 → 勾清单 → 清闪卡。间隔重复（SM-2）会替你安排复习，忘了的卡自动再出现。
          </p>
          {firstUndone && onOpenModule && (
            <button className="btn btn--primary" onClick={() => onOpenModule(firstUndone.id)}>
              开始 {firstUndone.title}（阅读 {firstUndone.read ?? 20} + 动手 {firstUndone.lab ?? 30} 分钟）
            </button>
          )}
        </div>
      )}

      <div className="stat-grid" style={{ marginBottom: "var(--space-4)" }}>
        <div className="stat-tile">
          <div className="stat-tile__value">{pct}%</div>
          <div className="stat-tile__label">总进度</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value" style={{ color: "var(--series-2)" }}>{stats.streak}</div>
          <div className="stat-tile__label">连续学习天数</div>
        </div>
        <button className="stat-tile stat-tile--action" onClick={() => onGoTab?.("flashcards")}
          style={{ cursor: "pointer", textAlign: "left", font: "inherit" }}>
          <div className="stat-tile__value">{stats.dueToday}</div>
          <div className="stat-tile__label">今日待学 →</div>
        </button>
        <button className="stat-tile stat-tile--action" onClick={() => onGoTab?.("flashcards")}
          style={{ cursor: "pointer", textAlign: "left", font: "inherit" }}>
          <div className="stat-tile__value">{stats.mastery.good}/{stats.totalCards}</div>
          <div className="stat-tile__label">已掌握闪卡 →</div>
        </button>
      </div>

      <div className="card">
        <h2 className="card__title">掌握度概览</h2>
        <div className="donut-wrap" style={{ marginBottom: "var(--space-4)" }}>
          <div className="donut" style={{ width: 120, height: 120, ["--p" as string]: `${pct}%` }} role="img" aria-label={`总进度 ${pct}%`}>
            <span className="donut__center" aria-hidden="true">{pct}%</span>
          </div>
          <div style={{ flex: 1 }}>
            {([
              ["清单勾选", `${stats.check[0]}/${stats.check[1]}`, "var(--series-1)"],
              ["命令完成", `${stats.cmd[0]}/${stats.cmd[1]}`, "var(--series-3)"],
              ["面试掌握", `${stats.quiz[0]}/${stats.quiz[1]}`, "var(--series-4)"],
              ["闪卡学习中", `${stats.mastery.learning}`, "var(--status-warning)"],
            ] as const).map(([label, value, color]) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-1) 0" }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block", flexShrink: 0 }} aria-hidden="true"></span>
                <span style={{ flex: 1 }}>{label}</span>
                <span className="tabular" style={{ fontFamily: "var(--font-mono)" }}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        <h3 className="section-label">最近 5 周学习日历 · 共 {activeDays} 天</h3>
        <div className="streak-grid" role="img" aria-label={`最近五周共学习 ${activeDays} 天`}>
          {cells.map((c) => (
            <span key={c.key} className={`streak-cell ${c.on ? "streak-cell--on" : ""} ${c.today ? "streak-cell--today" : ""}`}
              title={`${c.key}${c.on ? " 有学习" : ""}`}></span>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 className="card__title">按天进度</h2>
        {path.modules.map((m) => {
          const done = m.checklist.filter((_, i) => checklist[`${path.id}:${m.id}:${i}`]).length;
          const p = m.checklist.length ? (done / m.checklist.length) * 100 : 0;
          return (
            <div key={m.id} style={{ marginBottom: "var(--space-3)" }}>
              <div className="progress-label"><span>Day {m.order} · {m.title}</span><span>{done}/{m.checklist.length}</span></div>
              <button className="progress progress--action" onClick={() => onOpenModule?.(m.id)}
                aria-label={`打开 Day ${m.order} ${m.title}`} style={{ width: "100%", border: "none", padding: 0 }}>
                <div className="progress__bar" style={{ width: `${p}%` }}></div>
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
