import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { PathMeta } from "@aiforge/content-schema";
import { cardMastery, evaluateCompletion } from "@aiforge/logic";
import { quizKey, cardKey, checkKey, commandKey } from "../lib/keys.ts";
import type { useProgress } from "../hooks/useProgress.ts";

type Progress = ReturnType<typeof useProgress>;

function Quiz({ path, progress, onGoTab }: { path: PathMeta; progress: Progress; onGoTab?: (tab: string) => void }) {
  const { quiz, cards, commands, checklist, gradeQuiz } = progress;
  const [copied, setCopied] = useState(false);
  /** 剪贴板不可用时的降级：展示可手动复制 的只读文本块 */
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  /** 题列表筛选（30 天路径聚合后是长列表，需要「只看没答的」） */
  const [filter, setFilter] = useState<"all" | "unanswered" | "unknown">("all");

  /* 「已复制」提示的定时器在卸载/切 tab 后仍会 setState，这里统一清理 */
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);

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
        if (checklist[checkKey(path.id, m, i)]) checks++;
      }
    }
    return evaluateCompletion({
      quizKnown: flat.filter((x) => quiz[x.key] === "known").length,
      quizTotal: flat.length,
      cardsGood, cardsTotal, commandsDone, commandsTotal,
      checklistDone: checks, checklistTotal: checksTotal,
    });
  }, [path, flat, quiz, cards, commands, checklist]);

  if (!flat.length) return (
    <div>
      <h2 className="card__title">面试自测</h2>
      <p className="empty">本路径没有面试题
        {onGoTab && <> · <button className="btn" onClick={() => onGoTab("path")}>回到学习路径</button></>}
      </p>
    </div>
  );
  const known = flat.filter((x) => quiz[x.key] === "known").length;
  const answered = flat.filter((x) => quiz[x.key]).length;

  /* 筛选后的题目（保留原始题号，方便和内容侧对照） */
  const shown = flat
    .map((item, i) => ({ item, no: i + 1 }))
    .filter(({ item }) => filter === "all" || (filter === "unanswered" ? !quiz[item.key] : quiz[item.key] === "unknown"));

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
    // 非安全上下文（如 http://192.168.x.x:8080 的 Docker 部署）无 clipboard API——
    // 降级为展示可手动复制的只读文本块，绝不静默失败
    if (!navigator.clipboard?.writeText) {
      setFallbackText(proofText);
      return;
    }
    try {
      await navigator.clipboard.writeText(proofText);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFallbackText(proofText);
    }
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
            {fallbackText && (
              <div style={{ marginTop: "var(--space-3)" }}>
                <p className="card__subtitle" style={{ margin: "0 0 var(--space-1)" }}>
                  浏览器限制无法自动复制（非 HTTPS 环境）。请选中下方文本手动复制：
                </p>
                <textarea className="cmd-input" readOnly value={fallbackText} rows={8}
                  onFocus={(e) => e.target.select()} aria-label="通关证明文本，选中后可手动复制" />
                <button className="btn" onClick={() => setFallbackText(null)} style={{ marginTop: "var(--space-2)" }}>
                  收起
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="stat-grid" style={{ marginBottom: "var(--space-3)" }}>
        <div className="stat-tile"><div className="stat-tile__value">{known}/{flat.length}</div><div className="stat-tile__label">已掌握</div></div>
        <div className="stat-tile"><div className="stat-tile__value">{Math.round((known / flat.length) * 100)}%</div><div className="stat-tile__label">掌握率</div></div>
      </div>

      {/* 长列表筛选：只看没答的，避免在几十道题里滚动找 */}
      <div className="filter-chips" role="group" aria-label="题目筛选">
        {([
          ["all", `全部 ${flat.length}`],
          ["unanswered", `未作答 ${flat.length - answered}`],
          ["unknown", `不熟 ${flat.filter((x) => quiz[x.key] === "unknown").length}`],
        ] as const).map(([k, label]) => (
          <button key={k} className={`chip chip--action ${filter === k ? "chip--on" : ""}`}
            aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>

      <details className="quiz-item">
        <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 44, display: "flex", alignItems: "center" }}>
          如何使用
        </summary>
        <p className="quiz-item__a" style={{ borderLeftColor: "var(--series-3)" }}>
          先自己口头回答，再展开对答案，如实自评。自评「掌握」会提高你的面试掌握率。
        </p>
      </details>

      {shown.length === 0 && <p className="empty">这个筛选下没有题目</p>}

      {shown.map(({ item, no }) => {
        const g = quiz[item.key];
        return (
          <div className="quiz-item" key={item.key}>
            <p className="quiz-item__q">
              <span className="quiz-item__no" aria-hidden="true">{no}</span>
              {item.q}
            </p>
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

/* 五个 tab 常驻挂载：memo 配合 App 里的稳定回调，切 tab 时只重渲染目标面板 */
export default memo(Quiz);
