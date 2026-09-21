import assert from "node:assert/strict";
import test from "node:test";
import { destinations } from "../data/planner-destinations.ts";
import { buildRouteFallbackDays } from "./planner.ts";
import { buildRoutePlan } from "./route-planner.ts";
import { buildTripPlanFromSkeleton, buildTripPlanOutput } from "./plan-output-adapter.ts";
import { prepareGuidebookDayNarrative } from "./guidebook-narrative.server.ts";
import type { PlannerSkeleton } from "./planner-skeleton.ts";
import type { PlannerDayCopy } from "./planner-day-copy.ts";
import type { PlanViolation } from "./plan-validator.ts";

function fixtureOutput() {
  const destination = destinations.find((item) => item.id === "huangshan") ?? destinations[0];
  const routePlan = buildRoutePlan({
    origin: "上海",
    destination: destination.name,
    waypoints: ["杭州"],
    roundTrip: true,
    returnMode: "fast",
    defaultStyle: "direct",
    legPreferences: {},
  });
  const weather = [
    { date: "2026-09-20", code: 1, tempMax: 27, tempMin: 19 },
    { date: "2026-09-21", code: 3, tempMax: 26, tempMin: 18 },
    { date: "2026-09-22", code: 61, tempMax: 23, tempMin: 17 },
  ];
  const plannedDays = buildRouteFallbackDays({
    route: routePlan,
    days: 3,
    destinationPlaces: destination.places,
    weather,
    pace: "balanced",
  });

  return buildTripPlanOutput({
    origin: "上海",
    destination,
    startDate: "2026-09-20",
    days: 3,
    pace: "balanced",
    interests: ["自然山水"],
    waypoints: ["杭州"],
    roundTrip: true,
    returnMode: "fast",
    travelers: { adults: 2, children: 1 },
    totalBudget: 9000,
    startTime: "08:30",
    endTime: "20:30",
    plannedDays,
    routePlan,
  });
}

const skeletonDestination = destinations.find((item) => item.id === "huangshan") ?? destinations[0];
const skeletonRoutePlan = buildRoutePlan({
  origin: "上海",
  destination: skeletonDestination.name,
  waypoints: ["杭州"],
  roundTrip: true,
  returnMode: "fast",
  defaultStyle: "direct",
  legPreferences: {},
});

const skeleton: PlannerSkeleton = {
  title: "黄山2日徽州山水古村行程",
  summary: "用两天时间串联黄山与徽州古村。",
  days: [
    {
      day: 1,
      theme: "黄山主景区",
      nodes: [
        {
          type: "attraction",
          startTime: "09:00",
          endTime: "12:00",
          name: "黄山风景区",
          location: "黄山",
          stayMinutes: 180,
          estimatedCost: 320,
          tips: "上午上山，预留排队与索道时间。",
        },
      ],
      radar: {
        physical: 80,
        childFit: 50,
        weatherSensitivity: 75,
        timeCost: 70,
        crowding: 82,
      },
    },
    {
      day: 2,
      theme: "徽州古村",
      nodes: [
        {
          type: "attraction",
          startTime: "09:30",
          endTime: "12:30",
          name: "宏村",
          location: "黟县",
          stayMinutes: 180,
          estimatedCost: 180,
          tips: "清晨入村，避开旅行团高峰。",
        },
      ],
      radar: {
        physical: 45,
        childFit: 75,
        weatherSensitivity: 55,
        timeCost: 50,
        crowding: 68,
      },
    },
  ],
};

const skeletonInputFixture = {
  skeleton,
  origin: "上海",
  destination: skeletonDestination,
  startDate: "2026-09-20",
  travelers: { adults: 2, children: 0 },
  totalBudget: 5000,
  pace: "balanced" as const,
  interests: ["自然山水", "古村"],
  roundTrip: true,
  returnMode: "fast" as const,
  routePlan: skeletonRoutePlan,
  weather: [
    { date: "2026-09-20", code: 1, tempMax: 27, tempMin: 19 },
    { date: "2026-09-21", code: 3, tempMax: 26, tempMin: 18 },
  ],
  transportPreference: "balanced" as const,
};

const dayCopyFixture: PlannerDayCopy[] = [
  {
    day: 1,
    purpose: "把主景区放在体力最好的上午。",
    highlights: [
      "黄山风景区：上午云海视野更稳定。",
      "节奏留白：午后按体力休整。",
      "轻装上山：减少台阶负担。",
    ],
    cautions: ["索道可能排队，请预留时间。", "山顶温差大，注意保暖。"],
    history: [],
  },
];

test("骨架转 TripPlan 保留模型给的时间与费用", () => {
  const plan = buildTripPlanFromSkeleton(skeletonInputFixture);
  const firstNode = plan.days[0]?.nodes[0];

  assert.equal(firstNode?.startTime, "09:00");
  assert.equal(firstNode?.timeLabel, "09:00–12:00");
  assert.equal(firstNode?.navigation, null);
  assert.equal(plan.days[0]?.estimatedCost, 320);
  assert.equal(plan.days[0]?.date, "2026-09-20");
  assert.equal(plan.days[1]?.date, "2026-09-21");
  assert.equal(plan.meta.title, "黄山2日徽州山水古村行程");
  assert.deepEqual(plan.days[0]?.radar, skeleton.days[0]?.radar);
});

test("骨架转 TripPlan 用文案覆盖每日分析", () => {
  const plan = buildTripPlanFromSkeleton({ ...skeletonInputFixture, dayCopy: dayCopyFixture });
  assert.equal(plan.days[0]?.purpose, "把主景区放在体力最好的上午。");
  assert.equal(plan.days[0]?.highlights.length, 3);
  assert.equal(plan.days[0]?.cautions.length, 2);
});

test("缺少文案时退回本地默认文案", () => {
  const plan = buildTripPlanFromSkeleton(skeletonInputFixture);
  assert.ok((plan.days[0]?.purpose ?? "").length > 0);
  assert.ok((plan.days[0]?.cautions.length ?? 0) >= 2);
});

test("失败日与违规信息保留可识别标记并原样透传", () => {
  const violations: PlanViolation[] = [
    {
      code: "PACE_EXCEEDED",
      day: 1,
      message: "第 1 天景点数量超过节奏限制",
      detail: { expected: "≤3 个", actual: "4 个" },
    },
  ];
  const plan = buildTripPlanFromSkeleton({
    ...skeletonInputFixture,
    dayCopy: [{ day: 1, purpose: "", highlights: [], cautions: [], history: [] }],
    failedDays: [1],
    violations,
  });

  assert.equal(plan.days[0]?.analysisFailed, true);
  assert.equal(plan.days[1]?.analysisFailed, undefined);
  assert.ok((plan.days[0]?.purpose ?? "").length > 0);
  assert.equal(plan.violations, violations);
});

test("converts every route leg into a formal transfer timeline node", () => {
  const plan = fixtureOutput();
  const transfers = plan.days.flatMap((day) =>
    day.nodes.filter((node) => node.type === "transfer"),
  );

  assert.equal(
    transfers.length,
    plan.route.outboundSegments.length + plan.route.returnSegments.length,
  );
  assert.ok(transfers.some((node) => /上海.*杭州/.test(node.name)));
  assert.ok(transfers.some((node) => /杭州.*黄山/.test(node.name)));
  assert.ok(transfers.some((node) => /黄山.*上海/.test(node.name)));
  assert.ok(transfers.every((node) => node.startTime < node.endTime));
});

test("reconciles budget categories, daily totals and timeline node costs", () => {
  const plan = fixtureOutput();
  const dailyTotal = plan.days.reduce((sum, day) => sum + day.estimatedCost, 0);
  const nodeTotal = plan.days.reduce(
    (sum, day) => sum + day.nodes.reduce((daySum, node) => daySum + node.estimatedCost, 0),
    0,
  );
  const categoryTotal =
    plan.budget.transport.amount +
    plan.budget.lodging.amount +
    plan.budget.food.amount +
    plan.budget.tickets.amount +
    plan.budget.other.amount;

  assert.equal(dailyTotal, nodeTotal); // 节点合计不变
  assert.equal(categoryTotal, dailyTotal + plan.budget.other.amount); // 五类合计 = 节点 + 杂事开销
  assert.equal(plan.budget.estimatedTotal, categoryTotal);
  assert.equal(plan.budget.totalMin, categoryTotal);
  assert.equal(plan.budget.totalMax, categoryTotal);
});

test("maps real builder weather and destination data into TripPlan", () => {
  const plan = fixtureOutput();

  assert.equal(plan.meta.destination, "黄山");
  assert.equal(plan.days.length, 3);
  assert.ok(plan.days.every((day) => day.date));
  assert.ok(plan.days.some((day) => /晴|多云|有雨/.test(day.weather ?? "")));
  assert.ok(plan.days.some((day) => day.nodes.some((node) => node.type === "attraction")));
});

test("其他项在兜底路径下按前四类 10% 预留", () => {
  const plan = fixtureOutput();
  assert.ok(plan.budget.other.amount >= 200, "杂事开销最低 ¥200");
  assert.ok(plan.budget.other.amount > 0, "不应再恒为 0");
});

test("骨架转 TripPlan 写入本 run 候选并驱动文案拒绝未安排景点", async () => {
  const copy: PlannerDayCopy[] = [
    {
      day: 1,
      purpose: "顺路去故宫看看",
      highlights: ["午餐后继续行程", "休息后再出发", "关注天气变化"],
      cautions: ["带好雨具", "注意保暖"],
      history: [],
    },
  ];
  const plan = buildTripPlanFromSkeleton({
    ...skeletonInputFixture,
    dayCopy: copy,
    candidates: [
      { name: "黄山风景区", summary: "主景区", source: "https://example.com/huangshan" },
      { name: "宏村", summary: "古村", source: "https://example.com/hongcun" },
      { name: "故宫", summary: "候选但未安排", source: "https://example.com/gugong" },
    ],
  });

  assert.deepEqual(plan.meta.allowedAttractions, ["黄山风景区", "宏村", "故宫"]);

  const prepared = await prepareGuidebookDayNarrative(plan, 0);
  assert.match(prepared.purpose, /第 1 天：/);
  assert.equal(prepared.analysisFailed, true);
  assert.doesNotMatch(JSON.stringify(prepared), /故宫/);
});

test("确定性预算与交通腿覆盖节点费用并保留路线元数据", () => {
  const budgetPlan = {
    transport: 10_800,
    lodging: 6_000,
    food: 5_500,
    tickets: 1_500,
    other: 2_380,
    estimatedTotal: 26_180,
    priceReferences: [],
    provenance: {
      transport: [],
      tickets: [],
      lodging: {
        kind: "lodging" as const,
        label: "住宿参考价",
        amount: 500,
        currency: "CNY" as const,
        confidence: "fallback" as const,
        quantity: 12,
        total: 6_000,
      },
      food: {
        kind: "food" as const,
        label: "餐饮参考价",
        amount: 220,
        currency: "CNY" as const,
        confidence: "fallback" as const,
        quantity: 25,
        total: 5_500,
      },
      other: {
        kind: "other" as const,
        label: "其他费用",
        amount: 2_380,
        currency: "CNY" as const,
        confidence: "fallback" as const,
        quantity: 1,
        total: 2_380,
      },
    },
  };
  const transportLegs = skeletonRoutePlan.legs.map((leg) => ({
    id: leg.id,
    kind: leg.kind,
    from: leg.from,
    to: leg.to,
    distanceKm: 1_964,
    mode: "flight" as const,
    doorToDoorMinutes: 344,
    minimumPerPersonCost: 1_080,
  }));

  const plan = buildTripPlanFromSkeleton({
    ...skeletonInputFixture,
    budgetPlan,
    transportLegs,
  });

  assert.equal(plan.budget.transport.amount, 10_800);
  assert.equal(plan.budget.lodging.amount, 6_000);
  assert.equal(plan.budget.estimatedTotal, 26_180);
  assert.ok(plan.route.outboundSegments.every((segment) => segment.distanceKm === 1_964));
  assert.ok(plan.route.returnSegments.every((segment) => segment.durationMinutes === 344));
});
