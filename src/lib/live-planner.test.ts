import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlannerMessages,
  mapDiscoveredStops,
  parsePlannerJson,
  selectPlannerSources,
} from "./live-planner.ts";
import { normalizeTavilyResults } from "./tavily.server.ts";
import { buildRoutePlan } from "./route-planner.ts";

test("normalizes Tavily results and drops entries without a URL", () => {
  const results = normalizeTavilyResults({
    results: [
      { title: "西湖", url: "https://example.com/west-lake", content: "杭州热门景点", score: 0.9 },
      { title: "无来源", content: "不应保留" },
      { title: "宏村", url: "https://example.com/hongcun", content: "徽州古村" },
    ],
  });

  assert.deepEqual(
    results.map((item) => item.title),
    ["西湖", "宏村"],
  );
  assert.equal(results[0]?.url, "https://example.com/west-lake");
});

test("parses a fenced DeepSeek planner response", () => {
  const plan = parsePlannerJson(`\n\n\`\`\`json\n{
    "title": "江南三日",
    "summary": "避开雨天，先看西湖与园林。",
    "days": [{
      "day": 1,
      "note": "先室内后户外",
      "places": [{
        "id": "west-lake",
        "name": "西湖",
        "area": "杭州",
        "indoor": false,
        "duration": 180,
        "summary": "沿湖慢游",
        "source": "https://example.com/west-lake"
      }]
    }]
  }\n\`\`\``);

  assert.equal(plan.title, "江南三日");
  assert.equal(plan.days[0]?.places[0]?.name, "西湖");
});

test("planner prompt receives route legs and internal time validation rules", () => {
  const route = buildRoutePlan({
    origin: "北京",
    destination: "敦煌",
    waypoints: ["大同"],
    roundTrip: true,
    returnMode: "fast",
    defaultStyle: "direct",
    legPreferences: { "outbound:1": { style: "wander", transport: "drive" } },
  });
  const messages = buildPlannerMessages({
    destinationName: "敦煌",
    region: "甘肃",
    startDate: "2026-10-01",
    days: 8,
    dailyHours: 6,
    pace: "balanced",
    interests: ["自然山水"],
    weather: [],
    searchResults: [],
    route,
  });
  const prompt = messages.map((message) => message.content).join("\n");

  assert.match(prompt, /北京/);
  assert.match(prompt, /大同/);
  assert.match(prompt, /边走边玩/);
  assert.match(prompt, /睡眠/);
  assert.match(prompt, /快速回家/);
});

test("planner prompt requires real waypoint stops and verified regions", () => {
  const messages = buildPlannerMessages({
    destinationName: "黄山",
    region: "安徽",
    startDate: "2026-09-19",
    days: 3,
    dailyHours: 8,
    pace: "balanced",
    interests: [],
    weather: [],
    searchResults: [],
    route: {
      origin: "厦门",
      destination: "黄山",
      waypoints: ["龙岩"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
  });
  const content = JSON.stringify(messages);

  assert.match(content, /途经点都必须作为实际停留与游玩节点/);
  assert.match(content, /使用校核后的地区/);
});

test("planner prompt includes verified discovery context", () => {
  const messages = buildPlannerMessages({
    destinationName: "黄山",
    region: "安徽",
    startDate: "2026-09-19",
    days: 3,
    dailyHours: 8,
    pace: "balanced",
    interests: [],
    weather: [],
    searchResults: [],
    discoveredStops: [
      {
        name: "龙岩",
        region: "福建",
        placeType: "城市",
        summary: "福建西部城市，适合作为客家文化停留点。",
        tags: ["客家文化", "古城"],
        verificationStatus: "verified",
      },
    ],
    route: {
      origin: "厦门",
      destination: "黄山",
      waypoints: ["龙岩"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
  });
  const content = JSON.stringify(messages);

  assert.match(content, /龙岩/);
  assert.match(content, /福建/);
  assert.match(content, /客家文化/);
  const payload = JSON.parse(messages[1].content) as {
    discoveredStops: { placeType: string }[];
  };
  assert.equal(payload.discoveredStops[0]?.placeType, "城市");
});

test("realtime prompt preserves verified and candidate discovery status", () => {
  const discoveredStops = mapDiscoveredStops({
    verifiedPlaces: [
      {
        canonicalName: "龙岩",
        region: "福建",
        placeType: "城市",
        summary: "福建西部城市，适合作为客家文化停留点。",
        tags: ["客家文化", "古城"],
      },
    ],
    candidatePlaces: [
      {
        canonicalName: "景德镇",
        region: "江西",
        placeType: "瓷都",
        summary: "陶瓷文化城市，地区资料仍待进一步确认。",
        tags: ["陶瓷", "古窑"],
      },
    ],
  });
  const messages = buildPlannerMessages({
    destinationName: "黄山",
    region: "安徽",
    startDate: "2026-09-19",
    days: 3,
    dailyHours: 8,
    pace: "balanced",
    interests: [],
    weather: [],
    searchResults: [],
    discoveredStops,
    route: {
      origin: "厦门",
      destination: "黄山",
      waypoints: ["龙岩", "景德镇"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
  });
  const payload = JSON.parse(messages[1].content) as {
    constraints: string[];
    discoveredStops: {
      name: string;
      placeType: string;
      verificationStatus: string;
    }[];
  };

  assert.deepEqual(
    payload.discoveredStops.map(({ name, placeType, verificationStatus }) => ({
      name,
      placeType,
      verificationStatus,
    })),
    [
      { name: "龙岩", placeType: "城市", verificationStatus: "verified" },
      { name: "景德镇", placeType: "瓷都", verificationStatus: "candidate" },
    ],
  );
  assert.match(payload.constraints.join("\n"), /候选地点.*不是已确认事实.*不确定性/);
});

test("rejects planner output whose source is not in the search result allowlist", () => {
  assert.throws(
    () =>
      parsePlannerJson(
        JSON.stringify({
          title: "测试",
          summary: "测试",
          days: [
            {
              day: 1,
              note: "测试",
              places: [
                {
                  id: "fake",
                  name: "虚构景区",
                  area: "未知",
                  indoor: false,
                  duration: 60,
                  summary: "无来源",
                  source: "https://invented.example.com",
                },
              ],
            },
          ],
        }),
        ["https://example.com/real"],
      ),
    /来源不在搜索结果中/,
  );
});

test("source selection keeps destination and seed sources ahead of discovery", () => {
  const destinationSources = Array.from({ length: 14 }, (_, index) => ({
    title: `目的地 ${index}`,
    url: `https://destination.example/${index}`,
    content: `目的地资料 ${index}`,
  }));
  const seedSources = [
    { title: "种子甲", url: "https://seed.example/a", content: "种子来源甲" },
    { title: "种子乙", url: "https://seed.example/b", content: "种子来源乙" },
  ];
  const discoverySourceGroups = Array.from({ length: 8 }, (_, groupIndex) => ({
    inputName: `途经点${groupIndex}`,
    sources: Array.from({ length: 10 }, (_, sourceIndex) => ({
      title: `发现 ${groupIndex}-${sourceIndex}`,
      url: `https://discovery.example/${groupIndex}/${sourceIndex}`,
      content: `发现资料 ${groupIndex}-${sourceIndex}`,
    })),
  }));

  const selected = selectPlannerSources({
    destinationSources,
    seedSources,
    discoverySourceGroups,
  });

  assert.equal(selected.length, 20);
  assert.deepEqual(
    selected.slice(0, 12).map((source) => source.url),
    destinationSources.slice(0, 12).map((source) => source.url),
  );
  assert.deepEqual(
    selected.slice(12, 14).map((source) => source.url),
    seedSources.map((source) => source.url),
  );
  const discoveryByGroup = new Map<string, number>();
  for (const source of selected.slice(14)) {
    const match = /discovery\.example\/(\d+)\//.exec(source.url);
    const group = match?.[1] ?? "unknown";
    discoveryByGroup.set(group, (discoveryByGroup.get(group) ?? 0) + 1);
  }
  assert.deepEqual([...discoveryByGroup.values()], [4, 2]);
});
