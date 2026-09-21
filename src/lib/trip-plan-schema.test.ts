import test from "node:test";
import assert from "node:assert/strict";
import { tripPlanSchema } from "./trip-plan-schema.ts";
import type { TripPlan } from "./travel-plan.ts";

// 构造一份通过 JSON 序列化往返的最小合法 TripPlan，模拟 preview/PDF 的请求体边界。
function makeDay(day: number): TripPlan["days"][number] {
  return {
    date: "2026-09-20",
    theme: `第 ${day} 天`,
    nodes: [
      {
        startTime: "09:00",
        endTime: "12:00",
        timeLabel: "09:00–12:00",
        type: "attraction",
        name: "黄山风景区",
        estimatedCost: 320,
        navigation: null,
      },
    ],
    estimatedCost: 320,
    radar: { physical: 50, childFit: 50, weatherSensitivity: 50, timeCost: 50, crowding: 50 },
    purpose: "管家生成的目的文案",
    highlights: ["黄山风景区：云海"],
    cautions: ["注意保暖"],
  };
}

function makePlan(
  dayCount: number,
  options: { butler?: boolean; failedDay?: number } = {},
): TripPlan {
  return {
    meta: {
      title: "徽州路书",
      origin: "上海",
      waypoints: [],
      destination: "黄山",
      startDate: "2026-09-20",
      days: dayCount,
      travelers: { adults: 2, children: 0 },
      perPersonBudget: 4000,
      transportPreference: "balanced",
      pace: "balanced",
      interests: ["自然山水"],
      ...(options.butler ? { narrativeSource: "butler" } : {}),
    },
    budget: {
      totalBudget: 8000,
      estimatedTotal: 3000,
      totalMin: 2800,
      totalMax: 3200,
      remaining: 4800,
      overBudget: 0,
      perPersonBudget: 4000,
      perPersonEstimated: 1500,
      rooms: 1,
      transport: { min: 800, max: 900, amount: 850, ratio: 0.28 },
      lodging: { min: 800, max: 900, amount: 850, ratio: 0.28 },
      food: { min: 400, max: 500, amount: 450, ratio: 0.15 },
      tickets: { min: 500, max: 600, amount: 550, ratio: 0.18 },
      other: { min: 200, max: 300, amount: 250, ratio: 0.08 },
    },
    route: {
      outbound: [],
      returnPath: [],
      outboundSegments: [],
      returnSegments: [],
      distanceKm: 0,
      durationMinutes: 0,
      returnMode: null,
    },
    days: Array.from({ length: dayCount }, (_, index) => {
      const day = makeDay(index + 1);
      return index + 1 === options.failedDay ? { ...day, analysisFailed: true } : day;
    }),
    closing: { quote: null, source: null, message: "旅行回望。" },
  };
}

test("共享 schema 透传 butler narrativeSource 与失败日 analysisFailed", () => {
  const parsed = tripPlanSchema.parse(JSON.parse(JSON.stringify(makePlan(2, { butler: true, failedDay: 1 }))));

  assert.equal(parsed.meta.narrativeSource, "butler");
  assert.equal(parsed.days[0]?.analysisFailed, true);
  assert.equal(parsed.days[1]?.analysisFailed, undefined);
});

test("共享 schema 拒绝未知的 narrativeSource 标记", () => {
  const plan = makePlan(1);
  (plan.meta as { narrativeSource?: string }).narrativeSource = "other";

  assert.throws(() => tripPlanSchema.parse(plan));
});

test("16 天详细路书可通过共享 schema", () => {
  const parsed = tripPlanSchema.parse(makePlan(16));
  assert.equal(parsed.days.length, 16);
});

test("超过 16 天的行程被共享 schema 拒绝", () => {
  assert.throws(() => tripPlanSchema.parse(makePlan(17)), /too_big|最多|16/);
});
test("共享 schema 往返保留时间轴节点 legId", () => {
  const plan = makePlan(1);
  plan.days[0]!.nodes[0] = {
    startTime: "08:00",
    endTime: "12:20",
    timeLabel: "08:00–12:20",
    type: "transport",
    name: "北京前往成都 · 飞机",
    transportMode: "flight",
    transportMinutes: 260,
    legId: "leg-1",
    estimatedCost: 5_000,
    navigation: null,
  };

  const parsed = tripPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
  assert.equal(parsed.days[0]?.nodes[0]?.legId, "leg-1");
});