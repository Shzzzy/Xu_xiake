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
    assert.ok(node.timeLabel.length > 0);
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

test("shows loose display time labels on relaxed days", () => {
  const [relaxed] = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "relaxed",
    travelers: { adults: 2, children: 0 },
    routeNodes: ["古镇"],
    audits: { 古镇: audit({ durationHours: 3 }) },
    nightActivity: "灯会",
  });

  const labels = relaxed.nodes.map((node) => node.timeLabel);
  assert.ok(labels.length > 0);
  assert.ok(labels.every((label) => /^(清晨|上午|中午|下午|傍晚|晚上|夜间)$/.test(label)));
  assert.ok(labels.every((label) => !/\d/.test(label) && !label.includes(":")));
  // 节点内部仍保留分钟级起止时间，用于排序与容量计算
  assert.ok(relaxed.nodes.every((node) => /^\d{2}:\d{2}$/.test(node.startTime)));
  assert.ok(relaxed.nodes.every((node) => node.startTime < node.endTime));

  const [balanced] = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "balanced",
    travelers: { adults: 2, children: 0 },
    routeNodes: ["古镇"],
    audits: { 古镇: audit({ durationHours: 3 }) },
  });
  assert.ok(balanced.nodes.every((node) => /^\d{2}:\d{2}–\d{2}:\d{2}$/.test(node.timeLabel)));
});

test("keeps multi-day attractions on at least two consecutive days", () => {
  const build = (requested: number) =>
    buildExecutionDays({
      startDate: "2026-09-20",
      days: 3,
      pace: "balanced",
      travelers: { adults: 2, children: 0 },
      routeNodes: ["大峡谷", "古镇"],
      audits: {
        大峡谷: audit({ scale: "multi-day", durationHours: 16 }),
        古镇: audit({ durationHours: 3, bestTime: "下午" }),
      },
      multiDayDays: { 大峡谷: requested },
    });

  for (const requested of [1, 1.9, 2.7]) {
    const days = build(requested);
    const first = attractionNames(days[0]);
    const second = attractionNames(days[1]);
    assert.ok(
      first.some((name) => name.includes("大峡谷") && name.includes("第 1/2 天")),
      `${requested} 天应被修正为至少 2 天`,
    );
    assert.ok(second.some((name) => name.includes("大峡谷") && name.includes("第 2/2 天")));
    assert.ok(!first.some((name) => name.includes("古镇")));
    assert.ok(attractionNames(days[2]).some((name) => name.includes("古镇")));
  }
});

test("never packs two multi-day attractions into the same day", () => {
  const days = buildExecutionDays({
    startDate: "2026-09-20",
    days: 3,
    pace: "balanced",
    travelers: { adults: 2, children: 1 },
    routeNodes: ["大峡谷", "高原湖泊"],
    audits: {
      大峡谷: audit({ scale: "multi-day", durationHours: 16, bestTime: "上午" }),
      高原湖泊: audit({ scale: "multi-day", durationHours: 16, bestTime: "下午" }),
    },
  });

  for (const day of days) {
    const names = attractionNames(day).join(" ");
    assert.ok(!(names.includes("大峡谷") && names.includes("高原湖泊")), `${day.date} 同时排入两个跨日景点`);
  }
  assert.equal(days.filter((day) => attractionNames(day).some((name) => name.includes("大峡谷"))).length, 2);
  assert.ok(days.every((day) => !attractionNames(day).some((name) => name.includes("高原湖泊"))));
  assert.ok(days.at(-1)?.cautions.some((text) => text.includes("高原湖泊")));
});

test("stops scheduling once a single day runs out of time", () => {
  const routeNodes = Array.from({ length: 40 }, (_, index) => `景点${index + 1}`);
  const audits = Object.fromEntries(
    routeNodes.map((name) => [name, audit({ scale: "large", durationHours: 4 })]),
  );
  const [day] = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "deep",
    travelers: { adults: 2, children: 0 },
    routeNodes,
    audits,
  });

  const bounds = resolveDayBounds("deep");
  assert.ok(day.nodes.length > 0);
  for (let index = 0; index < day.nodes.length; index += 1) {
    const node = day.nodes[index];
    assert.ok(node.startTime < node.endTime, `${node.name} 的时长为零`);
    assert.ok(node.endTime <= bounds.end, `${node.name} 超过当天结束时间`);
    if (index > 0) {
      assert.ok(node.startTime >= day.nodes[index - 1].endTime, `${node.name} 与上一节点重叠`);
      assert.ok(node.startTime > day.nodes[index - 1].startTime, `${node.name} 起始时间未严格递增`);
    }
  }
  assert.ok(day.nodes.every((node) => node.endTime !== "23:59"));
  assert.ok(attractionNames(day).length < 40);
  assert.ok(day.cautions.some((text) => text.includes("未排入")));
});

test("aligns custom bounds to the pace granularity and reports the effective end", () => {
  const routeNodes = Array.from({ length: 20 }, (_, index) => `景点${index + 1}`);
  const audits = Object.fromEntries(
    routeNodes.map((name) => [name, audit({ scale: "large", durationHours: 5 })]),
  );
  const [day] = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "balanced",
    travelers: { adults: 2, children: 0 },
    routeNodes,
    audits,
    dayStart: "08:37",
    dayEnd: "20:20",
  });

  assert.equal(day.nodes[0]?.startTime, "08:45");
  assert.equal(day.nodes.at(-1)?.endTime, "20:15");
  assert.ok(day.cautions.some((text) => text.includes("20:15")));
  assert.ok(day.cautions.every((text) => !text.includes("21:00")));
});
