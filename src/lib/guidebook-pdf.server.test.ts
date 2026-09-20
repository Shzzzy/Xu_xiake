import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { BudgetCategory, TripPlan } from "./travel-plan.ts";
import {
  exportGuidebookForTest,
  installGuidebookRequestGuard,
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
  },
  days: [
    {
      date: "2026-09-20",
      theme: "水乡慢游",
      weather: "多云",
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
