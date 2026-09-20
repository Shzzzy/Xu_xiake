import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";

const DEV_URL = process.env.XU_XIAKE_DEV_URL ?? "http://127.0.0.1:8082/";

function browserExecutable() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) return configured;
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) return bundled;
  return [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((candidate) => existsSync(candidate));
}

/**
 * 端到端验收：路书 PDF 必须在点击下载前就生成好，下载下来的文件体积正常。
 *
 * 需要本地开发服务已在运行（默认 8082）。
 */
test("结果页提前生成路书 PDF 并支持直接下载", { timeout: 300_000 }, async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("https://grok.com/grok-app-builder/extensions.js", (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
    );

    await page.goto(DEV_URL, { waitUntil: "networkidle", timeout: 120_000 });
    await page.waitForTimeout(1_500);
    await page.locator("button.choice-panel").filter({ hasText: "帮我决定去哪" }).click();
    const firstChoice = page.getByRole("button", { name: /奇峰与山水/ });
    await firstChoice.waitFor({ state: "visible", timeout: 60_000 });
    await firstChoice.click();
    await page.getByRole("button", { name: "3 天" }).click();
    await page.getByRole("button", { name: "适中" }).click();
    await page.getByRole("button", { name: "摄影与出片" }).click();
    await page.getByRole("button", { name: "上海" }).click();
    await page.getByText("STEP 6").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "继续" }).click();
    await page.getByText("STEP 7").waitFor({ state: "visible" });
    await page.getByLabel("交通上更看重什么？自定义答案").fill("自驾");
    await page.getByRole("button", { name: "继续" }).click();
    await page.getByText("STEP 8").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "单程 · 只去不回" }).click();
    await page.getByText("STEP 9").waitFor({ state: "visible" });
    await page.getByLabel("成人数").fill("2");
    await page.getByLabel("儿童数").fill("1");
    await page.getByLabel("全团总预算").fill("9000");
    await page.getByLabel("每日出发时间").fill("08:30");
    await page.getByLabel("每日最晚结束时间").fill("20:30");
    await page.getByRole("button", { name: "纯电" }).click();
    await page.getByRole("button", { name: "生成旅行规划" }).click();

    await page
      .locator('[aria-label="B 布局行程执行结果"]')
      .waitFor({ state: "visible", timeout: 120_000 });

    const readyButton = page.getByRole("button", { name: "下载路书 PDF" });
    const failedButton = page.getByRole("button", { name: "路书生成失败" });
    await Promise.race([
      readyButton.waitFor({ state: "visible", timeout: 240_000 }),
      failedButton.waitFor({ state: "visible", timeout: 240_000 }),
    ]);
    assert.equal(await failedButton.isVisible(), false, "路书生成失败，未进入可下载状态");
    assert.equal(await readyButton.isVisible(), true);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      readyButton.click(),
    ]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.ok(bytes.byteLength > 50_000, `PDF 体积过小：${bytes.byteLength}`);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "%PDF");
  } finally {
    await browser.close();
  }
});
