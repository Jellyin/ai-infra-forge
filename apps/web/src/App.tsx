import { useState } from "react";
import { paths } from "virtual:aiforge-content";
import type { PathContent } from "@aiforge/content-schema";
import { useProgress, useTheme } from "./hooks/useProgress.ts";
import Dashboard from "./components/Dashboard.tsx";
import PathView from "./components/PathView.tsx";
import Flashcards from "./components/Flashcards.tsx";
import CommandTrainer from "./components/CommandTrainer.tsx";
import Quiz from "./components/Quiz.tsx";

type Tab = "dashboard" | "path" | "flashcards" | "commands" | "quiz";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "dashboard", label: "仪表盘" },
  { id: "path", label: "学习路径" },
  { id: "flashcards", label: "闪卡复习" },
  { id: "commands", label: "命令训练" },
  { id: "quiz", label: "面试自测" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const { theme, setTheme } = useTheme();
  const progress = useProgress();
  const path: PathContent | undefined = paths[0];

  if (!path) return <div className="app-shell"><p className="empty">未发现学习路径内容</p></div>;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1 className="app-header__title">{path.title}</h1>
          <p className="app-header__subtitle">{path.subtitle}</p>
        </div>
        <div className="theme-toggle" role="radiogroup" aria-label="主题选择">
          {(["dark", "light", "system"] as const).map((t) => (
            <button key={t} className={`theme-toggle__btn ${theme === t ? "theme-toggle__btn--on" : ""}`}
              role="radio" aria-checked={theme === t} onClick={() => setTheme(t)}>
              {t === "dark" ? "暗" : t === "light" ? "亮" : "系"}
            </button>
          ))}
        </div>
      </header>

      <nav className="tabs" aria-label="模块导航">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "tab--active" : ""}`}
            onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined}>
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === "dashboard" && <Dashboard path={path} progress={progress} />}
        {tab === "path" && <PathView path={path} progress={progress} />}
        {tab === "flashcards" && <Flashcards path={path} progress={progress} />}
        {tab === "commands" && <CommandTrainer path={path} progress={progress} />}
        {tab === "quiz" && <Quiz path={path} progress={progress} />}
      </main>
    </div>
  );
}
