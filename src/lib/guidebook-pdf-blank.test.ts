import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import zlib from "node:zlib";
import { chromium } from "playwright";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import { renderGuidebookPdf } from "./guidebook-pdf.server.ts";
import { fixturePlan } from "./guidebook-html.server.test.ts";

const PNGSIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function browserExecutable(): string | undefined {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
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

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 解出 PNG 像素统计，用来判断第一页是否为空白纸张。 */
function pngStats(bytes: Buffer) {
  assert.ok(bytes.subarray(0, 8).equals(PNGSIG), "截图不是合法 PNG");
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  assert.ok(width > 0 && height > 0, "PNG 缺少尺寸信息");
  assert.equal(bitDepth, 8, "只支持 8 位 PNG 截图");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(channels > 0, `不支持的 PNG 颜色类型 ${colorType}`);

  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upLeft);
      else assert.equal(filter, 0, `未知 PNG 过滤器 ${filter}`);
      pixels[y * stride + x] = value & 0xff;
    }
  }

  let min = 255;
  let max = 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const unique = new Set<number>();
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      for (let channel = 0; channel < Math.min(3, channels); channel += 1) {
        const value = pixels[y * stride + x * channels + channel];
        min = Math.min(min, value);
        max = Math.max(max, value);
        sum += value;
        sumSq += value * value;
        count += 1;
        if (unique.size < 512) unique.add(value);
      }
    }
  }

  const mean = sum / count;
  return {
    width,
    height,
    min,
    max,
    mean,
    variance: sumSq / count - mean * mean,
    uniqueValues: unique.size,
  };
}

test("exported guidebook pdf renders a non-blank first page", async () => {
  const html = renderGuidebookHtml(fixturePlan);
  const pdf = await renderGuidebookPdf(html);
  assert.equal(Buffer.from(pdf.subarray(0, 4)).toString("ascii"), "%PDF");

  const artifactDir = join(tmpdir(), "xu-xiake-pdf-qa");
  mkdirSync(artifactDir, { recursive: true });
  const pdfPath = join(artifactDir, "guidebook-first-page-check.pdf");
  writeFileSync(pdfPath, pdf);

  const executablePath = browserExecutable();
  assert.ok(executablePath, "需要 Chromium、Chrome 或 Edge 才能做 PDF 内容断言");
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    try {
      await page.goto(pathToFileURL(pdfPath).toString(), { waitUntil: "load" });
    } catch {
      // Edge 内置 PDF 阅读器可能中止导航，但页面已经渲染，继续截图即可。
    }
    await page.waitForTimeout(4_000);
    const screenshot = await page.screenshot({ type: "png" });
    const stats = pngStats(screenshot);
    const statsPath = join(artifactDir, "guidebook-first-page-stats.json");
    writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");

    assert.ok(
      stats.uniqueValues >= 24,
      `PDF 首屏疑似空白：不同灰度仅 ${stats.uniqueValues} 种（${statsPath}）`,
    );
    assert.ok(
      stats.variance >= 40,
      `PDF 首屏疑似空白：像素方差仅 ${stats.variance.toFixed(1)}（${statsPath}）`,
    );
  } finally {
    await browser.close();
  }
});
