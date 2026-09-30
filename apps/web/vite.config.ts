import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { contentPlugin } from "@aiforge/content-schema/vite-plugin";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    contentPlugin(resolve(__dirname, "../../content")),
  ],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
