import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  fullyParallel: false,          // 共享 dev server + localStorage 隔离靠 context，串行最稳
  workers: 1,
  use: {
    baseURL: "http://localhost:5179",
    headless: true,
  },
  webServer: {
    command: "pnpm exec vite --port 5179 --strictPort",
    url: "http://localhost:5179",
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
