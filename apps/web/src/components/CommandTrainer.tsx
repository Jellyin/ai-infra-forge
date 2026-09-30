import { useState, useMemo, useRef, useEffect } from "react";
import type { PathContent } from "@aiforge/content-schema";
import { scoreCommand } from "@aiforge/logic";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

export default function CommandTrainer({ path, progress }: { path: PathContent; progress: Progress }) {
  const { commands, completeCommand } = progress;
  const [idx, setIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const flat = useMemo(() => {
    const out: Array<{ key: string; hint: string; cmd: string; moduleTitle: string }> = [];
    for (const m of path.modules)
      for (const c of m.commands)
        out.push({ key: `${m.id}:${c.hint}`, hint: c.hint, cmd: c.cmd, moduleTitle: m.title });
    return out;
  }, [path]);

  if (!flat.length) return <p className="empty">本路径没有命令训练</p>;
  const current = flat[Math.min(idx, flat.length - 1)]!;
  const score = scoreCommand(current.cmd, typed);
  const doneCount = flat.filter((c) => (commands[c.key] || 0) > 0).length;

  const onChange = (v: string) => {
    setTyped(v);
    if (v === current.cmd) completeCommand(current.key);
  };

  const next = () => { setIdx((i) => (i + 1) % flat.length); setTyped(""); };

  useEffect(() => { inputRef.current?.focus(); }, [idx]);

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: "var(--space-4)" }}>
        <div className="stat-tile"><div className="stat-tile__value">{doneCount}/{flat.length}</div><div className="stat-tile__label">已练成命令</div></div>
        <div className="stat-tile"><div className="stat-tile__value">{Math.round(score.accuracy * 100)}%</div><div className="stat-tile__label">当前准确率</div></div>
        <div className="stat-tile"><div className="stat-tile__value">{commands[current.key] || 0}</div><div className="stat-tile__label">本命令完成次数</div></div>
      </div>

      <div className="card">
        <p className="cmd-hint">🛠 {current.hint} <span className="module-card__meta">· {current.moduleTitle}</span></p>
        <div className="cmd-target" aria-label="目标命令">
          {score.states.map((s, i) => (
            <span key={i} className={`cmd-ch cmd-ch--${s}`}>{current.cmd[i]}</span>
          ))}
        </div>

        <input ref={inputRef} className="cmd-input" type="text" value={typed}
          onChange={(e) => onChange(e.target.value)}
          placeholder="在此敲出命令，练肌肉记忆…"
          aria-label="命令输入"
          spellCheck={false} autoComplete="off" autoCapitalize="off" />

        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
          <button className="btn" onClick={next}>下一条 →</button>
          <button className="btn" onClick={() => setTyped("")}>清空</button>
          <button className="btn" onClick={() => setTyped(current.cmd)} title="作弊看答案，不计入完成">显示答案</button>
        </div>

        {score.complete && (
          <p style={{ color: "var(--status-good)", fontWeight: 700, marginTop: "var(--space-3)" }}>
            ✓ 命令敲对了！已计入完成
          </p>
        )}
      </div>
    </>
  );
}
