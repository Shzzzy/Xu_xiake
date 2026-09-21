import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import { clearNarrativeCache, enrichTripPlanNarrative } from "./guidebook-narrative.server.ts";
import { streamGuidebookPages } from "./guidebook-stream.server.ts";
import type { BudgetCategory, TripPlan } from "./travel-plan.ts";
import {
  exportGuidebookForTest,
  exportGuidebookWithTimeout,
  installGuidebookRequestGuard,
  prepareGuidebookPlan,
  isGuidebookRequestAllowed,
  renderGuidebookPdf,
  resolveGuidebookRedirect,
} from "./guidebook-pdf.server.ts";

function category(amount: number, ratio: number): BudgetCategory {
  return { min: amount, max: amount, amount, ratio };
}

const fixturePlan: TripPlan = {
  meta: {
    title: "江南水乡两日路书",
    origin: "上海",
    waypoints: ["南浔"],
    destination: "乌镇",
    startDate: "2026-09-20",
    days: 2,
    travelers: { adults: 2, children: 0 },
    perPersonBudget: 1800,
    transportPreference: "balanced",
    pace: "balanced",
    interests: ["古村古镇", "摄影"],
  },
  budget: {
    totalBudget: 3600,
    estimatedTotal: 3000,
    totalMin: 2800,
    totalMax: 3300,
    remaining: 600,
    overBudget: 0,
    perPersonBudget: 1800,
    perPersonEstimated: 1500,
    rooms: 1,
    transport: category(720, 0.24),
    lodging: category(900, 0.3),
    food: category(600, 0.2),
    tickets: category(480, 0.16),
    other: category(300, 0.1),
  },
  route: {
    outbound: [
      [121.47, 31.23],
      [120.43, 30.88],
    ],
    returnPath: [],
    outboundSegments: [],
    returnSegments: [],
    distanceKm: 150,
    durationMinutes: 120,
    returnMode: null,
    staticMapUrl:
      "https://restapi.amap.com/v3/staticmap?zoom=10&size=750*500&paths=10,0x4A7C8A,1,,:121.47,31.23;120.43,30.88&key=leaked-plan-key",
  },
  days: [
    {
      date: "2026-09-20",
      theme: "水乡慢游",
      weather: "多云",
      mapUrl:
        "https://restapi.amap.com/v3/staticmap?zoom=12&size=750*500&paths=10,0x4A7C8A,1,,:121.47,31.23;120.43,30.88&key=leaked-plan-key",
      qrCodeUrl:
        "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=https%3A%2F%2Furi.amap.com%2Fnavigation&token=leaked-token",
      nodes: [],
      estimatedCost: 1500,
      radar: { physical: 42, childFit: 72, weatherSensitivity: 48, timeCost: 44, crowding: 58 },
      purpose: "沿河慢走，体验江南水乡。",
      highlights: ["西栅夜色：灯光与河道相映"],
      cautions: ["周末人流较多，建议错峰用餐。"],
    },
  ],
  closing: {
    quote: null,
    source: null,
    message: "愿你在水巷橹声里，慢慢看见江南。",
  },
};

test("allows only approved guidebook asset hosts and safe URL schemes", () => {
  assert.equal(
    isGuidebookRequestAllowed("https://fonts.googleapis.com/css2?family=Noto+Sans+SC"),
    true,
  );
  assert.equal(isGuidebookRequestAllowed("https://fonts.gstatic.com/s/noto/v1/font.woff2"), true);
  assert.equal(
    isGuidebookRequestAllowed("https://cdn.jsdelivr.net/npm/@tabler/icons-webfont"),
    true,
  );
  assert.equal(isGuidebookRequestAllowed("data:image/png;base64,AAAA"), true);
  assert.equal(isGuidebookRequestAllowed("blob:https://example.com/asset"), true);

  for (const blocked of [
    "https://example.com/tracker",
    "http://fonts.googleapis.com/css",
    "http://localhost/secret",
    "http://127.0.0.1/secret",
    "http://10.0.0.1/secret",
    "http://172.16.0.1/secret",
    "http://192.168.1.1/secret",
    "http://169.254.169.254/latest/meta-data",
    "http://100.100.100.200/latest/meta-data",
    "http://[::1]/secret",
    "http://[fc00::1]/secret",
    "file:///etc/passwd",
  ]) {
    assert.equal(isGuidebookRequestAllowed(blocked), false, blocked);
  }
});

test("does not follow an approved redirect into a private address", async () => {
  let abortReason = "";
  let fetchCount = 0;
  let fulfilled = false;
  const fakeRoute = {
    request: () => ({
      url: () => "https://fonts.googleapis.com/redirect",
      redirectedFrom: () => null,
    }),
    fetch: async (options: { maxRedirects?: number }) => {
      fetchCount += 1;
      assert.equal(options.maxRedirects, 0);
      return {
        status: () => 302,
        headers: () => ({ location: "http://127.0.0.1/secret" }),
      };
    },
    abort: async (reason?: string) => {
      abortReason = reason ?? "";
    },
    fulfill: async () => {
      fulfilled = true;
    },
    continue: async () => undefined,
  };
  const fakePage = {
    route: async (_url: string, handler: (route: unknown) => Promise<void>) => {
      await handler(fakeRoute);
    },
  };

  await installGuidebookRequestGuard(fakePage as never);

  assert.equal(fetchCount, 1);
  assert.equal(abortReason, "blockedbyclient");
  assert.equal(fulfilled, false);
});

test("rejects redirects into private, local, or unapproved targets", () => {
  assert.equal(
    resolveGuidebookRedirect(
      "https://fonts.googleapis.com/css2?family=Noto+Sans+SC",
      "https://fonts.gstatic.com/s/noto/v1/font.woff2",
    ),
    "https://fonts.gstatic.com/s/noto/v1/font.woff2",
  );
  assert.equal(
    resolveGuidebookRedirect("https://fonts.googleapis.com/css", "http://127.0.0.1/secret"),
    null,
  );
  assert.equal(
    resolveGuidebookRedirect(
      "https://fonts.googleapis.com/css",
      "http://169.254.169.254/latest/meta-data",
    ),
    null,
  );
  assert.equal(
    resolveGuidebookRedirect("https://fonts.googleapis.com/css", "http://10.0.0.1/private"),
    null,
  );
  assert.equal(
    resolveGuidebookRedirect("https://fonts.googleapis.com/css", "https://example.com/asset"),
    null,
  );
});

test(
  "blocks private image URLs before Chromium can reach the local server",
  { timeout: 30_000 },
  async () => {
    let hitCount = 0;
    const server = createServer((_request, response) => {
      hitCount += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("private");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      await renderGuidebookPdf(
        `<!doctype html><html><body><img src="http://127.0.0.1:${address.port}/secret"></body></html>`,
      );
      assert.equal(hitCount, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test("prepares AMap maps and trusted QR images as data URLs without leaking keys", async () => {
  const requestedUrls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;

  const prepared = await prepareGuidebookPlan(fixturePlan, {
    fetchImpl,
    amapKey: "server-only-key",
  });

  assert.match(prepared.route.staticMapUrl ?? "", /^data:image\/png;base64,/);
  assert.match(prepared.days[0]?.mapUrl ?? "", /^data:image\/png;base64,/);
  assert.match(prepared.days[0]?.qrCodeUrl ?? "", /^data:image\/png;base64,/);

  const amapRequests = requestedUrls.filter((url) => url.includes("restapi.amap.com"));
  assert.equal(amapRequests.length, 2);
  assert.ok(amapRequests.every((url) => url.includes("key=server-only-key")));
  assert.ok(amapRequests.every((url) => !url.includes("leaked-plan-key")));
  assert.doesNotMatch(JSON.stringify(prepared), /server-only-key|leaked-plan-key|leaked-token/);

  const html = renderGuidebookHtml(prepared);
  assert.doesNotMatch(html, /<img[^>]+src="https?:\/\//i);
  assert.match(html, /src="data:image\/png;base64,/);
});

test("uses local SVG placeholders when approved map or QR fetching fails", async () => {
  const prepared = await prepareGuidebookPlan(fixturePlan, {
    amapKey: "server-only-key",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const html = renderGuidebookHtml(prepared);

  assert.match(html, /src="data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(html, /<img[^>]+src="https?:\/\//i);
  assert.doesNotMatch(html, /server-only-key|leaked-plan-key|leaked-token/);
});

test("replaces untrusted remote image URLs with local SVG placeholders", async () => {
  let fetchCalls = 0;
  const untrustedPlan: TripPlan = {
    ...fixturePlan,
    route: { ...fixturePlan.route, staticMapUrl: "https://tracker.example/map.png" },
    days: fixturePlan.days.map((day) => ({
      ...day,
      mapUrl: "https://tracker.example/day.png",
      qrCodeUrl: "https://tracker.example/qr.png",
    })),
  };

  const prepared = await prepareGuidebookPlan(untrustedPlan, {
    amapKey: "server-only-key",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      });
    },
  });
  const html = renderGuidebookHtml(prepared);

  assert.equal(fetchCalls, 0);
  assert.match(html, /src="data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(html, /<img[^>]+src="https?:\/\//i);
});

test("renders a PDF from a local map placeholder data image", async () => {
  const prepared = await prepareGuidebookPlan(fixturePlan, {
    amapKey: "server-only-key",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const placeholder = prepared.route.staticMapUrl;
  assert.match(placeholder ?? "", /^data:image\/svg\+xml;base64,/);

  const pdf = await renderGuidebookPdf(
    `<!doctype html><html><body><img src="${placeholder}" alt="地图暂不可用"></body></html>`,
  );

  assert.equal(Buffer.from(pdf.subarray(0, 4)).toString("ascii"), "%PDF");
  assert.ok(pdf.byteLength > 1_000);
});

test("export pipeline passes only prepared data images to PDF rendering", async () => {
  let renderedHtml = "";
  const result = await exportGuidebookForTest(fixturePlan, {
    amapKey: "server-only-key",
    fetchImpl: async () => {
      throw new Error("offline");
    },
    renderPdf: async (html) => {
      renderedHtml = html;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  });

  assert.equal(result.status, "ok");
  assert.match(renderedHtml, /src="data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(renderedHtml, /<img[^>]+src="https?:\/\//i);
  assert.doesNotMatch(renderedHtml, /server-only-key|leaked-plan-key|leaked-token/);
});

test("returns a named PDF download from the rendered guidebook", async () => {
  let renderedHtml = "";
  const result = await exportGuidebookForTest(fixturePlan, {
    renderPdf: async (html) => {
      renderedHtml = html;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.filename, "江南水乡两日路书_guidebook.pdf");
  assert.equal(result.pdfBase64, Buffer.from("%PDF").toString("base64"));
  assert.match(renderedHtml, /江南水乡两日路书/);
});

test("falls back to printable html when chromium is unavailable", async () => {
  const result = await exportGuidebookForTest(fixturePlan, {
    renderPdf: async () => {
      throw new Error("chromium unavailable");
    },
  });

  assert.equal(result.status, "html");
  if (result.status !== "html") return;
  assert.match(result.html, /江南水乡/);
  assert.match(result.message, /PDF/);
});
test("PDF export reuses butler narrative instead of legacy enrichment", async () => {
  clearNarrativeCache();
  let calls = 0;
  const butlerPlan: TripPlan = {
    ...fixturePlan,
    meta: { ...fixturePlan.meta, narrativeSource: "butler" },
    days: [
      {
        ...fixturePlan.days[0],
        purpose: "管家原文目的",
        highlights: ["管家原文重点"],
        cautions: ["本页分析未能生成，已改用基础行程与本地提示。"],
        analysisFailed: true,
      },
    ],
  };

  // 导出前与预览共用同一份 enrichment：butler 标记下不允许再发 legacy 总结请求。
  const prepared = await enrichTripPlanNarrative(butlerPlan, {
    apiKey: "test-key",
    fetchImpl: (async () => {
      calls += 1;
      throw new Error("legacy enrichment 不应被调用");
    }) as typeof fetch,
  });
  assert.equal(calls, 0);

  let renderedHtml = "";
  const result = await exportGuidebookForTest(prepared, {
    renderPdf: async (html) => {
      renderedHtml = html;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  });

  assert.equal(result.status, "ok");
  assert.match(renderedHtml, /管家原文目的/);
  assert.match(renderedHtml, /本页分析未能生成/);
});

test("同一非法计划的预览与导出使用相同 fallback 文案", async () => {
  const invalidPlan: TripPlan = {
    ...fixturePlan,
    meta: { ...fixturePlan.meta, narrativeSource: "butler" },
    days: fixturePlan.days.map((day) => ({
      ...day,
      purpose: "顺路去故宫看看",
      highlights: ["故宫：临时增加的景点"],
      cautions: ["天气变化注意保暖"],
    })),
  };

  const previewEvents = [];
  for await (const event of streamGuidebookPages(invalidPlan, { runId: "preview-run" })) {
    previewEvents.push(event);
  }
  const previewHtml = previewEvents
    .flatMap((event) => (event.type === "page" ? [event.html] : []))
    .join("");

  let exportedHtml = "";
  const exportResult = await exportGuidebookForTest(invalidPlan, {
    renderPdf: async (html) => {
      exportedHtml = html;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  });

  assert.equal(exportResult.status, "ok");
  assert.match(previewHtml, /第 1 天：按已冻结排程继续行程/);
  assert.match(previewHtml, /本页分析未能生成/);
  assert.doesNotMatch(previewHtml, /故宫/);
  assert.match(exportedHtml, /第 1 天：按已冻结排程继续行程/);
  assert.match(exportedHtml, /本页分析未能生成/);
  assert.doesNotMatch(exportedHtml, /故宫/);
});

test("legacy 文案准备超时后返回安全可打印 HTML", async () => {
  const unsafePlan: TripPlan = {
    ...fixturePlan,
    meta: { ...fixturePlan.meta, allowedAttractions: ["故宫"] },
    route: { ...fixturePlan.route, staticMapUrl: "https://tracker.example/map.png" },
    days: fixturePlan.days.map((day) => ({
      ...day,
      theme: "顺路去故宫看看",
      purpose: "顺路去故宫看看",
      highlights: ["故宫：危险旧文案"],
      analysisFailed: true,
      mapUrl: "https://tracker.example/day.png",
      qrCodeUrl: "javascript:alert(1)",
      history: [{ title: "故宫", background: "危险内容", source: "javascript:alert(1)" }],
    })),
  };
  let prepareSignal: AbortSignal | undefined;
  let prepareAborted = false;
  let renderPdfCalls = 0;
  const result = await exportGuidebookWithTimeout(unsafePlan, {
    timeoutMs: 5,
    prepareNarrative: async (_plan, options) => {
      prepareSignal = options.signal;
      options.signal.addEventListener("abort", () => {
        prepareAborted = true;
      });
      return new Promise<TripPlan>(() => {});
    },
    renderPdf: async () => {
      renderPdfCalls += 1;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  });

  assert.equal(result.status, "html");
  if (result.status !== "html") return;
  assert.match(result.message, /超时/);
  assert.match(result.html, /江南水乡两日路书/);
  assert.equal(prepareSignal?.aborted, true);
  assert.equal(prepareAborted, true);
  assert.equal(renderPdfCalls, 0);
  assert.doesNotMatch(result.html, /tracker\\.example|故宫|javascript:|<script/i);
});

test("预取消信号在进入 Playwright 前终止 PDF 渲染", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      renderGuidebookPdf("<!doctype html><html><body>测试</body></html>", {
        signal: controller.signal,
      }),
    /中止|abort/i,
  );
});
test("文案完成后图片准备超时不再调用 renderPdf", async () => {
  const unique = Date.now();
  const plan: TripPlan = {
    ...fixturePlan,
    route: {
      ...fixturePlan.route,
      staticMapUrl: "https://restapi.amap.com/v3/staticmap?zoom=10&size=750*500&key=server-only-key&unique=" + unique,
    },
  };
  let renderPdfCalls = 0;
  const result = await exportGuidebookWithTimeout(plan, {
    timeoutMs: 5,
    amapKey: "server-only-key",
    prepareNarrative: async (narrativePlan) => narrativePlan,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      });
    },
    renderPdf: async () => {
      renderPdfCalls += 1;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  });

  assert.equal(result.status, "html");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(renderPdfCalls, 0);
});

test("渲染中取消会向 renderer 传递已中止信号", async () => {
  let rendererSignal: AbortSignal | undefined;
  const plan: TripPlan = {
    ...fixturePlan,
    route: { ...fixturePlan.route, staticMapUrl: undefined },
    days: fixturePlan.days.map((day) => ({ ...day, mapUrl: undefined, qrCodeUrl: undefined })),
  };
  const result = await exportGuidebookWithTimeout(plan, {
    timeoutMs: 5,
    prepareNarrative: async (plan) => plan,
    renderPdf: async (_html, options) => {
      const signal = options?.signal;
      assert.ok(signal);
      rendererSignal = signal;
      return new Promise<Uint8Array>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("render aborted")));
      });
    },
  });

  assert.equal(result.status, "html");
  assert.equal(rendererSignal?.aborted, true);
});

test("超时时仅 theme 非法也会重建安全 theme", async () => {
  const plan: TripPlan = {
    ...fixturePlan,
    meta: { ...fixturePlan.meta, narrativeSource: "butler", allowedAttractions: ["故宫"] },
    route: { ...fixturePlan.route, staticMapUrl: undefined },
    days: fixturePlan.days.map((day) => ({
      ...day,
      theme: "顺路去故宫看看",
      purpose: "沿河慢走，体验江南水乡。",
      highlights: ["沿河慢走，体验江南水乡。"],
      cautions: ["建议错峰出行。"],
      history: [],
      mapUrl: undefined,
      qrCodeUrl: undefined,
    })),
  };
  let renderPdfCalls = 0;
  const result = await exportGuidebookWithTimeout(plan, {
    timeoutMs: 5,
    prepareNarrative: async () => new Promise<TripPlan>(() => {}),
    renderPdf: async () => {
      renderPdfCalls += 1;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  });

  assert.equal(result.status, "html");
  if (result.status !== "html") return;
  assert.match(result.html, /第 1 天安全行程/);
  assert.doesNotMatch(result.html, /故宫/);
  assert.equal(renderPdfCalls, 0);
});
