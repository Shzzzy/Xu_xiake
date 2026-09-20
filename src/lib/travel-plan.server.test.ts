import test from "node:test";
import assert from "node:assert/strict";
import {
  auditAttractionsWithDeepSeek,
  buildDaySummaryWithDeepSeek,
  buildTripClosingWithDeepSeek,
  DeepSeekTravelError,
  estimateBudgetWithDeepSeek,
  parseAttractionAudits,
  parseBudgetEstimate,
  parseDaySummary,
  parseTripClosing,
  verifiedQuotes,
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

test("rejects model-authored quote and source fields", () => {
  assert.throws(
    () => parseTripClosing({ quote: "不存在的原文", source: "《虚构游记》", message: "寄语" }),
    /只能返回 quoteId/,
  );
});

test("falls back to modern wording when quote is absent", () => {
  const closing = parseTripClosing({ quoteId: null, message: "山河万里，行者常新。" });
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
  assert.equal(budget.remaining, 700);
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
    quoteId: "not-in-whitelist",
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

test("resolves a verified quote id to the server whitelist text", async () => {
  const quote = verifiedQuotes.find((entry) => entry.id === "xuxiake-youtiantai-opening");
  assert.ok(quote);
  assert.equal(quote.quote, "癸丑之三月晦，自宁海出西门。云散日朗，人意山光，俱有喜态。");
  assert.equal(quote.source, "《徐霞客游记·游天台山日记》");
  const fetchImpl = createDeepSeekFetch({
    quoteId: quote.id,
    message: "愿每一次出发，都成为丈量山河的注脚。",
  });

  const closing = await buildTripClosingWithDeepSeek(
    { destination: "天台山", days: 2 },
    { apiKey: "test-key", fetchImpl },
  );

  assert.equal(closing.quote, quote.quote);
  assert.equal(closing.source, quote.source);
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

function baseAudit(overrides: Record<string, unknown> = {}) {
  return {
    name: "西湖",
    scale: "large",
    durationHours: 7,
    physical: 50,
    childFit: 70,
    weatherSensitivity: 60,
    timeCost: 70,
    crowding: 80,
    bestTime: "清晨",
    ...overrides,
  };
}

async function assertDeepSeekError(promise: Promise<unknown>, code: DeepSeekTravelError["code"]) {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof DeepSeekTravelError && error.code === code && error.service.length > 0,
  );
}

test("resolves an unknown quote id to a modern closing without free-form citation", () => {
  const closing = parseTripClosing({ quoteId: "unknown-id", message: "山河万里，行者常新。" });
  assert.equal(closing.quote, null);
  assert.equal(closing.source, null);
});

test("audit schema requires unique names and rejects extra records", () => {
  assert.throws(
    () => parseAttractionAudits({ audits: [{ ...baseAudit(), name: undefined }] }, ["西湖"]),
    /名称/,
  );
  assert.throws(
    () =>
      parseAttractionAudits(
        { audits: [baseAudit(), baseAudit({ scale: "medium", durationHours: 4 })] },
        ["西湖", "灵隐寺"],
      ),
    /名称必须唯一/,
  );
  assert.throws(
    () =>
      parseAttractionAudits(
        { audits: [baseAudit(), baseAudit({ name: "灵隐寺", scale: "medium", durationHours: 4 })] },
        ["西湖"],
      ),
    /数量/,
  );
});

test("audit scale must match duration ranges", () => {
  const invalidCases = [
    { scale: "small", durationHours: 3 },
    { scale: "medium", durationHours: 2 },
    { scale: "large", durationHours: 5 },
    { scale: "multi-day", durationHours: 47 },
  ];

  for (const invalid of invalidCases) {
    assert.throws(() => parseAttractionAudits({ audits: [baseAudit(invalid)] }, ["西湖"]), /时长/);
  }
});

test("budget schema requires min/max ranges and preserves totals", () => {
  const budget = parseBudgetEstimate(
    {
      categories: {
        transport: { min: 1000, max: 1600 },
        lodging: { min: 900, max: 1100 },
        food: { min: 500, max: 700 },
        tickets: { min: 200, max: 300 },
        other: { min: 200, max: 300 },
      },
    },
    3000,
    { adults: 2, children: 1 },
  );

  assert.deepEqual(
    [budget.transport.min, budget.transport.max, budget.transport.amount],
    [1000, 1600, 1300],
  );
  assert.equal(budget.totalMin, 2800);
  assert.equal(budget.totalMax, 4000);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.overBudget, 1000);
  assert.equal(budget.rooms, 1);
});

test("budget schema rejects numeric and amount category values", () => {
  assert.throws(
    () =>
      parseBudgetEstimate(
        {
          categories: {
            transport: 1000,
            lodging: { min: 900, max: 1100 },
            food: { min: 500, max: 700 },
            tickets: { min: 200, max: 300 },
            other: { min: 200, max: 300 },
          },
        },
        5000,
        { adults: 2, children: 0 },
      ),
    /min 和 max/,
  );
  assert.throws(
    () =>
      parseBudgetEstimate(
        {
          categories: {
            transport: { amount: 1000 },
            lodging: { min: 900, max: 1100 },
            food: { min: 500, max: 700 },
            tickets: { min: 200, max: 300 },
            other: { min: 200, max: 300 },
          },
        },
        5000,
        { adults: 2, children: 0 },
      ),
    /min 和 max/,
  );
});

test("budget root and category objects reject extra keys", () => {
  const validCategories = {
    transport: { min: 800, max: 1200 },
    lodging: { min: 900, max: 1100 },
    food: { min: 500, max: 700 },
    tickets: { min: 200, max: 300 },
    other: { min: 200, max: 300 },
  };

  assert.throws(
    () =>
      parseBudgetEstimate({ categories: validCategories, extra: true }, 5000, {
        adults: 2,
        children: 0,
      }),
    /额外字段/,
  );
  assert.throws(
    () =>
      parseBudgetEstimate(
        {
          categories: {
            ...validCategories,
            transport: { ...validCategories.transport, extra: true },
          },
        },
        5000,
        { adults: 2, children: 0 },
      ),
    /额外字段/,
  );
  assert.throws(
    () =>
      parseBudgetEstimate(
        {
          categories: {
            ...validCategories,
            attraction: { min: 1, max: 2 },
          },
        },
        5000,
        { adults: 2, children: 0 },
      ),
    /额外字段/,
  );
});

test("budget prompt includes travelers, child discounts and room rules", async () => {
  const requests: RecordedRequest[] = [];
  const fetchImpl = createDeepSeekFetch(
    {
      categories: {
        transport: { min: 1000, max: 1200 },
        lodging: { min: 1000, max: 1400 },
        food: { min: 600, max: 800 },
        tickets: { min: 300, max: 500 },
        other: { min: 200, max: 400 },
      },
    },
    requests,
  );

  const budget = await estimateBudgetWithDeepSeek(
    {
      totalBudget: 8000,
      travelers: { adults: 3, children: 2 },
      destination: "杭州",
    },
    { apiKey: "test-key", fetchImpl },
  );

  const messages = requestBody(requests[0]).messages as { role: string; content: string }[];
  const serializedMessages = JSON.stringify(messages);
  assert.match(serializedMessages, /成人数/);
  assert.match(serializedMessages, /儿童数/);
  assert.match(serializedMessages, /儿童优惠规则/);
  assert.match(serializedMessages, /房间数规则/);
  const userPrompt = JSON.parse(messages[1].content) as {
    input: { budgetPolicy: { rooms: number; childDiscountRule: string } };
  };
  assert.equal(userPrompt.input.budgetPolicy.rooms, 2);
  assert.match(userPrompt.input.budgetPolicy.childDiscountRule, /儿童/);
  assert.equal(budget.rooms, 2);
});

test("self-driving budget requires and preserves road trip cost details", async () => {
  const requests: RecordedRequest[] = [];
  const fetchImpl = createDeepSeekFetch(
    {
      categories: {
        transport: { min: 1600, max: 2200 },
        lodging: { min: 1000, max: 1400 },
        food: { min: 600, max: 800 },
        tickets: { min: 300, max: 500 },
        other: { min: 200, max: 400 },
      },
      roadTrip: {
        energy: { min: 400, max: 600 },
        toll: { min: 500, max: 700 },
        holidayFreeAdjustment: { min: 0, max: 300 },
        parking: { min: 100, max: 200 },
      },
    },
    requests,
  );

  const budget = await estimateBudgetWithDeepSeek(
    {
      totalBudget: 10000,
      travelers: { adults: 3, children: 1 },
      destination: "黄山",
      selfDrive: true,
      vehicleEnergy: "electric",
    },
    { apiKey: "test-key", fetchImpl },
  );

  assert.equal(budget.rooms, 2);
  assert.deepEqual(budget.roadTrip?.energy, { min: 400, max: 600 });
  assert.deepEqual(budget.roadTrip?.holidayFreeAdjustment, { min: 0, max: 300 });
  assert.match(JSON.stringify(requestBody(requests[0]).messages), /高速费/);
  assert.match(JSON.stringify(requestBody(requests[0]).messages), /节假日免费调整/);
});

test("non-self-driving budget ignores road trip fields", async () => {
  const fetchImpl = createDeepSeekFetch({
    categories: {
      transport: { min: 800, max: 1000 },
      lodging: { min: 1000, max: 1400 },
      food: { min: 600, max: 800 },
      tickets: { min: 300, max: 500 },
      other: { min: 200, max: 400 },
    },
    roadTrip: {
      energy: { min: 400, max: 600 },
      toll: { min: 500, max: 700 },
      holidayFreeAdjustment: { min: 0, max: 300 },
      parking: { min: 100, max: 200 },
    },
  });

  const budget = await estimateBudgetWithDeepSeek(
    { totalBudget: 6000, travelers: { adults: 2, children: 1 }, transportMode: "train" },
    { apiKey: "test-key", fetchImpl },
  );

  assert.equal(budget.roadTrip, undefined);
});

test("rejects invalid vehicleEnergy before calling DeepSeek", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({});
  }) as typeof fetch;

  await assertDeepSeekError(
    estimateBudgetWithDeepSeek(
      {
        totalBudget: 5000,
        travelers: { adults: 2, children: 0 },
        vehicleEnergy: "hydrogen" as never,
      },
      { apiKey: "test-key", fetchImpl },
    ),
    "schema_error",
  );
  assert.equal(calls, 0);
});

test("day summary requires exact fields and string arrays", () => {
  assert.throws(
    () =>
      parseDaySummary({
        todayPurpose: "别名目的",
        highlights: ["重点"],
        cautions: ["注意"],
      }),
    /额外字段/,
  );
  assert.throws(
    () =>
      parseDaySummary({
        purpose: "目的",
        highlights: [{ title: "重点", detail: "详情" }],
        cautions: ["注意"],
      }),
    /字符串/,
  );
  assert.throws(
    () =>
      parseDaySummary({
        purpose: "目的",
        highlights: ["重点"],
        cautions: ["注意"],
        extra: true,
      }),
    /额外字段/,
  );
  assert.throws(
    () =>
      parseDaySummary({
        purpose: "目的",
        highlights: ["重点"],
        cautions: ["注意"],
        objective: "别名",
      }),
    /额外字段/,
  );
});

test("closing degrades network and invalid JSON failures to modern text", async () => {
  const timeoutFetch = (async () => {
    throw new DOMException("timed out", "TimeoutError");
  }) as typeof fetch;
  const networkFetch = (async () => {
    throw new TypeError("network failed");
  }) as typeof fetch;
  const invalidJsonFetch = (async () =>
    Response.json({ choices: [{ message: { content: "{bad json" } }] })) as typeof fetch;
  const emptyContentFetch = (async () =>
    Response.json({ choices: [{ message: { content: "" } }] })) as typeof fetch;
  for (const fetchImpl of [timeoutFetch, networkFetch, invalidJsonFetch, emptyContentFetch]) {
    const closing = await buildTripClosingWithDeepSeek(
      { destination: "杭州", days: 2 },
      { apiKey: "test-key", fetchImpl },
    );
    assert.equal(closing.quote, null);
    assert.equal(closing.source, null);
    assert.match(closing.message, /山河/);
  }
});

test("closing degrades HTTP non-2xx responses to modern text", async () => {
  const httpFetch = (async () => new Response("server error", { status: 500 })) as typeof fetch;

  const closing = await buildTripClosingWithDeepSeek(
    { destination: "杭州", days: 2 },
    { apiKey: "test-key", fetchImpl: httpFetch },
  );

  assert.equal(closing.quote, null);
  assert.equal(closing.source, null);
  assert.match(closing.message, /山河/);
});

test("other services expose identifiable degradation errors", async () => {
  const timeoutFetch = (async () => {
    throw new DOMException("timed out", "TimeoutError");
  }) as typeof fetch;
  const networkFetch = (async () => {
    throw new TypeError("network failed");
  }) as typeof fetch;
  const httpFetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
  const invalidJsonFetch = (async () =>
    Response.json({ choices: [{ message: { content: "not-json" } }] })) as typeof fetch;
  const emptyContentFetch = (async () =>
    Response.json({ choices: [{ message: { content: "" } }] })) as typeof fetch;

  await assertDeepSeekError(
    auditAttractionsWithDeepSeek(
      { attractions: ["西湖"] },
      { apiKey: "test-key", fetchImpl: timeoutFetch },
    ),
    "timeout",
  );
  await assertDeepSeekError(
    estimateBudgetWithDeepSeek(
      { totalBudget: 5000, travelers: { adults: 2, children: 0 } },
      { apiKey: "test-key", fetchImpl: networkFetch },
    ),
    "network",
  );
  await assertDeepSeekError(
    buildDaySummaryWithDeepSeek(
      { destination: "杭州", routeNodes: ["西湖"] },
      { apiKey: "test-key", fetchImpl: httpFetch },
    ),
    "http_error",
  );
  await assertDeepSeekError(
    buildDaySummaryWithDeepSeek(
      { destination: "杭州", routeNodes: ["西湖"] },
      { apiKey: "test-key", fetchImpl: invalidJsonFetch },
    ),
    "invalid_json",
  );
  await assertDeepSeekError(
    auditAttractionsWithDeepSeek(
      { attractions: ["西湖"] },
      { apiKey: "test-key", fetchImpl: emptyContentFetch },
    ),
    "invalid_content",
  );
});
