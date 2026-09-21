import test from "node:test";
import assert from "node:assert/strict";
import {
  planWithButler,
  type ButlerPlanInput,
} from "./planner-orchestrator.server.ts";

// 两条候选资料，供骨架指令与校验器使用。
const candidates = [
  { name: "黄山风景区", summary: "以奇松怪石云海温泉四绝著称。", source: "https://example.com/huangshan" },
  { name: "屯溪老街", summary: "徽州老街，适合傍晚漫步。", source: "https://example.com/tunxi" },
];

// 合法的两天行程输入；transport 留空，避免触发 TRANSPORT_CONFLICT。
const butlerInput: ButlerPlanInput = {
  origin: "杭州",
  destination: "黄山",
  region: "安徽",
  startDate: "2026-10-01",
  days: 2,
  startTime: "08:00",
  endTime: "18:00",
  pace: "balanced",
  totalBudget: 8000,
  travelers: { adults: 2, children: 1 },
  interests: ["自然山水"],
  transport: null,
  route: {
    origin: "杭州",
    destination: "黄山",
    waypoints: [],
    roundTrip: false,
    returnMode: null,
    legs: [
      {
        id: "leg-1",
        from: "杭州",
        to: "黄山",
        transport: "balanced",
        style: "direct",
        kind: "outbound",
      },
    ],
  },
  weather: [
    { date: "2026-10-01", code: 0, tempMax: 22, tempMin: 14, precipProb: 10 },
    { date: "2026-10-02", code: 1, tempMax: 20, tempMin: 12, precipProb: 20 },
  ],
  candidates,
};

// 一份通过 parsePlannerSkeleton 与 validateSkeleton 的两天骨架。
// overBudget 为 true 时把住宿费用抬高到超预算，用于重排测试。
function skeletonJson(overBudget = false): string {
  const hotelCost = overBudget ? 9000 : 680;
  const day = (day: number, hotel: number) => ({
    day,
    theme: day === 1 ? "黄山核心游览" : "屯溪老街收尾",
    nodes: [
      { type: "attraction", startTime: "09:00", endTime: "11:30", name: "黄山风景区", stayMinutes: 150, estimatedCost: 230 },
      { type: "meal", startTime: "12:00", endTime: "13:00", name: "徽菜午餐", estimatedCost: 120 },
      { type: "attraction", startTime: "14:00", endTime: "15:30", name: "屯溪老街", stayMinutes: 90, estimatedCost: 60 },
      { type: "hotel", startTime: "16:00", endTime: "16:30", name: "黄山温泉酒店", estimatedCost: hotel },
      { type: "rest", startTime: "17:00", endTime: "17:30", name: "返回酒店休息", estimatedCost: 0 },
    ],
    radar: { physical: 60, childFit: 55, weatherSensitivity: 65, timeCost: 50, crowding: 70 },
  });
  return JSON.stringify({
    title: "黄山两日徽州山水行",
    summary: "两天游览黄山风景区与屯溪老街。",
    days: [day(1, hotelCost), day(2, 680)],
  });
}

function dayCopyJson(day: number): string {
  return JSON.stringify({
    day,
    purpose: `第 ${day} 天的旅行目的。`,
    highlights: ["重点1：说明", "重点2：说明", "重点3：说明"],
    cautions: ["注意保暖", "带好雨具"],
    history: [],
  });
}

function closingJson(): string {
  return JSON.stringify({ quoteId: null, message: "这是一段值得回味的旅程。" });
}

function responseWith(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

type FetchImpl = typeof fetch;

// 正常路径：第一条骨架、每日文案与结尾都成功。
function fakeFetch(calls: string[] = []): FetchImpl {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const content = body.messages.map((message) => message.content).join("\n");

    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return responseWith(dayCopyJson(day));
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWith(closingJson());
    }
    return responseWith(skeletonJson(false));
  }) as FetchImpl;
}

// 首次骨架超预算，重排一次后合规。
function fakeFetchOverBudgetOnce(): FetchImpl {
  let skeletonCalls = 0;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const content = body.messages.map((message) => message.content).join("\n");

    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return responseWith(dayCopyJson(day));
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWith(closingJson());
    }

    skeletonCalls += 1;
    return responseWith(skeletonJson(skeletonCalls === 1));
  }) as FetchImpl;
}

// 重排后仍然超预算：只允许一次内容重排，最终交付带违规的版本。
function fakeFetchOverBudgetAlways(): FetchImpl {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const content = body.messages.map((message) => message.content).join("\n");

    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return responseWith(dayCopyJson(day));
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWith(closingJson());
    }
    return responseWith(skeletonJson(true));
  }) as FetchImpl;
}

// 骨架连续网络失败：自动重试一次后仍失败，返回 fallback。
function failingFetch(): FetchImpl {
  return (async () => {
    throw new TypeError("network down");
  }) as FetchImpl;
}

test("正常路径：骨架一次、文案按天并行、结尾一次", async () => {
  const calls: string[] = [];
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: fakeFetch(calls) });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(result.attempts, 1);
  assert.equal(result.dayCopy.length, 2);
  assert.equal(result.candidates.length, 2);
  assert.equal(calls.filter((url) => url.includes("chat/completions")).length, 4); // 骨架 + 2 文案 + 结尾
});

test("首次骨架超预算时只重排一次", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: fakeFetchOverBudgetOnce() });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(result.attempts, 2);
  assert.equal(result.violations.length, 0);
});

test("重排后仍不合规则带违规清单返回", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: fakeFetchOverBudgetAlways() });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(result.attempts, 3); // 1 正常 + 1 技术重试额度未用 + 1 重排
  assert.ok(result.violations.some((item) => item.code === "OVER_BUDGET"));
});

test("骨架连续失败后走兜底", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: failingFetch() });

  assert.equal(result.status, "fallback");
});

test("缺少 API key 时返回 needs_configuration", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "" });

  assert.equal(result.status, "needs_configuration");
});