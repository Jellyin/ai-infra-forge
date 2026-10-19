import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { contentPlugin } from "@aiforge/content-schema/vite-plugin";
import { resolve } from "node:path";

// content-schema 包保持零 vite 依赖（结构类型手写），此处做一次类型桥接
const aiforgeContent = contentPlugin(resolve(__dirname, "../../content")) as unknown as Plugin;

/* GitHub Pages 是项目站，站点挂在 /ai-infra-forge/ 子路径下；不切 base 的话
   产出的 index.html 会引用 /assets/*，在 Pages 上 404 → 整页白屏。

   只有「构建产物」需要子路径：本地 dev、Docker/nginx 都是根路径部署，一律 "/"。
   这里必须带 command === "build"，光看 GITHUB_ACTIONS 不够 —— CI 的 E2E 也在同一个
   runner 上起 dev server（那个 job 里 GITHUB_ACTIONS 同样是 true），base 被切到
   /ai-infra-forge/ 后，按根路径取模块的测试会 404。 */
const pagesBase = (command: string) =>
  command === "build" && process.env.GITHUB_ACTIONS ? "/ai-infra-forge/" : "/";

export default defineConfig(({ command }) => ({
  base: pagesBase(command),
  plugins: [
    react(),
    aiforgeContent,
  ],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  build: {
    rollupOptions: {
      output: {
        /* 分包：react 运行时与内容数据各自成块。内容（30 天教程/实验）是体积主项，
           单独成块后更新内容不会让用户重下含 react 的 bundle，缓存命中率更高。 */
        manualChunks(id) {
          /* 正文模块（docs）必须排除在外，交给 Rollup 按动态 import 自动切分；
             若也归到 "content"，会把它和元数据合并回同一块，懒加载就白做了。 */
          if (id.includes("virtual:aiforge-content/docs")) return undefined;
          if (id.includes("virtual:aiforge-content")) return "content";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "vendor";
          return undefined;
        },
      },
    },
  },
}));
