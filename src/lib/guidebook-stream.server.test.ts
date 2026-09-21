import assert from "node:assert/strict";
import test from "node:test";
import type { TripPlan } from "./travel-plan.ts";
import {
  guidebookPageSpecs,
  renderGuidebookHead,
  renderGuidebookHtml,
  renderGuidebookPages,
} from "./guidebook-html.server.ts";
import { encodeGuidebookEvent, streamGuidebookPages } from "./guidebook-stream.server.ts";

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
  const line = encodeGuidebookEvent({ type: "meta", total: 9, title: "标题", head: "<style></style>" });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.trimEnd().split("\n").length, 1);
  assert.deepEqual(JSON.parse(line), {
    type: "meta",
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
