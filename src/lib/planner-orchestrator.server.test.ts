import test from "node:test";
import assert from "node:assert/strict";
import {
  planWithButler,
  runDeterministicPipeline,
  type ButlerPlanInput,
} from "./planner-orchestrator.server.ts";
import type { PlanningStage } from "./planning-run.ts";

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
type RequestBody = { messages: { content: string }[]; max_tokens?: number };

function messageContent(body: RequestBody): string {
  return body.messages.map((message) => message.content).join("\n");
}

// 正常路径：第一条骨架、每日文案与结尾都成功；可选记录请求体用于断言 token 上限。
function fakeFetch(calls: string[] = [], bodies: RequestBody[] = []): FetchImpl {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body)) as RequestBody;
    bodies.push(body);
    const content = messageContent(body);

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

// 首次骨架超预算，重排一次后合规；可选记录重排请求体，用于断言回喂内容。
function fakeFetchOverBudgetOnce(repairBodies: RequestBody[] = []): FetchImpl {
  let skeletonCalls = 0;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    const content = messageContent(body);

    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return responseWith(dayCopyJson(day));
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWith(closingJson());
    }
    if (content.includes("上一版排程骨架存在以下违规")) {
      repairBodies.push(body);
    }

    skeletonCalls += 1;
    return responseWith(skeletonJson(skeletonCalls === 1));
  }) as FetchImpl;
}

// 重排后仍然超预算：只允许一次内容重排，最终交付带违规的版本。
function fakeFetchOverBudgetAlways(): FetchImpl {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    const content = messageContent(body);

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

// 第 2 天文案失败：其余链路正常，用于覆盖 failedDays 降级。
function fakeFetchWithFailingDayCopy(): FetchImpl {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    const content = messageContent(body);

    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return day === 2 ? responseWith("{ bad json") : responseWith(dayCopyJson(day));
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWith(closingJson());
    }
    return responseWith(skeletonJson(false));
  }) as FetchImpl;
}

// 骨架连续网络失败：自动重试一次后仍失败，返回 fallback。
function failingFetch(): FetchImpl {
  return (async () => {
    throw new TypeError("network down");
  }) as FetchImpl;
}

test("正常路径：骨架一次、文案按天顺序、结尾一次", async () => {
  const calls: string[] = [];
  const bodies: RequestBody[] = [];
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: fakeFetch(calls, bodies) });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(result.attempts, 1);
  assert.equal(result.dayCopy.length, 2);
  assert.equal(result.failedDays.length, 0);
  assert.equal(result.candidates.length, 2);
  assert.equal(calls.filter((url) => url.includes("chat/completions")).length, 4); // 骨架 + 2 文案 + 结尾

  // 结尾调用必须显式收敛到 800 tokens。
  const closingBody = bodies.find((body) => messageContent(body).includes("生成旅行回望与结束语"));
  assert.ok(closingBody, "应发出一次结尾调用");
  assert.equal(closingBody?.max_tokens, 800);
});

test("首次骨架超预算时只重排一次", async () => {
  const repairBodies: RequestBody[] = [];
  const result = await planWithButler(butlerInput, {
    apiKey: "k",
    fetchImpl: fakeFetchOverBudgetOnce(repairBodies),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(result.attempts, 2);
  assert.equal(result.violations.length, 0);

  // 重排请求必须同时回喂上一版骨架节点与违规清单。
  assert.equal(repairBodies.length, 1);
  const repairContent = messageContent(repairBodies[0] as RequestBody);
  assert.match(repairContent, /黄山温泉酒店/); // 只出现在上一版骨架 JSON 里
  assert.match(repairContent, /总预算超支/); // 违规清单信息
});

test("重排后仍不合规则带违规清单返回", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: fakeFetchOverBudgetAlways() });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(result.attempts, 2); // 真实骨架调用次数：正常 + 一次重排
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

test("apiKey 为空字符串时回退到 deepseekKey", async () => {
  const result = await planWithButler(butlerInput, {
    apiKey: "",
    deepseekKey: "k",
    fetchImpl: fakeFetch(),
  });

  assert.equal(result.status, "ok");
});

test("第 2 天文案失败时降级为空文案并记录 failedDays", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: fakeFetchWithFailingDayCopy() });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.deepEqual(result.failedDays, [2]);
  assert.ok((result.dayCopy[0]?.purpose ?? "").length > 0);
  assert.equal(result.dayCopy[1]?.purpose, "");
  assert.deepEqual(result.dayCopy[1]?.highlights, []);
});

test("每一步失败后不会调用下一步", async () => {
  const stages: PlanningStage[] = [];
  const run = await runDeterministicPipeline({
    id: "run-stop",
    onStage: (stage) => stages.push(stage),
    failAt: "selection",
  });

  assert.deepEqual(stages, ["route", "pois", "selection"]);
  assert.equal(run.stages.selection.status, "failed");
  assert.equal(run.stages.timeline.status, "pending");
  assert.equal(run.stages.budget.status, "pending");
});

test("selection 失败后只修复当前阶段一次", async () => {
  const stages: PlanningStage[] = [];
  let selectionAttempts = 0;
  let repairs = 0;

  const run = await runDeterministicPipeline({
    id: "run-repair",
    onStage: (stage) => stages.push(stage),
    runStage: async (stage, attempt) => {
      if (stage !== "selection") return;
      selectionAttempts += 1;
      if (attempt === 0) throw new Error("模型选择了候选之外的景点");
    },
    repairSelection: async () => {
      repairs += 1;
    },
  });

  assert.equal(selectionAttempts, 2);
  assert.equal(repairs, 1);
  assert.equal(run.stages.selection.status, "passed");
  assert.ok(stages.includes("timeline"));
});

test("selection 修复后仍失败时立即停止，不再调用时间轴和预算", async () => {
  const stages: PlanningStage[] = [];
  let repairs = 0;

  const run = await runDeterministicPipeline({
    id: "run-repair-failed",
    onStage: (stage) => stages.push(stage),
    runStage: async (stage) => {
      if (stage === "selection") throw new Error("候选仍非法");
    },
    repairSelection: async () => {
      repairs += 1;
    },
  });

  assert.equal(repairs, 1);
  assert.deepEqual(stages, ["route", "pois", "selection"]);
  assert.equal(run.stages.selection.status, "failed");
  assert.equal(run.stages.timeline.status, "pending");
  assert.equal(run.stages.budget.status, "pending");
});

test("每日文案逐日生成，前一天完成前不会请求下一天", async () => {
  let releaseFirstDay: ((response: Response) => void) | undefined;
  let dayTwoCalled = false;

  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    const content = messageContent(body);
    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      if (day === 1) {
        return await new Promise<Response>((resolve) => {
          releaseFirstDay = resolve;
        });
      }
      if (day === 2) {
        dayTwoCalled = true;
        return responseWith(dayCopyJson(2));
      }
    }
    if (content.includes("生成旅行回望与结束语")) return responseWith(closingJson());
    return responseWith(skeletonJson(false));
  }) as FetchImpl;

  const pending = planWithButler(butlerInput, { apiKey: "k", fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const requestedDayTwoEarly = dayTwoCalled;
  releaseFirstDay?.(responseWith(dayCopyJson(1)));
  const result = await pending;

  assert.equal(requestedDayTwoEarly, false);
  assert.equal(result.status, "ok");
});

test("每日文案 day 与请求日期不一致时只降级当天", async () => {
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    const content = messageContent(body);
    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return responseWith(dayCopyJson(day === 2 ? 1 : day));
    }
    if (content.includes("生成旅行回望与结束语")) return responseWith(closingJson());
    return responseWith(skeletonJson(false));
  }) as FetchImpl;

  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok((result.dayCopy[0]?.purpose ?? "").length > 0);
  assert.equal(result.dayCopy[1]?.purpose, "");
  assert.deepEqual(result.failedDays, [2]);
});
