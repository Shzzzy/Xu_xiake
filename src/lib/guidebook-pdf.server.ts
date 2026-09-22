import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { chromium, type APIResponse, type Page, type Route } from "playwright";
import {
  enrichGuidebookPlanWithMaps,
  resolveGuidebookAmapKey,
  type GuidebookMapEnrichmentOptions,
} from "./guidebook-map.server.ts";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import {
  buildFallbackDayNarrative,
  buildFallbackDayTheme,
  prepareGuidebookNarrativePlan,
  validateDayNarrative,
} from "./guidebook-narrative.server.ts";
import type { TripPlan } from "./travel-plan.ts";

const PDF_RENDER_TIMEOUT_MS = 30_000;
const MAX_GUIDEBOOK_REDIRECTS = 5;
const ALLOWED_GUIDEBOOK_ASSET_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
] as const;
const AMAP_STATIC_MAP_HOST = "restapi.amap.com";
const AMAP_STATIC_MAP_PATH = "/v3/staticmap";
const TRUSTED_GUIDEBOOK_QR_HOSTS = ["api.qrserver.com"] as const;
const GUIDEBOOK_IMAGE_TIMEOUT_MS = 15_000;
const GUIDEBOOK_IMAGE_MAX_BYTES = 5_000_000;
const MAX_GUIDEBOOK_IMAGE_REDIRECTS = 3;
const SENSITIVE_IMAGE_QUERY_KEYS = [
  "key",
  "api_key",
  "apikey",
  "access_key",
  "accesskey",
  "secret",
  "token",
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

export type GuidebookImageKind = "map" | "qr";

export type GuidebookImageFetchOptions = GuidebookMapEnrichmentOptions;

function isSensitiveImageQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return (
    SENSITIVE_IMAGE_QUERY_KEYS.includes(
      normalized as (typeof SENSITIVE_IMAGE_QUERY_KEYS)[number],
    ) ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_access_key") ||
    normalized.endsWith("_token")
  );
}

function guidebookAmapKey(override: string | null | undefined): string {
  return resolveGuidebookAmapKey(override);
}

function secureGuidebookImageUrl(
  value: string,
  kind: GuidebookImageKind,
  amapKey: string,
): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;

    const hostname = normalizeHostname(url.hostname);
    if (isBlockedGuidebookHost(hostname)) return null;

    if (kind === "map") {
      if (hostname !== AMAP_STATIC_MAP_HOST || url.pathname !== AMAP_STATIC_MAP_PATH || !amapKey) {
        return null;
      }
      for (const key of [...url.searchParams.keys()]) {
        if (isSensitiveImageQueryKey(key)) url.searchParams.delete(key);
      }
      url.searchParams.set("key", amapKey);
      return url;
    }

    if (!TRUSTED_GUIDEBOOK_QR_HOSTS.some((host) => hostname === host)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveImageQueryKey(key)) url.searchParams.delete(key);
    }
    return url;
  } catch {
    return null;
  }
}

function guidebookPlaceholderSvg(kind: GuidebookImageKind): string {
  const label = kind === "map" ? "地图暂不可用" : "二维码暂不可用";
  const detail = kind === "map" ? "已使用本地路线占位图" : "可先使用导航链接";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="750" height="500" viewBox="0 0 750 500"><rect width="750" height="500" rx="24" fill="#f5f4ed"/><rect x="28" y="28" width="694" height="444" rx="18" fill="#faf9f5" stroke="#d1cfc5" stroke-width="2"/><path d="M170 250h410M280 150l95 100-95 100M470 150l-95 100 95 100" fill="none" stroke="#c96442" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><text x="375" y="395" text-anchor="middle" fill="#524f4a" font-family="serif" font-size="30">${label}</text><text x="375" y="430" text-anchor="middle" fill="#87867f" font-family="sans-serif" font-size="18">${detail}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function isSafeInlineImage(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(value);
}

function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function responseBytesWithinLimit(response: Response): Promise<Uint8Array | null> {
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > GUIDEBOOK_IMAGE_MAX_BYTES) return null;

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= GUIDEBOOK_IMAGE_MAX_BYTES ? bytes : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > GUIDEBOOK_IMAGE_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchGuidebookImageDataUrl(
  value: string,
  kind: GuidebookImageKind,
  options: GuidebookImageFetchOptions,
): Promise<string | null> {
  if (isSafeInlineImage(value)) return value;
  if (!isRemoteImageUrl(value)) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  const amapKey = guidebookAmapKey(options.amapKey);
  let nextUrl = secureGuidebookImageUrl(value, kind, amapKey);

  for (let redirectCount = 0; redirectCount <= MAX_GUIDEBOOK_IMAGE_REDIRECTS; redirectCount += 1) {
    if (!nextUrl) return null;

    try {
      const timeoutSignal = AbortSignal.timeout(GUIDEBOOK_IMAGE_TIMEOUT_MS);
      const requestSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      const response = await fetchImpl(nextUrl, {
        redirect: "manual",
        signal: requestSignal,
        headers: { accept: "image/*" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        nextUrl = secureGuidebookImageUrl(new URL(location, nextUrl).toString(), kind, amapKey);
        continue;
      }
      if (!response.ok) return null;

      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!contentType.startsWith("image/")) return null;

      const bytes = await responseBytesWithinLimit(response);
      if (!bytes) return null;
      return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 把单张远程图片转成可内联的 data URL（失败时给占位图）。
 *
 * 抽成导出函数是为了让逐页流式预览按页取图：纯文字页不必等图片，
 * 需要地图或二维码的页各自等自己的那一张。
 */
const GUIDEBOOK_IMAGE_CACHE_TTL_MS = 120_000;
const GUIDEBOOK_IMAGE_CONCURRENCY = 4;

type GuidebookImageCacheEntry = {
  expiresAt: number;
  promise: Promise<string | undefined>;
};

const guidebookImageCaches = new WeakMap<typeof fetch, Map<string, GuidebookImageCacheEntry>>();
let activeGuidebookImages = 0;
const queuedGuidebookImages: (() => void)[] = [];

function guidebookImageCache(fetchImpl: typeof fetch) {
  const cached = guidebookImageCaches.get(fetchImpl);
  if (cached) return cached;
  const cache = new Map<string, GuidebookImageCacheEntry>();
  guidebookImageCaches.set(fetchImpl, cache);
  return cache;
}

async function withGuidebookImageSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeGuidebookImages >= GUIDEBOOK_IMAGE_CONCURRENCY) {
    await new Promise<void>((resolve) => queuedGuidebookImages.push(resolve));
  }
  activeGuidebookImages += 1;
  try {
    return await task();
  } finally {
    activeGuidebookImages -= 1;
    queuedGuidebookImages.shift()?.();
  }
}

export async function prepareGuidebookImage(
  value: string | undefined,
  kind: GuidebookImageKind,
  options: GuidebookImageFetchOptions = {},
): Promise<string | undefined> {
  if (!value) return value;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = guidebookImageCache(fetchImpl);
  const cacheKey = `${kind}\u0000${guidebookAmapKey(options.amapKey)}\u0000${value}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = withGuidebookImageSlot(async () => {
    const first = await fetchGuidebookImageDataUrl(value, kind, options);
    if (first || options.signal?.aborted) return first;
    // 高德静图偶发失败：再取一次，降低瞬时抖动与限流造成的占位图。
    return fetchGuidebookImageDataUrl(value, kind, options);
  })
    .then((dataUrl) => {
      if (!dataUrl) {
        if (cache.get(cacheKey)?.promise === promise) cache.delete(cacheKey);
        return guidebookPlaceholderSvg(kind);
      }
      const success = Promise.resolve(dataUrl);
      cache.set(cacheKey, {
        expiresAt: Date.now() + GUIDEBOOK_IMAGE_CACHE_TTL_MS,
        promise: success,
      });
      return dataUrl;
    })
    .catch(() => {
      if (cache.get(cacheKey)?.promise === promise) cache.delete(cacheKey);
      return guidebookPlaceholderSvg(kind);
    });
  cache.set(cacheKey, { expiresAt: Number.POSITIVE_INFINITY, promise });
  return promise;
}
export async function prepareGuidebookPlan(
  plan: TripPlan,
  options: GuidebookImageFetchOptions = {},
): Promise<TripPlan> {
  const prepareImage = (value: string | undefined, kind: GuidebookImageKind) =>
    prepareGuidebookImage(value, kind, options);

  const staticMapUrl = await prepareImage(plan.route.staticMapUrl, "map");
  const days = await Promise.all(
    plan.days.map(async (day) => ({
      ...day,
      mapUrl: await prepareImage(day.mapUrl, "map"),
      qrCodeUrl: await prepareImage(day.qrCodeUrl, "qr"),
    })),
  );

  return {
    ...plan,
    route: { ...plan.route, staticMapUrl },
    days,
  };
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

export type GuidebookPdfRenderer = (
  html: string,
  options?: { signal?: AbortSignal },
) => Promise<Uint8Array>;

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

export async function renderGuidebookPdf(
  html: string,
  options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error("PDF 渲染已中止");
  };
  throwIfAborted();
  const executablePath = chromiumExecutablePath();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  const abortBrowser = () => {
    void browser.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", abortBrowser, { once: true });

  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    throwIfAborted();
    context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    throwIfAborted();
    const page = await context.newPage();
    await installGuidebookRequestGuard(page);
    throwIfAborted();
    await page.setContent(html, {
      waitUntil: "networkidle",
      timeout: PDF_RENDER_TIMEOUT_MS,
    });
    throwIfAborted();
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    return new Uint8Array(pdf);
  } finally {
    options.signal?.removeEventListener("abort", abortBrowser);
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
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

export type GuidebookExportDependencies = GuidebookImageFetchOptions & {
  renderPdf: GuidebookPdfRenderer;
};

export type GuidebookTimeoutExportDependencies = GuidebookExportDependencies & {
  timeoutMs?: number;
  prepareNarrative?: (plan: TripPlan, options: { signal: AbortSignal }) => Promise<TripPlan>;
};

function buildSafeGuidebookFallbackPlan(plan: TripPlan): TripPlan {
  const scheduledAttractions = plan.days.flatMap((day) =>
    day.nodes
      .filter((node) => node.type === "attraction" || node.type === "night-activity")
      .map((node) => node.name),
  );
  const knownAttractions = [...(plan.meta.allowedAttractions ?? []), ...scheduledAttractions];
  const days = plan.days.map((day, index) => {
    const safeDay = {
      ...day,
      mapUrl: undefined,
      qrCodeUrl: undefined,
      navigationUrl: undefined,
      history: [],
      nodes: day.nodes.map((node) => ({ ...node, navigation: null })),
    };
    try {
      validateDayNarrative(safeDay, index, { knownAttractions });
      return safeDay;
    } catch {
      const forced = {
        ...safeDay,
        theme: buildFallbackDayTheme(safeDay),
        purpose: `第 ${index + 1} 天：按已冻结排程继续行程`,
        highlights: [],
        cautions: ["本页分析未能生成，已改用基础行程与本地提示。"],
        history: [],
        analysisFailed: true,
      };
      try {
        validateDayNarrative(forced, index, {
          allowAnalysisFailure: true,
          knownAttractions,
        });
        return forced;
      } catch {
        const minimal = {
          ...forced,
          theme: forced.theme,
          purpose: "已改用基础行程与本地提示。",
        };
        validateDayNarrative(minimal, index, {
          allowAnalysisFailure: true,
          knownAttractions: [],
        });
        return minimal;
      }
    }
  });

  const stripSegmentNavigation = (segments: TripPlan["route"]["outboundSegments"]) =>
    segments.map((segment) => ({ ...segment, navigation: "" }));

  return {
    ...plan,
    route: {
      ...plan.route,
      staticMapUrl: undefined,
      outboundSegments: stripSegmentNavigation(plan.route.outboundSegments),
      returnSegments: stripSegmentNavigation(plan.route.returnSegments),
    },
    days,
    closing: { ...plan.closing, source: null },
  };
}
export const GUIDEBOOK_EXPORT_TOTAL_TIMEOUT_MS = 25_000;

/** 总超时先于文案准备启动；准备完成后复用的 plan 不再二次准备。 */
export async function exportGuidebookWithTimeout(
  plan: TripPlan,
  dependencies: GuidebookTimeoutExportDependencies,
): Promise<GuidebookExportResult> {
  const controller = new AbortController();
  const timeoutMs = dependencies.timeoutMs ?? GUIDEBOOK_EXPORT_TOTAL_TIMEOUT_MS;
  let fallbackPlan = buildSafeGuidebookFallbackPlan(plan);
  let timeoutResolve: ((result: GuidebookExportResult) => void) | undefined;
  const timeoutPromise = new Promise<GuidebookExportResult>((resolve) => {
    timeoutResolve = resolve;
  });
  const timer = setTimeout(() => {
    controller.abort(new Error("PDF 导出超过总预算"));
    timeoutResolve?.({
      status: "html",
      html: renderGuidebookHtml(fallbackPlan),
      message: "PDF 导出超时，已改为可打印 HTML。",
    });
  }, timeoutMs);

  try {
    const exportPromise = (async () => {
      const prepareNarrative =
        dependencies.prepareNarrative ??
        ((narrativePlan, options) => prepareGuidebookNarrativePlan(narrativePlan, options));
      const narrativePlan = await prepareNarrative(plan, { signal: controller.signal });
      fallbackPlan = buildSafeGuidebookFallbackPlan(narrativePlan);
      return exportPreparedGuidebookForTest(narrativePlan, {
        ...dependencies,
        signal: controller.signal,
        timeoutMs,
      });
    })();
    return await Promise.race([exportPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
export async function exportGuidebookForTest(
  plan: TripPlan,
  dependencies: GuidebookExportDependencies,
): Promise<GuidebookExportResult> {
  const narrativePlan = await prepareGuidebookNarrativePlan(plan);
  return exportPreparedGuidebookForTest(narrativePlan, dependencies);
}

async function exportPreparedGuidebookForTest(
  narrativePlan: TripPlan,
  dependencies: GuidebookExportDependencies,
): Promise<GuidebookExportResult> {
  const throwIfAborted = () => {
    if (dependencies.signal?.aborted) throw new Error("PDF 导出已取消");
  };
  throwIfAborted();
  const startedAt = Date.now();
  const mapPlan = await enrichGuidebookPlanWithMaps(narrativePlan, dependencies);
  throwIfAborted();
  const preparedPlan = await prepareGuidebookPlan(mapPlan, dependencies);
  throwIfAborted();
  const preparedAt = Date.now();
  const html = renderGuidebookHtml(preparedPlan);

  try {
    throwIfAborted();
    const pdf = await dependencies.renderPdf(html, { signal: dependencies.signal });
    if (process.env.GUIDEBOOK_EXPORT_TIMING === "1") {
      const finishedAt = Date.now();
      console.info(
        "[guidebook] image=" + (preparedAt - startedAt) + "ms html=" + (finishedAt - preparedAt) + "ms bytes=" + pdf.byteLength,
      );
    }
    return {
      status: "ok",
      pdfBase64: Buffer.from(pdf).toString("base64"),
      filename: guidebookFilename(narrativePlan),
    };
  } catch (error) {
    return {
      status: "html",
      html,
      message: fallbackMessage(error),
    };
  }
}
