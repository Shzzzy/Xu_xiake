import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  evaluateTripFeasibility,
  type TripFeasibilityPlanningInput,
} from "../../../lib/trip-feasibility.ts";
import { TripFeasibilityCards } from "./TripFeasibilityCards.tsx";

function decisionFixture() {
  const input: TripFeasibilityPlanningInput = {
    origin: "北京",
    destination: { id: "dali", name: "大理洱海", region: "云南 · 大理" },
    days: 5,
    dailyHours: 6,
    startTime: "08:00",
    endTime: "18:00",
    route: {
      origin: "北京",
      destination: "大理洱海",
      waypoints: ["上海"],
      roundTrip: true,
      returnMode: "fast",
      legs: [
        {
          id: "a",
          from: "北京",
          to: "上海",
          transport: "flight",
          style: "direct",
          kind: "outbound",
        },
        {
          id: "b",
          from: "上海",
          to: "大理洱海",
          transport: "drive",
          style: "wander",
          kind: "outbound",
        },
        {
          id: "return",
          from: "大理洱海",
          to: "北京",
          transport: "flight",
          style: "direct",
          kind: "return",
        },
      ],
    },
    transportLegs: [
      {
        id: "a",
        kind: "outbound",
        from: "北京",
        to: "上海",
        distanceKm: 1067,
        mode: "flight",
        doorToDoorMinutes: 300,
        minimumPerPersonCost: 588,
      },
      {
        id: "b",
        kind: "outbound",
        from: "上海",
        to: "大理洱海",
        distanceKm: 2651,
        mode: "drive",
        doorToDoorMinutes: 1906,
        minimumPerPersonCost: 1061,
      },
      {
        id: "return",
        kind: "return",
        from: "大理洱海",
        to: "北京",
        distanceKm: 2182,
        mode: "flight",
        doorToDoorMinutes: 360,
        minimumPerPersonCost: 1201,
      },
    ],
  };
  const decision = evaluateTripFeasibility(input);
  assert.ok(decision);
  return decision;
}

test("三方案卡片显示直达、延长自驾和专注一地选择", () => {
  const html = renderToStaticMarkup(
    <TripFeasibilityCards
      decision={decisionFixture()}
      onSelect={() => undefined}
      onCancel={() => undefined}
    />,
  );

  assert.match(html, /方案 A/);
  assert.match(html, /直达落地/);
  assert.match(html, /方案 B/);
  assert.match(html, /延长自驾/);
  assert.match(html, /方案 C/);
  assert.match(html, /专注一地/);
  assert.match(html, /上海/);
  assert.match(html, /大理洱海/);
  assert.match(html, /取消调整/);
});
