import { useState } from "react";
import type { PathContent } from "@aiforge/content-schema";
import { renderMarkdown } from "./markdown.ts";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

interface Props {
  path: PathContent;
  progress: Progress;
  openModuleId?: string | null;   // 外部（仪表盘）请求展开某模块
  onModuleOpened?: () => void;    // 展开后回调（清外部请求）
}

export default function PathView({ path, progress, openModuleId, onModuleOpened }: Props) {
  const [open, setOpen] = useState<string | null>(path.modules[0]?.id ?? null);
  const [showGuide, setShowGuide] = useState<Record<string, boolean>>({});
  const [showLab, setShowLab] = useState<Record<string, boolean>>({});
  const { checklist, toggleCheck } = progress;

  /* 外部请求展开（仪表盘点击进度条）：受控覆盖本地 open */
  const effectiveOpen = openModuleId ?? open;
  const toggle = (id: string) => {
    if (openModuleId) onModuleOpened?.();     // 先清外部请求，恢复本地控制
    setOpen((o) => (o === id ? null : id));
  };

  return (
    <div className="module-list">
      {path.modules.map((m) => {
        const done = m.checklist.filter((_, i) => checklist[`${path.id}:${m.id}:${i}`]).length;
        const pct = m.checklist.length ? Math.round((done / m.checklist.length) * 100) : 0;
        const isOpen = effectiveOpen === m.id;
        return (
          <section key={m.id} className="module-card">
            <button className="module-card__head" onClick={() => toggle(m.id)} aria-expanded={isOpen}>
              <span className="module-badge">{m.order}</span>
              <span className="module-card__title">{m.title}</span>
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

                {m.guideMd && (
                  <div style={{ margin: "var(--space-2) 0 var(--space-3)" }}>
                    <button className="btn" onClick={() => setShowGuide((s) => ({ ...s, [m.id]: !s[m.id] }))} aria-expanded={!!showGuide[m.id]}>
                      {showGuide[m.id] ? "📖 收起教程" : "📖 阅读教程"}
                    </button>
                    {showGuide[m.id] && (
                      <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.guideMd) }} />
                    )}
                  </div>
                )}

                {m.labMd && (
                  <div style={{ margin: "var(--space-2) 0 var(--space-3)" }}>
                    <button className="btn btn--primary" onClick={() => setShowLab((s) => ({ ...s, [m.id]: !s[m.id] }))} aria-expanded={!!showLab[m.id]}>
                      {showLab[m.id] ? "🧪 收起实验" : "🧪 动手实验"}
                    </button>
                    {showLab[m.id] && (
                      <div className="md-body md-body--lab" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.labMd) }} />
                    )}
                  </div>
                )}

                <ul className="checklist">
                  {m.checklist.map((item, i) => {
                    const key = `${path.id}:${m.id}:${i}`;
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
