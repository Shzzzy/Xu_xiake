import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTripFeasibilityChoice,
  evaluateTripFeasibility,
  type TripFeasibilityPlanningInput,
} from "./trip-feasibility.ts";
import { runLivePlannerWith, type LiveItineraryInput } from "./live-planner.functions.ts";
import type { AmapClient } from "./amap.server.ts";

function longDriveInput(): TripFeasibilityPlanningInput {
  return {
    origin: "北京",
    destination: { id: "dali", name: "大理洱海", region: "云南 · 大理" },
    days: 5,
    dailyHours: 6,
    startTime: "08:00",
    endTime: "18:00",
    route: {
      origin: "北京",
      destination: "大理洱海",
      waypoints: ["上海"],
      roundTrip: true,
      returnMode: "fast",
      legs: [
        {
          id: "outbound:0",
          from: "北京",
          to: "上海",
          transport: "flight",
          style: "direct",
          kind: "outbound",
        },
        {
          id: "outbound:1",
          from: "上海",
          to: "大理洱海",
          transport: "drive",
          style: "wander",
          kind: "outbound",
        },
        {
          id: "return",
          from: "大理洱海",
          to: "北京",
          transport: "flight",
          style: "direct",
          kind: "return",
        },
      ],
    },
    transportLegs: [
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
      {
        id: "outbound:1",
        kind: "outbound",
        from: "上海",
        to: "大理洱海",
        distanceKm: 2651.7,
        mode: "drive",
        doorToDoorMinutes: 1906,
        minimumPerPersonCost: 1061,
      },
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
    ],
  };
}

test("5 天 2000 公里以上沿途自驾会返回三方案而不是硬排", () => {
  const decision = evaluateTripFeasibility(longDriveInput());

  assert.ok(decision);
  assert.equal(decision.options.length, 3);
  assert.deepEqual(
    decision.options.map((option) => option.strategy.type),
    ["direct", "extend", "focus"],
  );
  assert.match(decision.reason, /上海/);
  assert.match(decision.reason, /大理洱海/);
  assert.ok(decision.summary.shortageMinutes > 0);
});

test("长距离边走边玩即使未显式写成自驾也要先做可行性决策", () => {
  const input = longDriveInput();
  input.route.legs[1] = { ...input.route.legs[1]!, transport: "balanced", style: "wander" };

  const decision = evaluateTripFeasibility(input);

  assert.ok(decision);
  assert.deepEqual(decision.longDriveLegIds, ["outbound:1"]);
});
test("方案 A 只把长距离自驾腿改为直飞直达", () => {
  const adjusted = applyTripFeasibilityChoice(longDriveInput(), { strategy: "direct" });
  const changed = adjusted.route.legs.find((leg) => leg.id === "outbound:1");

  assert.equal(changed?.transport, "flight");
  assert.equal(changed?.style, "direct");
  assert.equal(adjusted.route.legs[0]?.transport, "flight");
  assert.equal(adjusted.route.legs[2]?.transport, "flight");
});

test("方案 B 按真实门到门时间增加天数并保留自驾和沿途游玩", () => {
  const decision = evaluateTripFeasibility(longDriveInput());
  assert.ok(decision);
  const extend = decision.options.find((option) => option.strategy.type === "extend");
  assert.ok(extend && extend.strategy.type === "extend");
  assert.ok(extend.strategy.recommendedDays > 5);
  const expectedDriveSegmentDays = Math.ceil(1906 / extend.strategy.dailyDriveLimitMinutes);
  assert.equal(extend.strategy.driveSegmentDays, expectedDriveSegmentDays);
  assert.equal(
    extend.strategy.recommendedDays,
    decision.summary.transportDays + decision.summary.stopDays,
  );
  assert.match(extend.metrics.join(" "), /每日驾驶 ≤/);
  assert.match(extend.metrics.join(" "), /长途拆为/);

  const adjusted = applyTripFeasibilityChoice(longDriveInput(), { strategy: "extend" });
  const driveLeg = adjusted.route.legs.find((leg) => leg.id === "outbound:1");

  assert.equal(adjusted.days, extend.strategy.recommendedDays);
  assert.equal(driveLeg?.transport, "drive");
  assert.equal(driveLeg?.style, "wander");
  assert.equal(evaluateTripFeasibility(adjusted), null);
});

test("方案 C 可选择单个区域并不再跨双城", () => {
  const adjusted = applyTripFeasibilityChoice(longDriveInput(), {
    strategy: "focus",
    focusTarget: "上海",
  });

  assert.equal(adjusted.destination.name, "上海");
  assert.deepEqual(adjusted.route.waypoints, []);
  assert.deepEqual(
    adjusted.route.legs.map((leg) => `${leg.from}->${leg.to}:${leg.transport}:${leg.style}`),
    ["北京->上海:flight:direct", "上海->北京:flight:direct"],
  );
  assert.equal(evaluateTripFeasibility(adjusted), null);
});

test("普通短途直达不会触发方案选择", () => {
  const input = longDriveInput();
  input.days = 3;
  input.transportLegs = input.transportLegs.filter((leg) => leg.id !== "outbound:1");
  input.route = {
    ...input.route,
    waypoints: [],
    destination: "上海",
    legs: [
      {
        id: "outbound:0",
        from: "北京",
        to: "上海",
        transport: "flight",
        style: "direct",
        kind: "outbound",
      },
      {
        id: "return",
        from: "上海",
        to: "北京",
        transport: "flight",
        style: "direct",
        kind: "return",
      },
    ],
  };
  input.destination = { id: "shanghai", name: "上海", region: "上海市" };

  assert.equal(evaluateTripFeasibility(input), null);
});

type FetchImpl = typeof fetch;

function liveLongDriveInput(): LiveItineraryInput & TripFeasibilityPlanningInput {
  const base = longDriveInput();
  return {
    ...base,
    destination: base.destination,
    startDate: "2026-10-01",
    pace: "balanced",
    interests: ["自然山水"],
    totalBudget: 30000,
    travelers: { adults: 3, children: 0 },
    transport: null,
    style: "wander",
    weather: Array.from({ length: 5 }, (_, index) => ({
      date: `2026-10-0${index + 1}`,
      code: 1,
      tempMax: 25,
      tempMin: 16,
      precipProb: 10,
    })),
    seedPlaces: [],
  };
}

function responseWith(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

function requestMessageContent(body: unknown): string {
  const parsed = body as { messages?: { content?: string }[] };
  return (parsed.messages ?? []).map((message) => message.content ?? "").join("\n");
}

function selectionJsonFromPrompt(content: string): string {
  const marker = '"task": "景点选择"';
  const markerIndex = content.indexOf(marker);
  const start = markerIndex >= 0 ? content.lastIndexOf("{", markerIndex) : -1;
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return JSON.stringify({ selections: [] });
  const payload = JSON.parse(content.slice(start, end + 1)) as {
    candidates?: { id?: string }[];
    nonMovementDays?: number[];
  };
  const ids = (payload.candidates ?? []).map((candidate) => candidate.id).filter(Boolean);
  return JSON.stringify({
    selections: (payload.nonMovementDays ?? []).map((day, index) => ({
      day,
      candidateId: ids[index % Math.max(1, ids.length)],
      sequence: 1,
      stayMinutes: 120,
      reason: "测试选择",
    })),
  });
}

function fakeButlerFetch(): FetchImpl {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("tavily")) {
      return Response.json({ results: [] });
    }
    const content = requestMessageContent(JSON.parse(String(init?.body)));
    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return responseWith(
        JSON.stringify({
          day,
          purpose: `第 ${day} 天的旅行目的。`,
          highlights: ["按候选景点安排：说明"],
          cautions: ["注意交通与天气"],
          history: [],
        }),
      );
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWith(JSON.stringify({ quoteId: null, message: "安全返回。" }));
    }
    return responseWith(selectionJsonFromPrompt(content));
  }) as FetchImpl;
}

function fakeLongDriveAmapClient(): AmapClient {
  const geocodes = {
    北京: { location: [116.407526, 39.90403] as [number, number], province: "北京市" },
    上海: { location: [121.473701, 31.230416] as [number, number], province: "上海市" },
    大理洱海: { location: [100.225, 25.606] as [number, number], province: "云南省" },
  };
  return {
    async searchPoi() {
      return [
        {
          id: "dali-old-town",
          name: "大理古城",
          type: "风景名胜;风景名胜",
          address: "云南省大理白族自治州大理市大理洱海景区",
          location: [100.164, 25.695],
          province: "云南省",
          city: "大理白族自治州",
          district: "大理市",
          adcode: "532901",
        },
        {
          id: "erhai-eco",
          name: "洱海生态廊道",
          type: "风景名胜;风景名胜",
          address: "云南省大理白族自治州大理市大理洱海景区",
          location: [100.205, 25.62],
          province: "云南省",
          city: "大理白族自治州",
          district: "大理市",
          adcode: "532901",
        },
      ];
    },
    async fetchStaticMap() {
      return new Uint8Array();
    },
    async route(input) {
      return {
        mode: input.mode,
        origin: input.origin,
        destination: input.destination,
        distanceMeters: 2_651_700,
        durationSeconds: 100_860,
        path: [input.origin, input.destination],
        steps: [],
      };
    },
    async geocode(input) {
      const point = geocodes[input.address.trim() as keyof typeof geocodes];
      if (!point) return [];
      return [
        {
          formattedAddress: input.address,
          province: point.province,
          city: input.address,
          district: "",
          adcode: "",
          location: point.location,
        },
      ];
    },
    async weather() {
      return [];
    },
  };
}

test("方案 A 修改后被正式 live planner 接受并进入管家链路", async () => {
  const original = liveLongDriveInput();
  const deps = {
    env: {
      BUTLER_PLANNER: "1",
      DEEPSEEK_API_KEY: "k",
      TAVILY_API_KEY: "k",
    },
    fetchImpl: fakeButlerFetch(),
    amapClient: fakeLongDriveAmapClient(),
  } as const;

  const decision = await runLivePlannerWith(original, deps);
  assert.equal(decision.status, "needs_decision");
  if (decision.status !== "needs_decision") return;

  const adjusted = applyTripFeasibilityChoice(original, { strategy: "direct" });
  const result = await runLivePlannerWith(adjusted, deps);

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.mode, "butler");
  const changed = result.route.legs.find((leg) => leg.id === "outbound:1");
  assert.equal(changed?.transport, "flight");
  assert.equal(changed?.style, "direct");
});
