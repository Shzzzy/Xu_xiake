import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BudgetCategory, TimelineNodeType, TripPlan } from "../../../lib/travel-plan";
import { TripOverview } from "./TripOverview";

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
  assert.match(html, /西湖核心环线/);
  assert.match(html, /全团总预算/);
  assert.match(html, /日期导航/);
  assert.match(html, /预算构成饼图/);
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
