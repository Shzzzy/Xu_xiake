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

  assert.equal(
    nodes.some((node) => node.type === "attraction"),
    false,
  );
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

  const transportNode = nodes.find((node) => node.type === "transport");
  assert.equal(transportNode?.transportMinutes, 70);
  assert.ok(nodes.some((node) => node.type === "transfer"));
  assert.equal(nodes.filter((node) => node.type === "meal").length, 2);
  assert.ok(nodes.some((node) => node.type === "hotel"));
  assertTimelineWindow(nodes, "08:00", "20:00");
});

test("剩余恰好 75 分钟可以安排 75 分钟景点", () => {
  const nodes = buildDayTimeline({
    day,
    startTime: "09:00",
    endTime: "18:00",
    transportMinutes: 285,
    meals: [60, 60],
    restMinutes: 30,
    attractions: [{ name: "恰好七十五分钟景点", stayMinutes: 75 }],
  });

  const attractionNode = nodes.find((node) => node.type === "attraction");
  assert.equal(attractionNode?.name, "恰好七十五分钟景点");
  assert.equal(attractionNode?.stayMinutes, 75);
  assertTimelineWindow(nodes, "09:00", "18:00");
});

test("短景点在前不会阻断后续可容纳景点", () => {
  const nodes = buildDayTimeline({
    day,
    startTime: "08:00",
    endTime: "20:00",
    transportMinutes: 60,
    meals: [60, 60],
    restMinutes: 30,
    attractions: [
      { name: "短景点", stayMinutes: 45 },
      { name: "中景点", stayMinutes: 300 },
      { name: "后续小景点", stayMinutes: 90 },
    ],
  });

  assert.deepEqual(
    nodes.filter((node) => node.type === "attraction").map((node) => node.name),
    ["短景点", "中景点", "后续小景点"],
  );
  assertTimelineWindow(nodes, "08:00", "20:00");
});

test("长景点放不下时跳过并继续尝试后续小景点", () => {
  const nodes = buildDayTimeline({
    day,
    startTime: "09:00",
    endTime: "18:00",
    transportMinutes: 300,
    meals: [30],
    restMinutes: 30,
    attractions: [
      { name: "放不下的长景点", stayMinutes: 200 },
      { name: "可容纳的小景点", stayMinutes: 90 },
    ],
  });

  assert.equal(
    nodes.some((node) => node.name === "放不下的长景点"),
    false,
  );
  assert.ok(nodes.some((node) => node.type === "attraction" && node.name === "可容纳的小景点"));
  assertTimelineWindow(nodes, "09:00", "18:00");
});

test("短窗口优先保留可容纳景点并跳过晚餐与前置休息", () => {
  const nodes = buildDayTimeline({
    day,
    startTime: "08:00",
    endTime: "11:30",
    transportMinutes: 0,
    meals: [60, 60],
    restMinutes: 30,
    attractions: [{ name: "短窗口景点", stayMinutes: 75 }],
  });

  assert.ok(nodes.some((node) => node.type === "attraction" && node.name === "短窗口景点"));
  assert.equal(nodes.filter((node) => node.type === "meal").length, 1);
  assert.equal(nodes.filter((node) => node.type === "rest").length, 1);
  assertTimelineWindow(nodes, "08:00", "11:30");
});

test("窗口低于最小景点容量时允许降级为休整而不是抛错", () => {
  const nodes = buildDayTimeline({
    day,
    startTime: "08:00",
    endTime: "09:30",
    transportMinutes: 0,
    meals: [60, 60],
    restMinutes: 30,
    attractions: [{ name: "无法容纳景点", stayMinutes: 75 }],
  });

  assert.equal(
    nodes.some((node) => node.type === "attraction"),
    false,
  );
  assert.ok(nodes.some((node) => node.type === "rest"));
  assertTimelineWindow(nodes, "08:00", "09:30");
});
