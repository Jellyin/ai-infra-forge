import { useState, useEffect, useCallback } from "react";
import { paths } from "virtual:aiforge-content";
import type { PathContent } from "@aiforge/content-schema";
import { useProgress, useTheme } from "./hooks/useProgress.ts";
import Dashboard from "./components/Dashboard.tsx";
import PathView from "./components/PathView.tsx";
import Flashcards from "./components/Flashcards.tsx";
import CommandTrainer from "./components/CommandTrainer.tsx";
import Quiz from "./components/Quiz.tsx";
import DataPanel from "./components/DataPanel.tsx";

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
  const { theme, setTheme } = useTheme();
  const progress = useProgress();
  const path: PathContent | undefined = paths[0];

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

  if (!path) return <div className="app-shell"><p className="empty">未发现学习路径内容</p></div>;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1 className="app-header__title">{path.title}</h1>
          <p className="app-header__subtitle">{path.subtitle}</p>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <button className="btn" onClick={() => setShowData(true)} aria-label="管理学习数据"
            style={{ minHeight: 40, padding: "0 var(--space-3)", fontSize: "var(--fs-xs)" }}>
            数据
          </button>
          <div className="theme-toggle" role="radiogroup" aria-label="主题选择">
            {(["dark", "light", "system"] as const).map((t) => (
              <button key={t} className={`theme-toggle__btn ${theme === t ? "theme-toggle__btn--on" : ""}`}
                role="radio" aria-checked={theme === t} onClick={() => setTheme(t)}>
                {t === "dark" ? "暗" : t === "light" ? "亮" : "系"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="模块导航">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "tab--active" : ""}`}
            onClick={() => go(t.id)} aria-current={tab === t.id ? "page" : undefined}>
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {/* 五 tab 常驻挂载、display 切换：切 tab 不丢闪卡翻面/命令输入等会话状态（评审 P1-2） */}
        <div style={{ display: tab === "dashboard" ? "block" : "none" }}>
          <Dashboard path={path} progress={progress} onGoTab={(t) => go(t as Tab)} onOpenModule={openModule} />
        </div>
        <div style={{ display: tab === "path" ? "block" : "none" }}>
          <PathView path={path} progress={progress} openModuleId={openModuleId} onModuleOpened={() => setOpenModuleId(null)} />
        </div>
        <div style={{ display: tab === "flashcards" ? "block" : "none" }}>
          <Flashcards path={path} progress={progress} />
        </div>
        <div style={{ display: tab === "commands" ? "block" : "none" }}>
          <CommandTrainer path={path} progress={progress} />
        </div>
        <div style={{ display: tab === "quiz" ? "block" : "none" }}>
          <Quiz path={path} progress={progress} />
        </div>
      </main>

      {showData && <DataPanel progress={progress} onClose={() => setShowData(false)} />}
    </div>
  );
}
