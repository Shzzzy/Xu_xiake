import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBudgetAdviceMessages,
  parseBudgetAdvice,
  requestBudgetAdvice,
  type BudgetAdviceInput,
} from "./budget-advice.server.ts";

const input: BudgetAdviceInput = {
  origin: "上海",
  destination: "北京",
  region: "北京",
  days: 2,
  travelers: { adults: 3, children: 0 },
  transportPreference: "高铁 / 飞机",
  roundTrip: true,
  returnMode: "fast",
  routeLegs: [
    { from: "上海", to: "北京", transport: "flight", kind: "outbound", style: "direct" },
    { from: "北京", to: "上海", transport: "flight", kind: "return", style: "direct" },
  ],
  pace: "balanced",
  interests: ["人文建筑"],
};

test("预算建议解析合法 JSON 并保留分类", () => {
  const advice = parseBudgetAdvice(
    JSON.stringify({
      total: 8600,
      categories: { transport: 2600, lodging: 2800, food: 1400, tickets: 1200, other: 600 },
      note: "含黄山门票与山上住宿",
    }),
  );
  assert.equal(advice.total, 8600);
  assert.equal(advice.categories.other, 600);
});

test("预算建议拒绝缺少分类或负数", () => {
  assert.throws(() => parseBudgetAdvice(JSON.stringify({ total: 100, categories: {} })));
  assert.throws(() =>
    parseBudgetAdvice(
      JSON.stringify({
        total: -1,
        categories: { transport: 1, lodging: 1, food: 1, tickets: 1, other: 1 },
      }),
    ),
  );
});

test("预算建议提示词要求全团中值并解释杂事开销", () => {
  const messages = JSON.stringify(buildBudgetAdviceMessages(input));

  assert.match(messages, /全团/);
  assert.match(messages, /区间中值/);
  assert.match(messages, /杂事开销/);
  assert.match(messages, /上海/);
  assert.match(messages, /北京/);
  assert.match(messages, /往返/);
  assert.match(messages, /返程/);
  assert.match(messages, /flight/);
  assert.match(messages, /1 晚/);
  assert.match(messages, /分类合计.*total|total.*分类合计/);
});

test("预算建议请求使用 DeepSeek JSON 合同并解析结果", async () => {
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input: requestInput, init });
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              total: 8600,
              categories: {
                transport: 2600,
                lodging: 2800,
                food: 1400,
                tickets: 1200,
                other: 600,
              },
              note: "含黄山门票与山上住宿",
            }),
          },
        },
      ],
    });
  }) as typeof fetch;

  const advice = await requestBudgetAdvice(input, { apiKey: "test-key", fetchImpl });
  const body = JSON.parse(String(requests[0]?.init?.body)) as {
    messages: unknown[];
    response_format: { type: string };
    max_tokens: number;
    temperature: number;
  };

  assert.equal(advice.categories.lodging, 2800);
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.max_tokens, 800);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages, buildBudgetAdviceMessages(input));
});

test("预算建议把总额校正为分类合计", () => {
  const advice = parseBudgetAdvice(JSON.stringify({
    total: 4200,
    categories: {
      transport: 6600,
      lodging: 900,
      food: 900,
      tickets: 300,
      other: 650,
    },
    note: "往返高铁、2 晚住宿与门票餐饮",
  }));

  assert.equal(advice.total, 9350);
});
