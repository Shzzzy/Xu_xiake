import test from "node:test";
import assert from "node:assert/strict";
import { estimateBudget, normalizeRadarScores, validateTripBrief } from "./travel-plan.ts";
import type { Pace } from "./planner.ts";
import type { TransportMode } from "./route-planner.ts";
import type {
  RouteSegment,
  TransportPreference,
  TripMeta,
  TripTimelineNode,
} from "./travel-plan.ts";

test("requires a total budget and at least one adult", () => {
  const errors = validateTripBrief({
    adults: 0,
    children: 1,
    totalBudget: 0,
    startTime: "09:00",
    endTime: "21:00",
    vehicleEnergy: null,
  });
  assert.deepEqual(errors, ["至少需要 1 位成人", "请填写全团总预算"]);
});

test("requires the end time to be later than the start time", () => {
  const errors = validateTripBrief({
    adults: 2,
    children: 0,
    totalBudget: 3000,
    startTime: "18:00",
    endTime: "09:00",
    vehicleEnergy: null,
  });
  assert.deepEqual(errors, ["每日最晚结束时间必须晚于出发时间"]);
});

type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type Expect<Value extends true> = Value;

type _NavigationIsRequiredNullable = Expect<Equal<TripTimelineNode["navigation"], string | null>>;
type _PaceReusesSharedType = Expect<Equal<TripMeta["pace"], Pace>>;
type _TransportPreferenceReusesSharedType = Expect<
  Equal<TripMeta["transportPreference"], TransportPreference>
>;
type _RouteModeReusesSharedType = Expect<Equal<RouteSegment["mode"], TransportMode>>;
type _NodeTransportModeReusesSharedType = Expect<
  Equal<TripTimelineNode["transportMode"], TransportMode | undefined>
>;

test("adds a ten percent other budget with a minimum of 200", () => {
  const budget = estimateBudget({ transport: 1000, lodging: 500, food: 300, tickets: 200 });
  assert.equal(budget.other, 200);
  assert.equal(budget.total, 2200);
});

test("expands clustered radar scores without changing order", () => {
  assert.deepEqual(normalizeRadarScores([52, 55, 58, 61, 64]), [22, 43, 64, 85, 94]);
});

test("builds a complete trip budget from total budget and travelers", () => {
  const budget = estimateBudget({
    totalBudget: 10000,
    travelers: { adults: 2, children: 1 },
    transport: 1000,
    lodging: 500,
    food: 300,
    tickets: 200,
  });

  assert.equal(budget.estimatedTotal, 2200);
  assert.equal(budget.other.amount, 200);
  assert.equal(budget.remaining, 7800);
  assert.equal(budget.overBudget, 0);
  assert.equal(budget.perPersonBudget, 10000 / 3);
  assert.equal(budget.perPersonEstimated, 2200 / 3);
  assert.equal(budget.transport.ratio, 1000 / 2200);
});

test("keeps over-budget amounts explicit", () => {
  const budget = estimateBudget({
    totalBudget: 1000,
    travelers: { adults: 1, children: 0 },
    transport: 900,
    lodging: 200,
    food: 100,
    tickets: 100,
  });

  assert.equal(budget.estimatedTotal, 1500);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.overBudget, 500);
});

test("uses shared semantic types and explicit null navigation fallback", () => {
  const navigation: TripTimelineNode["navigation"] = null;
  const meta: Pick<TripMeta, "pace" | "transportPreference"> = {
    pace: "balanced",
    transportPreference: "speed",
  };
  const routeMode: RouteSegment["mode"] = "drive";
  const nodeMode: TripTimelineNode["transportMode"] = "train";

  assert.equal(navigation, null);
  assert.deepEqual(meta, { pace: "balanced", transportPreference: "speed" });
  assert.equal(routeMode, "drive");
  assert.equal(nodeMode, "train");
});

test("derives rooms from adults and preserves budget ranges", () => {
  const budget = estimateBudget({
    totalBudget: 3000,
    travelers: { adults: 3, children: 2 },
    transport: { min: 1000, max: 1600 },
    lodging: { min: 900, max: 1100 },
    food: { min: 500, max: 700 },
    tickets: { min: 200, max: 300 },
    other: { min: 200, max: 300 },
  });

  assert.equal(budget.rooms, 2);
  assert.equal(budget.transport.min, 1000);
  assert.equal(budget.transport.max, 1600);
  assert.equal(budget.totalMin, 2800);
  assert.equal(budget.totalMax, 4000);
  assert.equal(budget.overBudget, 1000);
  assert.equal(budget.remaining, 0);
});
