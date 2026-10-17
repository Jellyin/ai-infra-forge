import { Fragment, memo, useEffect, useMemo, useState } from "react";
import type { PathMeta, DocsMap } from "@aiforge/content-schema";
import { renderMarkdown } from "./markdown.ts";
import { checkKey } from "../lib/keys.ts";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

/** markdown 渲染结果按内容缓存：勾任意清单项都会让 PathView 重渲染，
   不缓存就要把当前展开模块的教程/实验整篇重新解析一遍。 */
const Markdown = memo(function Markdown({ md, className }: { md: string; className: string }) {
  const html = useMemo(() => renderMarkdown(md), [md]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});

interface Props {
  path: PathMeta;
  progress: Progress;
  openModuleId?: string | null;   // 外部（仪表盘）请求展开某模块
  onModuleOpened?: () => void;    // 展开后回调（清外部请求）
}

function PathView({ path, progress, openModuleId, onModuleOpened }: Props) {
  const [open, setOpen] = useState<string | null>(path.modules[0]?.id ?? null);
  const [showGuide, setShowGuide] = useState<Record<string, boolean>>({});
  const [showLab, setShowLab] = useState<Record<string, boolean>>({});
  /** 正文（30 天 guide/lab）单独成 chunk，展开某天时才拉取——首屏不含正文 */
  const [docs, setDocs] = useState<DocsMap | null>(null);
  const { checklist, toggleCheck } = progress;

  /** 轨道（多轨道路径用）：按轨道分组展示 + 可筛选，让学习者自行挑选先学哪条 */
  const tracks = useMemo(
    () => [...new Set(path.modules.map((m) => m.track).filter((t): t is string => !!t))],
    [path],
  );
  const [track, setTrack] = useState<string | null>(null);
  const shown = track ? path.modules.filter((m) => m.track === track) : path.modules;

  /* 外部请求展开（仪表盘点击进度条）：受控覆盖本地 open */
  const effectiveOpen = openModuleId ?? open;

  useEffect(() => {
    if (!effectiveOpen || docs) return;
    let alive = true;
    import("virtual:aiforge-content/docs")
      .then((m) => { if (alive) setDocs(m.docs); })
      .catch(() => { /* 拉取失败就停在「正在加载」提示，不阻塞列表 */ });
    return () => { alive = false; };
  }, [effectiveOpen, docs]);

  /* 切换路径时把展开项重置为新路径的首个模块：open 里存的是上一条路径的模块 id，
     不重置会导致切过去后所有模块都是折叠的（且与「首个模块默认展开」的行为不一致）。 */
  useEffect(() => {
    setOpen(path.modules[0]?.id ?? null);
  }, [path.id]);

  const toggle = (id: string) => {
    /* 比较「实际生效」的开合状态而非本地 open：从仪表盘跳进来时 openModuleId 覆盖了 open，
       若比较本地 open，第一次点标题会把「收起」误判成「展开别的」，表现为点了没反应。 */
    const next = effectiveOpen === id ? null : id;
    if (openModuleId) onModuleOpened?.();     // 清外部请求，恢复本地控制
    setOpen(next);
  };

  return (
    <div className="module-list">
      {/* 多轨道路径：先让学习者看清有哪几条线，再各自挑选 */}
      {tracks.length > 1 && (
        <div className="filter-chips" role="group" aria-label="按轨道筛选">
          <button className={`chip chip--action ${track === null ? "chip--on" : ""}`}
            aria-pressed={track === null} onClick={() => setTrack(null)}>
            全部 {path.modules.length}
          </button>
          {tracks.map((t) => (
            <button key={t} className={`chip chip--action ${track === t ? "chip--on" : ""}`}
              aria-pressed={track === t} onClick={() => setTrack(t)}>
              {t} {path.modules.filter((m) => m.track === t).length}
            </button>
          ))}
        </div>
      )}

      {shown.map((m, i) => {
        const done = m.checklist.filter((_, j) => checklist[checkKey(path.id, m, j)]).length;
        const pct = m.checklist.length ? Math.round((done / m.checklist.length) * 100) : 0;
        const isOpen = effectiveOpen === m.id;
        const doc = docs?.[`${path.id}:${m.id}`];
        const prevTrack = i > 0 ? shown[i - 1]?.track : undefined;
        const newTrack = m.track && m.track !== prevTrack ? m.track : null;
        return (
          <Fragment key={m.id}>
            {newTrack && <h2 className="track-heading">{newTrack}</h2>}
            <section className="module-card">
            <button className="module-card__head" onClick={() => toggle(m.id)} aria-expanded={isOpen}>
              <span className="module-badge">{m.order}</span>
              <span className="module-card__title">{m.title}</span>
              <span className="module-card__meta">{done}/{m.checklist.length} · {pct}%</span>
            </button>

            {isOpen && (
              <div className="module-card__body">
                {m.goal && <p className="card__subtitle">🎯 {m.goal}</p>}
                {m.read != null && m.lab != null && m.hasLab && (
                  <p className="module-card__meta">建议投入：阅读 {m.read} 分钟 · 动手 {m.lab} 分钟</p>
                )}

                {m.concepts.length > 0 && (
                  <div className="concept-chips">
                    {m.concepts.map((c) => <span key={c} className="chip">{c}</span>)}
                  </div>
                )}

                {m.hasGuide && (
                  <div style={{ margin: "var(--space-2) 0 var(--space-3)" }}>
                    <button className="btn" onClick={() => setShowGuide((s) => ({ ...s, [m.id]: !s[m.id] }))} aria-expanded={!!showGuide[m.id]}>
                      {showGuide[m.id] ? "📖 收起教程" : "📖 阅读教程"}
                    </button>
                    {showGuide[m.id] && (doc
                      ? <Markdown md={doc.guideMd} className="md-body" />
                      : <p className="module-card__meta">正在加载教程…</p>)}
                  </div>
                )}

                {m.hasLab && (
                  <div style={{ margin: "var(--space-2) 0 var(--space-3)" }}>
                    <button className="btn btn--primary" onClick={() => setShowLab((s) => ({ ...s, [m.id]: !s[m.id] }))} aria-expanded={!!showLab[m.id]}>
                      {showLab[m.id] ? "🧪 收起实验" : "🧪 动手实验"}
                    </button>
                    {showLab[m.id] && (doc
                      ? <Markdown md={doc.labMd} className="md-body md-body--lab" />
                      : <p className="module-card__meta">正在加载实验…</p>)}
                  </div>
                )}

                <ul className="checklist">
                  {m.checklist.map((item, i) => {
                    const key = checkKey(path.id, m, i);
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
          </Fragment>
        );
      })}
    </div>
  );
}

/* 五个 tab 常驻挂载：memo 配合 App 里的稳定回调，切 tab 时只重渲染目标面板 */
export default memo(PathView);
