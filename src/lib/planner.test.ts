import test from "node:test";
import assert from "node:assert/strict";
import { classifyWeather, splitPlacesAcrossDays } from "./planner.ts";

test("weather codes map to actionable itinerary conditions", () => {
  assert.equal(classifyWeather(0).tone, "clear");
  assert.equal(classifyWeather(3).tone, "cloudy");
  assert.equal(classifyWeather(61).tone, "rain");
  assert.equal(classifyWeather(95).tone, "storm");
});

test("rainy days lead with indoor places", () => {
  const days = splitPlacesAcrossDays(
    [
      { id: "trail", name: "山间步道", indoor: false, duration: 180, area: "北海", summary: "观景步道", source: "https://example.com/trail" },
      { id: "museum", name: "徽州文化馆", indoor: true, duration: 90, area: "屯溪", summary: "室内展馆", source: "https://example.com/museum" },
      { id: "old-town", name: "老街", indoor: false, duration: 120, area: "屯溪", summary: "历史街区", source: "https://example.com/old-town" },
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
