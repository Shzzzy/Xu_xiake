import assert from "node:assert/strict";
import test from "node:test";
import { destinations } from "../data/planner-destinations.ts";
import { buildRouteFallbackDays } from "./planner.ts";
import { buildRoutePlan } from "./route-planner.ts";
import { buildTripPlanOutput } from "./plan-output-adapter.ts";

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

  assert.equal(dailyTotal, nodeTotal);                                  // 节点合计不变
  assert.equal(categoryTotal, dailyTotal + plan.budget.other.amount);   // 五类合计 = 节点 + 杂事开销
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
