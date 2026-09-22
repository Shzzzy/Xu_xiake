import assert from "node:assert/strict";
import test from "node:test";
import type { AmapClient, AmapCoordinate, AmapRoute } from "./amap.server.ts";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import { enrichGuidebookPlanWithMaps } from "./guidebook-map.server.ts";
import { exportGuidebookForTest, prepareGuidebookImage } from "./guidebook-pdf.server.ts";
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
    北京: [116.4074, 39.9042],
    上海: [121.4737, 31.2304],
    大理洱海: [100.2676, 25.6065],
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
  const searchInputs: Parameters<AmapClient["searchPoi"]>[0][] = [];
  const routeInputs: Parameters<AmapClient["route"]>[0][] = [];

  const client: AmapClient = {
    async searchPoi(input) {
      searchCalls += 1;
      searchInputs.push(input);
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
      routeInputs.push(input);
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
    details: () => ({
      searchCities: searchInputs.map((input) => input.city ?? ""),
      searchContexts: searchInputs.map((input) => `${input.city ?? ""}:${input.keywords}`),
      routeInputs: [...routeInputs],
    }),
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
  const { client, counts } = fakeAmapClient();
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
  const routeCallsAfterPreview = counts().routeCalls;

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
  assert.equal(counts().routeCalls, routeCallsAfterPreview);
  assert.match(pdfHtml, /src="data:image\/png;base64,/);
  assert.doesNotMatch(pdfHtml, /server-only-secret|<img[^>]+src="https?:\/\//i);
});

test("caches only the map overlay and preserves the current plan's non-map fields", async () => {
  const { client, counts } = fakeAmapClient();
  const firstPlan = fixturePlan();
  const first = await enrichGuidebookPlanWithMaps(firstPlan, { amapClient: client });
  const callsAfterFirst = counts();

  const changedPlan = fixturePlan();
  changedPlan.meta.title = "第二份行程标题";
  changedPlan.meta.travelers = { adults: 1, children: 2 };
  changedPlan.budget.totalBudget = 9999;
  changedPlan.days[0]!.purpose = "仅文案变化，不应重新请求地图";
  const second = await enrichGuidebookPlanWithMaps(changedPlan, { amapClient: client });

  assert.deepEqual(second.route, first.route);
  assert.deepEqual(second.days[0]?.mapUrl, first.days[0]?.mapUrl);
  assert.equal(second.meta.title, "第二份行程标题");
  assert.deepEqual(second.meta.travelers, { adults: 1, children: 2 });
  assert.equal(second.budget.totalBudget, 9999);
  assert.equal(second.days[0]?.purpose, "仅文案变化，不应重新请求地图");
  assert.deepEqual(counts(), callsAfterFirst);
});

test("plans supported transport modes explicitly and disables unsupported navigation", async () => {
  const plan = fixturePlan();
  plan.route.returnMode = null;
  plan.route.returnSegments = [];
  plan.route.outboundSegments = [
    {
      from: "上海",
      to: "杭州",
      mode: "train",
      distanceKm: 170,
      durationMinutes: 60,
      navigation: "",
    },
    {
      from: "杭州",
      to: "黄山",
      mode: "bus",
      distanceKm: 240,
      durationMinutes: 210,
      navigation: "",
    },
    {
      from: "黄山",
      to: "上海",
      mode: "flight",
      distanceKm: 400,
      durationMinutes: 65,
      navigation: "",
    },
    {
      from: "上海",
      to: "杭州",
      mode: "ship",
      distanceKm: 150,
      durationMinutes: 300,
      navigation: "",
    },
  ];

  const { client, counts, details } = fakeAmapClient();
  const enriched = await enrichGuidebookPlanWithMaps(plan, { amapClient: client });
  const segments = enriched.route.outboundSegments;
  const routeInputs = details().routeInputs;
  const trainInput = routeInputs.find((input) => input.mode === "transit");
  const busSegment = segments.find((segment) => segment.mode === "bus");
  const flightSegment = segments.find((segment) => segment.mode === "flight");
  const shipSegment = segments.find((segment) => segment.mode === "ship");

  assert.equal(counts().routeCalls, 2);
  assert.equal(trainInput?.city, "上海");
  assert.equal(trainInput?.destinationCity, "杭州");
  assert.match(busSegment?.navigation ?? "", /mode=bus/);
  assert.equal(busSegment?.durationMinutes, 210);
  assert.notEqual(busSegment?.durationMinutes, 120);
  assert.equal(flightSegment?.distanceKm, 400);
  assert.equal(flightSegment?.durationMinutes, 65);
  assert.equal(flightSegment?.navigation, "");
  assert.equal(shipSegment?.distanceKm, 150);
  assert.equal(shipSegment?.durationMinutes, 300);
  assert.equal(shipSegment?.navigation, "");
});

test("derives city context per POI for same-day and same-name cross-city nodes", async () => {
  const plan = fixturePlan();
  plan.days = [
    {
      ...plan.days[0]!,
      nodes: [plan.days[0]!.nodes[0]!, plan.days[1]!.nodes[0]!],
    },
    {
      ...plan.days[1]!,
      nodes: [
        {
          ...plan.days[0]!.nodes[0]!,
          name: "西湖",
          location: "惠州市西湖风景名胜区",
        },
      ],
    },
  ];

  const { client, details } = fakeAmapClient();
  const enriched = await enrichGuidebookPlanWithMaps(plan, { amapClient: client });
  const contexts = details().searchContexts;

  assert.ok(enriched.days[0]?.nodes[0]?.coordinates);
  assert.ok(enriched.days[0]?.nodes[1]?.coordinates);
  assert.ok(contexts.includes("杭州:西湖"), `杭州西湖缺失：${contexts.join(",")}`);
  assert.ok(contexts.includes("黄山:宏村"), `黄山宏村缺失：${contexts.join(",")}`);
  assert.ok(contexts.includes("惠州:西湖"), `惠州西湖缺失：${contexts.join(",")}`);
});

test("carries the previous day's endpoint into the next day's navigation", async () => {
  const { client } = fakeAmapClient();
  const enriched = await enrichGuidebookPlanWithMaps(fixturePlan(), { amapClient: client });
  const secondDayFirstNode = enriched.days[1]?.nodes[0];
  const nodeNavigation = new URL(secondDayFirstNode?.navigation ?? "");
  const dayNavigation = new URL(enriched.days[1]?.navigationUrl ?? "");

  assert.match(nodeNavigation.searchParams.get("from") ?? "", /^120\.1379,30\.2458/);
  assert.doesNotMatch(nodeNavigation.searchParams.get("from") ?? "", /^121\.4737,31\.2304/);
  assert.match(dayNavigation.searchParams.get("from") ?? "", /^120\.1379,30\.2458/);
});

test(
  "stops enrichment within the total budget and returns degraded fields",
  { timeout: 2_000 },
  async () => {
    const points = coords();
    const messages: string[] = [];
    const client: AmapClient = {
      searchPoi: async (input) => {
        const point = points[input.keywords];
        return point
          ? [{ id: input.keywords, name: input.keywords, type: "", address: "", location: point }]
          : [];
      },
      fetchStaticMap: async () => new Uint8Array(),
      route: async () => new Promise<AmapRoute>(() => undefined),
      geocode: async (input) => {
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
      weather: async () => [],
    };

    const startedAt = Date.now();
    const enriched = await enrichGuidebookPlanWithMaps(fixturePlan(), {
      amapClient: client,
      timeoutMs: 30,
      onError: (message) => messages.push(message),
    });

    assert.ok(Date.now() - startedAt < 500, "总预算超时后应立即返回降级结果");
    assert.ok(enriched.route.outbound.length > 0);
    assert.ok(
      messages.some((message) => /总预算|超时/.test(message)),
      messages.join("\n"),
    );
  },
);

test("limits map and QR image preparation to a shared concurrency ceiling", async () => {
  let active = 0;
  let maximum = 0;
  const fetchImpl = (async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;

  await Promise.all(
    Array.from({ length: 6 }, (_, index) => {
      const isMap = index % 2 === 0;
      const url = isMap
        ? `https://restapi.amap.com/v3/staticmap?zoom=10&i=${index}`
        : `https://api.qrserver.com/v1/create-qr-code/?data=${index}`;
      return prepareGuidebookImage(url, isMap ? "map" : "qr", {
        fetchImpl,
        amapKey: "concurrency-key",
      });
    }),
  );

  assert.ok(maximum <= 4, `并发上限失效，实际 ${maximum}`);
});

test("首次失败会自动重试并直接返回真实地图", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Response("offline", { status: 503 });
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;
  const url = `https://restapi.amap.com/v3/staticmap?zoom=10&retry=${Date.now()}`;

  const result = await prepareGuidebookImage(url, "map", { fetchImpl, amapKey: "retry-key" });

  assert.match(result ?? "", /^data:image\/png;base64,/);
  assert.equal(calls, 2);
});

test("重试后仍失败才回退占位图，且占位图不会被缓存", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    // 前两次（首次 + 重试）都失败，之后才恢复。
    if (calls <= 2) return new Response("offline", { status: 503 });
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;
  const url = `https://restapi.amap.com/v3/staticmap?zoom=10&retry=${Date.now()}`;

  const first = await prepareGuidebookImage(url, "map", { fetchImpl, amapKey: "retry-key" });
  const second = await prepareGuidebookImage(url, "map", { fetchImpl, amapKey: "retry-key" });

  assert.match(first ?? "", /^data:image\/svg\+xml;base64,/);
  assert.match(second ?? "", /^data:image\/png;base64,/);
  assert.equal(calls, 3);
});

test("merges missing navigation and QR fields into a partially mapped plan", async () => {
  const plan = fixturePlan();
  plan.route.outbound = [coords().上海, coords().杭州];
  plan.route.returnPath = [coords().黄山, coords().上海];
  plan.route.staticMapUrl = "https://restapi.amap.com/v3/staticmap?zoom=7&paths=test";
  plan.days = plan.days.map((day) => ({
    ...day,
    mapUrl: "https://restapi.amap.com/v3/staticmap?zoom=12&paths=day",
  }));

  const { client } = fakeAmapClient();
  const enriched = await enrichGuidebookPlanWithMaps(plan, { amapClient: client });

  assert.ok(enriched.days[0]?.nodes[0]?.coordinates);
  assert.match(enriched.days[0]?.nodes[0]?.navigation ?? "", /^https:\/\/uri\.amap\.com/);
  assert.match(enriched.days[0]?.qrCodeUrl ?? "", /^https:\/\/api\.qrserver\.com/);
});

test("does not cache partial enrichment after a map request failure", async () => {
  const { client: baseClient } = fakeAmapClient();
  let attempts = 0;
  const client: AmapClient = {
    ...baseClient,
    async route(input) {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary route failure");
      return baseClient.route(input);
    },
  };

  const first = await enrichGuidebookPlanWithMaps(fixturePlan(), { amapClient: client });
  assert.ok(first.route.staticMapUrl);
  const firstAttempts = attempts;
  assert.ok(firstAttempts > 0);

  await enrichGuidebookPlanWithMaps(fixturePlan(), { amapClient: client });
  assert.equal(attempts, firstAttempts * 2, "失败结果不得进入共享缓存，下一次应重新尝试");
});

test("propagates upstream cancellation through preview and PDF preparation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("client disconnected"));
  const { client, counts } = fakeAmapClient();

  for await (const _event of streamGuidebookPages(fixturePlan(), {
    amapClient: client,
    signal: controller.signal,
  })) {
    // 只需要确认流会结束并保持降级，不需要逐页断言。
  }
  assert.equal(counts().routeCalls, 0);

  let rendered = false;
  await assert.rejects(
    () =>
      exportGuidebookForTest(fixturePlan(), {
        amapClient: client,
        signal: controller.signal,
        renderPdf: async () => {
          rendered = true;
          return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        },
      }),
    /取消/,
  );
  assert.equal(rendered, false);
  assert.equal(counts().routeCalls, 0);
});

test("fits nationwide route maps with complete stop markers and daily padding", async () => {
  const plan = fixturePlan();
  plan.meta = {
    ...plan.meta,
    origin: "北京",
    waypoints: ["上海"],
    destination: "大理洱海",
    days: 1,
  };
  plan.route.outboundSegments = [
    {
      from: "北京",
      to: "上海",
      mode: "flight",
      distanceKm: 1_100,
      durationMinutes: 180,
      navigation: "",
    },
    {
      from: "上海",
      to: "大理洱海",
      mode: "flight",
      distanceKm: 2_160,
      durationMinutes: 210,
      navigation: "",
    },
  ];
  plan.route.returnSegments = [
    {
      from: "大理洱海",
      to: "北京",
      mode: "flight",
      distanceKm: 2_180,
      durationMinutes: 220,
      navigation: "",
    },
  ];
  plan.days = [
    {
      ...plan.days[0]!,
      date: "2026-09-20",
      mapUrl: undefined,
      nodes: [
        {
          ...plan.days[0]!.nodes[0]!,
          startTime: "08:00",
          endTime: "11:00",
          timeLabel: "08:00–11:00",
          type: "transport",
          name: "北京飞往上海",
          location: "北京",
          transportMode: "flight",
          transportMinutes: 180,
          estimatedCost: 1600,
          navigation: null,
        },
        {
          ...plan.days[0]!.nodes[0]!,
          startTime: "13:00",
          endTime: "16:30",
          timeLabel: "13:00–16:30",
          type: "transport",
          name: "上海飞往大理洱海",
          location: "上海",
          transportMode: "flight",
          transportMinutes: 210,
          estimatedCost: 3200,
          navigation: null,
        },
      ],
    },
  ];

  const { client } = fakeAmapClient();
  const enriched = await enrichGuidebookPlanWithMaps(plan, { amapClient: client });
  const routeUrl = new URL(enriched.route.staticMapUrl ?? "");
  const dayUrl = new URL(enriched.days[0]?.mapUrl ?? "");
  const routeMarkers = decodeURIComponent(routeUrl.searchParams.get("markers") ?? "");
  const dayMarkers = decodeURIComponent(dayUrl.searchParams.get("markers") ?? "");

  assert.ok(Number(routeUrl.searchParams.get("zoom")) <= 2, "全国长距离路线必须保留足够边距");
  assert.match(routeMarkers, /A:116\.4074,39\.9042/);
  assert.match(routeMarkers, /B:121\.4737,31\.2304/);
  assert.match(routeMarkers, /C:100\.2676,25\.6065/);
  assert.match(dayMarkers, /A:116\.4074,39\.9042/);
  assert.match(dayMarkers, /B:100\.2676,25\.6065/);
  assert.match(
    decodeURIComponent(dayUrl.searchParams.get("paths") ?? ""),
    /121\.4737,31\.2304/,
    "跨城当日地图必须包含途经地坐标，不能只画起终点直线",
  );
});
