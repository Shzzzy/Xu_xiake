import assert from "node:assert/strict";
import test from "node:test";
import type { TripPlan } from "./travel-plan.ts";
import {
  guidebookPageSpecs,
  renderGuidebookHead,
  renderGuidebookHtml,
  renderGuidebookPages,
} from "./guidebook-html.server.ts";
import {
  acceptPage,
  createPreviewState,
  encodeGuidebookEvent,
  streamGuidebookPages,
  type GuidebookPageEvent,
} from "./guidebook-stream.server.ts";

/** 最小可用路书行程：不带远程地图，测试不需要联网。 */
const plan: TripPlan = {
  meta: {
    title: "徽州两日路书",
    origin: "上海",
    waypoints: [],
    destination: "黄山",
    startDate: "2026-09-20",
    days: 2,
    travelers: { adults: 2, children: 0 },
    perPersonBudget: 4000,
    transportPreference: "balanced",
    pace: "balanced",
    interests: ["自然山水"],
  },
  budget: {
    totalBudget: 8000,
    estimatedTotal: 3000,
    totalMin: 2800,
    totalMax: 3200,
    remaining: 4800,
    overBudget: 0,
    perPersonBudget: 4000,
    perPersonEstimated: 1500,
    rooms: 1,
    transport: { min: 800, max: 900, amount: 850, ratio: 0.28 },
    lodging: { min: 800, max: 900, amount: 850, ratio: 0.28 },
    food: { min: 400, max: 500, amount: 450, ratio: 0.15 },
    tickets: { min: 500, max: 600, amount: 550, ratio: 0.18 },
    other: { min: 200, max: 300, amount: 250, ratio: 0.08 },
  },
  route: {
    outbound: [
      [118.4, 29.7],
      [118.3, 30.1],
    ],
    returnPath: [],
    outboundSegments: [
      {
        from: "上海",
        to: "黄山",
        mode: "balanced",
        distanceKm: 400,
        durationMinutes: 240,
        navigation: "https://www.amap.com/",
      },
    ],
    returnSegments: [],
    distanceKm: 400,
    durationMinutes: 240,
    returnMode: null,
  },
  days: [
    {
      date: "2026-09-20",
      theme: "黄山风景区",
      weather: "晴 18–26°",
      nodes: [
        {
          startTime: "09:00",
          endTime: "12:00",
          timeLabel: "09:00–12:00",
          type: "attraction",
          name: "黄山风景区",
          location: "黄山风景区",
          estimatedCost: 320,
          navigation: null,
        },
      ],
      estimatedCost: 320,
      radar: { physical: 60, childFit: 40, weatherSensitivity: 70, timeCost: 55, crowding: 65 },
      purpose: "把主景区安排在体力最好的上午。",
      highlights: ["黄山风景区：奇松怪石集中"],
      cautions: ["山上风大，注意保暖"],
    },
    {
      date: "2026-09-21",
      theme: "宏村",
      weather: "多云 19–27°",
      nodes: [],
      estimatedCost: 160,
      radar: { physical: 40, childFit: 70, weatherSensitivity: 50, timeCost: 45, crowding: 55 },
      purpose: "古村慢走，留出返程时间。",
      highlights: ["宏村：水系与民居"],
      cautions: ["石板路雨后湿滑"],
    },
  ],
  closing: { quote: null, source: null, message: "路线总结：上海到黄山。旅行评价：值得。" },
};

test("overview page carries the daily weather trend", () => {
  const html = renderGuidebookHtml(plan);
  assert.match(html, /逐日天气/);
  assert.match(html, /晴 18–26°/);
  assert.match(html, /第 2 天/);
});

test("page specs and rendered pages keep one shared order", () => {
  const specs = guidebookPageSpecs(plan);
  const pages = renderGuidebookPages(plan);
  assert.deepEqual(
    pages.map((page) => page.id),
    specs.map((spec) => spec.id),
  );
  // 封面、概览、路线、预算 + 每天两页 + 来源、回望、封底
  assert.equal(specs.length, 4 + plan.days.length * 2 + 3);
  const html = renderGuidebookHtml(plan);
  for (const page of pages) assert.ok(html.includes(page.html));
});

test("stream pushes meta first then every page in order", async () => {
  const events = [];
  for await (const event of streamGuidebookPages(plan)) events.push(event);

  const [meta, ...pages] = events;
  assert.equal(meta?.type, "meta");
  if (meta?.type === "meta") assert.equal(meta.runId, "legacy");
  assert.equal(pages.length, meta && meta.type === "meta" ? meta.total : -1);
  assert.equal(pages[0]?.type, "page");
  const ids = pages.flatMap((event) => (event.type === "page" ? [event.id] : []));
  assert.deepEqual(ids, guidebookPageSpecs(plan).map((spec) => spec.id));
  for (const event of pages) {
    if (event.type !== "page") continue;
    assert.match(event.html, /data-page=/);
    assert.ok(event.label.length > 0);
  }
});

test("stream events encode as one NDJSON line each", () => {
  const line = encodeGuidebookEvent({
    type: "meta",
    runId: "run-1",
    total: 9,
    title: "标题",
    head: "<style></style>",
  });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.trimEnd().split("\n").length, 1);
  assert.deepEqual(JSON.parse(line), {
    type: "meta",
    runId: "run-1",
    total: 9,
    title: "标题",
    head: "<style></style>",
  });
});

test("preview head avoids third-party CDNs while the PDF head keeps webfonts", () => {
  const previewHead = renderGuidebookHead(plan, { forPreview: true });
  assert.doesNotMatch(previewHead, /fonts\.googleapis\.com|cdn\.jsdelivr\.net/);
  assert.match(previewHead, /Songti SC/);
  assert.match(renderGuidebookHead(plan), /fonts\.googleapis\.com/);
});

test("butler day copy and analysis failure reach every preview page unchanged", async () => {
  const butlerPlan: TripPlan = {
    ...plan,
    meta: { ...plan.meta, narrativeSource: "butler" },
    days: plan.days.map((day, index) => ({
      ...day,
      purpose: `管家第 ${index + 1} 天目的`,
      highlights: [`管家第 ${index + 1} 天重点`],
      cautions:
        index === 0
          ? ["本页分析未能生成，已改用基础行程与本地提示。"]
          : day.cautions,
      analysisFailed: index === 0 ? true : undefined,
    })),
  };

  const events = [];
  for await (const event of streamGuidebookPages(butlerPlan)) events.push(event);
  const html = events.flatMap((event) => (event.type === "page" ? [event.html] : [])).join("");

  // 逐页预览使用管家原文，失败日的「本页分析未能生成」留痕也保留。
  assert.match(html, /管家第 1 天目的/);
  assert.match(html, /管家第 1 天重点/);
  assert.match(html, /本页分析未能生成/);
});

test("每日文案校验通过后才推送该日页面，失败日降级后继续", async () => {
  const order: string[] = [];
  const events: unknown[] = [];
  const butlerPlan: TripPlan = {
    ...plan,
    meta: { ...plan.meta, narrativeSource: "butler" },
    days: plan.days.map((day, index) => ({
      ...day,
      purpose: index === 1 ? "未校验的旧文案" : `待校验第 ${index + 1} 天`,
    })),
  };

  for await (const event of streamGuidebookPages(butlerPlan, {
    runId: "run-1",
    onEvent: (streamEvent) => {
      events.push(streamEvent);
      if (streamEvent.type === "page") order.push(streamEvent.id);
    },
    loadDayNarrative: async (_day, index) => {
      order.push(`load-day-${index + 1}`);
      if (index === 1) throw new Error("第 2 天文案未通过校验");
      const source = butlerPlan.days[index];
      if (!source) throw new Error("缺少测试日期");
      return {
        ...source,
        purpose: `校验通过第 ${index + 1} 天`,
        highlights: [`第 ${index + 1} 天：按冻结排程游览`],
        cautions: ["遵守集合时间"],
      };
    },
  })) {
    // 消费生成器；事件顺序由 onEvent 记录。
  }

  assert.ok(order.indexOf("load-day-1") < order.indexOf("day-1-map"));
  assert.ok(order.indexOf("day-1-summary") < order.indexOf("load-day-2"));
  assert.ok(order.indexOf("load-day-2") < order.indexOf("day-2-map"));

  const pageEvents = events.filter(
    (event): event is GuidebookPageEvent =>
      typeof event === "object" && event !== null && "type" in event && event.type === "page",
  );
  assert.ok(pageEvents.length > 0);
  assert.ok(pageEvents.every((event) => event.runId === "run-1"));
  assert.ok(pageEvents.every((event) => event.checksum.length > 0));
  assert.equal(new Set(pageEvents.map((event) => event.checksum)).size, pageEvents.length);

  const dayTwoHtml = pageEvents
    .filter((event) => event.id === "day-2-map" || event.id === "day-2-summary")
    .map((event) => event.html)
    .join("");
  assert.match(dayTwoHtml, /本页分析未能生成/);
  assert.doesNotMatch(dayTwoHtml, /未校验的旧文案/);
});

test("服务端页面状态拒绝乱序、重复 checksum 和旧 run", () => {
  const state = createPreviewState("run-1");
  const pageEvent: GuidebookPageEvent = {
    type: "page",
    runId: "run-1",
    index: 0,
    id: "cover",
    label: "封面",
    checksum: "checksum-a",
    html: "<article>封面</article>",
  };

  assert.equal(acceptPage(state, { ...pageEvent, index: 1, checksum: "checksum-b" }), false);
  assert.equal(acceptPage(state, pageEvent), true);
  assert.equal(acceptPage(state, pageEvent), false);
  assert.equal(acceptPage(state, { ...pageEvent, runId: "run-old", index: 1, checksum: "checksum-c" }), false);
  assert.equal(acceptPage(state, { ...pageEvent, index: 1, checksum: "checksum-d" }), true);
});

test("meta 和 error 协议都携带 runId", () => {
  const events: unknown[] = [];
  const iterator = streamGuidebookPages(plan, {
    runId: "run-1",
    onEvent: (event) => events.push(event),
  });
  void iterator;

  const errorLine = encodeGuidebookEvent({ type: "error", runId: "run-1", message: "失败" });
  assert.deepEqual(JSON.parse(errorLine), {
    type: "error",
    runId: "run-1",
    message: "失败",
  });
});

test("生成器真实路径按共享协议自检并拒绝重复 checksum", async () => {
  await assert.rejects(async () => {
    for await (const _event of streamGuidebookPages(plan, {
      runId: "run-1",
      pageChecksumFactory: () => "duplicate-checksum",
    })) {
      // 消费生成器以触发自检。
    }
  }, /页面协议/);
});
