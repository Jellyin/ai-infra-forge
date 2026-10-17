/* 主题初始化：必须在首屏绘制前同步执行，避免浅色用户闪一帧暗色（FOUC）。
 *
 * 放在外部文件而非内联，是为了能用严格 CSP（script-src 'self' 不允许内联脚本）。
 * 解析规则与 src/hooks/useProgress.ts 的 useTheme 完全一致：
 * 把 "system" 落成显式 data-theme，并同步 <meta name="theme-color">。
 */
(function () {
  try {
    var t = localStorage.getItem("aiforge:theme");
    if (t !== "light" && t !== "dark") {
      t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", t === "light" ? "#f9f9f7" : "#0d0d0d");
  } catch (e) {
    /* 隐私模式下 localStorage 抛错：退回默认暗色即可 */
  }
})();
