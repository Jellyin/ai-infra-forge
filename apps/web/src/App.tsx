import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { paths } from "virtual:aiforge-content";
import type { PathMeta } from "@aiforge/content-schema";
import { useProgress, useTheme } from "./hooks/useProgress.ts";
import Dashboard from "./components/Dashboard.tsx";
import PathView from "./components/PathView.tsx";
import Flashcards from "./components/Flashcards.tsx";
import CommandTrainer from "./components/CommandTrainer.tsx";
import Quiz from "./components/Quiz.tsx";
import DataPanel from "./components/DataPanel.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

type Tab = "dashboard" | "path" | "flashcards" | "commands" | "quiz";

const TABS: Array<{ id: Tab; label: string; hash: string }> = [
  { id: "dashboard", label: "仪表盘", hash: "dashboard" },
  { id: "path", label: "学习路径", hash: "path" },
  { id: "flashcards", label: "闪卡复习", hash: "flashcards" },
  { id: "commands", label: "命令训练", hash: "commands" },
  { id: "quiz", label: "面试自测", hash: "quiz" },
];

/** 从 location.hash 恢复 tab（评审 P1-2：刷新/返回不丢位置） */
function tabFromHash(): Tab {
  const h = location.hash.replace(/^#\/?/, "");
  const found = TABS.find((t) => t.hash === h);
  return found ? found.id : "dashboard";
}

export default function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [openModuleId, setOpenModuleId] = useState<string | null>(null);
  const [showData, setShowData] = useState(false);
  /** 当前学习路径。多路径时在 header 切换（进度 key 自带 path 维度，天然隔离） */
  const [pathIdx, setPathIdx] = useState(0);
  const { theme, setTheme } = useTheme();
  const progress = useProgress();
  const path: PathMeta | undefined = paths[pathIdx] ?? paths[0];

  /* hash 路由同步：浏览器返回/前进键可用 */
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((t: Tab) => {
    const entry = TABS.find((x) => x.id === t);
    if (entry) location.hash = `/${entry.hash}`;
    setTab(t);
  }, []);

  /** 仪表盘 → 展开某模块：切到 path tab 并请求展开 */
  const openModule = useCallback((id: string) => {
    setOpenModuleId(id);
    go("path");
  }, [go]);

  /* 稳定的回调引用：内联箭头函数每次渲染都是新值，会让子组件的 memo 完全失效 */
  const goTab = useCallback((t: string) => go(t as Tab), [go]);
  const closeModule = useCallback(() => setOpenModuleId(null), []);

  /* tablist 的键盘模型（WAI-ARIA）：左右方向键 / Home / End 在 tab 间移动并激活 */
  const onTabKey = useCallback((e: ReactKeyboardEvent, id: Tab) => {
    const i = TABS.findIndex((x) => x.id === id);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length
      : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    const t = TABS[next]!;
    go(t.id);
    document.getElementById(`tab-${t.id}`)?.focus();
  }, [go]);

  if (!path) return <div className="app-shell"><p className="empty">未发现学习路径内容</p></div>;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1 className="app-header__title">{path.title}</h1>
          <p className="app-header__subtitle">{path.subtitle}</p>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          {/* 多路径时才出现：内容即数据，加一条路径不该需要改代码 */}
          {paths.length > 1 && (
            <select className="path-select" value={pathIdx} aria-label="选择学习路径"
              onChange={(e) => setPathIdx(Number(e.target.value))}>
              {paths.map((p, i) => <option key={p.id} value={i}>{p.title}</option>)}
            </select>
          )}
          <button className="btn" onClick={() => setShowData(true)} aria-label="管理学习数据"
            style={{ minHeight: 44, padding: "0 var(--space-3)", fontSize: "var(--fs-xs)" }}>
            数据
          </button>
          {/* 用 aria-pressed 的普通按钮组，而不是声明成 radiogroup 却不实现方向键导航
              （语义与行为必须一致）；按钮名也从「暗/亮/系」改成完整可读的标签。 */}
          <div className="theme-toggle" role="group" aria-label="主题选择">
            {([["dark", "深色主题", "暗"], ["light", "浅色主题", "亮"], ["system", "跟随系统", "系"]] as const).map(([t, label, short]) => (
              <button key={t} className={`theme-toggle__btn ${theme === t ? "theme-toggle__btn--on" : ""}`}
                aria-pressed={theme === t} aria-label={label} title={label} onClick={() => setTheme(t)}>
                {short}
              </button>
            ))}
          </div>
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="模块导航">
        {TABS.map((t) => (
          <button key={t.id} id={`tab-${t.id}`} role="tab"
            aria-selected={tab === t.id} aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`tab ${tab === t.id ? "tab--active" : ""}`}
            onClick={() => go(t.id)} onKeyDown={(e) => onTabKey(e, t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {/* 五 tab 常驻挂载、hidden 切换：切 tab 不丢闪卡翻面/命令输入等会话状态（评审 P1-2）。
            每个面板各包一层 ErrorBoundary —— 常驻挂载意味着一处抛错会连累其余 tab，
            分开兜底才能只降级出错的那一块，保住顶部「数据」自救入口。 */}
        <div id="panel-dashboard" role="tabpanel" aria-labelledby="tab-dashboard" hidden={tab !== "dashboard"}>
          <ErrorBoundary>
            <Dashboard path={path} progress={progress} onGoTab={goTab} onOpenModule={openModule} />
          </ErrorBoundary>
        </div>
        <div id="panel-path" role="tabpanel" aria-labelledby="tab-path" hidden={tab !== "path"}>
          <ErrorBoundary>
            <PathView path={path} progress={progress} openModuleId={openModuleId} onModuleOpened={closeModule} />
          </ErrorBoundary>
        </div>
        <div id="panel-flashcards" role="tabpanel" aria-labelledby="tab-flashcards" hidden={tab !== "flashcards"}>
          <ErrorBoundary>
            <Flashcards path={path} progress={progress} onGoTab={goTab} />
          </ErrorBoundary>
        </div>
        <div id="panel-commands" role="tabpanel" aria-labelledby="tab-commands" hidden={tab !== "commands"}>
          <ErrorBoundary>
            <CommandTrainer path={path} progress={progress} onGoTab={goTab} />
          </ErrorBoundary>
        </div>
        <div id="panel-quiz" role="tabpanel" aria-labelledby="tab-quiz" hidden={tab !== "quiz"}>
          <ErrorBoundary>
            <Quiz path={path} progress={progress} onGoTab={goTab} />
          </ErrorBoundary>
        </div>
      </main>

      {showData && <DataPanel progress={progress} onClose={() => setShowData(false)} />}
    </div>
  );
}
