import { useMemo, useState } from "react";
import type { PathContent } from "@aiforge/content-schema";
import { cardMastery, evaluateCompletion } from "@aiforge/logic";
import { quizKey, cardKey, commandKey } from "../lib/keys.ts";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

export default function Quiz({ path, progress }: { path: PathContent; progress: Progress }) {
  const { quiz, cards, commands, checklist, gradeQuiz } = progress;
  const [copied, setCopied] = useState(false);

  const flat = useMemo(() => {
    const out: Array<{ key: string; q: string; a: string; moduleTitle: string }> = [];
    for (const m of path.modules)
      for (const item of m.quiz)
        out.push({ key: quizKey(path.id, m, item), q: item.q, a: item.a, moduleTitle: m.title });
    return out;
  }, [path]);

  /* 通关判定（多源，不靠单一自评） */
  const completion = useMemo(() => {
    let cardsGood = 0, cardsTotal = 0, commandsDone = 0, commandsTotal = 0, checks = 0, checksTotal = 0;
    for (const m of path.modules) {
      for (const c of m.flashcards) {
        cardsTotal++;
        if (cardMastery(cards[cardKey(path.id, m, c)]) === "good") cardsGood++;
      }
      for (const c of m.commands) {
        commandsTotal++;
        if ((commands[commandKey(path.id, m, c)] || 0) > 0) commandsDone++;
      }
      for (let i = 0; i < m.checklist.length; i++) {
        checksTotal++;
        if (checklist[`${path.id}:${m.id}:${i}`]) checks++;
      }
    }
    return evaluateCompletion({
      quizKnown: flat.filter((x) => quiz[x.key] === "known").length,
      quizTotal: flat.length,
      cardsGood, cardsTotal, commandsDone, commandsTotal,
      checklistDone: checks, checklistTotal: checksTotal,
    });
  }, [path, flat, quiz, cards, commands, checklist]);

  if (!flat.length) return <p className="empty">本路径没有面试题</p>;
  const known = flat.filter((x) => quiz[x.key] === "known").length;

  const partOf = (k: "quiz" | "cards" | "commands" | "checklist") =>
    completion.parts.find((p) => p.key === k)?.ratio ?? 0;

  const proofText = `【AI Infra Forge 通关证明】
路径：${path.title}
综合掌握分：${completion.score}/100
· 面试掌握 ${known}/${flat.length}（${Math.round(partOf("quiz") * 100)}%）
· 闪卡掌握 ${Math.round(partOf("cards") * 100)}%
· 命令完成 ${Math.round(partOf("commands") * 100)}%
· 清单勾选 ${Math.round(partOf("checklist") * 100)}%
判定：${completion.passed ? "✅ 通关（多源掌握达标）" : "尚未通关"}
日期：${new Date().toLocaleDateString("zh-CN")}`;

  const copyProof = async () => {
    try {
      await navigator.clipboard.writeText(proofText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* 剪贴板不可用 */ }
  };

  return (
    <>
      <div className={`card ${completion.passed ? "card--passed" : ""}`}>
        <h2 className="card__title">{completion.passed ? "🏆 通关达成" : "🎯 通关判定"}</h2>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
          <span className="stat-tile__value" style={{ color: completion.passed ? "var(--status-good)" : "var(--text-primary)" }}>
            {completion.score}
          </span>
          <span className="stat-tile__label">/ 100 综合掌握分</span>
        </div>
        {completion.parts.map((p) => (
          <div key={p.key} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-1) 0" }}>
            <span aria-hidden="true" style={{ color: p.ok ? "var(--status-good)" : "var(--status-critical-text)", fontWeight: 700 }}>
              {p.ok ? "✓" : "✗"}
            </span>
            <span style={{ flex: 1 }}>{p.label}</span>
            <span className="tabular">{Math.round(p.ratio * 100)}%</span>
          </div>
        ))}
        {completion.passed && (
          <div style={{ marginTop: "var(--space-3)" }}>
            <button className="btn btn--primary" onClick={copyProof}>
              {copied ? "✓ 已复制" : "📋 复制通关证明文本"}
            </button>
          </div>
        )}
      </div>

      <div className="stat-grid" style={{ marginBottom: "var(--space-4)" }}>
        <div className="stat-tile"><div className="stat-tile__value">{known}/{flat.length}</div><div className="stat-tile__label">已掌握</div></div>
        <div className="stat-tile"><div className="stat-tile__value">{Math.round((known / flat.length) * 100)}%</div><div className="stat-tile__label">掌握率</div></div>
      </div>

      <details className="quiz-item">
        <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 44, display: "flex", alignItems: "center" }}>
          如何使用
        </summary>
        <p className="quiz-item__a" style={{ borderLeftColor: "var(--series-3)" }}>
          先自己口头回答，再展开对答案，如实自评。自评「掌握」会提高你的面试掌握率。
        </p>
      </details>

      {flat.map((item) => {
        const g = quiz[item.key];
        return (
          <div className="quiz-item" key={item.key}>
            <p className="quiz-item__q">{item.q}</p>
            <details>
              <summary style={{ cursor: "pointer", color: "var(--text-secondary)", minHeight: 44, display: "flex", alignItems: "center" }}>
                展开参考答案
              </summary>
              <p className="quiz-item__a">{item.a}</p>
            </details>
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
              <button className="btn btn--good" onClick={() => gradeQuiz(item.key, "known")} aria-pressed={g === "known"}>
                {g === "known" ? "✓ 已掌握" : "掌握"}
              </button>
              <button className="btn btn--critical" onClick={() => gradeQuiz(item.key, "unknown")} aria-pressed={g === "unknown"}>
                {g === "unknown" ? "✗ 不熟" : "不熟"}
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
