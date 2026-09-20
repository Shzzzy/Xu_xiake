import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("开发服务提前退出（" + child.exitCode + "\n" + output());
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 服务尚未监听，继续轮询。
    }
    await delay(200);
  }
  throw new Error("等待开发服务超时\n" + output());
}

async function startDevServer(port) {
  const child = spawn(npmCommand(), ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, BROWSER_SMOKE_TIMEOUT_MS: String(START_TIMEOUT_MS) },
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
  const url = "http://127.0.0.1:" + port + "/";
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

test(
  "未知行程从结果页返回后保留步骤、同行、预算、时间和能源草稿",
  { timeout: 90_000 },
  async () => {
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
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);
      await page.waitForTimeout(1000);
      await page.getByRole("button", { name: /帮我决定去哪/ }).click();

      await page.getByRole("button", { name: "奇峰与山水" }).click();
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
      await page.getByLabel("成人数").waitFor({ state: "visible" });
      await page.getByLabel("成人数").fill("4");
      await page.getByLabel("儿童数").fill("2");
      await page.getByLabel("全团总预算").fill("8800");
      await page.getByLabel("每日出发时间").fill("08:30");
      await page.getByLabel("每日最晚结束时间").fill("20:30");
      await page.getByRole("button", { name: "纯电" }).click();

      await page.getByRole("button", { name: "生成旅行规划" }).click();
      await page.getByRole("button", { name: "返回调整" }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "返回调整" }).click();

      await page.getByText("问题 9 / 9").waitFor({ state: "visible" });
      assert.equal(await page.getByLabel("成人数").inputValue(), "4");
      assert.equal(await page.getByLabel("儿童数").inputValue(), "2");
      assert.equal(await page.getByLabel("全团总预算").inputValue(), "8800");
      assert.equal(await page.getByLabel("每日出发时间").inputValue(), "08:30");
      assert.equal(await page.getByLabel("每日最晚结束时间").inputValue(), "20:30");
      assert.equal(
        await page.getByRole("button", { name: "纯电" }).getAttribute("aria-pressed"),
        "true",
      );
    } finally {
      await browser?.close();
      await stopProcessTree(server?.child);
    }
  },
);
