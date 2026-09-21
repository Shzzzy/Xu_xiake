import assert from "node:assert/strict";
import test from "node:test";
import type { TripPlan } from "./travel-plan.ts";
import {
  clearNarrativeCache,
  enrichTripPlanNarrative,
  prepareGuidebookDayNarrative,
  prepareGuidebookNarrativePlan,
  validateDayNarrative,
} from "./guidebook-narrative.server.ts";

const plan: TripPlan = {
  meta: {
    title: "徽州两日路书",
    origin: "上海",
    waypoints: [],
    destination: "黄山",
    startDate: "2026-09-20",
    days: 2,
    travelers: { adults: 2, children: 0 },
    perPersonBudget: 4000,
    transportPreference: "balanced",
    pace: "balanced",
    interests: ["自然山水"],
  },
  budget: {
    totalBudget: 8000,
    estimatedTotal: 3000,
    totalMin: 2800,
    totalMax: 3200,
    remaining: 4800,
    overBudget: 0,
    perPersonBudget: 4000,
    perPersonEstimated: 1500,
    rooms: 1,
    transport: { min: 800, max: 900, amount: 850, ratio: 0.28 },
    lodging: { min: 800, max: 900, amount: 850, ratio: 0.28 },
    food: { min: 400, max: 500, amount: 450, ratio: 0.15 },
    tickets: { min: 500, max: 600, amount: 550, ratio: 0.18 },
    other: { min: 200, max: 300, amount: 250, ratio: 0.08 },
  },
  route: {
    outbound: [
      [118.4, 29.7],
      [118.3, 30.1],
    ],
    returnPath: [],
    outboundSegments: [
      {
        from: "上海",
        to: "黄山",
        mode: "balanced",
        distanceKm: 400,
        durationMinutes: 240,
        navigation: "https://www.amap.com/",
      },
    ],
    returnSegments: [],
    distanceKm: 400,
    durationMinutes: 240,
    returnMode: null,
  },
  days: [0, 1].map((offset) => ({
    date: offset === 0 ? "2026-09-20" : "2026-09-21",
    theme: offset === 0 ? "黄山风景区" : "宏村",
    weather: offset === 0 ? "晴 18–26°" : "多云 19–27°",
    nodes: [
      {
        startTime: "09:00",
        endTime: "12:00",
        timeLabel: "09:00–12:00",
        type: "attraction" as const,
        name: offset === 0 ? "黄山风景区" : "宏村",
        location: offset === 0 ? "黄山风景区" : "宏村",
        estimatedCost: 320,
        navigation: null,
      },
    ],
    estimatedCost: 320,
    radar: { physical: 60, childFit: 40, weatherSensitivity: 70, timeCost: 55, crowding: 65 },
    purpose: "本地排程兜底文案",
    highlights: ["本地亮点"],
    cautions: ["本地注意事项"],
  })),
  closing: { quote: null, source: null, message: "山河万里。" },
};

function summaryFetch(content: unknown, calls: unknown[] = []) {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.body ?? null);
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
  }) as typeof fetch;
}

test("rewrites each day's travel analysis from the final schedule", async () => {
  clearNarrativeCache();
  const calls: unknown[] = [];
  const enriched = await enrichTripPlanNarrative(plan, {
    apiKey: "test-key",
    fetchImpl: summaryFetch(
      {
        purpose: "上午先登主峰，下午转古村，避开午后阵雨。",
        highlights: ["黄山风景区：迎客松与光明顶是当日主线"],
        cautions: ["山上风大，注意保暖", "雨后石阶湿滑"],
      },
      calls,
    ),
  });

  assert.equal(calls.length, plan.days.length);
  assert.equal(enriched.days[0]?.purpose, "上午先登主峰，下午转古村，避开午后阵雨。");
  assert.deepEqual(enriched.days[0]?.highlights, ["黄山风景区：迎客松与光明顶是当日主线"]);
  assert.deepEqual(enriched.days[0]?.cautions, ["山上风大，注意保暖", "雨后石阶湿滑"]);
  // 时间轴与费用必须原样保留，AI 只能改文字。
  assert.deepEqual(enriched.days[0]?.nodes, plan.days[0]?.nodes);
  assert.equal(enriched.days[0]?.date, plan.days[0]?.date);
  assert.equal(enriched.days[0]?.estimatedCost, plan.days[0]?.estimatedCost);
});

test("reuses the cached analysis for an unchanged day", async () => {
  clearNarrativeCache();
  const calls: unknown[] = [];
  const deps = {
    apiKey: "test-key",
    fetchImpl: summaryFetch(
      { purpose: "AI 目的", highlights: ["AI 重点"], cautions: ["AI 注意"] },
      calls,
    ),
  };

  await enrichTripPlanNarrative(plan, deps);
  const firstRound = calls.length;
  await enrichTripPlanNarrative(plan, deps);
  assert.equal(calls.length, firstRound);
});

test("keeps the local text when DeepSeek is unavailable", async () => {
  clearNarrativeCache();
  const failing = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const enriched = await enrichTripPlanNarrative(plan, { apiKey: "test-key", fetchImpl: failing });
  assert.equal(enriched.days[0]?.purpose, "本地排程兜底文案");
  assert.deepEqual(enriched.days[1]?.highlights, ["本地亮点"]);
});

test("butler plan skips legacy enrichment and preserves day copy", async () => {
  clearNarrativeCache();
  const calls: unknown[] = [];
  const butlerPlan: TripPlan = {
    ...plan,
    meta: { ...plan.meta, narrativeSource: "butler" },
    days: plan.days.map((day, index) => ({
      ...day,
      purpose: `管家第 ${index + 1} 天目的`,
      highlights: [`管家第 ${index + 1} 天重点`],
      cautions:
        index === 0
          ? ["本页分析未能生成，已改用基础行程与本地提示。", "管家注意保暖"]
          : ["管家次日注意"],
      analysisFailed: index === 0 ? true : undefined,
    })),
  };

  const enriched = await enrichTripPlanNarrative(butlerPlan, {
    apiKey: "test-key",
    fetchImpl: summaryFetch(
      { purpose: "不应覆盖", highlights: ["不应覆盖"], cautions: ["不应覆盖"] },
      calls,
    ),
  });

  // 管家文案是权威源：不得再发起 legacy 每日总结调用，也不得覆盖任何字段。
  assert.equal(calls.length, 0);
  assert.equal(enriched.days[0]?.purpose, "管家第 1 天目的");
  assert.deepEqual(enriched.days[0]?.highlights, ["管家第 1 天重点"]);
  assert.equal(enriched.days[0]?.analysisFailed, true);
  assert.match(enriched.days[0]?.cautions[0] ?? "", /本页分析未能生成/);
  assert.equal(enriched.days[1]?.purpose, "管家第 2 天目的");
});

test("自由文本提到已知但非当天安排的景点时拒绝", () => {
  const day = plan.days[0];
  assert.ok(day);
  const illegal = {
    ...day,
    purpose: "顺路去故宫看看",
    highlights: ["午餐后继续去故宫"],
    cautions: ["天气变化注意保暖"],
  };

  assert.throws(
    () => validateDayNarrative(illegal, 0, { knownAttractions: ["故宫"] }),
    /未安排/,
  );
});

test("当天景点与通用词不会被自由文本规则误杀", () => {
  const day = plan.days[0];
  assert.ok(day);
  const allowed = {
    ...day,
    purpose: "上午游览黄山风景区，午餐后休息，关注天气与 ETH 行程标记。",
    highlights: ["黄山风景区：按当天排程游览", "午餐：在山脚用餐", "天气：关注阵雨"],
    cautions: ["休息：午后保留机动时间", "ETH 是内部测试标记，不是景点"],
  };

  assert.doesNotThrow(() =>
    validateDayNarrative(allowed, 0, { knownAttractions: ["黄山风景区", "故宫"] }),
  );
});

test("真实单日准备入口读取计划候选并降级自由文本提到的未安排景点", async () => {
  const source = plan.days[0];
  assert.ok(source);
  const planWithCandidates: TripPlan = {
    ...plan,
    meta: {
      ...plan.meta,
      narrativeSource: "butler",
      allowedAttractions: ["黄山风景区", "故宫"],
    },
    days: [
      {
        ...source,
        purpose: "顺路去故宫看看",
        highlights: ["午餐后继续行程"],
        cautions: ["天气变化注意保暖"],
      },
    ],
  };

  const prepared = await prepareGuidebookDayNarrative(planWithCandidates, 0);
  const preparedPlan = await prepareGuidebookNarrativePlan(planWithCandidates);

  assert.match(prepared.purpose, /第 1 天：/);
  assert.equal(prepared.analysisFailed, true);
  assert.doesNotMatch(JSON.stringify(prepared), /故宫/);
  assert.match(preparedPlan.days[0]?.purpose ?? "", /第 1 天：/);
  assert.doesNotMatch(JSON.stringify(preparedPlan.days[0]), /故宫/);
});

test("真实单日准备入口保留当天景点和通用词", async () => {
  const source = plan.days[0];
  assert.ok(source);
  const planWithCandidates: TripPlan = {
    ...plan,
    meta: {
      ...plan.meta,
      narrativeSource: "butler",
      allowedAttractions: ["黄山风景区", "宏村", "故宫"],
    },
    days: [
      {
        ...source,
        purpose: "上午游览黄山风景区，午餐后休息，关注天气。",
        highlights: ["黄山风景区：按当天排程游览", "午餐：在山脚用餐", "天气：关注阵雨"],
        cautions: ["休息：午后保留机动时间"],
      },
    ],
  };

  const prepared = await prepareGuidebookDayNarrative(planWithCandidates, 0);
  assert.equal(prepared.analysisFailed, undefined);
  assert.match(prepared.purpose, /黄山风景区/);
  assert.match(JSON.stringify(prepared), /午餐/);
});

test("history 未安排景点和危险文本触发 fallback 且不泄漏", async () => {
  const source = plan.days[0];
  assert.ok(source);
  const planWithHistory: TripPlan = {
    ...plan,
    meta: {
      ...plan.meta,
      narrativeSource: "butler",
      allowedAttractions: ["黄山风景区", "故宫"],
    },
    days: [
      {
        ...source,
        purpose: "上午游览黄山风景区。",
        highlights: ["黄山风景区：按当天排程游览"],
        cautions: ["天气变化注意保暖"],
        history: [
          {
            title: "故宫午后",
            background: "顺路去故宫看看<script>alert(1)</script>",
            source: "javascript:alert(1)",
          },
        ],
      },
    ],
  };

  const prepared = await prepareGuidebookDayNarrative(planWithHistory, 0);
  assert.equal(prepared.analysisFailed, true);
  assert.equal(prepared.history?.length ?? 0, 0);
  assert.doesNotMatch(JSON.stringify(prepared), /故宫|script|javascript:/);
});

test("prepareGuidebookDayNarrative 把 AbortSignal 传到 DeepSeek 并取消请求", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal;
    return Response.json({
      purpose: "AI 目的",
      highlights: ["AI 重点"],
      cautions: ["AI 注意"],
    });
  }) as typeof fetch;

  await prepareGuidebookDayNarrative(plan, 0, {
    deps: { apiKey: "test-key", fetchImpl },
    signal: controller.signal,
  });
  controller.abort();

  assert.equal(requestSignal?.aborted, true);
});

test("history.source 的显示文本也参与未安排景点校验", async () => {
  const source = plan.days[0];
  assert.ok(source);
  const planWithSource: TripPlan = {
    ...plan,
    meta: {
      ...plan.meta,
      narrativeSource: "butler",
      allowedAttractions: ["黄山风景区", "故宫"],
    },
    days: [
      {
        ...source,
        purpose: "上午游览黄山风景区。",
        highlights: ["黄山风景区：按当天排程游览"],
        cautions: ["天气变化注意保暖"],
        history: [
          {
            title: "地方志",
            background: "记录古村历史。",
            source: "https://example.com/故宫",
          },
        ],
      },
    ],
  };

  const prepared = await prepareGuidebookDayNarrative(planWithSource, 0);
  assert.equal(prepared.analysisFailed, true);
  assert.equal(prepared.history?.length ?? 0, 0);
});
