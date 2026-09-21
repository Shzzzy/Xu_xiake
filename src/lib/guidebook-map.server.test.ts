import assert from "node:assert/strict";
import test from "node:test";
import type { AmapClient, AmapCoordinate, AmapRoute } from "./amap.server.ts";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import { enrichGuidebookPlanWithMaps } from "./guidebook-map.server.ts";
import { exportGuidebookForTest } from "./guidebook-pdf.server.ts";
import { streamGuidebookPages } from "./guidebook-stream.server.ts";
import type { BudgetCategory, TripPlan } from "./travel-plan.ts";

function category(amount: number, ratio: number): BudgetCategory {
  return { min: amount, max: amount, amount, ratio };
}

function fixturePlan(): TripPlan {
  return {
    meta: {
      title: "江南两日路书",
      origin: "上海",
      waypoints: ["杭州"],
      destination: "黄山",
      startDate: "2026-09-20",
      days: 2,
      travelers: { adults: 2, children: 0 },
      perPersonBudget: 3000,
      transportPreference: "balanced",
      pace: "balanced",
      interests: ["山水", "古村"],
      narrativeSource: "butler",
    },
    budget: {
      totalBudget: 6000,
      estimatedTotal: 4000,
      totalMin: 3800,
      totalMax: 4200,
      remaining: 2000,
      overBudget: 0,
      perPersonBudget: 3000,
      perPersonEstimated: 2000,
      rooms: 1,
      transport: category(1200, 0.3),
      lodging: category(1200, 0.3),
      food: category(800, 0.2),
      tickets: category(500, 0.125),
      other: category(300, 0.075),
    },
    route: {
      outbound: [],
      returnPath: [],
      outboundSegments: [
        {
          from: "上海",
          to: "杭州",
          mode: "drive",
          distanceKm: 0,
          durationMinutes: 0,
          navigation: "",
        },
        {
          from: "杭州",
          to: "黄山",
          mode: "drive",
          distanceKm: 0,
          durationMinutes: 0,
          navigation: "",
        },
      ],
      returnSegments: [
        {
          from: "黄山",
          to: "上海",
          mode: "drive",
          distanceKm: 0,
          durationMinutes: 0,
          navigation: "",
        },
      ],
      distanceKm: 0,
      durationMinutes: 0,
      returnMode: "fast",
    },
    days: [
      {
        date: "2026-09-20",
        theme: "西湖晨光",
        nodes: [
          {
            startTime: "09:00",
            endTime: "12:00",
            timeLabel: "09:00–12:00",
            type: "attraction",
            name: "西湖",
            location: "杭州西湖风景名胜区",
            estimatedCost: 0,
            navigation: null,
          },
        ],
        estimatedCost: 800,
        radar: {
          physical: 30,
          childFit: 80,
          weatherSensitivity: 40,
          timeCost: 30,
          crowding: 60,
        },
        purpose: "慢游西湖。",
        highlights: ["西湖：湖山相映"],
        cautions: ["周末注意人流"],
      },
      {
        date: "2026-09-21",
        theme: "徽州古村",
        nodes: [
          {
            startTime: "09:30",
            endTime: "12:30",
            timeLabel: "09:30–12:30",
            type: "attraction",
            name: "宏村",
            location: "安徽省黄山市黟县宏村",
            estimatedCost: 180,
            navigation: null,
          },
          {
            startTime: "09:00",
            endTime: "10:00",
            timeLabel: "09:00–10:00",
            type: "attraction",
            name: "西湖",
            location: "杭州西湖风景名胜区",
            estimatedCost: 0,
            navigation: null,
          },
        ],
        estimatedCost: 980,
        radar: {
          physical: 45,
          childFit: 75,
          weatherSensitivity: 50,
          timeCost: 40,
          crowding: 55,
        },
        purpose: "走进徽州古村。",
        highlights: ["宏村：水系与民居"],
        cautions: ["石板路雨后湿滑"],
      },
    ],
    closing: {
      quote: null,
      source: null,
      message: "愿山水与古村都留下清晰记忆。",
    },
  };
}

function coords(): Record<string, AmapCoordinate> {
  return {
    上海: [121.4737, 31.2304],
    杭州: [120.1551, 30.2741],
    黄山: [118.3376, 29.7147],
    西湖: [120.1379, 30.2458],
    宏村: [117.9933, 29.9098],
  };
}

function fakeAmapClient() {
  const points = coords();
  let geocodeCalls = 0;
  let routeCalls = 0;
  let searchCalls = 0;

  const client: AmapClient = {
    async searchPoi(input) {
      searchCalls += 1;
      const point = points[input.keywords];
      return point
        ? [
            {
              id: input.keywords,
              name: input.keywords,
              type: "风景名胜",
              address: input.keywords,
              location: point,
            },
          ]
        : [];
    },
    async fetchStaticMap() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
    async route(input): Promise<AmapRoute> {
      routeCalls += 1;
      const midpoint: AmapCoordinate = [
        (input.origin[0] + input.destination[0]) / 2,
        (input.origin[1] + input.destination[1]) / 2,
      ];
      return {
        mode: input.mode,
        origin: input.origin,
        destination: input.destination,
        distanceMeters: 120_000,
        durationSeconds: 7_200,
        path: [input.origin, midpoint, input.destination],
        steps: [],
      };
    },
    async geocode(input) {
      geocodeCalls += 1;
      const point = points[input.address];
      return point
        ? [
            {
              formattedAddress: input.address,
              province: "",
              city: "",
              district: "",
              adcode: "",
              location: point,
            },
          ]
        : [];
    },
    async weather() {
      return [];
    },
  };

  return {
    client,
    counts: () => ({ geocodeCalls, routeCalls, searchCalls }),
  };
}

function imageFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "restapi.amap.com" || url.hostname === "api.qrserver.com") {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`未预期的图片地址：${url.hostname}`);
  }) as typeof fetch;
}

test("enriches TripPlan with route coordinates, maps and keyless navigation", async () => {
  const { client, counts } = fakeAmapClient();
  const enriched = await enrichGuidebookPlanWithMaps(fixturePlan(), { amapClient: client });

  assert.ok((enriched.route.outbound.length ?? 0) >= 3);
  assert.ok((enriched.route.returnPath.length ?? 0) >= 2);
  assert.ok(enriched.route.distanceKm > 0);
  assert.ok(enriched.route.durationMinutes > 0);
  assert.match(enriched.route.staticMapUrl ?? "", /^https:\/\/restapi\.amap\.com\/v3\/staticmap/);
  assert.equal(
    enriched.route.outboundSegments.every((segment) => segment.navigation.includes("uri.amap.com")),
    true,
  );

  assert.match(enriched.days[0]?.mapUrl ?? "", /^https:\/\/restapi\.amap\.com\/v3\/staticmap/);
  assert.match(enriched.days[0]?.navigationUrl ?? "", /^https:\/\/uri\.amap\.com\/navigation/);
  assert.match(
    enriched.days[0]?.qrCodeUrl ?? "",
    /^https:\/\/api\.qrserver\.com\/v1\/create-qr-code/,
  );
  assert.deepEqual(enriched.days[0]?.nodes[0]?.coordinates, coords().西湖);
  assert.match(
    enriched.days[0]?.nodes[0]?.navigation ?? "",
    /^https:\/\/uri\.amap\.com\/navigation/,
  );

  assert.deepEqual(counts(), { geocodeCalls: 3, routeCalls: 3, searchCalls: 2 });
});

test("keeps the Amap key out of public TripPlan URLs and HTML", async () => {
  const { client } = fakeAmapClient();
  const secret = "server-only-amap-secret";
  const enriched = await enrichGuidebookPlanWithMaps(fixturePlan(), {
    amapClient: client,
    amapKey: secret,
  });
  const html = renderGuidebookHtml(enriched);

  assert.doesNotMatch(JSON.stringify(enriched), new RegExp(secret));
  assert.doesNotMatch(html, new RegExp(secret));
  assert.doesNotMatch(html, /(?:[?&](?:key|api_key|apikey|access_key|token)=)/i);
});

test("keeps schematic fallback and reports sanitized errors when Amap enrichment fails", async () => {
  const failures: string[] = [];
  const failingClient: AmapClient = {
    searchPoi: async () => {
      throw new Error("POI unavailable");
    },
    fetchStaticMap: async () => {
      throw new Error("map unavailable");
    },
    route: async () => {
      throw new Error("route unavailable");
    },
    geocode: async () => {
      throw new Error("geocode unavailable server-only-secret");
    },
    weather: async () => [],
  };
  const enriched = await enrichGuidebookPlanWithMaps(fixturePlan(), {
    amapClient: failingClient,
    amapKey: "server-only-secret",
    onError: (message) => failures.push(message),
  });
  const html = renderGuidebookHtml(enriched);

  assert.equal(enriched.route.staticMapUrl, undefined);
  assert.equal(enriched.days[0]?.mapUrl, undefined);
  assert.equal(enriched.days[0]?.nodes[0]?.navigation, null);
  assert.match(html, /地图暂不可用/);
  assert.ok(failures.length > 0);
  assert.doesNotMatch(failures.join("\n"), /server-only-secret/);
});

test("preview and PDF both receive inlined maps from the shared enrichment chain", async () => {
  const { client } = fakeAmapClient();
  const options = {
    amapClient: client,
    amapKey: "server-only-secret",
    fetchImpl: imageFetch(),
  };

  let previewRoute = "";
  let previewDay = "";
  for await (const event of streamGuidebookPages(fixturePlan(), options)) {
    if (event.type !== "page") continue;
    if (event.id === "route") previewRoute = event.html;
    if (event.id === "day-1-map") previewDay = event.html;
  }

  assert.match(previewRoute, /src="data:image\/png;base64,/);
  assert.match(previewDay, /src="data:image\/png;base64,/);
  assert.doesNotMatch(`${previewRoute}${previewDay}`, /server-only-secret/);

  let pdfHtml = "";
  const result = await exportGuidebookForTest(fixturePlan(), {
    ...options,
    renderPdf: async (html) => {
      pdfHtml = html;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  });

  assert.equal(result.status, "ok");
  assert.match(pdfHtml, /src="data:image\/png;base64,/);
  assert.doesNotMatch(pdfHtml, /server-only-secret|<img[^>]+src="https?:\/\//i);
});
