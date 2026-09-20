import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import type { TripPlan } from "./travel-plan.ts";

const PDF_RENDER_TIMEOUT_MS = 30_000;

function chromiumExecutablePath(): string | undefined {
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

export type GuidebookPdfRenderer = (html: string) => Promise<Uint8Array>;

export type GuidebookExportResult =
  | {
      status: "ok";
      pdfBase64: string;
      filename: string;
    }
  | {
      status: "html";
      html: string;
      message: string;
    };

export async function renderGuidebookPdf(html: string): Promise<Uint8Array> {
  const executablePath = chromiumExecutablePath();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, {
      waitUntil: "networkidle",
      timeout: PDF_RENDER_TIMEOUT_MS,
    });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}

function guidebookFilename(plan: TripPlan): string {
  const rawName = plan.meta.title.trim() || plan.meta.destination.trim() || "旅行路书";
  const routeName = Array.from(rawName, (character) =>
    character.charCodeAt(0) < 32 ? "_" : character,
  )
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return `${routeName || "旅行路书"}_guidebook.pdf`;
}

function fallbackMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail
    ? `PDF 生成失败，已改为可打印 HTML：${detail}`
    : "PDF 生成失败，已改为可打印 HTML。";
}

export async function exportGuidebookForTest(
  plan: TripPlan,
  dependencies: { renderPdf: GuidebookPdfRenderer },
): Promise<GuidebookExportResult> {
  const html = renderGuidebookHtml(plan);

  try {
    const pdf = await dependencies.renderPdf(html);
    return {
      status: "ok",
      pdfBase64: Buffer.from(pdf).toString("base64"),
      filename: guidebookFilename(plan),
    };
  } catch (error) {
    return {
      status: "html",
      html,
      message: fallbackMessage(error),
    };
  }
}
