import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { chromium } from "playwright";

const ROOT = process.cwd();
const START_TIMEOUT_MS = 45_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

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

/** 反复点击直到目标出现：冷启动的开发服务里 React 水合完成时间不确定。 */
async function clickUntilVisible(button, expected, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await button.click({ timeout: 15_000 }).catch(() => {});
    if ((await expected.count()) > 0) return;
    await delay(400);
  }
  throw new Error("点击后界面没有进入下一步，可能是水合尚未完成");
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`开发服务提前退出（${child.exitCode}）\n${output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 服务尚未监听，继续轮询。
    }
    await delay(200);
  }
  throw new Error(`等待开发服务超时\n${output()}`);
}

async function startDevServer(port) {
  const child = spawn(npmCommand(), ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BROWSER_SMOKE_TIMEOUT_MS: String(START_TIMEOUT_MS),
      // 强制走真实管家排程链路，而不是依赖外部碰巧设置的环境变量。
      BUTLER_PLANNER: "1",
      AMAP_E2E_FIXTURE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32",
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const url = `http://127.0.0.1:${port}/`;
  await waitForServer(url, child, () => output);
  return { child, url };
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("真实向导输出逐页路书预览且移动端无溢出", { timeout: 300_000 }, async () => {
  const port = await reservePort();
  let server = null;
  let browser = null;

  try {
    server = await startDevServer(port);
    const executablePath = browserExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    mkdirSync("screenshots", { recursive: true });
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    // 平台注入脚本依赖线上域名，测试中返回空脚本，避免把外部网络问题计为应用错误。
    await page.route("https://grok.com/grok-app-builder/extensions.js", (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
    );

    await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const entryButton = page.getByRole("button", { name: /帮我决定去哪/ });
    const destinationChoice = page.getByRole("button", { name: "奇峰与山水" });
    await clickUntilVisible(entryButton, destinationChoice);
    await destinationChoice.click();
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

    // 结果页现在就是路书：页面逐页流式到达，全部就绪后才允许导出 PDF。
    // 真实链路必须配置 DEEPSEEK/TAVILY；缺配置时不允许把回退行程当成通过。
    const configMissing = page.getByText(/缺少配置/);
    try {
      await page.getByText("逐页生成你的路书").waitFor({ state: "visible", timeout: 60_000 });
    } catch (error) {
      if ((await configMissing.count()) > 0) {
        const message = await configMissing.first().innerText();
        throw new Error(`真实管家链路缺少配置：${message}`);
      }
      throw error;
    }
    await page
      .getByText(/路书已就绪 · 共 \d+ 页/)
      .waitFor({ state: "visible", timeout: 180_000 });

    const guidebookFrame = page
      .frames()
      .find((frame) => frame !== page.mainFrame() && frame.url() === "about:blank");
    assert.ok(guidebookFrame, "路书预览 iframe 应存在");
    const guidebookPageCount = await guidebookFrame.locator("section.page").count();
    assert.ok(guidebookPageCount >= 9, `路书页数应不少于 9 页，实际 ${guidebookPageCount} 页`);
    await guidebookFrame.getByText("换乘").first().waitFor({ state: "visible", timeout: 30_000 });
    await guidebookFrame.getByText("全团总预算").first().waitFor({ state: "visible", timeout: 30_000 });
    // 结尾走并行生成的 AI 回望（服务端拼路线总结/评价/寄语），不再是旧的兜底文案。
    await guidebookFrame.getByText(/路线总结/).first().waitFor({ state: "visible", timeout: 60_000 });

    // 摘要与逐日页必须同源：从路书总览页「核心亮点」读取景点名，
    // 摘要至少包含其中一个，且每个亮点都出现在每日导航/时间轴页里。
    const overviewPage = guidebookFrame.locator('section.page[data-page="overview"]');
    await overviewPage.getByText("核心亮点").waitFor({ state: "visible", timeout: 30_000 });
    const highlightNames = (await overviewPage.locator("ul.highlight-list li span").allInnerTexts())
      .map((name) => name.replace(/\s+/g, ""))
      .filter(Boolean);
    assert.ok(highlightNames.length > 0, "路书总览页应包含核心亮点列表");

    const summary = (await page.locator("section.result-hero p").first().innerText()).replace(
      /\s+/g,
      "",
    );

    // 摘要与排程双向跨源校验：总览核心亮点必须全部出现在摘要里。
    for (const name of highlightNames) {
      assert.ok(
        summary.includes(name),
        `摘要必须包含核心亮点「${name}」，摘要：${summary}`,
      );
    }

    const dayPages = guidebookFrame.locator(
      "section.page.day-map-page, section.page.day-timeline-page",
    );
    const dayTexts = (await dayPages.allInnerTexts()).map((text) => text.replace(/\s+/g, ""));
    for (const name of highlightNames) {
      assert.ok(
        dayTexts.some((text) => text.includes(name)),
        `核心亮点「${name}」应出现在每日页时间轴/内容中`,
      );
    }

    // 真实跨源：从每日执行页提取已排景点名，与摘要和总览双向比对。
    const scheduledNames = [
      ...new Set(
        (
          await guidebookFrame
            .locator(
              "section.page.day-timeline-page li.timeline-item.node-attraction .timeline-card-title strong",
            )
            .allInnerTexts()
        )
          .map((name) => name.replace(/\s+/g, ""))
          .filter(Boolean),
      ),
    ];
    assert.ok(scheduledNames.length > 0, "每日执行页应包含景点节点");
    for (const name of scheduledNames) {
      assert.ok(summary.includes(name), `摘要缺少已排景点「${name}」，摘要：${summary}`);
      assert.ok(
        highlightNames.includes(name),
        `总览核心亮点缺少已排景点「${name}」，亮点：${highlightNames.join("、")}`,
      );
    }

    // 若结果页出现「未满足你设定的条件」提示条，路书里也必须渲染对应执行提醒。
    const constraintBanner = page.getByText(/未满足你设定的条件/);
    if ((await constraintBanner.count()) > 0) {
      assert.ok(
        (await guidebookFrame.getByText(/未满足条件/).count()) > 0,
        "提示条与路书执行提醒必须一致",
      );
    }

    const exportButton = page.getByRole("button", { name: "生成路书 PDF" });
    await exportButton.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await exportButton.isEnabled(), true, "路书就绪后导出按钮应可用");

    await page.screenshot({ path: "screenshots/task-6-plan-output-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert.ok(horizontalOverflow <= 0, `移动端横向溢出 ${horizontalOverflow}px`);
    mkdirSync("screenshots", { recursive: true });
    await page.screenshot({ path: "screenshots/task-6-plan-output-mobile.png", fullPage: true });
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser?.close();
    await stopProcessTree(server?.child);
  }
});
