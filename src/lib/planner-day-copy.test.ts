import test from "node:test";
import assert from "node:assert/strict";
import { buildDayCopyInstruction, parsePlannerDayCopy } from "./planner-day-copy.ts";

test("文案解析丢弃没有来源的历史条目", () => {
  const copy = parsePlannerDayCopy(
    JSON.stringify({
      day: 1,
      purpose: "建立徽州古村与黄山的初印象。",
      highlights: ["黄山：观察奇松怪石", "宏村：沿水系看徽派村落", "屯溪老街：感受市井烟火"],
      cautions: ["注意保暖", "带好雨具"],
      history: [
        { title: "黄山", background: "背景", source: "《黄山志》" },
        { title: "宏村", background: "背景", source: "" },
        { title: "西递", background: "背景" },
      ],
    }),
  );

  assert.equal(copy.history.length, 1);
  assert.equal(copy.history[0]?.source, "《黄山志》");
});

test("文案解析拒绝少于两条注意事项", () => {
  assert.throws(() =>
    parsePlannerDayCopy(
      JSON.stringify({
        day: 1,
        purpose: "p",
        highlights: ["a：b", "c：d", "e：f"],
        cautions: ["只有一条"],
        history: [],
      }),
    ),
  );
});

test("文案解析拒绝少于三条核心重点", () => {
  assert.throws(() =>
    parsePlannerDayCopy(
      JSON.stringify({
        day: 1,
        purpose: "p",
        highlights: ["a：b", "c：d"],
        cautions: ["注意保暖", "带好雨具"],
        history: [],
      }),
    ),
  );
});

test("文案解析将核心重点和注意事项清理到最多五条", () => {
  const copy = parsePlannerDayCopy(
    JSON.stringify({
      day: 1,
      purpose: "p",
      highlights: Array.from({ length: 6 }, (_, index) => `重点${index + 1}：说明`),
      cautions: Array.from({ length: 6 }, (_, index) => `事项${index + 1}`),
      history: [],
    }),
  );

  assert.deepEqual(copy.highlights, [
    "重点1：说明",
    "重点2：说明",
    "重点3：说明",
    "重点4：说明",
    "重点5：说明",
  ]);
  assert.deepEqual(copy.cautions, ["事项1", "事项2", "事项3", "事项4", "事项5"]);
});

test("文案解析要求非空今日目的", () => {
  assert.throws(() =>
    parsePlannerDayCopy(
      JSON.stringify({
        day: 1,
        purpose: "   ",
        highlights: ["a：b", "c：d", "e：f"],
        cautions: ["注意保暖", "带好雨具"],
        history: [],
      }),
    ),
  );
});

test("每日文案提示词只使用冻结的当日节点并要求来源", () => {
  const instruction = buildDayCopyInstruction({
    day: 2,
    theme: "徽州古村",
    nodes: [
      { name: "宏村", type: "attraction" },
      { name: "徽州午餐", type: "meal" },
    ],
  });

  assert.match(instruction, /第 2 天/);
  assert.match(instruction, /徽州古村/);
  assert.match(instruction, /宏村/);
  assert.match(instruction, /attraction/);
  assert.match(instruction, /今日目的/);
  assert.match(instruction, /核心重点/);
  assert.match(instruction, /注意事项/);
  assert.match(instruction, /历史背景/);
  assert.match(instruction, /仅依据给定节点/);
  assert.match(instruction, /可核验来源/);
  assert.match(instruction, /给不出来源/);
  assert.match(instruction, /不要编造/);
  assert.match(instruction, /只输出严格 JSON/);
});
