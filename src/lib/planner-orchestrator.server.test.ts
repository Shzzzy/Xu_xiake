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
  {
    id: "poi-huangshan",
    name: "黄山风景区",
    summary: "以奇松怪石云海温泉四绝著称。",
    source: "https://example.com/huangshan",
    address: "安徽省黄山市黄山区",
    type: "风景名胜",
    location: [118.166, 30.13] as [number, number],
    publicUrl: "https://example.com/huangshan",
    areaKey: "黄山市-黄山区",
  },
  {
    id: "poi-tunxi",
    name: "屯溪老街",
    summary: "徽州老街，适合傍晚漫步。",
    source: "https://example.com/tunxi",
    address: "安徽省黄山市屯溪区",
    type: "风景名胜",
    location: [118.31, 29.71] as [number, number],
    publicUrl: "https://example.com/tunxi",
    areaKey: "黄山市-屯溪区",
  },
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
        transport: "train",
        style: "direct",
        kind: "outbound",
      },
    ],
  },
  transportLegs: [
    {
      id: "leg-1",
      kind: "outbound",
      from: "杭州",
      to: "黄山",
      distanceKm: 260,
      mode: "train",
      doorToDoorMinutes: 180,
      minimumPerPersonCost: 150,
    },
  ],
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
      {
        type: "attraction",
        startTime: "09:00",
        endTime: "11:30",
        name: "黄山风景区",
        stayMinutes: 150,
        estimatedCost: 230,
      },
      { type: "meal", startTime: "12:00", endTime: "13:00", name: "徽菜午餐", estimatedCost: 120 },
      {
        type: "attraction",
        startTime: "14:00",
        endTime: "15:30",
        name: "屯溪老街",
        stayMinutes: 90,
        estimatedCost: 60,
      },
      {
        type: "hotel",
        startTime: "16:00",
        endTime: "16:30",
        name: "黄山温泉酒店",
        estimatedCost: hotel,
      },
      {
        type: "rest",
        startTime: "17:00",
        endTime: "17:30",
        name: "返回酒店休息",
        estimatedCost: 0,
      },
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

function selectionJson(): string {
  return JSON.stringify([
    { day: 2, candidateId: "poi-tunxi", sequence: 1, stayMinutes: 120, reason: "次日安排屯溪老街" },
  ]);
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
    return responseWith(selectionJson());
  }) as FetchImpl;
}

// selection 首次越界时只修复一次；可选记录修复请求体。
function fakeFetchOverBudgetOnce(repairBodies: RequestBody[] = []): FetchImpl {
  let selectionCalls = 0;
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
    if (content.includes("景点选择")) {
      selectionCalls += 1;
      if (content.includes("上一版景点选择未通过校验")) {
        repairBodies.push(body);
        return responseWith(selectionJson());
      }
      return responseWith(
        JSON.stringify([
          { day: 2, candidateId: "missing", sequence: 1, stayMinutes: 120, reason: "越界" },
        ]),
      );
    }

    return responseWith(selectionJson());
  }) as FetchImpl;
}

// selection 修复后仍越界时，必须 fail closed。
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
    return responseWith(
      JSON.stringify([
        { day: 2, candidateId: "missing", sequence: 1, stayMinutes: 120, reason: "越界" },
      ]),
    );
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
    return responseWith(selectionJson());
  }) as FetchImpl;
}

// 骨架连续网络失败：自动重试一次后仍失败，返回 fallback。
function failingFetch(): FetchImpl {
  return (async () => {
    throw new TypeError("network down");
  }) as FetchImpl;
}

test("正常路径：选择一次、文案按天顺序、结尾一次", async () => {
  const calls: string[] = [];
  const bodies: RequestBody[] = [];
  const result = await planWithButler(butlerInput, {
    apiKey: "k",
    fetchImpl: fakeFetch(calls, bodies),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(result.attempts, 4);
  assert.equal(result.dayCopy.length, 2);
  assert.equal(result.failedDays.length, 0);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.budget.transport >= 450);
  assert.equal(calls.filter((url) => url.includes("chat/completions")).length, 4);

  // 结尾调用必须显式收敛到 800 tokens。
  const closingBody = bodies.find((body) => messageContent(body).includes("生成旅行回望与结束语"));
  assert.ok(closingBody, "应发出一次结尾调用");
  assert.equal(closingBody?.max_tokens, 800);
});

test("selection 首次网络失败后自动重试并成功", async () => {
  let failed = false;
  const base = fakeFetch();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    const content = messageContent(body);
    if (content.includes("景点选择") && !failed) {
      failed = true;
      throw new TypeError("fetch failed");
    }
    return base(input, init);
  }) as FetchImpl;

  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl });

  assert.equal(result.status, "ok");
  assert.equal(failed, true);
});

test("selection 连续网络失败时返回友好错误", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as FetchImpl;

  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl });

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.match(result.reason, /AI 规划服务暂时不可用/);
  }
});

test("selection 首次越界时只修复一次", async () => {
  const repairBodies: RequestBody[] = [];
  const result = await planWithButler(butlerInput, {
    apiKey: "k",
    fetchImpl: fakeFetchOverBudgetOnce(repairBodies),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  assert.equal(result.attempts, 5);
  assert.equal(result.violations.length, 0);
  assert.equal(repairBodies.length, 1);
  const repairContent = messageContent(repairBodies[0] as RequestBody);
  assert.match(repairContent, /上一版景点选择未通过校验/);
  assert.match(repairContent, /missing/);
});

test("selection 修复后仍越界时 fail closed", async () => {
  const result = await planWithButler(butlerInput, {
    apiKey: "k",
    fetchImpl: fakeFetchOverBudgetAlways(),
  });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.stage, "selection");
  assert.match(result.reason, /候选/);
});

test("selection 连续请求失败时 fail closed", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: failingFetch() });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.stage, "selection");
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
  const result = await planWithButler(butlerInput, {
    apiKey: "k",
    fetchImpl: fakeFetchWithFailingDayCopy(),
  });

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
    runStage: async () => ({ handled: true }),
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
      if (stage !== "selection") return { handled: true };
      selectionAttempts += 1;
      if (attempt === 0) throw new Error("模型选择了候选之外的景点");
      return { handled: true };
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
      return { handled: true };
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
    return responseWith(selectionJson());
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
    return responseWith(selectionJson());
  }) as FetchImpl;

  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok((result.dayCopy[0]?.purpose ?? "").length > 0);
  assert.equal(result.dayCopy[1]?.purpose, "");
  assert.deepEqual(result.failedDays, [2]);
});

test("缺少阶段处理器时当前阶段失败并停止", async () => {
  const stages: PlanningStage[] = [];
  const run = await runDeterministicPipeline({
    id: "run-missing-handler",
    onStage: (stage) => stages.push(stage),
  });

  assert.deepEqual(stages, ["route"]);
  assert.equal(run.stages.route.status, "failed");
  assert.match(run.stages.route.error ?? "", /处理器/);
  assert.equal(run.stages.pois.status, "pending");
});

test("runStage 返回空结果时当前阶段失败并停止", async () => {
  const stages: PlanningStage[] = [];
  const run = await runDeterministicPipeline({
    id: "run-unhandled",
    onStage: (stage) => stages.push(stage),
    runStage: async () => ({}) as { handled: true },
  });

  assert.deepEqual(stages, ["route"]);
  assert.equal(run.stages.route.status, "failed");
  assert.match(run.stages.route.error ?? "", /未处理/);
  assert.equal(run.stages.pois.status, "pending");
});

// selection 首次跨天重复同一景点：修复一次后改用尚未占用的候选。
function fakeFetchDuplicateAttractionOnce(repairBodies: RequestBody[] = []): FetchImpl {
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
    if (content.includes("上一版景点选择未通过校验")) {
      repairBodies.push(body);
      return responseWith(
        JSON.stringify([
          { day: 1, candidateId: "poi-huangshan", sequence: 1, stayMinutes: 120, reason: "首日黄山" },
          { day: 2, candidateId: "poi-tunxi", sequence: 1, stayMinutes: 120, reason: "次日屯溪" },
        ]),
      );
    }
    return responseWith(
      JSON.stringify([
        { day: 1, candidateId: "poi-huangshan", sequence: 1, stayMinutes: 120, reason: "首日黄山" },
        { day: 2, candidateId: "poi-huangshan", sequence: 1, stayMinutes: 120, reason: "重复安排" },
      ]),
    );
  }) as FetchImpl;
}

// selection 修复后仍然跨天重复：必须 fail closed，不交付重复行程。
function fakeFetchDuplicateAttractionAlways(): FetchImpl {
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
    return responseWith(
      JSON.stringify([
        { day: 1, candidateId: "poi-huangshan", sequence: 1, stayMinutes: 120, reason: "首日黄山" },
        { day: 2, candidateId: "poi-huangshan", sequence: 1, stayMinutes: 120, reason: "重复安排" },
      ]),
    );
  }) as FetchImpl;
}

test("selection 跨天重复时只修复一次并改用未占用的候选", async () => {
  const repairBodies: RequestBody[] = [];
  const result = await planWithButler(butlerInput, {
    apiKey: "k",
    fetchImpl: fakeFetchDuplicateAttractionOnce(repairBodies),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(repairBodies.length, 1);
  const repairContent = messageContent(repairBodies[0] as RequestBody);
  assert.match(repairContent, /上一版景点选择未通过校验/);
  assert.match(repairContent, /重复出现/);
  const scheduledNames = result.skeleton.days.flatMap((day) =>
    day.nodes.filter((node) => node.type === "attraction").map((node) => node.name),
  );
  assert.deepEqual(scheduledNames, ["黄山风景区", "屯溪老街"]);
});

test("selection 修复后仍跨天重复时由本地兜底改用未占用候选", async () => {
  const result = await planWithButler(butlerInput, {
    apiKey: "k",
    fetchImpl: fakeFetchDuplicateAttractionAlways(),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const scheduledNames = result.skeleton.days.flatMap((day) =>
    day.nodes.filter((node) => node.type === "attraction").map((node) => node.name),
  );
  // AI 第二次仍重复，本地兜底把第二天换成未占用的屯溪老街，保证交付不重复。
  assert.deepEqual(scheduledNames, ["黄山风景区", "屯溪老街"]);
});

test("候选不足以覆盖景点槽位时允许复用同一景点", async () => {
  const singleCandidateInput: ButlerPlanInput = {
    ...butlerInput,
    candidates: [candidates[0]!],
  };
  const result = await planWithButler(singleCandidateInput, {
    apiKey: "k",
    fetchImpl: fakeFetchDuplicateAttractionAlways(),
  });

  // 只有一个候选而两天都需要景点：允许复用，不因去重规则拒绝交付。
  assert.equal(result.status, "ok");
});
