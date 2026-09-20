import test from "node:test";
import assert from "node:assert/strict";
import { buildRouteFallbackDays, classifyWeather, splitPlacesAcrossDays } from "./planner.ts";

test("weather codes map to actionable itinerary conditions", () => {
  assert.equal(classifyWeather(0).tone, "clear");
  assert.equal(classifyWeather(3).tone, "cloudy");
  assert.equal(classifyWeather(61).tone, "rain");
  assert.equal(classifyWeather(95).tone, "storm");
});

test("rainy days lead with indoor places", () => {
  const days = splitPlacesAcrossDays(
    [
      {
        id: "trail",
        name: "山间步道",
        indoor: false,
        duration: 180,
        area: "北海",
        summary: "观景步道",
        source: "https://example.com/trail",
      },
      {
        id: "museum",
        name: "徽州文化馆",
        indoor: true,
        duration: 90,
        area: "屯溪",
        summary: "室内展馆",
        source: "https://example.com/museum",
      },
      {
        id: "old-town",
        name: "老街",
        indoor: false,
        duration: 120,
        area: "屯溪",
        summary: "历史街区",
        source: "https://example.com/old-town",
      },
    ],
    [{ date: "2026-09-20", code: 61, tempMax: 22, tempMin: 17, precipProb: 80 }],
    "balanced",
  );

  assert.deepEqual(
    days[0]?.places.map((place) => place.id),
    ["museum", "trail", "old-town"],
  );
});

test("parses MCP streamable HTTP event messages", async () => {
  const { parseMcpSse } = await import("./mcp-sse.ts");
  const messages = parseMcpSse(
    'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n\n',
  );

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 3, result: { ok: true } });
});

test("fallback itinerary preserves waypoint order and includes the destination", () => {
  const route = {
    origin: "北京",
    destination: "敦煌",
    waypoints: ["洛阳", "西安"],
    roundTrip: false,
    returnMode: "fast" as const,
    legs: [
      {
        id: "outbound:0",
        from: "北京",
        to: "洛阳",
        transport: "balanced" as const,
        style: "direct" as const,
        kind: "outbound" as const,
      },
      {
        id: "outbound:1",
        from: "洛阳",
        to: "西安",
        transport: "balanced" as const,
        style: "direct" as const,
        kind: "outbound" as const,
      },
      {
        id: "outbound:2",
        from: "西安",
        to: "敦煌",
        transport: "balanced" as const,
        style: "direct" as const,
        kind: "outbound" as const,
      },
    ],
  };
  const days = buildRouteFallbackDays({
    route,
    days: 2,
    destinationPlaces: [
      {
        id: "mogao",
        name: "莫高窟",
        area: "敦煌",
        indoor: false,
        duration: 180,
        summary: "目的地核心景点",
        source: "https://maps.google.com",
      },
    ],
    weather: [],
    pace: "balanced",
  });

  assert.deepEqual(
    days.flatMap((day) => day.places.map((place) => place.name)),
    ["洛阳", "西安", "莫高窟"],
  );
});
