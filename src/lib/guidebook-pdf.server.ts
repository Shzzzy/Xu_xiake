import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { chromium, type APIResponse, type Page, type Route } from "playwright";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import type { TripPlan } from "./travel-plan.ts";

const PDF_RENDER_TIMEOUT_MS = 30_000;
const MAX_GUIDEBOOK_REDIRECTS = 5;
const ALLOWED_GUIDEBOOK_ASSET_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
] as const;

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isPrivateOrReservedIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const [first, second] = hostname.split(".").map(Number);

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateOrReservedIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase().split("%")[0];
  if (isIP(host) !== 6) return false;

  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/.test(host) ||
    host.startsWith("ff")
  );
}

function isBlockedGuidebookHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host === "metadata.azure.internal" ||
    host === "metadata.aws.internal"
  ) {
    return true;
  }

  return isPrivateOrReservedIpv4(host) || isPrivateOrReservedIpv6(host);
}

export function isGuidebookRequestAllowed(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    if (url.protocol !== "https:" || url.username || url.password) return false;

    const hostname = normalizeHostname(url.hostname);
    if (isBlockedGuidebookHost(hostname)) return false;

    return ALLOWED_GUIDEBOOK_ASSET_HOSTS.some(
      (allowedHost) => hostname === allowedHost || hostname.endsWith(`.${allowedHost}`),
    );
  } catch {
    return false;
  }
}

export function resolveGuidebookRedirect(
  currentUrlValue: string,
  locationValue: string,
): string | null {
  try {
    const currentUrl = new URL(currentUrlValue);
    if (!isGuidebookRequestAllowed(currentUrl.toString())) return null;

    const nextUrl = new URL(locationValue, currentUrl);
    if (nextUrl.protocol !== "https:" || !isGuidebookRequestAllowed(nextUrl.toString())) {
      return null;
    }
    return nextUrl.toString();
  } catch {
    return null;
  }
}

async function fetchGuidebookAsset(route: Route, startUrl: string): Promise<APIResponse | null> {
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount <= MAX_GUIDEBOOK_REDIRECTS; redirectCount += 1) {
    if (!isGuidebookRequestAllowed(currentUrl)) return null;

    const response = await route.fetch({ url: currentUrl, maxRedirects: 0 });
    const status = response.status();
    const location = response.headers()["location"];
    if (status < 300 || status >= 400 || !location) return response;

    const nextUrl = resolveGuidebookRedirect(currentUrl, location);
    if (!nextUrl) return null;
    currentUrl = nextUrl;
  }

  return null;
}

function hasAllowedRedirectChain(route: Route): boolean {
  let current = route.request().redirectedFrom();
  while (current) {
    if (!isGuidebookRequestAllowed(current.url())) return false;
    current = current.redirectedFrom();
  }
  return true;
}

export async function installGuidebookRequestGuard(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (!hasAllowedRedirectChain(route) || !isGuidebookRequestAllowed(requestUrl)) {
      await route.abort("blockedbyclient");
      return;
    }

    if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) {
      await route.continue();
      return;
    }

    try {
      const response = await fetchGuidebookAsset(route, requestUrl);
      if (!response) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.fulfill({ response });
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}

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

  const context = await browser.newContext({
    javaScriptEnabled: false,
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage();
    await installGuidebookRequestGuard(page);
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
    await context.close();
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
