import { Component, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * 渲染兜底。用途很具体：进度数据损坏（旧版本写坏 / 手工编辑 / 导入坏文件）时，
 * 某个 tab 组件可能抛错；没有边界的话 React 会卸载整棵树 → 白屏，连顶部「数据」
 * 入口也一起消失，用户无法导出/导入自救。这里只让出错的那块降级，保住自救通道。
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error("[aiforge] 渲染出错：", error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" role="alert">
        <h2 className="card__title">这一块渲染出错了</h2>
        <p className="card__subtitle">
          多半是本地学习数据损坏。可用右上角「数据」导出备份后清空进度，或直接导入一份完好的备份。
        </p>
        <p className="card__subtitle" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-2xs)", wordBreak: "break-all" }}>
          {this.state.error.message}
        </p>
        <button className="btn" onClick={() => this.setState({ error: null })}>重试渲染</button>
      </div>
    );
  }
}
