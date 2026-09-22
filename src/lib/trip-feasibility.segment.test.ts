import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTripFeasibilityChoice,
  resolveDailyDriveLimitMinutes,
  type TripFeasibilityPlanningInput,
} from "./trip-feasibility.ts";
import { planWithButler, type ButlerPlanInput } from "./planner-orchestrator.server.ts";
import {
  splitTransportLegIntoSegments,
  type TransportPlanLeg,
} from "./transport-planner.server.ts";
import { buildTripPlanFromSkeleton } from "./plan-output-adapter.ts";
import { destinations } from "../data/planner-destinations.ts";

const DAILY_HOURS = 6;
const DRIVE_LEG: TransportPlanLeg = {
  id: "outbound:1",
  kind: "outbound",
  from: "上海",
  to: "大理洱海",
  distanceKm: 2651.7,
  mode: "drive",
  doorToDoorMinutes: 1906,
  minimumPerPersonCost: 1061,
};

function responseWithJson(value: unknown): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

function requestText(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as { messages?: { content?: string }[] };
  return (body.messages ?? []).map((message) => message.content ?? "").join("\n");
}

function selectionForNonMovementDays(init?: RequestInit): unknown {
  const content = requestText(init);
  const marker = '"task": "景点选择"';
  const markerIndex = content.indexOf(marker);
  const start = markerIndex >= 0 ? content.lastIndexOf("{", markerIndex) : -1;
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return { selections: [] };
  const payload = JSON.parse(content.slice(start, end + 1)) as {
    nonMovementDays?: number[];
  };
  return {
    selections: (payload.nonMovementDays ?? []).map((day) => ({
      day,
      candidateId: "dali-old-town",
      sequence: 1,
      stayMinutes: 120,
      reason: "只在非驾驶日安排景点",
    })),
  };
}

function butlerFetch(): typeof fetch {
  return (async (_input, init) => {
    const content = requestText(init);
    if (content.includes("景点选择")) return responseWithJson(selectionForNonMovementDays(init));
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

type ExtendedDriveInput = TripFeasibilityPlanningInput &
  Omit<ButlerPlanInput, "destination" | "candidates" | "transportLegs">;

function extendedDriveInput(): {
  feasibilityInput: ExtendedDriveInput;
  days: number;
} {
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
    DRIVE_LEG,
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
  const feasibilityInput: ExtendedDriveInput = {
    origin: "北京",
    destination: { id: "dali", name: "大理洱海", region: "云南 · 大理" },
    days: 5,
    dailyHours: DAILY_HOURS,
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
  return { feasibilityInput, days };
}

test("长距离自驾按每日上限分段并保持距离与时间守恒", () => {
  const limit = resolveDailyDriveLimitMinutes(DAILY_HOURS);
  const segments = splitTransportLegIntoSegments(DRIVE_LEG, limit);

  assert.ok(segments.length >= 3);
  assert.ok(segments.every((segment) => segment.doorToDoorMinutes <= limit));
  assert.equal(
    segments.reduce((total, segment) => total + segment.doorToDoorMinutes, 0),
    DRIVE_LEG.doorToDoorMinutes,
  );
  assert.ok(
    Math.abs(
      segments.reduce((total, segment) => total + segment.distanceKm, 0) - DRIVE_LEG.distanceKm,
    ) < 0.2,
  );
});

test("方案 B 的超长自驾跨天连续执行，景点只在其余下容量安排且成本只计一次", async () => {
  const { feasibilityInput, days } = extendedDriveInput();
  const limit = resolveDailyDriveLimitMinutes(DAILY_HOURS);
  const segmentedDrive = {
    ...DRIVE_LEG,
    executionSegments: splitTransportLegIntoSegments(DRIVE_LEG, limit),
  };
  const result = await planWithButler(
    {
      ...feasibilityInput,
      days,
      destination: feasibilityInput.destination.name,
      region: feasibilityInput.destination.region,
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
      transportLegs: [
        feasibilityInput.transportLegs[0]!,
        segmentedDrive,
        feasibilityInput.transportLegs[2]!,
      ],
    },
    { apiKey: "k", fetchImpl: butlerFetch() },
  );

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
    assert.ok(driveMinutes <= limit, `第 ${day.day} 天驾驶 ${driveMinutes} 分钟超过上限`);
    assert.equal(
      day.nodes.some((node) => node.type === "attraction"),
      false,
    );
  }

  const totalDriveMinutes = result.skeleton.days
    .flatMap((day) => day.nodes)
    .filter((node) => node.transportMode === "drive")
    .reduce((total, node) => total + (node.transportMinutes ?? 0), 0);
  assert.equal(totalDriveMinutes, DRIVE_LEG.doorToDoorMinutes);

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
    origin: feasibilityInput.origin,
    destination: {
      ...(destinations.find((item) => item.id === "huangshan") ?? destinations[0]!),
      id: "dali",
      name: "大理洱海",
      region: "云南 · 大理",
    },
    startDate: feasibilityInput.startDate,
    travelers: feasibilityInput.travelers,
    totalBudget: feasibilityInput.totalBudget,
    pace: feasibilityInput.pace,
    interests: feasibilityInput.interests,
    roundTrip: feasibilityInput.route.roundTrip,
    returnMode: feasibilityInput.route.returnMode ?? "fast",
    routePlan: feasibilityInput.route,
    weather: feasibilityInput.weather,
    closing: result.closing,
    transportPreference: "balanced",
  });
  const transportNodeCost = plan.days
    .flatMap((day) => day.nodes)
    .filter((node) => node.type === "transport")
    .reduce((total, node) => total + node.estimatedCost, 0);
  assert.equal(transportNodeCost, plan.budget.transport.amount);
});
