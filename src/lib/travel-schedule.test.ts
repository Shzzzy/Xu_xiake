import test from "node:test";
import assert from "node:assert/strict";
import { buildExecutionDays, resolveDayBounds } from "./travel-schedule.ts";
import type { AttractionAudit, TripDay } from "./travel-plan.ts";

// 便捷构造审核结果：只覆盖当前用例关心的字段。
function audit(overrides: Partial<AttractionAudit> = {}): AttractionAudit {
  return {
    scale: "medium",
    durationHours: 3,
    physical: 5,
    childFit: 5,
    weatherSensitivity: 5,
    timeCost: 5,
    crowding: 5,
    bestTime: "上午",
    ...overrides,
  };
}

// 取出某天安排的景点名称，便于断言规模排序与跨日拆分。
function attractionNames(day: TripDay): string[] {
  return day.nodes.filter((node) => node.type === "attraction").map((node) => node.name);
}

test("night activity stays inside the same day", () => {
  const days = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "balanced",
    travelers: { adults: 2, children: 1 },
    routeNodes: ["西湖", "灵隐寺"],
    audits: {
      西湖: { scale: "large", durationHours: 7, physical: 6, childFit: 8, weatherSensitivity: 7, timeCost: 7, crowding: 9, bestTime: "上午" },
      灵隐寺: { scale: "medium", durationHours: 3, physical: 5, childFit: 6, weatherSensitivity: 4, timeCost: 4, crowding: 8, bestTime: "下午" },
    },
    nightActivity: "湖边夜游",
  });
  assert.equal(days[0]?.nodes.at(-2)?.type, "night-activity");
  assert.equal(days[0]?.nodes.at(-1)?.type, "rest");
});

test("pace controls the default day bounds", () => {
  assert.deepEqual(resolveDayBounds("relaxed"), { start: "09:30", end: "19:30" });
  assert.deepEqual(resolveDayBounds("deep"), { start: "08:00", end: "22:00" });
});

test("every node carries explicit time, type, cost and navigation", () => {
  const days = buildExecutionDays({
    startDate: "2026-09-20",
    days: 2,
    pace: "balanced",
    travelers: { adults: 2, children: 1 },
    routeNodes: ["西湖", "灵隐寺"],
    audits: {
      西湖: audit({ scale: "large", durationHours: 6 }),
      灵隐寺: audit({ durationHours: 3, bestTime: "下午" }),
    },
    nightActivity: "湖边夜游",
    navigation: (name) => `https://uri.amap.com/search?keyword=${encodeURIComponent(name)}`,
  });

  const nodes = days.flatMap((day) => day.nodes);
  assert.ok(nodes.length > 0);
  for (const node of nodes) {
    assert.match(node.startTime, /^\d{2}:\d{2}$/);
    assert.match(node.endTime, /^\d{2}:\d{2}$/);
    assert.ok(node.startTime < node.endTime, `${node.name} 的起止时间应为升序`);
    assert.equal(typeof node.name, "string");
    assert.ok(node.name.length > 0);
    assert.equal(typeof node.estimatedCost, "number");
    assert.ok(node.navigation?.startsWith("https://uri.amap.com/"));
  }
});

test("degrades to null navigation when no resolver is provided", () => {
  const [day] = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "deep",
    travelers: { adults: 1, children: 0 },
    routeNodes: ["古镇"],
    audits: { 古镇: audit({ durationHours: 3 }) },
  });

  assert.ok(day.nodes.length > 0);
  assert.ok(day.nodes.every((node) => node.navigation === null));
});

test("inserts meal, hotel and rest nodes inside the day bounds", () => {
  const [day] = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "relaxed",
    travelers: { adults: 2, children: 1 },
    routeNodes: ["古镇"],
    audits: { 古镇: audit({ durationHours: 3 }) },
    lodging: "河畔客栈",
  });

  const bounds = resolveDayBounds("relaxed");
  const types = day.nodes.map((node) => node.type);
  assert.ok(types.includes("meal"));
  assert.ok(types.includes("hotel"));
  assert.ok(types.includes("rest"));
  assert.ok(day.nodes.some((node) => node.name.includes("河畔客栈")));
  assert.equal(day.nodes[0]?.startTime, bounds.start);
  assert.equal(day.nodes.at(-1)?.endTime, bounds.end);
});

test("splits multi-day attractions across consecutive days", () => {
  const days = buildExecutionDays({
    startDate: "2026-09-20",
    days: 3,
    pace: "balanced",
    travelers: { adults: 2, children: 1 },
    routeNodes: ["大峡谷", "古镇"],
    audits: {
      大峡谷: audit({ scale: "multi-day", durationHours: 16 }),
      古镇: audit({ durationHours: 3, bestTime: "下午" }),
    },
  });

  assert.equal(days.length, 3);
  assert.equal(days[0]?.date, "2026-09-20");
  assert.equal(days[1]?.date, "2026-09-21");

  const first = attractionNames(days[0]);
  const second = attractionNames(days[1]);
  assert.ok(first.some((name) => name.includes("大峡谷") && name.includes("第 1/2 天")));
  assert.ok(second.some((name) => name.includes("大峡谷") && name.includes("第 2/2 天")));
  assert.ok(first.every((name) => name.includes("大峡谷")));
  assert.ok(second.every((name) => name.includes("大峡谷")));
  assert.ok(attractionNames(days[2]).some((name) => name.includes("古镇")));
});

test("orders attractions by best time and keeps transport placeholders", () => {
  const [day] = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "deep",
    travelers: { adults: 2, children: 0 },
    routeNodes: ["小公园", "大瀑布"],
    audits: {
      小公园: audit({ scale: "small", durationHours: 2, bestTime: "下午" }),
      大瀑布: audit({ scale: "large", durationHours: 5, bestTime: "上午" }),
    },
  });

  const names = attractionNames(day);
  assert.ok(names.length >= 2);
  assert.ok(names[0]?.includes("大瀑布"));

  const transport = day.nodes.find((node) => node.type === "transport");
  assert.ok(transport);
  assert.equal(transport?.transportMinutes, 15);
});

test("keeps the timeline ordered when the day is over capacity", () => {
  const [day] = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "relaxed",
    travelers: { adults: 2, children: 1 },
    routeNodes: ["大峡谷", "古镇"],
    audits: {
      大峡谷: audit({ scale: "large", durationHours: 8 }),
      古镇: audit({ scale: "medium", durationHours: 4 }),
    },
  });

  const bounds = resolveDayBounds("relaxed");
  for (let index = 1; index < day.nodes.length; index += 1) {
    assert.ok(
      day.nodes[index].startTime >= day.nodes[index - 1].endTime,
      `${day.nodes[index].name} 与上一节点时间重叠`,
    );
  }
  assert.equal(day.nodes[0]?.startTime, bounds.start);
  assert.equal(day.nodes.at(-1)?.endTime, bounds.end);
  assert.ok(attractionNames(day).some((name) => name.includes("古镇")));
  assert.ok(day.cautions.length > 0);
});

test("derives the daily radar, theme and cost from scheduled attractions", () => {
  const [day] = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "balanced",
    travelers: { adults: 2, children: 0 },
    routeNodes: ["古镇"],
    audits: {
      古镇: audit({ physical: 80, childFit: 20, weatherSensitivity: 100, timeCost: 60, crowding: 40 }),
    },
    ticketCosts: { 古镇: 100 },
    mealCostPerPerson: 50,
    lodgingCost: 300,
  });

  assert.deepEqual(day.radar, { physical: 80, childFit: 20, weatherSensitivity: 100, timeCost: 60, crowding: 40 });
  assert.ok(day.theme.includes("古镇"));
  assert.ok(day.purpose.length > 0);
  // 门票 100 × 2 人 + 午餐 50 × 2 + 晚餐 50 × 2 + 住宿 300
  assert.equal(day.estimatedCost, 200 + 100 + 100 + 300);
});
