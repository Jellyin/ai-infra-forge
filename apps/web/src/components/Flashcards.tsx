import { useState, useMemo } from "react";
import type { PathContent } from "@aiforge/content-schema";
import { buildCardQueue, newCardState, sm2Next, cardMastery } from "@aiforge/logic";
import type { CardState, Grade } from "@aiforge/logic";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

interface FlatCard { key: string; front: string; back: string; moduleTitle: string }

export default function Flashcards({ path, progress }: { path: PathContent; progress: Progress }) {
  const { cards, gradeCard } = progress;
  const [flipped, setFlipped] = useState(false);

  /* 拍平全路径闪卡（保持模块顺序） */
  const flat = useMemo<FlatCard[]>(() => {
    const out: FlatCard[] = [];
    for (const m of path.modules)
      for (const c of m.flashcards)
        out.push({ key: `${m.id}:${c.id ?? c.front.slice(0, 20)}`, front: c.front, back: c.back, moduleTitle: m.title });
    return out;
  }, [path]);

  /* SM-2 出卡顺序：先到期(升序) → 新卡。queue 随每次评分实时重算 */
  const queue = useMemo(() => buildCardQueue(flat.map((c) => cards[c.key])), [flat, cards]);

  /* 出卡始终取队列头 —— 评分后 queue 重算，被评过的卡按新 due 归位，
     again 卡(due=now)当天会再次浮到队头，实现「当天重学」 */
  const headIdx = queue.order[0];
  const card = headIdx != null ? flat[headIdx] : undefined;
  const state: CardState = { ...newCardState(), ...(card ? cards[card.key] : undefined) };

  const grade = (g: Grade) => {
    if (!card) return;
    gradeCard(card.key, sm2Next(state, g));
    setFlipped(false);
  };

  if (!flat.length) return <p className="empty">本路径没有闪卡</p>;

  const doneToday = queue.due.length === 0 && queue.fresh.length === 0;
  const masteryCount = flat.reduce((acc, c) => { acc[cardMastery(cards[c.key])]++; return acc; },
    { good: 0, learning: 0, new: 0 } as Record<"good" | "learning" | "new", number>);

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: "var(--space-4)" }}>
        <div className="stat-tile"><div className="stat-tile__value">{queue.due.length}</div><div className="stat-tile__label">今日待复习</div></div>
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
            <div className={`flashcard ${flipped ? "flashcard--flipped" : ""}`} onClick={() => setFlipped(!flipped)}
              role="button" tabIndex={0}
              aria-label={`闪卡。问题：${card.front}。点击或按 Enter 翻面看答案`}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFlipped(!flipped); } }}>
              <div className="flashcard__face">
                <div className="flashcard__label">问题 · {card.moduleTitle}</div>
                <div className="flashcard__front-text">{card.front}</div>
                <div className="flashcard__label" style={{ marginTop: "var(--space-4)" }}>点击卡片或按 Enter 翻面</div>
              </div>
              <div className="flashcard__face flashcard__face--back">
                <div className="flashcard__label">答案</div>
                <div className="flashcard__back-text">{card.back}</div>
              </div>
            </div>
          </div>

          <div className="grade-row">
            <button className="btn btn--critical" onClick={() => grade("again")} disabled={!flipped}>不认识</button>
            <button className="btn btn--warning" onClick={() => grade("hard")} disabled={!flipped}>模糊</button>
            <button className="btn btn--good" onClick={() => grade("good")} disabled={!flipped}>认识</button>
          </div>
          <p className="module-card__meta" style={{ textAlign: "center", marginTop: "var(--space-2)" }} aria-live="polite">
            翻面后自评 · 复习 {state.reps} 次 · 间隔 {state.interval} 天
          </p>
        </>
      ) : null}
    </>
  );
}
