import test from "node:test";
import assert from "node:assert/strict";
import {
  auditAttractionsWithDeepSeek,
  buildDaySummaryWithDeepSeek,
  buildTripClosingWithDeepSeek,
  estimateBudgetWithDeepSeek,
  parseTripClosing,
} from "./travel-plan.server.ts";

type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit };

function createDeepSeekFetch(content: unknown, requests: RecordedRequest[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Response.json({
      choices: [{ message: { content: JSON.stringify(content) } }],
    });
  }) as typeof fetch;
}

function requestBody(request: RecordedRequest | undefined): Record<string, unknown> {
  assert.ok(request, "应发起一次 DeepSeek 请求");
  return JSON.parse(String(request.init?.body)) as Record<string, unknown>;
}

test("rejects a fabricated historical quote without a verified source", () => {
  assert.throws(
    () => parseTripClosing({ quote: "不存在的原文", source: "", message: "寄语" }),
    /引用必须提供可核验来源/,
  );
});

test("falls back to modern wording when quote is absent", () => {
  const closing = parseTripClosing({ quote: null, source: null, message: "山河万里，行者常新。" });
  assert.equal(closing.quote, null);
  assert.match(closing.message, /山河/);
});

test("audits attractions in input order with strict JSON output", async () => {
  const requests: RecordedRequest[] = [];
  const fetchImpl = createDeepSeekFetch(
    {
      audits: [
        {
          name: "灵隐寺",
          scale: "medium",
          durationHours: 3,
          physical: 42,
          childFit: 68,
          weatherSensitivity: 35,
          timeCost: 48,
          crowding: 76,
          bestTime: "上午",
        },
        {
          name: "西湖",
          scale: "large",
          durationHours: 7,
          physical: 58,
          childFit: 74,
          weatherSensitivity: 81,
          timeCost: 72,
          crowding: 92,
          bestTime: "清晨",
        },
      ],
    },
    requests,
  );

  const audits = await auditAttractionsWithDeepSeek(
    {
      destination: "杭州",
      attractions: ["西湖", "灵隐寺"],
      travelers: { adults: 2, children: 1 },
      pace: "balanced",
    },
    { apiKey: "test-key", baseUrl: "https://deepseek.test/", fetchImpl },
  );

  assert.deepEqual(
    audits.map((audit) => audit.scale),
    ["large", "medium"],
  );
  assert.equal(String(requests[0]?.input), "https://deepseek.test/chat/completions");
  const body = requestBody(requests[0]);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(JSON.stringify(body.messages), /西湖/);
  assert.match(JSON.stringify(body.messages), /只输出 JSON/);
});

test("does not call DeepSeek when there are no attractions", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({});
  }) as typeof fetch;

  const audits = await auditAttractionsWithDeepSeek(
    { attractions: [] },
    { apiKey: "test-key", fetchImpl },
  );

  assert.deepEqual(audits, []);
  assert.equal(calls, 0);
});

test("turns per-category budget ranges into a complete TripBudget", async () => {
  const fetchImpl = createDeepSeekFetch({
    categories: {
      transport: { min: 800, max: 1200 },
      lodging: { min: 1000, max: 1400 },
      food: { min: 600, max: 800 },
      tickets: { min: 300, max: 500 },
      other: { min: 200, max: 400 },
    },
  });

  const budget = await estimateBudgetWithDeepSeek(
    {
      totalBudget: 5000,
      travelers: { adults: 2, children: 1 },
      destination: "杭州",
      days: 3,
      transportPreference: "balanced",
    },
    { apiKey: "test-key", fetchImpl },
  );

  assert.equal(budget.transport.amount, 1000);
  assert.equal(budget.lodging.amount, 1200);
  assert.equal(budget.estimatedTotal, 3600);
  assert.equal(budget.remaining, 1400);
  assert.equal(budget.overBudget, 0);
  assert.equal(budget.perPersonEstimated, 1200);
  assert.equal(budget.other.ratio, 300 / 3600);
});

test("builds a structured daily summary", async () => {
  const fetchImpl = createDeepSeekFetch({
    purpose: "用一天串起西湖与灵隐寺，兼顾湖山景色和人文停留。",
    highlights: ["清晨沿湖避开人流", "午后在灵隐寺放慢节奏"],
    cautions: ["周末拥堵明显，建议提前出发", "湖区天气变化快，备好雨具"],
  });

  const summary = await buildDaySummaryWithDeepSeek(
    {
      dayNumber: 1,
      date: "2026-09-20",
      destination: "杭州",
      routeNodes: ["西湖", "灵隐寺"],
      weather: "多云",
    },
    { apiKey: "test-key", fetchImpl },
  );

  assert.match(summary.purpose, /西湖/);
  assert.equal(summary.highlights.length, 2);
  assert.equal(summary.cautions.length, 2);
});

test("falls back to modern closing text when the model quote has no source", async () => {
  const fetchImpl = createDeepSeekFetch({
    quote: "不存在的原文",
    source: "",
    message: "愿你在山河之间收获新的故事。",
  });

  const closing = await buildTripClosingWithDeepSeek(
    {
      origin: "上海",
      destination: "杭州",
      waypoints: [],
      days: 3,
      pace: "balanced",
    },
    { apiKey: "test-key", fetchImpl },
  );

  assert.equal(closing.quote, null);
  assert.equal(closing.source, null);
  assert.match(closing.message, /山河/);
});

test("accepts a quote only when both quote and source are verifiable citations", async () => {
  const fetchImpl = createDeepSeekFetch({
    quote: "五岳归来不看山，黄山归来不看岳。",
    source: "《徐霞客游记》",
    message: "愿每一次出发，都成为丈量山河的注脚。",
  });

  const closing = await buildTripClosingWithDeepSeek(
    { destination: "黄山", days: 2 },
    { apiKey: "test-key", fetchImpl },
  );

  assert.equal(closing.quote, "五岳归来不看山，黄山归来不看岳。");
  assert.equal(closing.source, "《徐霞客游记》");
});

test("rejects malformed strict JSON from DeepSeek", async () => {
  const fetchImpl = (async () =>
    Response.json({ choices: [{ message: { content: "不是 JSON" } }] })) as typeof fetch;

  await assert.rejects(
    () =>
      buildDaySummaryWithDeepSeek(
        { destination: "杭州", routeNodes: ["西湖"] },
        { apiKey: "test-key", fetchImpl },
      ),
    /有效 JSON/,
  );
});
