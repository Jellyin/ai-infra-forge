import { useState, useMemo } from "react";
import type { PathContent } from "@aiforge/content-schema";
import { buildCardQueue, newCardState, sm2Next, cardMastery } from "@aiforge/logic";
import type { CardState, Grade } from "@aiforge/logic";
import { cardKey } from "../lib/keys.ts";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

interface FlatCard { key: string; front: string; back: string; moduleTitle: string }

/** 每日新卡上限（Anki 式日节奏：防首日洪水，评审 P0-2）。真·按天限额由
 *  useProgress 的 newCardsByDay 持久化计数实现，此处常量只定义上限值。 */
const DAILY_NEW_LIMIT = 5;

export default function Flashcards({ path, progress }: { path: PathContent; progress: Progress }) {
  const { cards, gradeCard, todayNewCardCount, recordNewCard, undoNewCard } = progress;
  const [flipped, setFlipped] = useState(false);
  /** 供撤销上一评（评审 P1-4） */
  const [lastGraded, setLastGraded] = useState<{ key: string; state: CardState; consumedQuota: boolean } | null>(null);

  const flat = useMemo<FlatCard[]>(() => {
    const out: FlatCard[] = [];
    for (const m of path.modules)
      for (const c of m.flashcards)
        out.push({ key: cardKey(path.id, m, c), front: c.front, back: c.back, moduleTitle: m.title });
    return out;
  }, [path]);

  /* 真·每日新卡限额：今日剩余额度 = 上限 - 今日已引入（跨会话/刷新按天持久化） */
  const remainingQuota = Math.max(0, DAILY_NEW_LIMIT - todayNewCardCount);
  const queue = useMemo(
    () => buildCardQueue(flat.map((c) => cards[c.key]), undefined, { dailyNewLimit: remainingQuota }),
    [flat, cards, remainingQuota],
  );
  const remaining = queue.order.length;   // 本次会话剩余（due + 限额内新卡）

  const headIdx = queue.order[0];
  const card = headIdx != null ? flat[headIdx] : undefined;
  const state: CardState = { ...newCardState(), ...(card ? cards[card.key] : undefined) };
  /** 当前卡是否为今天首次引入的新卡（需要计入每日额度） */
  const isNewCard = state.reps === 0 && state.interval === 0 && state.due === 0;

  const grade = (g: Grade) => {
    if (!card) return;
    const consumedQuota = isNewCard && g !== "again";   // again 不消耗额度
    const prev = { key: card.key, state: { ...newCardState(), ...state }, consumedQuota };
    const next = sm2Next(state, g);
    gradeCard(card.key, next);
    if (consumedQuota) recordNewCard();
    setLastGraded(prev);
    setFlipped(false);
  };

  const undo = () => {
    if (!lastGraded) return;
    gradeCard(lastGraded.key, lastGraded.state);
    if (lastGraded.consumedQuota) undoNewCard();   // 只回补真实消耗过的额度（M4：
    // good→again→undo 序列下 again 未消耗额度，按 wasNew 误判会多发 1 张）
    setLastGraded(null);
    setFlipped(false);
  };

  if (!flat.length) return <p className="empty">本路径没有闪卡</p>;

  const doneToday = queue.due.length === 0 && queue.fresh.length === 0;
  const masteryCount = flat.reduce((acc, c) => { acc[cardMastery(cards[c.key])]++; return acc; },
    { good: 0, learning: 0, new: 0 } as Record<"good" | "learning" | "new", number>);

  /* Anki 式评分预览：三个纯函数调用，让用户看见后果（评审 P0-3） */
  const preview = (g: Grade): number => sm2Next(state, g).interval;

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: "var(--space-4)" }}>
        <div className="stat-tile"><div className="stat-tile__value">{remaining}</div><div className="stat-tile__label">本次剩余</div></div>
        <div className="stat-tile"><div className="stat-tile__value" style={{ color: "var(--status-good)" }}>{masteryCount.good}</div><div className="stat-tile__label">已掌握</div></div>
        <div className="stat-tile"><div className="stat-tile__value" style={{ color: "var(--status-warning)" }}>{masteryCount.learning}</div><div className="stat-tile__label">学习中</div></div>
        <div className="stat-tile"><div className="stat-tile__value">{masteryCount.new}</div><div className="stat-tile__label">未开始</div></div>
      </div>

      {doneToday ? (
        <div className="card"><p className="empty" style={{ padding: 0 }}>
          🎉 今日已清完到期卡。下次最早到期：{(() => {
            const next = flat.map((c) => cards[c.key]?.due).filter((d): d is number => d != null && d > Date.now()).sort((a, b) => a - b)[0];
            return next ? new Date(next).toLocaleString("zh-CN") : "暂无";
          })()}
        </p></div>
      ) : card ? (
        <>
          <div className="flashcard-stage">
            <div className={`flashcard ${flipped ? "flashcard--flipped" : ""}`}
              onClick={() => setFlipped(!flipped)}
              role="button" tabIndex={0}
              aria-label={flipped
                ? `闪卡。答案：${card.back}`
                : `闪卡。问题：${card.front}。点击或按 Enter 翻面看答案`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFlipped(!flipped); }
                if (flipped && (e.key === "1" || e.key === "a")) { e.preventDefault(); grade("again"); }
                if (flipped && (e.key === "2" || e.key === "s")) { e.preventDefault(); grade("hard"); }
                if (flipped && (e.key === "3" || e.key === "d")) { e.preventDefault(); grade("good"); }
                if (e.key === "z" && !flipped && lastGraded) { e.preventDefault(); undo(); }
              }}>
              <div className="flashcard__face" aria-hidden={flipped}>
                <div className="flashcard__label">问题 · {card.moduleTitle}</div>
                <div className="flashcard__front-text">{card.front}</div>
                <div className="flashcard__label" style={{ marginTop: "var(--space-4)" }}>点击卡片或按 Enter 翻面</div>
              </div>
              <div className="flashcard__face flashcard__face--back" aria-hidden={!flipped}>
                <div className="flashcard__label">答案</div>
                <div className="flashcard__back-text">{card.back}</div>
              </div>
            </div>
          </div>

          <div className="grade-row">
            <button className="btn btn--critical" onClick={() => grade("again")} disabled={!flipped}>
              1 不认识<br /><span className="btn__preview">{preview("again") === 0 ? "今天再见" : `${preview("again")} 天后`}</span>
            </button>
            <button className="btn btn--warning" onClick={() => grade("hard")} disabled={!flipped}>
              2 模糊<br /><span className="btn__preview">{preview("hard")} 天后</span>
            </button>
            <button className="btn btn--good" onClick={() => grade("good")} disabled={!flipped}>
              3 认识<br /><span className="btn__preview">{preview("good")} 天后</span>
            </button>
          </div>

          <div className="undo-row">
            {lastGraded && (
              <button className="btn" onClick={undo} style={{ minHeight: 36, fontSize: "var(--fs-xs)" }}>
                Z 撤销上一评（{lastGraded.state.reps > 0 ? `此前间隔 ${lastGraded.state.interval} 天` : "新卡"}）
              </button>
            )}
          </div>

          <p className="grade-meta" aria-live="polite">
            翻面后自评 · 复习 {state.reps} 次 · 间隔 {state.interval} 天
          </p>
        </>
      ) : null}
    </>
  );
}
