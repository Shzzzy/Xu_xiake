import test from "node:test";
import assert from "node:assert/strict";
import { buildRoutePlan, removeWaypointAt } from "./route-planner.ts";

test("waypoints become ordered outbound legs", () => {
  const route = buildRoutePlan({
    origin: "北京",
    destination: "敦煌",
    waypoints: ["大同", "银川"],
    roundTrip: false,
    returnMode: null,
    defaultStyle: "direct",
    legPreferences: {},
  });

  assert.deepEqual(
    route.legs.map((leg) => [leg.from, leg.to]),
    [
      ["北京", "大同"],
      ["大同", "银川"],
      ["银川", "敦煌"],
    ],
  );
});

test("fast return adds a direct destination-to-origin leg", () => {
  const route = buildRoutePlan({
    origin: "北京",
    destination: "敦煌",
    waypoints: ["大同"],
    roundTrip: true,
    returnMode: "fast",
    defaultStyle: "direct",
    legPreferences: {},
  });

  const returnLeg = route.legs.at(-1);
  assert.equal(returnLeg?.from, "敦煌");
  assert.equal(returnLeg?.to, "北京");
  assert.equal(returnLeg?.style, "direct");
  assert.equal(returnLeg?.kind, "return");
});

test("scenic return can travel without retracing the same route", () => {
  const route = buildRoutePlan({
    origin: "北京",
    destination: "敦煌",
    waypoints: ["大同"],
    roundTrip: true,
    returnMode: "scenic",
    defaultStyle: "direct",
    legPreferences: {},
  });

  const returnLeg = route.legs.at(-1);
  assert.equal(returnLeg?.style, "wander");
  assert.equal(returnLeg?.kind, "return");
});

test("per-segment transport and style preferences override defaults", () => {
  const route = buildRoutePlan({
    origin: "北京",
    destination: "敦煌",
    waypoints: ["大同", "银川"],
    roundTrip: false,
    returnMode: null,
    defaultStyle: "direct",
    legPreferences: {
      "outbound:1": { transport: "drive", style: "wander" },
    },
  });

  assert.equal(route.legs[0].transport, "balanced");
  assert.equal(route.legs[1].transport, "drive");
  assert.equal(route.legs[1].style, "wander");
});

test("economy and speed recommendations can override the default balanced recommendation", () => {
  const economyRoute = buildRoutePlan({
    origin: "北京",
    destination: "敦煌",
    waypoints: [],
    roundTrip: false,
    returnMode: null,
    defaultStyle: "direct",
    legPreferences: { "outbound:0": { transport: "economy" } },
  });
  assert.equal(economyRoute.legs[0].transport, "economy");

  const route = buildRoutePlan({
    origin: "北京",
    destination: "敦煌",
    waypoints: [],
    roundTrip: false,
    returnMode: null,
    defaultStyle: "direct",
    legPreferences: {
      "outbound:0": { transport: "speed" },
    },
  });

  assert.equal(route.legs[0].transport, "speed");
});

test("route planning rejects more than five waypoints", () => {
  assert.throws(
    () =>
      buildRoutePlan({
        origin: "北京",
        destination: "敦煌",
        waypoints: ["a", "b", "c", "d", "e", "f"],
        roundTrip: false,
        returnMode: null,
        defaultStyle: "direct",
        legPreferences: {},
      }),
    /5 个/,
  );
});

test("removing a waypoint keeps the remaining route order intact", () => {
  const waypoints = ["大同", "银川", "敦煌"];

  const nextWaypoints = removeWaypointAt(waypoints, 1);

  assert.deepEqual(nextWaypoints, ["大同", "敦煌"]);
  assert.deepEqual(waypoints, ["大同", "银川", "敦煌"]);
});
