import { useState, useMemo, useRef, useEffect } from "react";
import type { PathContent } from "@aiforge/content-schema";
import { scoreCommand } from "@aiforge/logic";
import { commandKey } from "../lib/keys.ts";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

export default function CommandTrainer({ path, progress }: { path: PathContent; progress: Progress }) {
  const { commands, completeCommand } = progress;
  const [idx, setIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 本条命令本次会话是否已完成计分（防退格重敲重复计数，评审 M5） */
  const countedRef = useRef(false);

  const flat = useMemo(() => {
    const out: Array<{ key: string; hint: string; cmd: string; moduleTitle: string }> = [];
    for (const m of path.modules)
      for (const c of m.commands)
        out.push({ key: commandKey(path.id, m, c), hint: c.hint, cmd: c.cmd, moduleTitle: m.title });
    return out;
  }, [path]);

  if (!flat.length) return <p className="empty">本路径没有命令训练</p>;
  const current = flat[Math.min(idx, flat.length - 1)]!;
  const score = scoreCommand(current.cmd, typed);
  const doneCount = flat.filter((c) => (commands[c.key] || 0) > 0).length;

  /** 智能引号归一化：macOS/iOS 输入法常把直引号转成弯引号（评审 P2-3） */
  const normalize = (s: string) => s.replace(/[""]/g, '"').replace(/['']/g, "'");

  const onChange = (v: string) => {
    const nv = normalize(v);
    setTyped(nv);
    if (nv === current.cmd && !countedRef.current) {
      countedRef.current = true;
      completeCommand(current.key);
    }
  };

  const next = () => { setIdx((i) => (i + 1) % flat.length); setTyped(""); setRevealed(false); countedRef.current = false; };
  const clear = () => { setTyped(""); countedRef.current = false; inputRef.current?.focus(); };
  const reveal = () => { setRevealed(true); setTyped(current.cmd); inputRef.current?.focus(); };

  /** 揭示答案后重新默写：清空并允许再计分（重默写成功是真实掌握信号） */
  const retype = () => { setRevealed(false); setTyped(""); countedRef.current = false; inputRef.current?.focus(); };

  useEffect(() => { countedRef.current = false; inputRef.current?.focus(); }, [idx]);

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: "var(--space-4)" }}>
        <div className="stat-tile"><div className="stat-tile__value">{doneCount}/{flat.length}</div><div className="stat-tile__label">已练成命令</div></div>
        <div className="stat-tile"><div className="stat-tile__value">{revealed ? "—" : `${Math.round(score.accuracy * 100)}%`}</div><div className="stat-tile__label">当前准确率</div></div>
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
          placeholder={revealed ? "答案已显示——点「重新默写」清空重练" : "在此敲出命令，练肌肉记忆…"}
          aria-label="命令输入"
          readOnly={revealed}
          spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" />

        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
          {revealed ? (
            <button className="btn btn--primary" onClick={retype}>我记住了，重新默写</button>
          ) : (
            <>
              <button className="btn" onClick={next}>下一条 →</button>
              <button className="btn" onClick={clear}>清空</button>
              <button className="btn" onClick={reveal} title="看答案不计分，看完需重新默写">显示答案</button>
            </>
          )}
        </div>

        {score.complete && !revealed && (
          <p style={{ color: "var(--status-good)", fontWeight: 700, marginTop: "var(--space-3)" }} aria-live="polite">
            ✓ 命令敲对了！已计入完成
          </p>
        )}
      </div>
    </>
  );
}
