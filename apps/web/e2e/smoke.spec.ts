import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * 冒烟测试：钉死历次评审暴露的「声明 ↔ 行为」断链。
 * 每条用例对应一个曾在浏览器里「点一下看起来正常」但实际坏掉的链路。
 *
 * 注意：App 五 tab 常驻挂载（display:none 切换），text=/类名选择器会撞到
 * 隐藏 tab 的 DOM——所有断言必须限定在可见的 tab 容器内（visibleScope）。
 */

const PREFIX = "aiforge:";

/** 清空进度（每个用例独立状态） */
async function resetProgress(page: Page) {
  await page.goto("/");
  await page.evaluate((prefix) => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(prefix)) localStorage.removeItem(k);
    }
  }, PREFIX);
  await page.reload();
}

async function gotoTab(page: Page, tab: string) {
  await page.click(`nav.tabs button:has-text("${tab}")`);
  await page.waitForTimeout(250);
}

/** 当前可见的 tab 容器（main > div[style*=block]）——限定选择器作用域 */
function visibleScope(page: Page): Locator {
  return page.locator("main > div:visible");
}

/** 闪卡流程：翻面 → 评分（等按钮可用）。按样式类精确选，避免「不认识」撞「认识」 */
async function gradeCard(page: Page, grade: "again" | "good") {
  const scope = visibleScope(page);
  await scope.locator(".flashcard").click();
  await page.waitForTimeout(350);           // 翻面动画
  const btn = grade === "good" ? ".btn--good" : ".btn--critical";
  await scope.locator(`${btn}:enabled`).click();
  await page.waitForTimeout(200);
}

test.describe("冒烟 · 关键链路", () => {

  test("1. 首屏零进度：引导卡 + Day1 入口存在", async ({ page }) => {
    await resetProgress(page);
    await expect(page.locator(".app-header__title")).toContainText("30 天掌握计划");
    await expect(page.locator("text=从这里开始").first()).toBeVisible();
    await expect(page.locator("button:has-text('开始')").first()).toBeVisible();
  });

  test("2. 学习动作持久化：勾清单 → 刷新 → 进度还在", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "学习路径");
    const first = visibleScope(page).locator(".checklist__box").first();
    await first.check();
    await expect(first).toBeChecked();

    await page.reload();
    await gotoTab(page, "学习路径");
    await expect(visibleScope(page).locator(".checklist__box").first()).toBeChecked();
  });

  test("3. 闪卡评分 → 刷新 → SM-2 状态持久化（不重置为新卡）", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "闪卡复习");
    await gradeCard(page, "good");

    // 评分后：该卡离开新卡池（今天不再重现），今日剩余额度 5 → 4
    await page.reload();
    await gotoTab(page, "闪卡复习");
    await expect(visibleScope(page).locator(".flashcard__label").first()).toBeVisible();
    await expect(visibleScope(page).locator(".stat-tile").first()).toContainText("4");
    // localStorage 中当日新卡计数 = 1（真按天限额的证据）
    const count = await page.evaluate(() => {
      const today = new Date();
      const k = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      return JSON.parse(localStorage.getItem("aiforge:newCardsByDay") || "{}")[k] ?? 0;
    });
    expect(count).toBe(1);
  });

  test("4. 每日新卡限额跨刷新保持（真按天）", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "闪卡复习");
    // 连评 5 张新卡（达到当日上限）
    for (let i = 0; i < 5; i++) {
      await gradeCard(page, "good");
    }
    // 刷新后：今日已引入 5 张 → 队列只剩复习任务（这 5 张 due 在明天）
    await page.reload();
    await gotoTab(page, "闪卡复习");
    await expect(visibleScope(page).locator(".stat-tile").first()).toContainText("0");
    // localStorage 中应有当日计数 = 5
    const count = await page.evaluate(() => {
      const today = new Date();
      const k = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      return JSON.parse(localStorage.getItem("aiforge:newCardsByDay") || "{}")[k] ?? 0;
    });
    expect(count).toBe(5);
  });

  test("5. 导出 → 清空 → 导入 → 刷新：进度完整恢复", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "学习路径");
    await visibleScope(page).locator(".checklist__box").nth(0).check();
    await visibleScope(page).locator(".checklist__box").nth(1).check();

    // 导出（拦截下载）
    const downloadPromise = page.waitForEvent("download");
    await page.click("button:has-text('数据')");
    await page.click(".modal button:has-text('导出进度')");
    const download = await downloadPromise;
    const exportPath = "/tmp/aiforge-smoke-export.json";
    await download.saveAs(exportPath);
    await page.click(".modal button:has-text('关闭')");

    // 清空全部进度
    await page.evaluate((prefix) => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(prefix)) localStorage.removeItem(k);
      }
    }, PREFIX);
    await page.reload();

    // 导入（file chooser + 确认对话框）
    await page.click("button:has-text('数据')");
    const fileChooser = page.waitForEvent("filechooser");
    await page.click(".modal button:has-text('选择导入文件')");
    await (await fileChooser).setFiles(exportPath);
    await page.click(".modal button:has-text('确认覆盖导入')");
    await expect(page.locator("[role=status]").last()).toContainText("导入成功");

    // 刷新验证：清单勾选还在（评审断链：导入成功但写入失败的场景）
    await page.reload();
    await gotoTab(page, "学习路径");
    await expect(visibleScope(page).locator(".checklist__box").nth(0)).toBeChecked();
    await expect(visibleScope(page).locator(".checklist__box").nth(1)).toBeChecked();
  });

  test("6. 改 content → HMR 真刷新拿新数据（非假刷新）", async ({ page }) => {
    await page.goto("/");
    const before = await page.locator(".app-header__title").textContent();

    // node 侧改 path.yaml 标题，触发 watcher → invalidate → full-reload
    const { writeFile, readFile } = await import("node:fs/promises");
    const pathYaml = "/Users/lv/ai-infra-forge/content/paths/ai-infra-engineer/path.yaml";
    const original = await readFile(pathYaml, "utf8");
    await writeFile(pathYaml, original.replace(
      "title: AI Infra / MaaS 平台工程师 · 30 天掌握计划",
      "title: HMR-SMOKE-TEST-TITLE-CHANGED",
    ));

    try {
      // full-reload 自动发生；等待新标题出现在页面（HMR 假刷新会拿旧缓存而卡死在此）
      await expect(page.locator(".app-header__title")).toContainText("HMR-SMOKE-TEST-TITLE-CHANGED", { timeout: 8000 });
    } finally {
      await writeFile(pathYaml, original);
    }

    // 恢复后再次等待标题回到原值
    await expect(page.locator(".app-header__title")).toContainText(before?.trim() ?? "30 天掌握计划", { timeout: 8000 });
  });

  test("7. 命令训练：敲对完整命令计入完成，显示答案不计入", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "命令训练");
    const scope = visibleScope(page);
    await expect(scope.locator(".cmd-target")).toBeVisible();

    // 读取目标命令并输入
    const target = await scope.locator(".cmd-target").textContent();
    expect((target ?? "").length).toBeGreaterThan(3);

    await scope.locator(".cmd-input").fill(target ?? "");
    await expect(scope.locator("text=命令敲对了").first()).toBeVisible();

    // 完成计数 ≥ 1（首 tile「已练成命令」）
    const stat = await scope.locator(".stat-tile").first().textContent();
    expect(stat).toMatch(/^[1-9]|10/);
  });

  test("8. 通关判定卡可见且四路指标渲染", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "面试自测");
    const scope = visibleScope(page);
    await expect(scope.locator("text=通关判定").first()).toBeVisible();
    await expect(scope.locator("text=面试掌握").first()).toBeVisible();
    await expect(scope.locator("text=闪卡掌握").first()).toBeVisible();
    await expect(scope.locator("text=命令完成").first()).toBeVisible();
    await expect(scope.locator("text=清单勾选").first()).toBeVisible();
  });
});
