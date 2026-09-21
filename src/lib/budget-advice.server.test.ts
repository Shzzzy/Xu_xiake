import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBudgetAdviceMessages,
  parseBudgetAdvice,
  requestBudgetAdvice,
  type BudgetAdviceInput,
} from "./budget-advice.server.ts";

const input: BudgetAdviceInput = {
  destination: "黄山",
  region: "安徽",
  days: 4,
  travelers: { adults: 2, children: 1 },
  transportPreference: "高铁 + 当地包车",
  pace: "balanced",
  interests: ["自然风光", "摄影"],
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
  assert.match(messages, /黄山/);
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
