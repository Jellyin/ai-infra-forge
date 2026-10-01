import { test, expect, type Page, type Locator } from "@playwright/test";
import { writeFileSync } from "node:fs";

/**
 * 补全 e2e：钉住冒烟之外的高价值行为盲区。
 * 约定（与 smoke.spec.ts 相同）：五 tab 常驻挂载 display:none——
 * 所有断言必须限定在 visibleScope（main > div:visible）内，避免撞隐藏 tab 的 DOM。
 */

const PREFIX = "aiforge:";

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

function visibleScope(page: Page): Locator {
  return page.locator("main > div:visible");
}

async function gradeCard(page: Page, grade: "again" | "good") {
  const scope = visibleScope(page);
  await scope.locator(".flashcard").click();
  await page.waitForTimeout(350);           // 翻面动画
  const btn = grade === "good" ? ".btn--good" : ".btn--critical";
  await scope.locator(`${btn}:enabled`).click();
  await page.waitForTimeout(200);
}

/** 读取 localStorage 中当日新卡引入计数（真按天限额的证据） */
async function todayNewCardCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const today = new Date();
    const k = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return JSON.parse(localStorage.getItem("aiforge:newCardsByDay") || "{}")[k] ?? 0;
  });
}

/** 生成合法导出文件内容（schema:1，与 useProgress.exportData 同构） */
function exportFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    exportedAt: new Date().toISOString(),
    checklist: {}, cards: {}, commands: {}, quiz: {}, activity: {}, newCardsByDay: {},
    ...overrides,
  }, null, 2);
}

/** 走完整导入流程（选择文件 → 确认覆盖） */
async function importFile(page: Page, path: string) {
  await page.click("button:has-text('数据')");
  const fileChooser = page.waitForEvent("filechooser");
  await page.click(".modal button:has-text('选择导入文件')");
  await (await fileChooser).setFiles(path);
  await page.click(".modal button:has-text('确认覆盖导入')");
}

test.describe("补全 · 数据完整性（导入的脏数据路径）", () => {

  test("9. 导入 schema 不符的文件被拒绝且当前进度不受损", async ({ page }) => {
    await resetProgress(page);
    // 先制造一点进度
    await gotoTab(page, "学习路径");
    await visibleScope(page).locator(".checklist__box").nth(0).check();

    // 写一个 schema 版本错误的文件（未来版本 / 手改文件）
    const futureFile = "/tmp/aiforge-gaps-schema.json";
    writeFileSync(futureFile, exportFile({ schema: 2 }));
    await importFile(page, futureFile);
    await expect(page.locator("[role=status]").last()).toContainText("未知的 schema 版本");
    // 进度不受损：刷新后勾选仍在（拒绝发生在任何写入之前）
    await page.reload();
    await gotoTab(page, "学习路径");
    await expect(visibleScope(page).locator(".checklist__box").nth(0)).toBeChecked();
  });

  test("10. 导入非 JSON 文件被拒绝且给出明确错误，模态框不误关闭", async ({ page }) => {
    await resetProgress(page);
    const notJson = "/tmp/aiforge-gaps-notjson.json";
    writeFileSync(notJson, "这不是 JSON{{{");
    await importFile(page, notJson);
    await expect(page.locator("[role=status]").last()).toContainText("JSON 解析失败");
    await expect(page.locator(".modal")).toBeVisible();
  });

  test("11. 导入空进度文件（无 checklist/cards/commands）被拒绝", async ({ page }) => {
    await resetProgress(page);
    const emptyFile = "/tmp/aiforge-gaps-empty.json";
    writeFileSync(emptyFile, JSON.stringify({ schema: 1, quiz: {} }));
    await importFile(page, emptyFile);
    await expect(page.locator("[role=status]").last()).toContainText("没有进度数据");
  });

  test("12. 导入含非法字段类型的脏 cards → 剔除并提示（字段级校验已修）", async ({ page }) => {
    // importData 逐字段 Number 校验：坏条目剔除并计数回报，不再静默写入。
    // 历史缺陷链（字符串 ease → good 拼接 "2.50.1" → NaN due → 卡冻结 waiting）已阻断。
    await resetProgress(page);
    const dirtyFile = "/tmp/aiforge-gaps-dirty.json";
    writeFileSync(dirtyFile, exportFile({
      cards: {
        "ai-infra-engineer:day01:day01-c1": { reps: "3", interval: 10, ease: "2.5", due: 100 },
      },
    }));
    await importFile(page, dirtyFile);
    await expect(page.locator("[role=status]").last()).toContainText("导入成功（跳过 1 条格式异常的数据）");
    // 脏条目被剔除，不进 localStorage
    const raw = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("aiforge:cards") || "{}"));
    expect(raw["ai-infra-engineer:day01:day01-c1"]).toBeUndefined();
  });
});

test.describe("补全 · 命令训练计分", () => {

  test("13. 退格重敲不重复计分；揭示答案后重默写成功才再计分", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "命令训练");
    const scope = visibleScope(page);
    await expect(scope.locator(".cmd-target")).toBeVisible();

    const target = (await scope.locator(".cmd-target").textContent()) ?? "";
    expect(target.length).toBeGreaterThan(3);

    // 完整敲对一次 → 首 tile（已练成命令）1/10
    await scope.locator(".cmd-input").fill(target);
    await expect(scope.locator("text=命令敲对了").first()).toBeVisible();
    await expect(scope.locator(".stat-tile").first()).toContainText("1/10");

    // 退格到一半再敲回 → 不重复计数（countedRef 防刷分）
    await scope.locator(".cmd-input").fill(target.slice(0, 3));
    await scope.locator(".cmd-input").fill(target);
    await expect(scope.locator(".stat-tile").first()).toContainText("1/10");

    // 揭示答案（此时不计分）→ 重新默写成功 → 本命令完成次数 +1（真实掌握信号）
    await scope.locator("button:has-text('显示答案')").click();
    await expect(scope.locator("button:has-text('重新默写')")).toBeVisible();
    await scope.locator("button:has-text('重新默写')").click();
    await scope.locator(".cmd-input").fill(target);
    await expect(scope.locator("text=命令敲对了").first()).toBeVisible();
    // distinct 完成数不变（同一条命令），完成次数 tile（第 3 个）= 2
    await expect(scope.locator(".stat-tile").first()).toContainText("1/10");
    await expect(scope.locator(".stat-tile").nth(2)).toContainText("2");
  });

  test("14. 首条命令敲对即持久化，刷新后完成数仍在（跨会话）", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "命令训练");
    const scope = visibleScope(page);
    const target = (await scope.locator(".cmd-target").textContent()) ?? "";
    await scope.locator(".cmd-input").fill(target);
    await expect(scope.locator(".stat-tile").first()).toContainText("1/10");

    await page.reload();
    await gotoTab(page, "命令训练");
    await expect(visibleScope(page).locator(".stat-tile").first()).toContainText("1/10");
  });
});

test.describe("补全 · Markdown 渲染（历史 bug 回归）", () => {

  test("15. 表格渲染为真正 table、pre 配对闭合、代码块与后续内容完整（嵌套未闭合 pre 吞内容回归）", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "学习路径");
    const scope = visibleScope(page);

    // Day1 默认展开，直接打开教程
    await scope.locator("button:has-text('阅读教程')").first().click();
    await page.waitForTimeout(300);

    const body = scope.locator(".md-body").first();
    await expect(body).toBeVisible();

    // 历史回归 1：表格必须渲染为真正的 <table>（曾有表格文本被吞进未闭合 pre）
    const table = body.locator("table");
    await expect(table).toHaveCount(1);
    await expect(table.locator("th")).toHaveCount(4);
    await expect(table.locator("th").first()).toContainText("指标");
    await expect(table.locator("td").first()).toContainText("TTFT");
    await expect(table).toContainText("整体多久出完");      // 表格最后一格文案完整
    await expect(body).toContainText("一个请求总耗时");      // 表格之后紧跟的段落不被吞

    // 历史回归 2：所有 pre 配对闭合，首尾代码块内容完整（早期 bug：后续内容全部被吞）
    const preCount = await body.locator("pre").count();
    expect(preCount).toBeGreaterThanOrEqual(4);
    await expect(body.locator("pre").first()).toContainText("请求 → 网关");
    await expect(body).toContainText("KV Cache 显存 ≈");   // 最后一个代码块的内容
    // pre 内不得嵌套表格（吞内容的典型症状）
    await expect(body.locator("pre table")).toHaveCount(0);
  });
});

test.describe("补全 · 闪卡撤销与限额交互", () => {

  test("16. 误评 good 后撤销 → 卡回到队首重出，当日额度回补（缺陷已修）", async ({ page }) => {
    // Flashcards.undo 恢复卡片状态 + 回补 newCardsByDay（undoNewCard）——
    // 误评撤销后当日额度不再被幽灵消耗。
    await resetProgress(page);
    await gotoTab(page, "闪卡复习");
    const scope = visibleScope(page);
    const frontBefore = await scope.locator(".flashcard__front-text").first().textContent();

    // 评一张 good（引入 1 张新卡，消耗 1 个今日额度）
    await gradeCard(page, "good");
    await expect(scope.locator(".stat-tile").first()).toContainText("4");
    expect(await todayNewCardCount(page)).toBe(1);

    // 撤销 → 同一张卡回到队首重新出现（卡片状态确实恢复了）
    await scope.locator("button:has-text('撤销上一评')").click();
    await page.waitForTimeout(200);
    await expect(scope.locator(".flashcard__front-text").first()).toHaveText(frontBefore ?? "");

    // 额度已回补——计数归 0，剩余额度恢复 5
    expect(await todayNewCardCount(page)).toBe(0);
    await expect(scope.locator(".stat-tile").first()).toContainText("5");

    // 刷新后仍然如此（持久化层面也回补了）
    await page.reload();
    await gotoTab(page, "闪卡复习");
    await expect(visibleScope(page).locator(".stat-tile").first()).toContainText("5");
    expect(await todayNewCardCount(page)).toBe(0);
  });

  test("17. again 不消耗当日新卡额度（「不认识」的卡当天重学、明天还是新卡语义）", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "闪卡复习");

    await gradeCard(page, "again");
    // again 不计引入：额度计数 = 0
    expect(await todayNewCardCount(page)).toBe(0);
    // 队列剩余 = 5 张限额内新卡 + 1 张当天重学卡（again 的卡 due=now，回到到期队列）= 6
    await expect(visibleScope(page).locator(".stat-tile").first()).toContainText("6");
  });

  test("18. 评 good 后掌握度三档统计联动（112 卡：学习中 1 / 未开始 111）", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "闪卡复习");
    await gradeCard(page, "good");

    const tiles = visibleScope(page).locator(".stat-tile");
    await expect(tiles.nth(0)).toContainText("4");    // 本次剩余（额度 5-1）
    await expect(tiles.nth(1)).toContainText("0");    // 已掌握（good 1 次，reps=1 尚未掌握）
    await expect(tiles.nth(2)).toContainText("1");    // 学习中
    await expect(tiles.nth(3)).toContainText("111");  // 未开始 112-1
  });
});

test.describe("补全 · 面试自测与通关判定联动", () => {

  test("19. 全部自评掌握 → 面试路 ✓ 100%，其余三路 ✗，综合分 30（缺失维度计 0 分）", async ({ page }) => {
    await resetProgress(page);
    await gotoTab(page, "面试自测");
    const scope = visibleScope(page);

    // 全部 10 题自评掌握
    const knownButtons = scope.locator("button.btn--good", { hasText: "掌握" });
    await knownButtons.first().waitFor({ state: "visible" });
    expect(await knownButtons.count()).toBe(20);   // day10 10 题 + day29 10 题
    for (let i = 0; i < 20; i++) {
      await knownButtons.nth(i).click();
    }

    // 面试题统计：已掌握 10/10、掌握率 100%
    await expect(scope.locator(".stat-tile").first()).toContainText("20/20");
    await expect(scope.locator(".stat-tile").nth(1)).toContainText("100%");

    // 通关判定卡：标题仍是「通关判定」（未通关）
    await expect(scope.locator(".card__title").first()).toContainText("通关判定");
    // 四路指标：quiz ✓，cards/commands/checklist ✗
    await expect(scope.locator("span[aria-hidden]").filter({ hasText: "✓" })).toHaveCount(1);
    await expect(scope.locator("span[aria-hidden]").filter({ hasText: "✗" })).toHaveCount(3);
    // 综合分 = round(0.3 × 1.0 × 100) = 30（缺失维度计 0 分的可见后果）
    await expect(scope.locator(".card").first().locator(".stat-tile__value").first()).toHaveText("30");
  });
});
