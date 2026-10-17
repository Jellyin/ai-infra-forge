import { memo, useMemo } from "react";
import type { PathMeta } from "@aiforge/content-schema";
import { computeStreak, cardMastery, buildCardQueue, dateKey } from "@aiforge/logic";
import { cardKey, checkKey, commandKey, quizKey } from "../lib/keys.ts";
import { DAILY_NEW_LIMIT } from "../hooks/useProgress.ts";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;
type CardMastery = "good" | "learning" | "new";

interface Props { path: PathMeta; progress: Progress; onGoTab?: (tab: string) => void; onOpenModule?: (id: string) => void }

function Dashboard({ path, progress, onGoTab, onOpenModule }: Props) {
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
        if (checklist[checkKey(path.id, m, i)]) doneChecks++;
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
    const now = Date.now();
    let nextChecklistModule: PathMeta["modules"][number] | undefined;
    let dueReviewModule: typeof path.modules[number] | undefined;
    let untrainedCommandModule: typeof path.modules[number] | undefined;
    for (const m of path.modules) {
      if (!nextChecklistModule && m.checklist.some((_, i) => !checklist[checkKey(path.id, m, i)])) {
        nextChecklistModule = m;
      }
      if (!dueReviewModule && m.flashcards.some((c) => {
        const s = cards[cardKey(path.id, m, c)];
        // 与 buildCardQueue 的到期口径保持一致：非 fresh（reps/interval/due 全 0）且已到期。
        // 只看 reps>0 会漏掉「新卡评了不认识」（reps=0 但 due=now），导致 tile 有此卡而「下一步」不给复习入口。
        return s && !(s.reps === 0 && s.interval === 0 && s.due === 0) && s.due <= now;
      })) {
        dueReviewModule = m;
      }
      if (!untrainedCommandModule && m.commands.some((c) => !commands[commandKey(path.id, m, c)])) {
        untrainedCommandModule = m;
      }
      if (nextChecklistModule && dueReviewModule && untrainedCommandModule) break;
    }
    const p = (a: number, b: number) => (b ? a / b : 0);
    /* 只对「有内容的轨」求平均。命令只覆盖 5/30 天、面试只 2/30 天，分母为 0 的轨
       若按 0% 计入，会把总进度系统性压低、且永远到不了 100%（与 evaluateCompletion
       的「缺失维度不构成门槛」对齐）。 */
    const totals = [totalChecks, totalCards, totalCmds, totalQuiz];
    const tracks = [p(doneChecks, totalChecks), p(mastery.good, totalCards), p(doneCmds, totalCmds), p(knownQuiz, totalQuiz)]
      .filter((_, i) => (totals[i] ?? 0) > 0);
    return {
      overall: tracks.length ? tracks.reduce((s, v) => s + v, 0) / tracks.length : 0,
      check: [doneChecks, totalChecks], cmd: [doneCmds, totalCmds],
      quiz: [knownQuiz, totalQuiz], mastery, totalCards,
      streak: computeStreak(activity),
      // 与 Flashcards 页同口径：剩余额度 = 上限 - 今日已引入（否则评 5 张后
      // 闪卡页显示 0 而仪表盘仍显示 5，点击进去是空队列）
      dueToday: buildCardQueue(cardStates, undefined, {
        dailyNewLimit: Math.max(0, DAILY_NEW_LIMIT - todayNewCardCount),
      }).order.length,
      totalChecks,
      nextChecklistModule,
      dueReviewModule,
      untrainedCommandModule,
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

  /* 「下一步」卡片常驻：fresh 时引导开始第 1 个单元，有进度时按 复习 > 继续清单 > 训练命令
   * 的优先级给出唯一 CTA。修复首个单元完成后入口消失的问题。 */
  const isFresh = stats.check[0] === 0 && stats.totalCards === stats.mastery.new;
  const nextCta = (() => {
    if (isFresh && stats.nextChecklistModule && onOpenModule) {
      const m = stats.nextChecklistModule;
      return { label: `开始 ${path.unit} ${m.order} · ${m.title}`,
        sub: "每天 15 分钟：读教程 → 勾清单 → 清闪卡。间隔重复（SM-2）会替你安排复习。",
        onClick: () => onOpenModule(m.id) };
    }
    const r = stats.dueReviewModule;
    if (r) {
      return { label: `复习 ${path.unit} ${r.order} · ${r.title} 闪卡`,
        sub: "间隔重复按你的遗忘曲线挑出了到期卡。先复习，再学新内容，记忆更牢。",
        onClick: () => onGoTab?.("flashcards") };
    }
    const c = stats.nextChecklistModule;
    if (c && onOpenModule) {
      return { label: `继续 ${path.unit} ${c.order} · ${c.title}`,
        sub: "继续阅读 / 勾清单 / 清闪卡。已完成的天会自动安排复习。",
        onClick: () => onOpenModule(c.id) };
    }
    const t = stats.untrainedCommandModule;
    if (t) {
      return { label: `训练 ${path.unit} ${t.order} · ${t.title} 命令`,
        sub: "命令训练帮你建立肌肉记忆。先看完教程，再来刷命令。",
        onClick: () => onGoTab?.("commands") };
    }
    return null;
  })();

  return (
    <>
      {nextCta && (
        <div className="card" style={{ borderColor: "var(--series-1)" }}>
          <h2 className="card__title">下一步</h2>
          <p className="card__subtitle">{nextCta.sub}</p>
          <button className="btn btn--primary" onClick={nextCta.onClick}>{nextCta.label}</button>
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
              // 类别用 series 色（原来借了 status-warning 状态色），并补上分母以与上面三行单位一致
              ["闪卡学习中", `${stats.mastery.learning}/${stats.totalCards}`, "var(--series-2)"],
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
        <h2 className="card__title">按天清单完成度</h2>
        {/* 这一条只量当天的清单勾选（命令/闪卡/面试在各自 tab），标题照实写，避免与顶部总进度口径混淆 */}
        {path.modules.map((m) => {
          const done = m.checklist.filter((_, i) => checklist[checkKey(path.id, m, i)]).length;
          const p = m.checklist.length ? (done / m.checklist.length) * 100 : 0;
          return (
            <div key={m.id} style={{ marginBottom: "var(--space-3)" }}>
              <div className="progress-label"><span>{path.unit} {m.order} · {m.title}</span><span>{done}/{m.checklist.length}</span></div>
              <button className="progress progress--action" onClick={() => onOpenModule?.(m.id)}
                aria-label={`打开 ${path.unit} ${m.order} ${m.title}`} style={{ width: "100%", border: "none", padding: 0 }}>
                <div className="progress__bar" style={{ width: `${p}%` }}></div>
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* 五个 tab 常驻挂载：memo 配合 App 里的稳定回调，切 tab 时只重渲染目标面板 */
export default memo(Dashboard);
