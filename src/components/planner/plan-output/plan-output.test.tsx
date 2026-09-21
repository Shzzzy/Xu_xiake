import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  BudgetCategory,
  TimelineNodeType,
  TripBrief,
  TripPlan,
} from "../../../lib/travel-plan";
import { buildPlannedDaysFromSkeleton } from "../../../lib/plan-output-adapter";
import {
  GUIDEBOOK_PREVIEW_FRAME_CLASS,
  GUIDEBOOK_PREVIEW_SCROLLING,
  GUIDEBOOK_PREVIEW_SHELL_CLASS,
  shouldAcceptPage,
  shouldHandleStreamEvent,
  assertGuidebookPageChecksum,
} from "./GuidebookPreview";
import { TravelerBudgetFields } from "./TravelerBudgetFields";
import { verifyGuidebookPageChecksum } from "@/lib/guidebook-page-protocol";
import { requestAndApplyBudget } from "./budget-advice-apply";
import { TripOverview } from "./TripOverview";
import { GuidebookStage } from "./GuidebookStage";

function category(amount: number, ratio: number): BudgetCategory {
  return { min: amount, max: amount, amount, ratio };
}

const fixturePlan: TripPlan = {
  meta: {
    title: "杭州两日执行计划",
    origin: "上海",
    waypoints: [],
    destination: "杭州",
    startDate: "2026-09-20",
    days: 2,
    travelers: { adults: 2, children: 1 },
    perPersonBudget: 3000,
    transportPreference: "balanced",
    pace: "balanced",
    interests: ["自然山水", "美食街区"],
  },
  budget: {
    totalBudget: 9000,
    estimatedTotal: 6480,
    totalMin: 5800,
    totalMax: 7200,
    remaining: 1800,
    overBudget: 0,
    perPersonBudget: 3000,
    perPersonEstimated: 2160,
    rooms: 1,
    transport: category(1500, 0.23),
    lodging: category(1800, 0.28),
    food: category(1300, 0.2),
    tickets: category(1200, 0.19),
    other: category(680, 0.1),
  },
  route: {
    outbound: [],
    returnPath: [],
    outboundSegments: [],
    returnSegments: [],
    distanceKm: 0,
    durationMinutes: 0,
    returnMode: null,
  },
  days: [
    {
      date: "2026-09-20",
      theme: "西湖核心环线",
      weather: "多云",
      nodes: [
        {
          startTime: "08:30",
          endTime: "09:20",
          timeLabel: "08:30–09:20",
          type: "transport",
          name: "前往西湖",
          estimatedCost: 60,
          navigation: "https://uri.amap.com/marker?position=120.15,30.27",
        },
        {
          startTime: "09:20",
          endTime: "09:35",
          timeLabel: "09:20–09:35",
          type: "transfer",
          name: "龙翔桥换乘",
          estimatedCost: 6,
          navigation: null,
        },
        {
          startTime: "09:35",
          endTime: "12:00",
          timeLabel: "09:35–12:00",
          type: "attraction",
          name: "断桥与白堤",
          location: "西湖风景名胜区",
          stayMinutes: 145,
          estimatedCost: 0,
          navigation: null,
        },
        {
          startTime: "12:00",
          endTime: "13:00",
          timeLabel: "12:00–13:00",
          type: "meal",
          name: "午餐",
          estimatedCost: 180,
          navigation: null,
        },
        {
          startTime: "13:00",
          endTime: "14:30",
          timeLabel: "13:00–14:30",
          type: "rest",
          name: "湖边休整",
          estimatedCost: 0,
          navigation: null,
        },
        {
          startTime: "18:00",
          endTime: "18:30",
          timeLabel: "18:00–18:30",
          type: "hotel",
          name: "湖滨酒店入住",
          estimatedCost: 680,
          navigation: null,
        },
        {
          startTime: "19:00",
          endTime: "20:30",
          timeLabel: "19:00–20:30",
          type: "night-activity",
          name: "西湖夜游",
          estimatedCost: 120,
          navigation: null,
        },
      ],
      estimatedCost: 1046,
      radar: { physical: 48, childFit: 70, weatherSensitivity: 45, timeCost: 50, crowding: 62 },
      purpose: "用一天完成西湖核心环线。",
      highlights: ["断桥与白堤：湖景精华段"],
      cautions: ["周末人流较多"],
    },
    {
      date: "2026-09-21",
      theme: "灵隐与龙井茶山",
      nodes: [],
      estimatedCost: 760,
      radar: { physical: 58, childFit: 62, weatherSensitivity: 50, timeCost: 45, crowding: 55 },
      purpose: "放慢节奏，转入山林。",
      highlights: ["灵隐寺：清晨更安静"],
      cautions: ["山路注意防滑"],
    },
  ],
  closing: {
    quote: null,
    source: null,
    message: "愿你在山水之间，慢下来再出发。",
  },
};

test("renders day navigation, timeline and budget", () => {
  const html = renderToStaticMarkup(<TripOverview plan={fixturePlan} />);

  assert.match(html, /DAY 01/);
  // 天序号取自行程顺序、日期按“月日”渲染：日期是 2026-09-20，不能出现 “2026月” 或 “DAY 20”。
  assert.match(html, /9月20日/);
  assert.match(html, /DAY 01 · 2026年9月20日/);
  assert.doesNotMatch(html, /2026月/);
  assert.doesNotMatch(html, /DAY 20/);
  assert.match(html, /西湖核心环线/);
  assert.match(html, /全团总预算/);
  assert.match(html, /日期导航/);
  assert.match(html, /预算构成饼图/);
  assert.match(html, /其他 · 杂事开销/);
  assert.match(html, /中途打车/);
});

test("renders every formal execution node type", () => {
  const html = renderToStaticMarkup(<TripOverview plan={fixturePlan} />);
  const labels: Record<TimelineNodeType, string> = {
    transport: "交通",
    transfer: "换乘",
    attraction: "景点",
    meal: "用餐",
    rest: "休息",
    hotel: "酒店",
    "night-activity": "夜游",
  };

  for (const label of Object.values(labels)) {
    assert.match(html, new RegExp(label));
  }
});

test("全团总预算旁提供 AI 推荐按钮", () => {
  const briefFixture: TripBrief = {
    adults: 2,
    children: 0,
    totalBudget: 8000,
    startTime: "09:00",
    endTime: "18:00",
    vehicleEnergy: null,
  };

  const html = renderToStaticMarkup(
    <TravelerBudgetFields
      value={briefFixture}
      onChange={() => {}}
      budgetAdvice={{ pending: false, onRequest: () => {} }}
    />,
  );
  assert.match(html, /AI 推荐/);
  assert.match(html, /budget-advice-panel/);
  assert.match(html, /budget-advice-action/);
  assert.match(html, /aria-describedby="budget-advice-hint"/);
});

const budgetAdvicePayload = {
  origin: "上海",
  destination: "杭州",
  region: "浙江",
  days: 2,
  travelers: { adults: 2, children: 0 },
  transportPreference: "均衡推荐",
  roundTrip: true,
  returnMode: "fast" as const,
  routeLegs: [
    {
      from: "上海",
      to: "杭州",
      transport: "balanced",
      kind: "outbound" as const,
      style: "direct" as const,
    },
    {
      from: "杭州",
      to: "上海",
      transport: "balanced",
      kind: "return" as const,
      style: "direct" as const,
    },
  ],
  pace: "balanced",
  interests: ["自然山水"],
};

test("AI 建议预算基于最新 brief 回写且不覆盖请求期间的编辑", async () => {
  let latest: TripBrief = {
    adults: 2,
    children: 0,
    totalBudget: 8000,
    startTime: "09:00",
    endTime: "18:00",
    vehicleEnergy: null,
  };
  let applyArgIsFunction = false;

  const outcome = await requestAndApplyBudget({
    payload: budgetAdvicePayload,
    request: async () => {
      // 请求返回前用户把成人数改成了 3，回写不能覆盖这次编辑。
      latest = { ...latest, adults: 3 };
      return { status: "ok" as const, advice: { total: 12000 } };
    },
    apply: (updater: (prev: TripBrief) => TripBrief) => {
      applyArgIsFunction = typeof updater === "function";
      latest = updater(latest);
    },
  });

  assert.equal(outcome.status, "applied");
  assert.equal(applyArgIsFunction, true);
  assert.equal(latest.adults, 3);
  assert.equal(latest.children, 0);
  assert.equal(latest.totalBudget, 12000);
  assert.equal(latest.startTime, "09:00");
});

test("needs_configuration 返回友好提示，failed 保留原始信息", async () => {
  const unavailable = await requestAndApplyBudget({
    payload: budgetAdvicePayload,
    request: async () => ({
      status: "needs_configuration" as const,
      message: "缺少 DEEPSEEK_API_KEY",
    }),
    apply: () => {
      throw new Error("未配置时不应回写预算");
    },
  });
  assert.deepEqual(unavailable, { status: "unavailable" });

  const failed = await requestAndApplyBudget({
    payload: budgetAdvicePayload,
    request: async () => ({ status: "failed" as const, message: "DeepSeek 预算建议请求超时" }),
    apply: () => {
      throw new Error("失败时不应回写预算");
    },
  });
  assert.deepEqual(failed, { status: "failed", message: "DeepSeek 预算建议请求超时" });
});

test("butler 骨架映射为与骨架同源的每日行程，只保留景点节点", () => {
  const plannedDays = buildPlannedDaysFromSkeleton(
    {
      title: "黄山两日",
      summary: "山岳与古村",
      days: [
        {
          day: 1,
          theme: "西湖晨光",
          nodes: [
            {
              type: "transport",
              startTime: "08:30",
              endTime: "11:00",
              name: "上海前往杭州",
              estimatedCost: 260,
            },
            {
              type: "attraction",
              startTime: "12:10",
              endTime: "15:00",
              name: "西湖白堤",
              location: "杭州西湖",
              stayMinutes: 170,
              estimatedCost: 0,
              tips: "沿湖慢行",
            },
            {
              type: "night-activity",
              startTime: "20:10",
              endTime: "21:00",
              name: "西湖夜游",
              estimatedCost: 120,
            },
            {
              type: "rest",
              startTime: "21:10",
              endTime: "22:00",
              name: "回酒店休息",
              estimatedCost: 0,
            },
          ],
          radar: { physical: 48, childFit: 70, weatherSensitivity: 45, timeCost: 50, crowding: 62 },
        },
      ],
    },
    [{ date: "2026-09-20", code: 1, tempMax: 27, tempMin: 19 }],
    [{ title: "西湖白堤", url: "https://example.test/xihu", content: "白堤简介" }],
  );

  assert.equal(plannedDays.length, 1);
  assert.equal(plannedDays[0].day, 1);
  assert.equal(plannedDays[0].note, "西湖晨光");
  assert.deepEqual(
    plannedDays[0].places.map((place) => place.name),
    ["西湖白堤", "西湖夜游"],
  );
  assert.equal(plannedDays[0].places[0].source, "https://example.test/xihu");
  assert.equal(plannedDays[0].places[0].duration, 170);
  assert.equal(plannedDays[0].weather?.code, 1);
});

test("客户端页面判定拒绝旧 run、乱序 index 和重复 checksum", () => {
  const state = { runId: "current", nextIndex: 0, seen: new Set<string>() };
  assert.equal(
    shouldAcceptPage({ runId: "old", index: 0, checksum: "a", latestRunId: "current", state }),
    false,
  );
  assert.equal(
    shouldAcceptPage({ runId: "current", index: 1, checksum: "b", latestRunId: "current", state }),
    false,
  );
  assert.equal(
    shouldAcceptPage({ runId: "current", index: 0, checksum: "a", latestRunId: "current", state }),
    true,
  );
  assert.equal(
    shouldAcceptPage({ runId: "current", index: 0, checksum: "a", latestRunId: "current", state }),
    false,
  );
  assert.equal(
    shouldAcceptPage({ runId: "current", index: 1, checksum: "b", latestRunId: "current", state }),
    true,
  );
});

test("路书预览使用固定高度外滚动壳且 iframe 不出现第二条滚动条", () => {
  assert.match(GUIDEBOOK_PREVIEW_SHELL_CLASS, /overflow-y-auto/);
  assert.match(GUIDEBOOK_PREVIEW_FRAME_CLASS, /overflow-hidden/);
  assert.equal(GUIDEBOOK_PREVIEW_SCROLLING, "no");
});

test("旧 run 的 meta/error 以及取消后的所有事件都不会处理", () => {
  assert.equal(
    shouldHandleStreamEvent({ eventRunId: "old", latestRunId: "current", cancelled: false }),
    false,
  );
  assert.equal(
    shouldHandleStreamEvent({ eventRunId: "current", latestRunId: "current", cancelled: false }),
    true,
  );
  assert.equal(
    shouldHandleStreamEvent({ eventRunId: "current", latestRunId: "current", cancelled: true }),
    false,
  );
});

test("页面 checksum 必须匹配实际 HTML 的 SHA-256", async () => {
  const html = "<article>完整页面内容</article>";
  const checksum = createHash("sha256").update(html).digest("hex");

  assert.equal(await verifyGuidebookPageChecksum(html, checksum), true);
  assert.equal(await verifyGuidebookPageChecksum(html, "wrong-checksum"), false);
});

test("checksum 校验门槛失败会抛出错误供组件停止处理", async () => {
  await assert.rejects(
    () => assertGuidebookPageChecksum("<article>页面</article>", "wrong-checksum"),
    /checksum|校验失败/,
  );
});

test("fallback 不挂载路书预览，仅显示错误提示", () => {
  const html = renderToStaticMarkup(
    <GuidebookStage state="fallback" message="selection 阶段候选越界">
      <div>逐页生成你的路书 生成路书 PDF</div>
    </GuidebookStage>,
  );

  assert.doesNotMatch(html, /逐页生成你的路书/);
  assert.doesNotMatch(html, /生成路书 PDF/);
  assert.match(html, /selection 阶段候选越界/);
});

test("ready 状态才挂载路书预览", () => {
  const html = renderToStaticMarkup(
    <GuidebookStage state="ready" message="">
      <div>逐页生成你的路书</div>
    </GuidebookStage>,
  );

  assert.match(html, /逐页生成你的路书/);
});
