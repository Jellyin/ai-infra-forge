import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { contentPlugin } from "@aiforge/content-schema/vite-plugin";
import { resolve } from "node:path";

// content-schema 包保持零 vite 依赖（结构类型手写），此处做一次类型桥接
const aiforgeContent = contentPlugin(resolve(__dirname, "../../content")) as unknown as Plugin;

export default defineConfig({
  plugins: [
    react(),
    aiforgeContent,
  ],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
