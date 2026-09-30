import { useMemo } from "react";
import type { PathContent } from "@aiforge/content-schema";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

export default function Quiz({ path, progress }: { path: PathContent; progress: Progress }) {
  const { quiz, gradeQuiz } = progress;

  const flat = useMemo(() => {
    const out: Array<{ key: string; q: string; a: string; moduleTitle: string }> = [];
    for (const m of path.modules)
      for (const item of m.quiz)
        out.push({ key: `${m.id}:${item.q}`, q: item.q, a: item.a, moduleTitle: m.title });
    return out;
  }, [path]);

  if (!flat.length) return <p className="empty">本路径没有面试题</p>;
  const known = flat.filter((x) => quiz[x.key] === "known").length;

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: "var(--space-4)" }}>
        <div className="stat-tile"><div className="stat-tile__value">{known}/{flat.length}</div><div className="stat-tile__label">已掌握</div></div>
        <div className="stat-tile"><div className="stat-tile__value">{Math.round((known / flat.length) * 100)}%</div><div className="stat-tile__label">掌握率</div></div>
      </div>

      <details className="quiz-item" key={flat[0]!.key}>
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
