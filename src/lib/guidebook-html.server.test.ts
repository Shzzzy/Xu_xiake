import assert from "node:assert/strict";
import test from "node:test";
import { buildTripMapLayers } from "./amap.server.ts";
import type { BudgetCategory, TripPlan } from "./travel-plan.ts";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import { buildTripClosingWithDeepSeek, verifiedQuotes } from "./travel-plan.server.ts";

function deepSeekFetch(content: unknown): typeof fetch {
  return (async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(content) } }],
    })) as typeof fetch;
}

function category(amount: number, ratio: number): BudgetCategory {
  return { min: amount, max: amount, amount, ratio };
}

export const fixturePlan: TripPlan = {
  meta: {
    title: "黄山秋日路书",
    origin: "上海",
    waypoints: ["杭州"],
    destination: "黄山",
    startDate: "2026-09-20",
    days: 2,
    travelers: { adults: 2, children: 1 },
    perPersonBudget: 3000,
    transportPreference: "balanced",
    pace: "balanced",
    interests: ["自然山水", "古村人文"],
  },
  budget: {
    totalBudget: 9000,
    estimatedTotal: 6480,
    totalMin: 5800,
    totalMax: 7200,
    remaining: 1800,
    overBudget: 0,
    perPersonBudget: 3000,
    perPersonEstimated: 2160,
    rooms: 1,
    transport: category(1500, 0.23),
    lodging: category(1800, 0.28),
    food: category(1300, 0.2),
    tickets: category(1200, 0.19),
    other: category(680, 0.1),
  },
  route: {
    staticMapUrl: "https://maps.example.test/static?key=top-secret&zoom=8",
    outbound: [
      [120.15, 30.27],
      [118.35, 29.72],
    ],
    returnPath: [
      [118.35, 29.72],
      [121.47, 31.23],
    ],
    outboundSegments: [
      {
        from: "上海",
        to: "杭州",
        mode: "drive",
        distanceKm: 180,
        durationMinutes: 150,
        navigation: "https://uri.amap.com/navigation?api_key=route-secret&from=上海",
      },
      {
        from: "杭州",
        to: "黄山",
        mode: "drive",
        distanceKm: 240,
        durationMinutes: 210,
        navigation: "https://uri.amap.com/navigation?from=杭州&to=黄山",
      },
    ],
    returnSegments: [
      {
        from: "黄山",
        to: "上海",
        mode: "drive",
        distanceKm: 410,
        durationMinutes: 330,
        navigation: "https://uri.amap.com/navigation?from=黄山&to=上海",
      },
    ],
    distanceKm: 830,
    durationMinutes: 690,
    returnMode: "fast",
  },
  days: [
    {
      date: "2026-09-20",
      theme: "西湖晨光与徽州入山",
      weather: "多云 19-27°",
      mapUrl: "https://maps.example.test/day-one?key=daily-secret&zoom=12",
      navigationUrl: "https://uri.amap.com/marker?position=120.15,30.27&key=navigation-secret",
      qrCodeUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E",
      nodes: [
        {
          startTime: "08:30",
          endTime: "11:00",
          timeLabel: "08:30-11:00",
          type: "transport",
          name: "上海前往杭州",
          location: "沪昆高速",
          transportMode: "drive",
          transportMinutes: 150,
          estimatedCost: 260,
          tips: "周末早高峰前出发",
          navigation: "https://uri.amap.com/navigation?from=上海&to=杭州&key=node-secret",
        },
        {
          startTime: "11:10",
          endTime: "12:00",
          timeLabel: "11:10-12:00",
          type: "meal",
          name: "杭帮菜午餐",
          location: "西湖边",
          estimatedCost: 220,
          navigation: null,
        },
        {
          startTime: "12:10",
          endTime: "15:00",
          timeLabel: "12:10-15:00",
          type: "attraction",
          name: "西湖白堤",
          location: "杭州西湖风景名胜区",
          stayMinutes: 170,
          estimatedCost: 0,
          tips: "步道平缓，建议放慢速度观察湖岸景观",
          navigation: "https://uri.amap.com/marker?position=120.15,30.27",
        },
        {
          startTime: "15:10",
          endTime: "17:40",
          timeLabel: "15:10-17:40",
          type: "transport",
          name: "杭州前往黄山",
          transportMode: "drive",
          transportMinutes: 150,
          estimatedCost: 340,
          navigation: null,
        },
        {
          startTime: "18:10",
          endTime: "19:00",
          timeLabel: "18:10-19:00",
          type: "hotel",
          name: "黄山南大门酒店入住",
          location: "黄山南大门",
          estimatedCost: 680,
          navigation: null,
        },
        {
          startTime: "19:10",
          endTime: "20:00",
          timeLabel: "19:10-20:00",
          type: "rest",
          name: "整理装备与休整",
          estimatedCost: 0,
          navigation: null,
        },
        {
          startTime: "20:10",
          endTime: "21:00",
          timeLabel: "20:10-21:00",
          type: "night-activity",
          name: "徽州老街夜游",
          location: "屯溪老街",
          estimatedCost: 120,
          navigation: "https://uri.amap.com/marker?position=118.31,29.71",
        },
      ],
      estimatedCost: 1620,
      radar: { physical: 52, childFit: 70, weatherSensitivity: 45, timeCost: 50, crowding: 62 },
      purpose: "把城市、湖泊与徽州山地的过渡放进同一天，抵达后不过度赶路。",
      highlights: [
        "西湖白堤：沿湖慢行，以白居易与苏东坡的治理故事理解湖山格局。",
        "屯溪老街：观察徽派建筑的粉墙黛瓦与商业街巷组织。",
        "黄山南大门：为次日登山留足体力并核对天气。",
      ],
      cautions: ["长距离驾车要轮换休息", "提前确认黄山预约和索道信息"],
      history: [
        {
          title: "西湖白堤",
          background: "白堤之名与唐代杭州刺史白居易主持治理西湖的历史记忆相关。",
          source: "杭州西湖风景名胜区公开资料",
        },
      ],
    },
    {
      date: "2026-09-21",
      theme: "黄山云海与古村回望",
      weather: "晴 16-24°",
      mapUrl: "https://maps.example.test/day-two?zoom=12",
      navigationUrl: "https://uri.amap.com/marker?position=118.16,30.13",
      qrCodeUrl: "https://qr.example.test/day-two.svg",
      nodes: [
        {
          startTime: "06:30",
          endTime: "07:00",
          timeLabel: "06:30-07:00",
          type: "transport",
          name: "酒店前往换乘中心",
          transportMode: "drive",
          transportMinutes: 30,
          estimatedCost: 40,
          navigation: "https://uri.amap.com/navigation?from=酒店&to=换乘中心",
        },
        {
          startTime: "07:10",
          endTime: "08:00",
          timeLabel: "07:10-08:00",
          type: "transfer",
          name: "换乘中心检票换乘",
          location: "黄山南大门换乘中心",
          estimatedCost: 38,
          tips: "保留二次进山凭证",
          navigation: null,
        },
        {
          startTime: "08:20",
          endTime: "14:30",
          timeLabel: "08:20-14:30",
          type: "attraction",
          name: "迎客松与玉屏楼",
          location: "黄山玉屏景区",
          stayMinutes: 370,
          estimatedCost: 190,
          tips: "徐霞客曾记黄山奇松怪石，现场应以景区说明和可核验史料为准",
          navigation: "https://uri.amap.com/marker?position=118.16,30.13",
        },
        {
          startTime: "14:40",
          endTime: "15:30",
          timeLabel: "14:40-15:30",
          type: "meal",
          name: "山顶简餐",
          location: "玉屏楼附近",
          estimatedCost: 180,
          navigation: null,
        },
        {
          startTime: "16:20",
          endTime: "20:20",
          timeLabel: "16:20-20:20",
          type: "transport",
          name: "黄山快速返回上海",
          transportMode: "drive",
          transportMinutes: 240,
          estimatedCost: 420,
          tips: "返程按快速原路原则安排",
          navigation: "https://uri.amap.com/navigation?from=黄山&to=上海",
        },
      ],
      estimatedCost: 868,
      radar: { physical: 82, childFit: 55, weatherSensitivity: 78, timeCost: 72, crowding: 66 },
      purpose: "把体力留给黄山核心山岳景观，并为快速返程留出缓冲。",
      highlights: [
        "迎客松：观察黄山松在花岗岩裂隙中的生长方式。",
        "玉屏楼：远眺天都峰与莲花峰的山岳轮廓。",
        "返程段：以行程复盘结束本次徽州山岳之旅。",
      ],
      cautions: ["山脊风大注意保暖", "返程前确认车辆续航与高速路况"],
    },
  ],
  closing: {
    quote: "癸丑之三月晦，自宁海出西门。云散日朗，人意山光，俱有喜态。",
    source: "《徐霞客游记·游天台山日记》",
    message: "愿每一次出发，都成为丈量山河、理解地方与自己的珍贵记忆。",
  },
};

function pageFragments(html: string, pageName: string): string[] {
  const matches = [...html.matchAll(/<section class="page [^"]*" data-page="([^"]+)"/g)];
  return matches
    .filter((match) => match[1] === pageName)
    .map((match) => {
      const start = match.index ?? 0;
      const next = matches.find((candidate) => (candidate.index ?? 0) > start);
      return html.slice(start, next?.index ?? html.length);
    });
}

function summaryFocusFragment(pageHtml: string): string {
  const start = pageHtml.indexOf('<div class="summary-focus">');
  const end = pageHtml.indexOf('<div class="summary-cautions">', start);
  return start >= 0 && end > start ? pageHtml.slice(start, end) : "";
}

test("renders cover, daily radar and closing pages", () => {
  const html = renderGuidebookHtml(fixturePlan);
  assert.match(html, /旅行回望/);
  assert.match(html, /当日综合雷达/);
  assert.match(html, /致当代徐霞客/);
  assert.match(html, /内容由 AI 生成，旅游记得以实际为准哦/);
});

test("keeps the guidebook page order and daily double-page ownership", () => {
  const html = renderGuidebookHtml(fixturePlan);
  const headings = [
    "封面",
    "旅程概览",
    "路线与交通",
    "预算分配",
    "DAY 01",
    "DAY 02",
    "数据来源与估算说明",
    "旅行回望",
    "致当代徐霞客",
  ];
  let previous = -1;
  for (const heading of headings) {
    const current = html.indexOf(heading);
    assert.ok(current > previous, `${heading} 应出现在前一章节之后`);
    previous = current;
  }

  assert.equal(html.match(/data-page="day-left"/g)?.length, 2);
  assert.equal(html.match(/data-page="day-right"/g)?.length, 2);
  const leftPages = pageFragments(html, "day-left");
  const rightPages = pageFragments(html, "day-right");
  assert.equal(leftPages.length, 2);
  assert.equal(rightPages.length, 2);
  for (const page of leftPages) {
    assert.match(page, /当日综合雷达/);
    assert.doesNotMatch(page, /执行时间轴|今日总结/);
  }
  for (const page of rightPages) {
    assert.match(page, /执行时间轴/);
    assert.match(page, /今日总结/);
    assert.doesNotMatch(page, /当日综合雷达/);
  }
  assert.match(html, /高德每日地图/);
  assert.match(html, /导航二维码/);
  assert.match(html, /今晚住宿/);
  assert.match(html, /当日预算/);
  assert.match(html, /体力/);
  assert.match(html, /亲子/);
  assert.match(html, /天气/);
  assert.match(html, /时间/);
  assert.match(html, /拥挤/);
  assert.match(html, /执行时间轴/);
  assert.match(html, /今日总结/);
  assert.match(html, /DAY 01 \/ 执行与总结/);
  assert.doesNotMatch(html, /DAY 20 \/ 执行与总结/);
  assert.match(html, /DAY 01 执行页/);
  assert.doesNotMatch(html, /DAY 20 执行页/);
  assert.match(html, /历史背景/);
});

test("renders only sourced daily history and never promotes node tips", () => {
  const html = renderGuidebookHtml(fixturePlan);
  const rightPages = pageFragments(html, "day-right");
  assert.equal(rightPages.length, 2);

  const summaryFocus = rightPages.map(summaryFocusFragment).join("");

  assert.match(summaryFocus, /白堤之名与唐代杭州刺史白居易主持治理西湖的历史记忆相关/);
  assert.match(summaryFocus, /来源：杭州西湖风景名胜区公开资料/);
  assert.match(summaryFocus, /计划中未记录可核验的历史沿革/);
  assert.doesNotMatch(summaryFocus, /步道平缓/);
});

test("总览页展示未满足约束清单", () => {
  const html = renderGuidebookHtml({
    ...fixturePlan,
    violations: [
      {
        code: "OVER_BUDGET",
        message: "预计 ¥18,420，超出预算 ¥420",
        detail: { expected: "≤¥18,000", actual: "¥18,420" },
      },
    ],
  });
  assert.match(html, /未满足/);
  assert.match(html, /18,420/);

  // 跨日/无 day 的违规只出现在总览，不应泄漏到任何一天的执行页。
  const dayRights = pageFragments(html, "day-right");
  for (const page of dayRights) {
    assert.doesNotMatch(page, /未满足条件/);
    assert.doesNotMatch(page, /18,420/);
  }
});

test("受影响日期的执行提醒包含违规项", () => {
  const html = renderGuidebookHtml({
    ...fixturePlan,
    violations: [
      {
        code: "TIME_WINDOW",
        day: 2,
        message: "第 2 天比设定结束时间晚 1 小时 30 分",
        detail: { expected: "≤18:00", actual: "19:30" },
      },
    ],
  });
  const dayRight = pageFragments(html, "day-right")[1];
  assert.match(dayRight ?? "", /未满足条件/);

  // 第 2 天的违规不应泄漏到第 1 天执行页。
  const firstDayRight = pageFragments(html, "day-right")[0];
  assert.doesNotMatch(firstDayRight ?? "", /未满足条件/);
  assert.doesNotMatch(firstDayRight ?? "", /第 2 天比设定结束时间晚 1 小时 30 分/);
});
test("only renders verified closing citations from TripClosing.source", () => {
  const withoutSource: TripPlan = {
    ...fixturePlan,
    closing: {
      quote: "这是一段无来源引用，不应进入路书。",
      source: null,
      message: "没有合适原文时，只使用现代语言释义。",
    },
  };

  const withSource = renderGuidebookHtml(fixturePlan);
  const withoutVerification = renderGuidebookHtml(withoutSource);

  assert.match(withSource, /《徐霞客游记·游天台山日记》/);
  assert.doesNotMatch(withoutVerification, /这是一段无来源引用/);
  assert.match(withoutVerification, /只使用现代语言释义/);
});

test("escapes plan content and strips API keys from rendered URLs", () => {
  const hostile: TripPlan = {
    ...fixturePlan,
    meta: { ...fixturePlan.meta, title: "<script>alert(1)</script>" },
    days: [
      {
        ...fixturePlan.days[0],
        navigationUrl: "/marker?key=relative-secret&position=120,30",
        nodes: [{ ...fixturePlan.days[0].nodes[0], name: "<img src=x onerror=alert(1)>" }],
      },
    ],
    closing: { ...fixturePlan.closing, message: "<b>安全结束语</b>" },
  };

  const html = renderGuidebookHtml(hostile);

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;安全结束语&lt;\/b&gt;/);
  assert.doesNotMatch(
    html,
    /top-secret|route-secret|daily-secret|navigation-secret|node-secret|relative-secret/,
  );
  assert.doesNotMatch(html, /(?:[?&](?:key|api_key|apikey|access_key|accesskey|secret|token)=)/i);
});

test("uses a real static map when available and keeps schematic return styles on fallback", () => {
  const fastHtml = renderGuidebookHtml({
    ...fixturePlan,
    route: { ...fixturePlan.route, returnMode: "fast" },
  });
  const scenicHtml = renderGuidebookHtml({
    ...fixturePlan,
    route: { ...fixturePlan.route, returnMode: "scenic" },
  });
  const fallbackHtml = renderGuidebookHtml({
    ...fixturePlan,
    route: { ...fixturePlan.route, returnMode: "fast", staticMapUrl: undefined },
  });

  const fastRoute = pageFragments(fastHtml, "route")[0] ?? "";
  const scenicRoute = pageFragments(scenicHtml, "route")[0] ?? "";
  assert.match(fastRoute, /<img src="https:\/\/maps\.example\.test\/static/);
  assert.doesNotMatch(fastRoute, /schematic-map/);
  assert.match(fastHtml, /快速返程/);
  assert.match(scenicRoute, /<img src="https:\/\/maps\.example\.test\/static/);
  assert.match(scenicHtml, /回程再玩/);
  assert.match(
    fallbackHtml,
    /<polyline data-layer="return"[^>]*stroke="#8A6A58"[^>]*stroke-dasharray="9 8"/,
  );
});

test("builds separate solid map layers for scenic returns", () => {
  const layers = buildTripMapLayers({ ...fixturePlan.route, returnMode: "scenic" });

  assert.deepEqual(
    layers.map((layer) => layer.kind),
    ["outbound", "return"],
  );
  assert.equal(layers[0]?.lineStyle, "solid");
  assert.equal(layers[1]?.lineStyle, "solid");
  assert.notEqual(layers[0]?.color, layers[1]?.color);
});

test("builds a dashed return layer for fast returns", () => {
  const layers = buildTripMapLayers({ ...fixturePlan.route, returnMode: "fast" });

  assert.equal(layers.at(-1)?.kind, "return");
  assert.equal(layers.at(-1)?.lineStyle, "dashed");
  assert.notEqual(layers[0]?.color, layers[1]?.color);
});

test("builds only the outbound layer for one-way trips", () => {
  const layers = buildTripMapLayers({ ...fixturePlan.route, returnMode: null });

  assert.deepEqual(
    layers.map((layer) => layer.kind),
    ["outbound"],
  );
});

test("starts the trip summary at the top of a new recap page", () => {
  const html = renderGuidebookHtml({
    ...fixturePlan,
    route: { ...fixturePlan.route, staticMapUrl: undefined },
  });
  const closingPage = pageFragments(html, "closing")[0];

  assert.ok(closingPage);
  assert.match(
    closingPage,
    /<div class="page-content"><header class="section-heading">[\s\S]*?<h2>旅行回望<\/h2><\/header><section class="reflection-card trip-summary"><h3>旅程总结<\/h3>/,
  );
});

test("builds route-aware closing text with all required sections and a verified quote", async () => {
  const quote = verifiedQuotes[0];
  const closing = await buildTripClosingWithDeepSeek(
    {
      origin: "上海",
      waypoints: ["杭州"],
      destination: "黄山",
      days: 2,
      pace: "balanced",
      interests: ["自然山水"],
    },
    {
      apiKey: "test-key",
      fetchImpl: deepSeekFetch({
        quoteId: quote.id,
        message: "一路所见让山海与古城都有了可以回想的细节。",
      }),
    },
  );

  assert.equal(closing.quote, quote.quote);
  assert.equal(closing.source, quote.source);
  assert.match(closing.message, /路线总结/);
  assert.match(closing.message, /上海/);
  assert.match(closing.message, /黄山/);
  assert.match(closing.message, /旅行评价/);
  assert.match(closing.message, /继续出发/);
  assert.match(closing.message, /寄语/);
});

test("generates different closing text for different journeys", async () => {
  const modelContent = {
    quoteId: null,
    message: "沿途的山水与人文让旅程有了耐心观察的尺度。",
  };
  const first = await buildTripClosingWithDeepSeek(
    { origin: "上海", destination: "黄山", days: 2, pace: "relaxed" },
    { apiKey: "test-key", fetchImpl: deepSeekFetch(modelContent) },
  );
  const second = await buildTripClosingWithDeepSeek(
    { origin: "北京", destination: "敦煌", days: 6, pace: "deep" },
    { apiKey: "test-key", fetchImpl: deepSeekFetch(modelContent) },
  );

  assert.notEqual(first.message, second.message);
  assert.match(first.message, /上海.*黄山|上海.*杭州|上海/);
  assert.match(second.message, /北京.*敦煌|敦煌/);
  assert.equal(first.quote, null);
  assert.equal(second.quote, null);
});

test("generates distinct closing route summaries for fast, scenic and one-way trips", async () => {
  const modelContent = {
    quoteId: null,
    message: "沿途的山水与人文让旅程有了耐心观察的尺度。",
  };
  const baseInput = { origin: "上海", waypoints: ["杭州"], destination: "黄山", days: 2 };
  const fast = await buildTripClosingWithDeepSeek(
    { ...baseInput, returnMode: "fast" },
    { apiKey: "test-key", fetchImpl: deepSeekFetch(modelContent) },
  );
  const scenic = await buildTripClosingWithDeepSeek(
    { ...baseInput, returnMode: "scenic" },
    { apiKey: "test-key", fetchImpl: deepSeekFetch(modelContent) },
  );
  const single = await buildTripClosingWithDeepSeek(
    { ...baseInput, returnMode: null },
    { apiKey: "test-key", fetchImpl: deepSeekFetch(modelContent) },
  );

  assert.notEqual(fast.message, scenic.message);
  assert.notEqual(fast.message, single.message);
  assert.notEqual(scenic.message, single.message);
  assert.match(fast.message, /快速返程|往返/);
  assert.match(scenic.message, /不走回头/);
  assert.match(single.message, /从出发到目的地的一段完整探索/);
  assert.doesNotMatch(single.message, /返程/);
});

test("accepts only Task 4 verified quote ids in final closing text", async () => {
  const unknownQuote = await buildTripClosingWithDeepSeek(
    { destination: "黄山", days: 2 },
    {
      apiKey: "test-key",
      fetchImpl: deepSeekFetch({ quoteId: "model-invented-quote", message: "自编引用不应生效。" }),
    },
  );

  assert.equal(unknownQuote.quote, null);
  assert.equal(unknownQuote.source, null);
  assert.doesNotMatch(unknownQuote.message, /自编引用不应生效/);
});
