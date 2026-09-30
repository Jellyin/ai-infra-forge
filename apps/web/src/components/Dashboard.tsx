import { useMemo } from "react";
import type { PathContent } from "@aiforge/content-schema";
import { computeStreak, cardMastery, buildCardQueue, dateKey } from "@aiforge/logic";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;
type CardMastery = "good" | "learning" | "new";

export default function Dashboard({ path, progress }: { path: PathContent; progress: Progress }) {
  const { checklist, cards, commands, quiz, activity } = progress;

  /* 全路径聚合：清单 / 闪卡 / 命令 / 面试 四路进度 */
  const stats = useMemo(() => {
    const modules = path.modules;
    let totalChecks = 0, doneChecks = 0, totalCards = 0;
    const mastery: Record<CardMastery, number> = { good: 0, learning: 0, new: 0 };
    const cardStates: Array<{ key: string; state: Progress["cards"][string] | undefined }> = [];
    let totalCmds = 0, doneCmds = 0, totalQuiz = 0, knownQuiz = 0;

    for (const m of modules) {
      for (let i = 0; i < m.checklist.length; i++) {
        totalChecks++;
        if (checklist[`${m.id}:${i}`]) doneChecks++;
      }
      for (const c of m.flashcards) {
        totalCards++;
        const key = `${m.id}:${c.id ?? c.front.slice(0, 20)}`;
        cardStates.push({ key, state: cards[key] });
        mastery[cardMastery(cards[key])] += 1;
      }
      for (const c of m.commands) {
        totalCmds++;
        if ((commands[`${m.id}:${c.hint}`] || 0) > 0) doneCmds++;
      }
      for (const q of m.quiz) {
        totalQuiz++;
        if (quiz[`${m.id}:${q.q}`] === "known") knownQuiz++;
      }
    }
    const p = (a: number, b: number) => (b ? a / b : 0);
    return {
      overall: (p(doneChecks, totalChecks) + p(mastery.good, totalCards) + p(doneCmds, totalCmds) + p(knownQuiz, totalQuiz)) / 4,
      check: [doneChecks, totalChecks], cmd: [doneCmds, totalCmds],
      quiz: [knownQuiz, totalQuiz], mastery, totalCards,
      streak: computeStreak(activity),
      dueToday: buildCardQueue(cardStates.map((c) => c.state)).due.length,
    };
  }, [path, checklist, cards, commands, quiz, activity]);

  const pct = Math.round(stats.overall * 100);
  const days = 35; // 日历显示最近5周（本地日期键，与 activity 一致）
  const cells = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const k = dateKey(d);
    return { key: k, on: (activity[k] || 0) > 0, today: i === days - 1 };
  });

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: "var(--space-4)" }}>
        <div className="stat-tile">
          <div className="stat-tile__value">{pct}%</div>
          <div className="stat-tile__label">总进度</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value" style={{ color: "var(--series-2)" }}>{stats.streak}</div>
          <div className="stat-tile__label">连续学习天数</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value">{stats.dueToday}</div>
          <div className="stat-tile__label">今日待复习闪卡</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__value">{stats.mastery.good}/{stats.totalCards}</div>
          <div className="stat-tile__label">已掌握闪卡</div>
        </div>
      </div>

      <div className="card">
        <h2 className="card__title">掌握度概览</h2>
        <div className="donut-wrap" style={{ marginBottom: "var(--space-4)" }}>
          <div className="donut" style={{ width: 120, height: 120, ["--p" as string]: `${pct}%` }} role="img" aria-label={`总进度 ${pct}%`}></div>
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

        <h3 style={{ fontSize: "0.9rem", color: "var(--text-secondary)", margin: "var(--space-4) 0 var(--space-2)" }}>最近 5 周学习日历</h3>
        <div className="streak-grid" aria-label="学习日历">
          {cells.map((c) => (
            <div key={c.key} className={`streak-cell ${c.on ? "streak-cell--on" : ""} ${c.today ? "streak-cell--today" : ""}`}
              title={c.key} role="img" aria-label={`${c.key} ${c.on ? "有学习" : "无学习"}`}></div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 className="card__title">按天进度</h2>
        {path.modules.map((m) => {
          const done = m.checklist.filter((_, i) => checklist[`${m.id}:${i}`]).length;
          const p = m.checklist.length ? (done / m.checklist.length) * 100 : 0;
          return (
            <div key={m.id} style={{ marginBottom: "var(--space-3)" }}>
              <div className="progress-label"><span>Day {m.order} · {m.title}</span><span>{done}/{m.checklist.length}</span></div>
              <div className="progress"><div className="progress__bar" style={{ width: `${p}%` }}></div></div>
            </div>
          );
        })}
      </div>
    </>
  );
}
