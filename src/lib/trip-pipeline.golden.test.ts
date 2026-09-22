import test from "node:test";
import assert from "node:assert/strict";
import type { AmapClient, AmapGeocode, AmapPoi } from "./amap.server.ts";
import type { LiveItineraryInput } from "./live-planner.functions.ts";
import { runLivePlannerWith } from "./live-planner.functions.ts";
import { planWithButler, type ButlerPlanInput } from "./planner-orchestrator.server.ts";
import type { PlanningStage } from "./planning-run.ts";
import {
  splitTransportLegIntoSegments,
  type TransportPlanLeg,
} from "./transport-planner.server.ts";
import { destinations } from "../data/planner-destinations.ts";
import { buildTripPlanFromSkeleton } from "./plan-output-adapter.ts";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import {
  applyTripFeasibilityChoice,
  resolveDailyDriveLimitMinutes,
  type TripFeasibilityPlanningInput,
} from "./trip-feasibility.ts";

const sichuanPois: AmapPoi[] = [
  {
    id: "sc-kuanzhai",
    name: "宽窄巷子",
    type: "风景名胜;特色街区",
    address: "四川省成都市青羊区金河路",
    province: "四川省",
    city: "成都市",
    district: "青羊区",
    adcode: "510105",
    location: [104.055, 30.669],
  },
  {
    id: "sc-wuhou",
    name: "武侯祠",
    type: "风景名胜;博物馆",
    address: "四川省成都市武侯区武侯祠大街",
    province: "四川省",
    city: "成都市",
    district: "武侯区",
    adcode: "510107",
    location: [104.048, 30.646],
  },
  {
    id: "sc-panda",
    name: "成都大熊猫繁育研究基地",
    type: "风景名胜;动物园",
    address: "四川省成都市成华区熊猫大道",
    province: "四川省",
    city: "成都市",
    district: "成华区",
    adcode: "510108",
    location: [104.145, 30.733],
  },
  {
    id: "sc-jinli",
    name: "锦里",
    type: "风景名胜;特色街区",
    address: "四川省成都市武侯区武侯祠大街",
    province: "四川省",
    city: "成都市",
    district: "武侯区",
    adcode: "510107",
    location: [104.043, 30.642],
  },
];

function geocode(name: string): AmapGeocode[] {
  if (name.trim() === "北京") {
    return [
      {
        formattedAddress: "北京",
        province: "北京市",
        city: "北京市",
        district: "东城区",
        adcode: "110101",
        location: [116.407526, 39.90403],
      },
    ];
  }
  if (name.trim() === "四川") {
    return [
      {
        formattedAddress: "四川",
        province: "四川省",
        city: "成都市",
        district: "",
        adcode: "",
        // 该固定点与北京约 1964 km，用于覆盖 1963 km 级长途飞行规则。
        location: [97.6, 31],
      },
    ];
  }
  return [];
}

function createGoldenAmapClient(): AmapClient {
  return {
    async searchPoi() {
      return sichuanPois;
    },
    async fetchStaticMap() {
      return new Uint8Array();
    },
    async route() {
      throw new Error("长途默认应选择飞机，不应调用驾车路线");
    },
    async geocode(input) {
      return geocode(input.address);
    },
    async weather() {
      return [];
    },
  };
}

function buildGoldenInput(): LiveItineraryInput {
  return {
    destination: { id: "sichuan", name: "四川", region: "四川省" },
    startDate: "2026-10-01",
    days: 5,
    dailyHours: 8,
    pace: "balanced",
    interests: ["自然山水", "人文建筑"],
    origin: "北京",
    startTime: "08:00",
    endTime: "20:00",
    totalBudget: 40000,
    travelers: { adults: 5, children: 0 },
    transport: null,
    style: "direct",
    route: {
      origin: "北京",
      destination: "四川",
      waypoints: [],
      roundTrip: true,
      returnMode: "fast",
      legs: [
        {
          id: "outbound:0",
          from: "北京",
          to: "四川",
          transport: "balanced",
          style: "direct",
          kind: "outbound",
        },
        {
          id: "return",
          from: "四川",
          to: "北京",
          transport: "balanced",
          style: "direct",
          kind: "return",
        },
      ],
    },
    weather: Array.from({ length: 5 }, (_, index) => ({
      date: `2026-10-0${index + 1}`,
      code: 1,
      tempMax: 24,
      tempMin: 14,
      precipProb: 10,
    })),
    seedPlaces: [],
  };
}

function responseWithJson(value: unknown): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

function requestText(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as { messages?: { content?: string }[] };
  return (body.messages ?? []).map((message) => message.content ?? "").join("\n");
}

function selectionJson(ids: string[]): unknown {
  return ids.map((candidateId, index) => ({
    day: index + 2,
    candidateId,
    sequence: 1,
    stayMinutes: 150,
    reason: "按地理分区安排，避免跨城折返",
  }));
}

test("Golden：北京到四川、5 人、5 天往返走确定性飞行与预算", async () => {
  const input = buildGoldenInput();
  const result = await runLivePlannerWith(input, {
    env: {
      BUTLER_PLANNER: "1",
      DEEPSEEK_API_KEY: "k",
      TAVILY_API_KEY: "k",
      TAVILY_SEARCH_URL: "https://tavily.test/search",
    },
    amapClient: createGoldenAmapClient(),
    fetchImpl: (async (input, init) => {
      const url = String(input);
      if (url.includes("tavily")) return Response.json({ results: [] });
      const content = requestText(init);
      if (content.includes("景点选择")) {
        return responseWithJson(selectionJson(["sc-kuanzhai", "sc-wuhou", "sc-panda"]));
      }
      if (content.includes("每日文案")) {
        const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
        return responseWithJson({
          day,
          purpose: `第 ${day} 天按已冻结时间轴游览。`,
          highlights: ["当地体验：按当天节点安排", "步行游览：按现场指引", "机动休息：保留体力"],
          cautions: ["关注天气变化", "按现场开放时间调整"],
          history: [],
        });
      }
      if (content.includes("生成旅行回望与结束语")) {
        return responseWithJson({ quoteId: null, message: "这是一段值得回味的旅程。" });
      }
      throw new Error(`Golden 测试收到未知 DeepSeek 请求：${content.slice(0, 80)}`);
    }) as typeof fetch,
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok" || result.mode !== "butler") return;

  assert.ok(result.transportLegs.every((leg) => leg.mode === "flight"));
  assert.ok(result.transportLegs[0]?.distanceKm && result.transportLegs[0].distanceKm >= 1963);
  assert.ok(
    result.budget.transport >= 10_800,
    `交通预算应至少为 10800，实际 ${result.budget.transport}`,
  );
  assert.equal(result.budget.provenance.lodging.quantity, 20); // 5 位成人按 5 间房 × 4 晚
  assert.equal(result.skeleton.days.length, 5);

  const attractionDays = result.skeleton.days
    .filter((day) => day.nodes.some((node) => node.type === "transport"))
    .map((day) => day.day);
  assert.deepEqual(attractionDays, [1, 5]);

  for (const day of result.skeleton.days.filter((item) => !attractionDays.includes(item.day))) {
    assert.ok(
      day.nodes.some((node) => node.type === "attraction"),
      `第 ${day.day} 天是非移动日，必须安排真实候选景点`,
    );
  }

  const firstTransport = result.skeleton.days[0]?.nodes.find((node) => node.type === "transport");
  assert.match(firstTransport?.name ?? "", /飞机/);
  assert.equal(result.budget.transport, 10_810);
  assert.equal(result.budget.lodging, 10_000);
  assert.equal(result.budget.food, 5_500);
  assert.equal(result.budget.tickets, 1_200);
  assert.equal(result.budget.other, 2_751);
  assert.equal(result.budget.estimatedTotal, 30_261);

  const destination = {
    ...(destinations.find((item) => item.id === "huangshan") ?? destinations[0]),
    id: "sichuan",
    name: "四川",
    region: "四川省",
  };
  const plan = buildTripPlanFromSkeleton({
    skeleton: result.skeleton,
    dayCopy: result.dayCopy,
    candidates: result.candidates,
    failedDays: result.failedDays,
    budgetPlan: result.budget,
    transportLegs: result.transportLegs,
    violations: result.violations,
    origin: input.origin,
    destination,
    startDate: input.startDate,
    travelers: input.travelers,
    totalBudget: input.totalBudget,
    pace: input.pace,
    interests: input.interests,
    roundTrip: input.route.roundTrip,
    returnMode: input.route.returnMode ?? "fast",
    routePlan: input.route,
    weather: input.weather,
    closing: result.closing,
    transportPreference: "balanced",
  });
  assert.equal(
    plan.days.reduce((total, day) => total + day.estimatedCost, 0),
    plan.budget.estimatedTotal,
  );
  assert.equal(plan.budget.transport.amount, 10_810);
  assert.equal(plan.budget.lodging.amount, 10_000);
  assert.equal(plan.budget.food.amount, 5_500);
  assert.equal(plan.budget.tickets.amount, 1_200);
  assert.equal(plan.budget.other.amount, 2_751);
});

function buildMinimalButlerInput(): ButlerPlanInput {
  const transportLegs: TransportPlanLeg[] = [
    {
      id: "outbound:0",
      kind: "outbound",
      from: "北京",
      to: "四川",
      distanceKm: 1964,
      mode: "flight",
      doorToDoorMinutes: 344,
      minimumPerPersonCost: 1081,
    },
  ];
  return {
    origin: "北京",
    destination: "四川",
    region: "四川省",
    startDate: "2026-10-01",
    days: 2,
    startTime: "08:00",
    endTime: "20:00",
    pace: "balanced",
    totalBudget: 40000,
    travelers: { adults: 5, children: 0 },
    interests: ["自然山水"],
    transport: null,
    route: {
      origin: "北京",
      destination: "四川",
      waypoints: [],
      roundTrip: false,
      returnMode: null,
      legs: [
        {
          id: "outbound:0",
          from: "北京",
          to: "四川",
          transport: "flight",
          style: "direct",
          kind: "outbound",
        },
      ],
    },
    weather: [
      { date: "2026-10-01", code: 1, tempMax: 24, tempMin: 14 },
      { date: "2026-10-02", code: 1, tempMax: 24, tempMin: 14 },
    ],
    candidates: [
      {
        id: "sc-kuanzhai",
        name: "宽窄巷子",
        summary: "成都历史街区",
        source: "https://www.amap.com/place/sc-kuanzhai",
        address: "四川省成都市青羊区",
        type: "风景名胜",
        location: [104.055, 30.669],
        publicUrl: "https://www.amap.com/place/sc-kuanzhai",
        areaKey: "成都市-青羊区",
      },
    ],
    transportLegs,
  };
}

test("Golden：候选越界 selection 最多修复一次且不启动后续阶段", async () => {
  const stages: PlanningStage[] = [];
  const narrativeCalls: string[] = [];
  let selectionCalls = 0;

  const result = await planWithButler(buildMinimalButlerInput(), {
    apiKey: "k",
    onStage: (stage) => stages.push(stage),
    fetchImpl: (async (_input, init) => {
      const content = requestText(init);
      if (content.includes("景点选择")) {
        selectionCalls += 1;
        return responseWithJson([
          {
            day: 2,
            candidateId: "not-in-candidates",
            sequence: 1,
            stayMinutes: 120,
            reason: "越界",
          },
        ]);
      }
      if (content.includes("每日文案")) narrativeCalls.push(content);
      return responseWithJson({ quoteId: null, message: "不应到达结尾阶段。" });
    }) as typeof fetch,
  });

  assert.equal(selectionCalls, 2);
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.stage, "selection");
  assert.deepEqual(stages, ["route", "pois", "selection"]);
  assert.deepEqual(narrativeCalls, []);
});

function buildSimpleButlerFetch(selection: unknown): typeof fetch {
  return (async (_input, init) => {
    const content = requestText(init);
    if (content.includes("景点选择")) return responseWithJson(selection);
    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return responseWithJson({
        day,
        purpose: `第 ${day} 天按已冻结时间轴游览。`,
        highlights: ["当地体验：按当天节点安排", "步行游览：按现场指引", "机动休息：保留体力"],
        cautions: ["关注天气变化", "按现场开放时间调整"],
        history: [],
      });
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWithJson({ quoteId: null, message: "这是一段值得回味的旅程。" });
    }
    throw new Error(`Golden 测试收到未知 DeepSeek 请求：${content.slice(0, 80)}`);
  }) as typeof fetch;
}

function buildMultiLegButlerInput(): ButlerPlanInput {
  const transportLegs: TransportPlanLeg[] = [
    {
      id: "outbound:0",
      kind: "outbound",
      from: "北京",
      to: "西安",
      distanceKm: 900,
      mode: "flight",
      doorToDoorMinutes: 260,
      minimumPerPersonCost: 600,
    },
    {
      id: "outbound:1",
      kind: "outbound",
      from: "西安",
      to: "成都",
      distanceKm: 700,
      mode: "flight",
      doorToDoorMinutes: 240,
      minimumPerPersonCost: 500,
    },
  ];
  return {
    origin: "北京",
    destination: "成都",
    region: "四川省",
    startDate: "2026-10-01",
    days: 1,
    startTime: "08:00",
    endTime: "22:00",
    pace: "balanced",
    totalBudget: 40000,
    travelers: { adults: 5, children: 0 },
    interests: ["自然山水"],
    transport: "flight",
    route: {
      origin: "北京",
      destination: "成都",
      waypoints: ["西安"],
      roundTrip: false,
      returnMode: null,
      legs: [
        {
          id: "outbound:0",
          from: "北京",
          to: "西安",
          transport: "flight",
          style: "direct",
          kind: "outbound",
        },
        {
          id: "outbound:1",
          from: "西安",
          to: "成都",
          transport: "flight",
          style: "direct",
          kind: "outbound",
        },
      ],
    },
    weather: [{ date: "2026-10-01", code: 1, tempMax: 24, tempMin: 14 }],
    candidates: [
      {
        id: "sc-kuanzhai",
        name: "宽窄巷子",
        summary: "成都历史街区",
        source: "https://www.amap.com/place/sc-kuanzhai",
        address: "四川省成都市青羊区",
        type: "风景名胜",
        location: [104.055, 30.669],
        publicUrl: "https://www.amap.com/place/sc-kuanzhai",
        areaKey: "成都市-青羊区",
      },
    ],
    transportLegs,
  };
}

function buildShortWindowButlerInput(): ButlerPlanInput {
  const input = buildMinimalButlerInput();
  return {
    ...input,
    days: 1,
    startTime: "08:00",
    endTime: "10:50",
    totalBudget: 40000,
    weather: [{ date: "2026-10-01", code: 1, tempMax: 24, tempMin: 14 }],
    route: {
      ...input.route,
      roundTrip: false,
      legs: [],
    },
    transportLegs: [],
  };
}

test("Golden：同日多条交通 leg 都进入时间轴与预算引用", async () => {
  const result = await planWithButler(buildMultiLegButlerInput(), {
    apiKey: "k",
    fetchImpl: buildSimpleButlerFetch([]),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const transportNodes =
    result.skeleton.days[0]?.nodes.filter((node) => node.type === "transport") ?? [];
  assert.equal(transportNodes.length, 2);
  assert.ok(transportNodes.some((node) => node.name.includes("北京 → 西安")));
  assert.ok(transportNodes.some((node) => node.name.includes("西安 → 成都")));
  assert.ok(
    result.budget.priceReferences.every(
      (reference) => reference.kind !== "transport" || reference.legId,
    ),
  );

  const input = buildMultiLegButlerInput();
  const destination = {
    ...(destinations.find((item) => item.id === "huangshan") ?? destinations[0]),
    id: "multi-leg",
    name: "成都",
    region: "四川省",
  };
  const plan = buildTripPlanFromSkeleton({
    skeleton: result.skeleton,
    dayCopy: result.dayCopy,
    candidates: result.candidates,
    failedDays: result.failedDays,
    budgetPlan: result.budget,
    transportLegs: result.transportLegs,
    violations: result.violations,
    origin: input.origin,
    destination,
    startDate: input.startDate,
    travelers: input.travelers,
    totalBudget: input.totalBudget,
    pace: input.pace,
    interests: input.interests,
    roundTrip: false,
    returnMode: "fast",
    routePlan: input.route,
    weather: input.weather,
    closing: result.closing,
    transportPreference: "balanced",
  });
  const pricedTransport = Object.fromEntries(
    plan.days
      .flatMap((day) => day.nodes)
      .filter((node) => node.type === "transport")
      .map((node) => [node.name, node.estimatedCost]),
  );
  assert.equal(pricedTransport["北京 → 西安 · 飞机"], 3_000);
  assert.equal(pricedTransport["西安 → 成都 · 飞机"], 2_500);
  assert.equal(
    plan.days.reduce((total, day) => total + day.estimatedCost, 0),
    plan.budget.estimatedTotal,
  );
});
test("Golden：短窗口非移动日可降级休整且不阻断整单", async () => {
  const input = buildShortWindowButlerInput();
  const fetchImpl = (async (_request: RequestInfo | URL, init?: RequestInit) => {
    const content = requestText(init);
    if (content.includes("景点选择")) {
      return responseWithJson({
        selections: [
          {
            day: 1,
            candidateId: "sc-kuanzhai",
            sequence: 1,
            stayMinutes: 150,
            reason: "测试物理容量不足",
          },
        ],
      });
    }
    if (content.includes("每日文案")) {
      return responseWithJson({
        day: 1,
        purpose: "宽窄巷子深度游。",
        highlights: ["宽窄巷子：历史街区", "当地体验：按节点安排", "机动休息：保留体力"],
        cautions: ["关注天气变化", "按现场开放时间调整"],
        history: [],
      });
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWithJson({ quoteId: null, message: "这是一段值得回味的旅程。" });
    }
    return responseWithJson([]);
  }) as typeof fetch;
  const result = await planWithButler(input, { apiKey: "k", fetchImpl });

  if (result.status === "failed") {
    assert.fail(`短窗口计划不应失败：${result.stage} / ${result.reason}`);
  }
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const onlyDay = result.skeleton.days[0];
  assert.ok(onlyDay);
  assert.equal(
    onlyDay.nodes.some((node) => node.type === "attraction"),
    false,
  );
  assert.ok(onlyDay.nodes.some((node) => node.type === "rest"));
  assert.equal(onlyDay.theme.includes("宽窄巷子"), false);

  const destination = {
    ...(destinations.find((item) => item.id === "huangshan") ?? destinations[0]),
    id: "short-window",
    name: "成都",
    region: "四川省",
  };
  const plan = buildTripPlanFromSkeleton({
    skeleton: result.skeleton,
    dayCopy: result.dayCopy,
    candidates: result.candidates,
    failedDays: result.failedDays,
    budgetPlan: result.budget,
    transportLegs: result.transportLegs,
    violations: result.violations,
    origin: input.origin,
    destination,
    startDate: input.startDate,
    travelers: input.travelers,
    totalBudget: input.totalBudget,
    pace: input.pace,
    interests: input.interests,
    roundTrip: false,
    returnMode: "fast",
    routePlan: input.route,
    weather: input.weather,
    closing: result.closing,
    transportPreference: "balanced",
  });
  assert.equal(plan.days[0]?.theme.includes("宽窄巷子"), false);
  assert.equal(plan.days[0]?.purpose.includes("宽窄巷子"), false);
  assert.doesNotMatch(renderGuidebookHtml(plan), /宽窄巷子/);
});

test("Golden：260 分钟窗口可完整安排 150 分钟已选景点", async () => {
  const result = await planWithButler(
    {
      origin: "成都",
      destination: "成都",
      region: "四川省",
      startDate: "2026-10-01",
      days: 1,
      startTime: "08:00",
      endTime: "12:20",
      pace: "balanced",
      totalBudget: 20_000,
      travelers: { adults: 2, children: 0 },
      interests: ["人文建筑"],
      transport: null,
      route: {
        origin: "成都",
        destination: "成都",
        waypoints: [],
        roundTrip: false,
        returnMode: null,
        legs: [],
      },
      weather: [{ date: "2026-10-01", code: 1, tempMax: 24, tempMin: 14 }],
      candidates: [
        {
          id: "sc-kuanzhai",
          name: "宽窄巷子",
          summary: "成都历史街区",
          source: "https://www.amap.com/place/sc-kuanzhai",
          address: "四川省成都市青羊区",
          type: "风景名胜",
          location: [104.055, 30.669],
          publicUrl: "https://www.amap.com/place/sc-kuanzhai",
          areaKey: "成都市-青羊区",
        },
      ],
      transportLegs: [],
    },
    {
      apiKey: "k",
      fetchImpl: buildSimpleButlerFetch({
        selections: [
          {
            day: 1,
            candidateId: "sc-kuanzhai",
            sequence: 1,
            stayMinutes: 150,
            reason: "核心景点优先",
          },
        ],
      }),
    },
  );

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(
    result.skeleton.days[0]?.nodes.some(
      (node) => node.type === "attraction" && node.stayMinutes === 150,
    ),
  );
});

test("Golden：交通时长超出窗口时 timeline fail closed 且不输出节点", async () => {
  const result = await planWithButler(
    {
      origin: "北京",
      destination: "成都",
      region: "四川省",
      startDate: "2026-10-01",
      days: 1,
      startTime: "08:00",
      endTime: "12:20",
      pace: "balanced",
      totalBudget: 20_000,
      travelers: { adults: 2, children: 0 },
      interests: ["自然山水"],
      transport: "flight",
      route: {
        origin: "北京",
        destination: "成都",
        waypoints: [],
        roundTrip: false,
        returnMode: null,
        legs: [
          {
            id: "overflow",
            from: "北京",
            to: "成都",
            transport: "flight",
            style: "direct",
            kind: "outbound",
          },
        ],
      },
      weather: [{ date: "2026-10-01", code: 1, tempMax: 24, tempMin: 14 }],
      candidates: [
        {
          id: "sc-kuanzhai",
          name: "宽窄巷子",
          summary: "成都历史街区",
          source: "https://www.amap.com/place/sc-kuanzhai",
          address: "四川省成都市青羊区",
          type: "风景名胜",
          location: [104.055, 30.669],
          publicUrl: "https://www.amap.com/place/sc-kuanzhai",
          areaKey: "成都市-青羊区",
        },
      ],
      transportLegs: [
        {
          id: "overflow",
          kind: "outbound",
          from: "北京",
          to: "成都",
          distanceKm: 1800,
          mode: "flight",
          doorToDoorMinutes: 260,
          minimumPerPersonCost: 1000,
        },
      ],
    },
    { apiKey: "k", fetchImpl: buildSimpleButlerFetch([]) },
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.stage, "timeline");
  assert.match(result.reason, /交通时长超出每日时间窗/);
});
function buildLongDriveButlerInput(): {
  input: ButlerPlanInput;
  limit: number;
  driveLeg: TransportPlanLeg;
} {
  const driveLeg: TransportPlanLeg = {
    id: "outbound:1",
    kind: "outbound",
    from: "上海",
    to: "大理洱海",
    distanceKm: 2651.7,
    mode: "drive",
    doorToDoorMinutes: 1906,
    minimumPerPersonCost: 1061,
  };
  const route = {
    origin: "北京",
    destination: "大理洱海",
    waypoints: ["上海"],
    roundTrip: true,
    returnMode: "fast" as const,
    legs: [
      {
        id: "outbound:0",
        from: "北京",
        to: "上海",
        transport: "flight" as const,
        style: "direct" as const,
        kind: "outbound" as const,
      },
      {
        id: "outbound:1",
        from: "上海",
        to: "大理洱海",
        transport: "drive" as const,
        style: "wander" as const,
        kind: "outbound" as const,
      },
      {
        id: "return",
        from: "大理洱海",
        to: "北京",
        transport: "flight" as const,
        style: "direct" as const,
        kind: "return" as const,
      },
    ],
  };
  const transportLegs: TransportPlanLeg[] = [
    {
      id: "outbound:0",
      kind: "outbound",
      from: "北京",
      to: "上海",
      distanceKm: 1067.3,
      mode: "flight",
      doorToDoorMinutes: 300,
      minimumPerPersonCost: 588,
    },
    driveLeg,
    {
      id: "return",
      kind: "return",
      from: "大理洱海",
      to: "北京",
      distanceKm: 2182,
      mode: "flight",
      doorToDoorMinutes: 360,
      minimumPerPersonCost: 1201,
    },
  ];
  const feasibilityInput: TripFeasibilityPlanningInput & {
    startDate: string;
    pace: "balanced";
    totalBudget: number;
    travelers: { adults: number; children: number };
    interests: string[];
    transport: "drive";
    style: "wander";
    weather: [];
  } = {
    origin: "北京",
    destination: { id: "dali", name: "大理洱海", region: "云南 · 大理" },
    days: 5,
    dailyHours: 6,
    startTime: "08:00",
    endTime: "20:00",
    route,
    transportLegs,
    startDate: "2026-10-01",
    pace: "balanced",
    totalBudget: 50000,
    travelers: { adults: 3, children: 0 },
    interests: ["自然山水"],
    transport: "drive",
    style: "wander",
    weather: [],
  };
  const days = applyTripFeasibilityChoice(feasibilityInput, { strategy: "extend" }).days;
  const limit = resolveDailyDriveLimitMinutes(feasibilityInput.dailyHours);
  const segmentedDrive = {
    ...driveLeg,
    executionSegments: splitTransportLegIntoSegments(driveLeg, limit),
  };
  return {
    limit,
    driveLeg,
    input: {
      origin: feasibilityInput.origin,
      destination: feasibilityInput.destination.name,
      region: feasibilityInput.destination.region,
      startDate: feasibilityInput.startDate,
      days,
      startTime: feasibilityInput.startTime,
      endTime: feasibilityInput.endTime,
      pace: feasibilityInput.pace,
      totalBudget: feasibilityInput.totalBudget,
      travelers: feasibilityInput.travelers,
      interests: feasibilityInput.interests,
      transport: feasibilityInput.transport,
      style: feasibilityInput.style,
      route,
      weather: Array.from({ length: days }, (_, index) => ({
        date: `2026-10-${String(index + 1).padStart(2, "0")}`,
        code: 1,
        tempMax: 24,
        tempMin: 14,
      })),
      candidates: [
        {
          id: "dali-old-town",
          name: "大理古城",
          summary: "大理代表性古城",
          source: "https://www.amap.com/place/dali-old-town",
          address: "云南省大理白族自治州大理市",
          type: "风景名胜",
          location: [100.164, 25.695],
          publicUrl: "https://www.amap.com/place/dali-old-town",
          areaKey: "大理市",
        },
      ],
      transportLegs: [transportLegs[0]!, segmentedDrive, transportLegs[2]!],
    },
  };
}

function dynamicSelectionFetch(): typeof fetch {
  return (async (_input, init) => {
    const content = requestText(init);
    if (content.includes("景点选择")) {
      const marker = '"task": "景点选择"';
      const markerIndex = content.indexOf(marker);
      const start = markerIndex >= 0 ? content.lastIndexOf("{", markerIndex) : -1;
      const end = content.lastIndexOf("}");
      const payload = JSON.parse(content.slice(start, end + 1)) as {
        nonMovementDays?: number[];
      };
      return responseWithJson({
        selections: (payload.nonMovementDays ?? []).map((day) => ({
          day,
          candidateId: "dali-old-town",
          sequence: 1,
          stayMinutes: 120,
          reason: "只在驾驶日之外安排景点",
        })),
      });
    }
    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return responseWithJson({
        day,
        purpose: `第 ${day} 天按已冻结时间轴执行。`,
        highlights: ["分段驾驶：按每日上限推进", "沿途休息：保留体力", "机动停留：按现场调整"],
        cautions: ["关注驾驶安全", "按天气调整"],
        history: [],
      });
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWithJson({ quoteId: null, message: "这是一段值得回味的旅程。" });
    }
    throw new Error(`未知请求：${content.slice(0, 80)}`);
  }) as typeof fetch;
}

test("Golden：方案 B 的超长自驾跨天执行且总时长与交通成本守恒", async () => {
  const { input, limit, driveLeg } = buildLongDriveButlerInput();
  const result = await planWithButler(input, {
    apiKey: "k",
    fetchImpl: dynamicSelectionFetch(),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;

  const driveDays = result.skeleton.days
    .filter((day) => day.nodes.some((node) => node.transportMode === "drive"))
    .map((day) => day.day);
  assert.ok(driveDays.length >= 3);
  assert.deepEqual(
    driveDays,
    Array.from({ length: driveDays.length }, (_, index) => driveDays[0]! + index),
  );

  for (const day of result.skeleton.days.filter((item) => driveDays.includes(item.day))) {
    const driveMinutes = day.nodes
      .filter((node) => node.transportMode === "drive")
      .reduce((total, node) => total + (node.transportMinutes ?? 0), 0);
    assert.ok(driveMinutes <= limit);
    assert.equal(
      day.nodes.some((node) => node.type === "attraction"),
      false,
    );
  }

  const totalDriveMinutes = result.skeleton.days
    .flatMap((day) => day.nodes)
    .filter((node) => node.transportMode === "drive")
    .reduce((total, node) => total + (node.transportMinutes ?? 0), 0);
  assert.equal(totalDriveMinutes, driveLeg.doorToDoorMinutes);
  assert.equal(result.transportLegs.length, 3);
  assert.equal(
    result.budget.transport,
    result.transportLegs.reduce((total, leg) => total + leg.minimumPerPersonCost * 3, 0),
  );

  const plan = buildTripPlanFromSkeleton({
    skeleton: result.skeleton,
    dayCopy: result.dayCopy,
    candidates: result.candidates,
    failedDays: result.failedDays,
    budgetPlan: result.budget,
    transportLegs: result.transportLegs,
    violations: result.violations,
    origin: input.origin,
    destination: {
      ...(destinations.find((item) => item.id === "huangshan") ?? destinations[0]!),
      id: "dali",
      name: "大理洱海",
      region: "云南 · 大理",
    },
    startDate: input.startDate,
    travelers: input.travelers,
    totalBudget: input.totalBudget,
    pace: input.pace,
    interests: input.interests,
    roundTrip: input.route.roundTrip,
    returnMode: input.route.returnMode ?? "fast",
    routePlan: input.route,
    weather: input.weather,
    closing: result.closing,
    transportPreference: "balanced",
  });
  const transportNodeCost = plan.days
    .flatMap((day) => day.nodes)
    .filter((node) => node.type === "transport")
    .reduce((total, node) => total + node.estimatedCost, 0);
  assert.equal(transportNodeCost, plan.budget.transport.amount);
});
