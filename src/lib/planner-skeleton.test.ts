import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSkeletonInstruction,
  buildSkeletonRepairInstruction,
  parsePlannerSkeleton,
} from "./planner-skeleton.ts";
import type { PlanViolation } from "./plan-validator.ts";

// 一份合法的骨架样例，供解析与拒绝用例复用。
const validSkeleton = {
  title: "黄山三日舒心行",
  summary: "以黄山云海为核心，穿插屯溪老街与温泉的舒展行程。",
  days: [
    {
      day: 1,
      theme: "抵达黄山与云谷索道",
      nodes: [
        {
          type: "attraction",
          startTime: "09:00",
          endTime: "11:30",
          name: "黄山风景区",
          stayMinutes: 150,
          estimatedCost: 230,
        },
        {
          type: "meal",
          startTime: "12:00",
          endTime: "13:00",
          name: "山脚徽菜午餐",
          estimatedCost: 120,
        },
        {
          type: "hotel",
          startTime: "20:00",
          endTime: "20:30",
          name: "黄山温泉酒店入住",
          estimatedCost: 680,
        },
      ],
      radar: { physical: 60, childFit: 55, weatherSensitivity: 65, timeCost: 50, crowding: 70 },
    },
  ],
};

// 覆盖雷达分值，便于构造越界用例。
function withRadar(overrides: Record<string, number>) {
  return {
    ...validSkeleton,
    days: validSkeleton.days.map((day) => ({ ...day, radar: { ...day.radar, ...overrides } })),
  };
}

// 提示词构建所需的最小输入，仅覆盖断言关心的字段。
const instructionInput = {
  brief: {
    origin: "杭州",
    destination: "黄山",
    startDate: "2026-10-01",
    days: 1,
    startTime: "09:00",
    endTime: "18:00",
    pace: "balanced" as const,
    totalBudget: 8000,
    travelers: { adults: 2, children: 1 },
    interests: ["自然山水"],
    transport: "balanced" as const,
  },
  route: {
    origin: "杭州",
    destination: "黄山",
    waypoints: [],
    roundTrip: false,
    returnMode: null,
    legs: [
      {
        id: "leg-1",
        from: "杭州",
        to: "黄山",
        transport: "balanced" as const,
        style: "direct" as const,
        kind: "outbound" as const,
      },
    ],
  },
  weather: [{ date: "2026-10-01", code: 0, tempMax: 22, tempMin: 14, precipProb: 10 }],
  candidates: [
    {
      name: "黄山风景区",
      summary: "以奇松怪石云海温泉四绝著称。",
      source: "https://example.com/huangshan",
    },
  ],
};

test("骨架解析接受合法结构并保留节点顺序", () => {
  const skeleton = parsePlannerSkeleton(JSON.stringify(validSkeleton));
  assert.equal(skeleton.days[0]?.nodes.length, 3);
  assert.equal(skeleton.days[0]?.nodes[0]?.type, "attraction");
});

test("骨架解析拒绝缺失雷达或越界分值", () => {
  assert.throws(() =>
    parsePlannerSkeleton(
      JSON.stringify({ ...validSkeleton, days: [{ day: 1, theme: "x", nodes: [] }] }),
    ),
  );
  assert.throws(() => parsePlannerSkeleton(JSON.stringify(withRadar({ physical: 120 }))));
});

test("骨架提示词写明候选、时间窗与必含节点约束", () => {
  const instruction = buildSkeletonInstruction(instructionInput);
  assert.match(instruction, /候选/);
  assert.match(instruction, /不得输出 URL/);
  assert.match(instruction, /09:00/);
  assert.match(instruction, /18:00/);
  assert.match(instruction, /用餐/);
  assert.match(instruction, /住宿/);
  assert.match(instruction, /休息/);
  assert.match(instruction, /8000/);
});

// 候选清单只约束景点类节点；餐宿休息等固定槽位由模型自行命名。
test("候选限制只作用于景点类节点", () => {
  const instruction = buildSkeletonInstruction(instructionInput);

  // 正面：把「必须来自 candidates」明确绑定到景点类节点。
  assert.match(instruction, /景点类节点（attraction \/ night-activity）必须来自 candidates\.name/);
  // 其余节点不受候选清单限制，自行给出合理名称。
  assert.match(instruction, /其余节点[\s\S]{0,80}自行给出合理名称/);
  // 反面：不得再出现把名称一律绑定到候选清单的旧措辞。
  assert.doesNotMatch(instruction, /只能来自 candidates/);
  assert.doesNotMatch(instruction, /(用餐|住宿|休息)[^；。]{0,40}来自 candidates/);
});

test("重排指令包含违规清单与两条硬约束", () => {
  const violations: PlanViolation[] = [
    {
      code: "OVER_BUDGET",
      message: "预计 9000 超出预算 8000",
      detail: { expected: "≤8000", actual: "9000" },
    },
  ];
  const instruction = buildSkeletonRepairInstruction(violations);
  assert.match(instruction, /只改/);
  assert.match(instruction, /不得引入/);
  assert.match(instruction, /9000/);
});
