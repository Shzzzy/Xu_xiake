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

test("节点结束时间不晚于开始时间会报 TIME_WINDOW", () => {
  const violations = validateSkeleton({
    skeleton: skeletonWith({ startTime: "14:00", endTime: "09:00" }),
    brief: balancedBrief({}),
    candidates: ["黄山风景区"],
  });
  const time = violations.find((item) => item.code === "TIME_WINDOW" && item.nodeIndex === 0);
  assert.ok(time);
  assert.match(time.detail.expected, /晚于开始时间/);
  assert.match(time.detail.actual, /14:00.*09:00/);
});

test("候选名追加常见后缀或省略后缀都算合法景点", () => {
  const suffixed = validateSkeleton({
    skeleton: skeletonWith({ name: "宏村古村落" }),
    brief: balancedBrief({}),
    candidates: ["宏村"],
  });
  assert.equal(suffixed.some((item) => item.code === "UNKNOWN_PLACE"), false);

  const shortened = validateSkeleton({
    skeleton: skeletonWith({ name: "黄山" }),
    brief: balancedBrief({}),
    candidates: ["黄山风景区"],
  });
  assert.equal(shortened.some((item) => item.code === "UNKNOWN_PLACE"), false);
});

test("候选名加编造后缀仍判为未知地点", () => {
  const violations = validateSkeleton({
    skeleton: skeletonWith({ name: "宏村旁边凭空古城" }),
    brief: balancedBrief({}),
    candidates: ["宏村"],
  });
  const unknown = violations.find((item) => item.code === "UNKNOWN_PLACE");
  assert.ok(unknown);
  assert.equal(unknown.nodeIndex, 0);
});

// 以下用例覆盖终审修复：摘要与排程一致性、骨架 day 编号连续性。
function twoDaySkeleton(
  dayNumbers: [number, number],
  summary = "游览黄山风景区与宏村",
): PlannerSkeleton {
  return {
    title: "黄山两日",
    summary,
    days: dayNumbers.map((day) => ({
      day,
      theme: `第 ${day} 天`,
      nodes: [
        {
          type: "attraction",
          startTime: "09:00",
          endTime: "12:00",
          name: "黄山风景区",
          stayMinutes: 120,
          estimatedCost: 100,
        },
        {
          type: "meal",
          startTime: "12:00",
          endTime: "13:00",
          name: "午餐",
          estimatedCost: 50,
        },
        {
          type: "attraction",
          startTime: "13:00",
          endTime: "16:00",
          name: "宏村",
          stayMinutes: 120,
          estimatedCost: 100,
        },
        {
          type: "hotel",
          startTime: "16:00",
          endTime: "16:30",
          name: "酒店入住",
          estimatedCost: 300,
        },
        {
          type: "rest",
          startTime: "17:00",
          endTime: "17:30",
          name: "回酒店休息",
          estimatedCost: 0,
        },
      ],
      radar,
    })),
  };
}

test("摘要提到未排入行程的候选景点会报 SUMMARY_MISMATCH", () => {
  const violations = validateSkeleton({
    skeleton: twoDaySkeleton([1, 2], "游览黄山风景区、宏村与屯溪老街"),
    brief: balancedBrief({ days: 2 }),
    candidates: ["黄山风景区", "宏村", "屯溪老街"],
  });

  assert.ok(
    violations.some(
      (item) => item.code === "SUMMARY_MISMATCH" && item.message.includes("屯溪老街"),
    ),
    "摘要提到但未排程的景点应被确定性校验发现",
  );
});

test("摘要漏掉已排景点同样会报 SUMMARY_MISMATCH", () => {
  const violations = validateSkeleton({
    skeleton: twoDaySkeleton([1, 2], "游览黄山风景区"),
    brief: balancedBrief({ days: 2 }),
    candidates: ["黄山风景区", "宏村"],
  });

  assert.ok(
    violations.some(
      (item) => item.code === "SUMMARY_MISMATCH" && item.message.includes("宏村"),
    ),
    "摘要缺失已排景点应被确定性校验发现",
  );
});

test("摘要与排程一致时不产生 SUMMARY_MISMATCH", () => {
  const violations = validateSkeleton({
    skeleton: twoDaySkeleton([1, 2]),
    brief: balancedBrief({ days: 2 }),
    candidates: ["黄山风景区", "宏村"],
  });

  assert.equal(violations.some((item) => item.code === "SUMMARY_MISMATCH"), false);
});

test("骨架 day 编号 [1,1] 重复会报 DAY_COVERAGE 连续性违规", () => {
  const violations = validateSkeleton({
    skeleton: twoDaySkeleton([1, 1]),
    brief: balancedBrief({ days: 2 }),
    candidates: ["黄山风景区", "宏村"],
  });

  assert.ok(
    violations.some(
      (item) => item.code === "DAY_COVERAGE" && /编号/.test(item.message),
    ),
    "[1,1] 应被判编号不连续",
  );
});

test("骨架 day 编号 [1,3] 跳号会报 DAY_COVERAGE 连续性违规", () => {
  const violations = validateSkeleton({
    skeleton: twoDaySkeleton([1, 3]),
    brief: balancedBrief({ days: 2 }),
    candidates: ["黄山风景区", "宏村"],
  });

  assert.ok(
    violations.some(
      (item) => item.code === "DAY_COVERAGE" && /编号/.test(item.message),
    ),
    "[1,3] 应被判编号不连续",
  );
});

test("骨架 day 编号 1..N 连续时不报连续性违规", () => {
  const violations = validateSkeleton({
    skeleton: twoDaySkeleton([1, 2]),
    brief: balancedBrief({ days: 2 }),
    candidates: ["黄山风景区", "宏村"],
  });

  assert.equal(
    violations.some((item) => item.code === "DAY_COVERAGE" && /编号/.test(item.message)),
    false,
  );
});