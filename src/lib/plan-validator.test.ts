import test from "node:test";
import assert from "node:assert/strict";
import { validateSkeleton, type PlanValidationInput } from "./plan-validator.ts";
import type { PlannerSkeleton, PlannerSkeletonNode } from "./planner-skeleton.ts";

// 每个测试都从一个合法的单日骨架出发，避免无关违规干扰断言。
const radar = { physical: 50, childFit: 50, weatherSensitivity: 50, timeCost: 50, crowding: 50 };

function skeletonWith(node: Partial<PlannerSkeletonNode> = {}): PlannerSkeleton {
  return {
    title: "黄山一日",
    summary: "游览黄山风景区",
    days: [
      {
        day: 1,
        theme: "核心游览",
        nodes: [
          {
            type: "attraction",
            startTime: "09:00",
            endTime: "12:00",
            name: "黄山风景区",
            stayMinutes: 120,
            estimatedCost: 100,
            ...node,
          },
        ],
        radar,
      },
    ],
  };
}

function balancedBrief(overrides: Partial<PlanValidationInput["brief"]> = {}): PlanValidationInput["brief"] {
  return {
    days: 1,
    startTime: "08:00",
    endTime: "18:00",
    totalBudget: 8000,
    pace: "balanced",
    transport: null,
    waypoints: [],
    destination: "黄山",
    ...overrides,
  };
}

function skeletonWithNodes(nodes: PlannerSkeletonNode[]): PlannerSkeleton {
  return {
    title: "黄山一日",
    summary: "游览黄山风景区",
    days: [{ day: 1, theme: "核心游览", nodes, radar }],
  };
}

test("时间窗违规会被指出具体节点", () => {
  const violations = validateSkeleton({
    skeleton: skeletonWith({ endTime: "22:00" }),
    brief: balancedBrief({ endTime: "18:00" }),
    candidates: ["黄山风景区"],
  });
  assert.equal(violations[0]?.code, "TIME_WINDOW");
  assert.equal(violations[0]?.nodeIndex, 0);
});

test("预算超支按差额给出 detail", () => {
  const violations = validateSkeleton({
    skeleton: skeletonWith({ estimatedCost: 9000 }),
    brief: balancedBrief({ totalBudget: 8000 }),
    candidates: ["黄山风景区"],
  });
  const budget = violations.find((item) => item.code === "OVER_BUDGET");
  assert.ok(budget);
  assert.match(budget.detail.actual, /9000/);
});

test("候选资料外的景点被判为未知地点", () => {
  const violations = validateSkeleton({
    skeleton: skeletonWith({ name: "凭空古城" }),
    brief: balancedBrief({}),
    candidates: ["黄山风景区"],
  });
  assert.ok(violations.some((item) => item.code === "UNKNOWN_PLACE"));
});

test("缺少住宿与用餐会各报一条槽位违规", () => {
  const skeleton = skeletonWithNodes([
    {
      type: "attraction",
      startTime: "09:00",
      endTime: "12:00",
      name: "黄山风景区",
      stayMinutes: 120,
      estimatedCost: 100,
    },
    {
      type: "rest",
      startTime: "12:00",
      endTime: "13:00",
      name: "午休",
      estimatedCost: 0,
    },
  ]);
  const violations = validateSkeleton({
    skeleton,
    brief: balancedBrief({}),
    candidates: ["黄山风景区"],
  });
  assert.deepEqual(
    violations.filter((item) => item.code === "MISSING_SLOT").map((item) => item.day),
    [1, 1],
  );
});

test("天数不一致会报 DAY_COVERAGE", () => {
  const violations = validateSkeleton({
    skeleton: skeletonWith({}),
    brief: balancedBrief({ days: 2 }),
    candidates: ["黄山风景区"],
  });
  const coverage = violations.find((item) => item.code === "DAY_COVERAGE");
  assert.ok(coverage);
  assert.match(coverage.detail.expected, /2/);
});

test("全天没有可执行节点会报 DAY_COVERAGE", () => {
  const skeleton = skeletonWithNodes([
    { type: "rest", startTime: "12:00", endTime: "13:00", name: "午休", estimatedCost: 0 },
  ]);
  const violations = validateSkeleton({
    skeleton,
    brief: balancedBrief({}),
    candidates: ["黄山风景区"],
  });
  assert.ok(violations.some((item) => item.code === "DAY_COVERAGE" && item.day === 1));
});

test("当天容量超限会报 OVER_CAPACITY", () => {
  const violations = validateSkeleton({
    skeleton: skeletonWith({ stayMinutes: 600 }),
    brief: balancedBrief({}),
    candidates: ["黄山风景区"],
  });
  assert.ok(violations.some((item) => item.code === "OVER_CAPACITY" && item.day === 1));
});

test("当天景点数量超过节奏限制会报 PACE_EXCEEDED", () => {
  const nodes = [0, 1, 2, 3].map((index) => ({
    type: "attraction" as const,
    startTime: `${9 + index}:00`,
    endTime: `${10 + index}:00`,
    name: "黄山风景区",
    stayMinutes: 60,
    estimatedCost: 100,
  }));
  const violations = validateSkeleton({
    skeleton: skeletonWithNodes(nodes),
    brief: balancedBrief({}),
    candidates: ["黄山风景区"],
  });
  assert.ok(violations.some((item) => item.code === "PACE_EXCEEDED" && item.day === 1));
});

test("交通方式与设定不一致会报 TRANSPORT_CONFLICT", () => {
  const violations = validateSkeleton({
    skeleton: skeletonWith({ transportMode: "drive" }),
    brief: balancedBrief({ transport: "train" }),
    candidates: ["黄山风景区"],
  });
  assert.ok(violations.some((item) => item.code === "TRANSPORT_CONFLICT"));
});

test("非法时钟时间 24:00 / 12:60 / 99:99 会被判定为时间窗违规", () => {
  for (const badTime of ["24:00", "12:60", "99:99"]) {
    const violations = validateSkeleton({
      skeleton: skeletonWith({ startTime: badTime }),
      brief: balancedBrief({}),
      candidates: ["黄山风景区"],
    });
    assert.ok(
      violations.some((item) => item.code === "TIME_WINDOW"),
      `${badTime} 应触发 TIME_WINDOW`,
    );
  }
});
