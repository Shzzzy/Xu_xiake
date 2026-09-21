import assert from "node:assert/strict";
import test from "node:test";
import type { PlannerSkeletonDay, PlannerSkeletonNode } from "./planner-skeleton.ts";
import { buildDayTimeline } from "./day-timeline.ts";

const day: PlannerSkeletonDay = {
  day: 1,
  theme: "核心景点游览",
  nodes: [],
  radar: {
    physical: 60,
    childFit: 60,
    weatherSensitivity: 50,
    timeCost: 60,
    crowding: 50,
  },
};

const attraction = { name: "黄山风景区", stayMinutes: 120 };

function toMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function assertTimelineWindow(
  nodes: PlannerSkeletonNode[],
  startTime: string,
  endTime: string,
): void {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    assert.ok(toMinutes(node.startTime) >= start, `${node.name} 早于每日窗口`);
    assert.ok(toMinutes(node.endTime) <= end, `${node.name} 晚于每日窗口`);
    assert.ok(toMinutes(node.startTime) < toMinutes(node.endTime), `${node.name} 时长无效`);

    const previous = nodes[index - 1];
    if (previous) {
      assert.ok(
        toMinutes(previous.endTime) <= toMinutes(node.startTime),
        `${previous.name} 与 ${node.name} 发生重叠`,
      );
    }
  }
}

test("通勤时间从可用游玩时间扣除", () => {
  const nodes = buildDayTimeline({
    day,
    startTime: "09:00",
    endTime: "18:00",
    transportMinutes: 300,
    meals: [60, 60],
    restMinutes: 30,
    attractions: [attraction],
  });

  assert.equal(nodes.some((node) => node.type === "attraction"), false);
  assert.ok(nodes.some((node) => node.type === "rest" && node.name.includes("自由活动")));
  assertTimelineWindow(nodes, "09:00", "18:00");
});

test("充足剩余时间必须插入真实景点", () => {
  const nodes = buildDayTimeline({
    day,
    startTime: "08:00",
    endTime: "20:00",
    transportMinutes: 60,
    meals: [60, 60],
    restMinutes: 30,
    attractions: [attraction],
  });

  assert.ok(nodes.some((node) => node.type === "attraction" && node.name === attraction.name));
  assertTimelineWindow(nodes, "08:00", "20:00");
});

test("交通用餐休息酒店先占容量且节点不重叠", () => {
  const nodes = buildDayTimeline({
    day,
    startTime: "08:00",
    endTime: "20:00",
    transportMinutes: 90,
    meals: [45, 75],
    restMinutes: 30,
    attractions: [attraction, { name: "屯溪老街", stayMinutes: 90 }],
  });

  assert.ok(nodes.some((node) => node.type === "transport"));
  assert.ok(nodes.some((node) => node.type === "transfer"));
  assert.equal(nodes.filter((node) => node.type === "meal").length, 2);
  assert.ok(nodes.some((node) => node.type === "hotel"));
  assertTimelineWindow(nodes, "08:00", "20:00");
});
