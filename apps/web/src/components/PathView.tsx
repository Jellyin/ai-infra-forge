import { useState } from "react";
import type { PathContent } from "@aiforge/content-schema";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

export default function PathView({ path, progress }: { path: PathContent; progress: Progress }) {
  const [open, setOpen] = useState<string | null>(path.modules[0]?.id ?? null);
  const { checklist, toggleCheck } = progress;

  return (
    <div className="module-list">
      {path.modules.map((m) => {
        const done = m.checklist.filter((_, i) => checklist[`${m.id}:${i}`]).length;
        const pct = m.checklist.length ? Math.round((done / m.checklist.length) * 100) : 0;
        const isOpen = open === m.id;
        return (
          <section key={m.id} className="module-card">
            <button className="module-card__head" onClick={() => setOpen(isOpen ? null : m.id)}
              aria-expanded={isOpen} style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", color: "inherit", font: "inherit" }}>
              <span className="module-badge">{m.order}</span>
              <h3 className="module-card__title">{m.title}</h3>
              <span className="module-card__meta">{done}/{m.checklist.length} · {pct}%</span>
            </button>

            {isOpen && (
              <div className="module-card__body">
                {m.goal && <p className="card__subtitle">🎯 {m.goal}</p>}
                {m.read != null && m.lab != null && (
                  <p className="module-card__meta">建议投入：阅读 {m.read} 分钟 · 动手 {m.lab} 分钟</p>
                )}

                {m.concepts.length > 0 && (
                  <div className="concept-chips">
                    {m.concepts.map((c) => <span key={c} className="chip">{c}</span>)}
                  </div>
                )}

                <ul className="checklist">
                  {m.checklist.map((item, i) => {
                    const key = `${m.id}:${i}`;
                    return (
                      <li key={key} className="checklist__item">
                        <input id={key} type="checkbox" className="checklist__box"
                          checked={!!checklist[key]} onChange={() => toggleCheck(key)} />
                        <label htmlFor={key} className="checklist__text">{item}</label>
                      </li>
                    );
                  })}
                </ul>

                {m.flashcards.length + m.commands.length + m.quiz.length > 0 && (
                  <p className="module-card__meta" style={{ marginTop: "var(--space-2)" }}>
                    📚 本模块训练物：闪卡 {m.flashcards.length} · 命令 {m.commands.length} · 面试 {m.quiz.length}
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
