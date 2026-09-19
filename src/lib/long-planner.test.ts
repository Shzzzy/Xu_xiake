import test from "node:test";
import assert from "node:assert/strict";
import { buildRoutePlan } from "./route-planner.ts";
import {
  buildFallbackLongPlan,
  buildLongPlannerMessages,
  createLongPhaseRanges,
  parseLongPlanJson,
} from "./long-planner.ts";

test("long trip ranges cover every day exactly once", () => {
  for (const days of [17, 30, 31, 90, 91, 365]) {
    const ranges = createLongPhaseRanges(days);
    assert.ok(ranges.length > 0, `${days} days produced no phases`);
    assert.ok(ranges.length <= 12, `${days} days produced too many phases`);
    assert.equal(ranges[0].dayStart, 1);
    assert.equal(ranges.at(-1)?.dayEnd, days);
    for (let index = 0; index < ranges.length; index += 1) {
      if (index > 0) assert.equal(ranges[index].dayStart, ranges[index - 1].dayEnd + 1);
    }
  }
});

test("long plan parser rejects missing or overlapping day ranges", () => {
  const invalid = JSON.stringify({
    title: "长线路线",
    summary: "分阶段旅行",
    phases: [
      {
        dayStart: 1,
        dayEnd: 8,
        title: "第一阶段",
        region: "川西",
        highlights: ["雪山"],
        transport: "包车",
        notes: "适应海拔",
      },
      {
        dayStart: 10,
        dayEnd: 17,
        title: "第二阶段",
        region: "云南",
        highlights: ["古城"],
        transport: "高铁",
        notes: "转场",
      },
    ],
  });

  assert.throws(() => parseLongPlanJson(invalid, 17), /覆盖/);
});

test("long planner prompt asks DeepSeek to cover the exact phase ranges", () => {
  const route = buildRoutePlan({
    origin: "成都",
    destination: "云南",
    waypoints: ["大理"],
    roundTrip: true,
    returnMode: "scenic",
    defaultStyle: "direct",
    legPreferences: { "outbound:1": { style: "wander" } },
  });
  const messages = buildLongPlannerMessages({
    destinationName: "云南",
    region: "昆明 · 大理 · 丽江",
    startDate: "2026-10-01",
    days: 30,
    pace: "balanced",
    interests: ["自然山水", "古村古镇"],
    seedPlaces: ["滇池", "大理古城", "玉龙雪山"],
    discoveredStops: [
      {
        name: "龙岩",
        region: "福建",
        placeType: "城市",
        summary: "福建西部城市，适合作为客家文化停留点。",
        tags: ["客家文化", "古城"],
        verificationStatus: "verified",
      },
    ],
    route,
  });
  const prompt = messages.map((message) => message.content).join("\n");

  assert.match(prompt, /30 天/);
  assert.match(prompt, /dayStart: 1/);
  assert.match(prompt, /dayEnd: 30/);
  assert.match(prompt, /阶段/);
  assert.match(prompt, /成都/);
  assert.match(prompt, /不走回头/);
  assert.match(prompt, /睡眠/);
  assert.match(prompt, /discoveredStops/);
  assert.match(prompt, /龙岩/);
  assert.match(prompt, /"placeType":"城市"/);
  assert.match(prompt, /福建/);
  assert.match(prompt, /福建西部城市，适合作为客家文化停留点。/);
  assert.match(prompt, /客家文化/);
  assert.match(prompt, /古城/);
});

test("fallback long plan covers the requested duration", () => {
  const plan = buildFallbackLongPlan({
    destinationName: "云南",
    region: "昆明 · 大理 · 丽江",
    days: 30,
    seedPlaces: ["滇池", "大理古城", "玉龙雪山"],
  });

  assert.equal(plan.phases[0].dayStart, 1);
  assert.equal(plan.phases.at(-1)?.dayEnd, 30);
  assert.ok(plan.phases.length <= 12);
  assert.ok(plan.phases.every((phase) => phase.title && phase.region && phase.notes));
});
