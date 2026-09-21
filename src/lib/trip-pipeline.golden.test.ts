import test from "node:test";
import assert from "node:assert/strict";
import type { AmapClient, AmapGeocode, AmapPoi } from "./amap.server.ts";
import type { LiveItineraryInput } from "./live-planner.functions.ts";
import { runLivePlannerWith } from "./live-planner.functions.ts";
import { planWithButler, type ButlerPlanInput } from "./planner-orchestrator.server.ts";
import type { PlanningStage } from "./planning-run.ts";
import type { TransportPlanLeg } from "./transport-planner.server.ts";

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
  const result = await runLivePlannerWith(buildGoldenInput(), {
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
  assert.equal(result.budget.provenance.lodging.quantity, 12);
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
