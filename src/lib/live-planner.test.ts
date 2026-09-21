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
import {
  runLivePlannerWith,
  type LiveItineraryInput,
} from "./live-planner.functions.ts";
import type {
  DiscoveredPlaceRecord,
  PlacePersistenceRepository,
} from "./place-discovery.ts";
import type { AmapClient } from "./amap.server.ts";

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


// ---- Task 9：服务端函数接线与 BUTLER_PLANNER 开关的契约测试 ----

type FetchImpl = typeof fetch;

function responseWith(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

function tavilySearchResponse(): Response {
  return Response.json({
    results: [
      { title: "黄山风景区", url: "https://example.com/huangshan", content: "安徽黄山风景区", score: 0.9 },
      { title: "屯溪老街", url: "https://example.com/tunxi", content: "徽州老街", score: 0.8 },
    ],
  });
}

function requestMessageContent(body: unknown): string {
  const parsed = body as { messages?: { content?: string }[] };
  return (parsed.messages ?? []).map((message) => message.content ?? "").join("\n");
}

function createMemoryPlaceRepository(): PlacePersistenceRepository {
  const rows = new Map<string, DiscoveredPlaceRecord>();
  return {
    async findDiscoveredPlaceByName(normalizedName: string) {
      return [...rows.values()].filter((record) => record.normalizedName === normalizedName);
    },
    async upsertDiscoveredPlace(record: DiscoveredPlaceRecord) {
      rows.set(record.canonicalKey, record);
      return record;
    },
    async touchDiscoveredPlaceUsage(canonicalKey: string) {
      return rows.get(canonicalKey) ?? null;
    },
  };
}

function buildLiveInput(overrides: Partial<LiveItineraryInput> = {}): LiveItineraryInput {
  return {
    destination: { id: "huangshan", name: "黄山", region: "安徽" },
    startDate: "2026-10-01",
    days: 2,
    dailyHours: 6,
    pace: "balanced",
    interests: ["自然山水"],
    origin: "北京",
    startTime: "08:00",
    endTime: "18:00",
    totalBudget: 8000,
    travelers: { adults: 2, children: 1 },
    transport: null,
    style: "direct",
    route: {
      origin: "北京",
      destination: "黄山",
      waypoints: [],
      roundTrip: false,
      returnMode: null,
      legs: [
        { id: "leg-1", from: "北京", to: "黄山", transport: "balanced", style: "direct", kind: "outbound" },
      ],
    },
    weather: [
      { date: "2026-10-01", code: 0, tempMax: 22, tempMin: 14, precipProb: 10 },
      { date: "2026-10-02", code: 1, tempMax: 20, tempMin: 12, precipProb: 20 },
    ],
    seedPlaces: [
      { id: "hs", name: "黄山风景区", area: "安徽", indoor: false, duration: 180, summary: "奇峰云海", source: "https://example.com/huangshan" },
      { id: "tx", name: "屯溪老街", area: "安徽", indoor: false, duration: 90, summary: "徽州老街", source: "https://example.com/tunxi" },
    ],
    ...overrides,
  };
}

function legacyPlanJson(): string {
  return JSON.stringify({
    title: "黄山两日",
    summary: "游览黄山风景区。",
    days: [
      {
        day: 1,
        note: "首日游览",
        places: [
          {
            id: "huangshan",
            name: "黄山风景区",
            area: "安徽",
            indoor: false,
            duration: 180,
            summary: "奇峰云海",
            source: "https://example.com/huangshan",
          },
        ],
      },
    ],
  });
}

function fakeLegacyFetch(): FetchImpl {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("tavily")) return tavilySearchResponse();
    const content = requestMessageContent(JSON.parse(String(init?.body)));
    if (content.includes("生成旅行回望与结束语")) {
      return responseWith(JSON.stringify({ quoteId: null, message: "值得回味。" }));
    }
    return responseWith(legacyPlanJson());
  }) as FetchImpl;
}

function butlerSkeletonJson(): string {
  const day = (day: number, hotel: number) => ({
    day,
    theme: day === 1 ? "黄山核心游览" : "屯溪老街收尾",
    nodes: [
      { type: "attraction", startTime: "09:00", endTime: "11:30", name: "黄山风景区", stayMinutes: 150, estimatedCost: 230 },
      { type: "meal", startTime: "12:00", endTime: "13:00", name: "徽菜午餐", estimatedCost: 120 },
      { type: "attraction", startTime: "14:00", endTime: "15:30", name: "屯溪老街", stayMinutes: 90, estimatedCost: 60 },
      { type: "hotel", startTime: "16:00", endTime: "16:30", name: "黄山温泉酒店", estimatedCost: hotel },
      { type: "rest", startTime: "17:00", endTime: "17:30", name: "返回酒店休息", estimatedCost: 0 },
    ],
    radar: { physical: 60, childFit: 55, weatherSensitivity: 65, timeCost: 50, crowding: 70 },
  });
  return JSON.stringify({
    title: "黄山两日徽州山水行",
    summary: "两天游览黄山风景区与屯溪老街。",
    days: [day(1, 680), day(2, 680)],
  });
}

function fakeButlerFetch(): FetchImpl {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("tavily")) return tavilySearchResponse();
    const content = requestMessageContent(JSON.parse(String(init?.body)));
    if (content.includes("每日文案")) {
      const day = Number(/(\d+) 天/.exec(content)?.[1] ?? 1);
      return responseWith(
        JSON.stringify({
          day,
          purpose: `第 ${day} 天的旅行目的。`,
          highlights: ["重点1：说明", "重点2：说明", "重点3：说明"],
          cautions: ["注意保暖", "带好雨具"],
          history: [],
        }),
      );
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWith(JSON.stringify({ quoteId: null, message: "这是一段值得回味的旅程。" }));
    }
    return responseWith(butlerSkeletonJson());
  }) as FetchImpl;
}

function failingButlerFetch(): FetchImpl {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("tavily")) return tavilySearchResponse();
    const content = requestMessageContent(JSON.parse(String(init?.body)));
    if (content.includes("生成逐日排程骨架")) {
      throw new TypeError("network down");
    }
    if (content.includes("生成旅行回望与结束语")) {
      return responseWith(JSON.stringify({ quoteId: null, message: "值得回味。" }));
    }
    return responseWith(legacyPlanJson());
  }) as FetchImpl;
}

test("开关关闭时走原链路且 mode 为 legacy", async () => {
  const result = await runLivePlannerWith(buildLiveInput(), {
    env: { BUTLER_PLANNER: "0", DEEPSEEK_API_KEY: "k", TAVILY_API_KEY: "k" },
    fetchImpl: fakeLegacyFetch(),
    repository: createMemoryPlaceRepository(),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.mode, "legacy");
  assert.ok(result.plan.days.length > 0);
});

test("开关打开时走管家链路并带回违规清单", async () => {
  const result = await runLivePlannerWith(buildLiveInput(), {
    env: { BUTLER_PLANNER: "1", DEEPSEEK_API_KEY: "k", TAVILY_API_KEY: "k" },
    fetchImpl: fakeButlerFetch(),
    repository: createMemoryPlaceRepository(),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.mode, "butler");
  assert.ok(Array.isArray(result.violations));
  assert.ok(result.skeleton.days.length > 0);
  assert.ok(result.dayCopy.length > 0);
  assert.ok(result.sources.length > 0);
});

test("管家骨架失败时退回 legacy 链路而不抛错", async () => {
  const result = await runLivePlannerWith(buildLiveInput(), {
    env: { BUTLER_PLANNER: "1", DEEPSEEK_API_KEY: "k", TAVILY_API_KEY: "k" },
    fetchImpl: failingButlerFetch(),
    repository: createMemoryPlaceRepository(),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.mode, "legacy");
});

test("高德目的地候选非空时会进入管家 sources", async () => {
  const tavilyQueries: string[] = [];
  const baseFetch = fakeButlerFetch();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("tavily")) {
      const body = JSON.parse(String(init?.body)) as { query?: string };
      if (body.query) tavilyQueries.push(body.query);
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  const amapClient: AmapClient = {
    async searchPoi() {
      return [
        {
          id: "B000A8UIN8",
          name: "故宫博物院",
          type: "风景名胜;博物馆",
          address: "北京市东城区景山前街4号",
          location: [116.397, 39.918],
        },
        {
          id: "B000A8UIN9",
          name: "天坛公园",
          type: "风景名胜;公园",
          address: "北京市东城区天坛东里甲1号",
          location: [116.410, 39.882],
        },
      ];
    },
    async fetchStaticMap() {
      return new Uint8Array();
    },
    async route() {
      throw new Error("本测试不应调用 AMap 路线规划");
    },
    async geocode(input) {
      const map = {
        厦门: { location: [118.089425, 24.479834] as [number, number], province: "福建省" },
        北京: { location: [116.407526, 39.90403] as [number, number], province: "北京市" },
      } as const;
      const point = map[input.address.trim() as keyof typeof map];
      if (!point) return [];
      return [
        {
          formattedAddress: input.address,
          province: point.province,
          city: input.address,
          district: "",
          adcode: "",
          location: point.location,
        },
      ];
    },
    async weather() {
      return [];
    },
  };

  const result = await runLivePlannerWith(
    buildLiveInput({
      destination: { id: "beijing", name: "北京", region: "北京市" },
      origin: "厦门",
      seedPlaces: [],
      route: {
        origin: "厦门",
        destination: "北京",
        waypoints: [],
        roundTrip: true,
        returnMode: "fast",
        legs: [
          { id: "outbound:0", from: "厦门", to: "北京", transport: "balanced", style: "direct", kind: "outbound" },
          { id: "return", from: "北京", to: "厦门", transport: "balanced", style: "direct", kind: "return" },
        ],
      },
    }),
    {
      env: { BUTLER_PLANNER: "1", DEEPSEEK_API_KEY: "k", TAVILY_API_KEY: "k" },
      fetchImpl,
      repository: createMemoryPlaceRepository(),
      amapClient,
    },
  );

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(result.sources.some((source) => source.title === "故宫博物院"));
  assert.ok(result.sources.some((source) => source.url.includes("amap.com/place/")));
  assert.deepEqual(result.route.legs.map((leg) => leg.transport), ["flight", "flight"]);
  assert.ok(tavilyQueries.length >= 2);
  assert.ok(tavilyQueries.every((query) => query.includes("票价")));
});
