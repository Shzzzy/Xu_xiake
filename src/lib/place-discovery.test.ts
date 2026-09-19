import {
  buildDiscoveredPlaceRecord,
  type DiscoveredPlaceRecord,
  type PlacePersistenceRepository,
} from "./place-discovery.ts";
import { createUniqueVisualSeed, hashString } from "./scene-art.ts";
import {
  discoverRoutePlaces,
  persistVerifiedPlaceResults,
  routeNodesNeedingDiscovery,
  verifyPlaceGroupsWithDeepSeek,
} from "./place-discovery.server.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPlaceKey,
  classifyPlaceConfidence,
  mapDiscoveredPlaceRow,
  normalizePlaceName,
  sanitizePlaceText,
} from "./place-discovery.ts";
import { buildPlaceSearchQueries, searchPlaceSources } from "./place-discovery.server.ts";

test("normalizes place names consistently", () => {
  assert.equal(normalizePlaceName(" 龙岩市 "), "龙岩");
  assert.equal(normalizePlaceName("LONG YAN"), "longyan");
});

test("allows same name in different regions", () => {
  assert.notEqual(canonicalPlaceKey("龙泉", "浙江"), canonicalPlaceKey("龙泉", "云南"));
});

test("classifies publish status by confidence and ambiguity", () => {
  assert.equal(classifyPlaceConfidence(0.85, false), "verified");
  assert.equal(classifyPlaceConfidence(0.84, false), "candidate");
  assert.equal(classifyPlaceConfidence(0.99, true), "rejected");
  assert.equal(classifyPlaceConfidence(0.54, false), "rejected");
});

test("removes control characters and trims text", () => {
  assert.equal(sanitizePlaceText(" 龙\u0000岩 ", 20), "龙岩");
});

test("maps a database row to a discovered place", () => {
  const place = mapDiscoveredPlaceRow({
    id: "dyn-longyan",
    canonical_key: "龙岩|福建",
    canonical_name: "龙岩",
    normalized_name: "龙岩",
    region: "福建",
    country: "中国",
    place_type: "城市",
    summary: "福建西部城市",
    tags: ["客家文化"],
    source_snapshot: [{ title: "龙岩", url: "https://example.com", content: "福建" }],
    confidence: "0.960",
    status: "verified",
    art: "mountain",
    accent: "#45695d",
    visual_seed: 12345,
    route_context: ["厦门", "黄山"],
    usage_count: 2,
    updated_at: "2026-09-01T00:00:00.000Z",
    last_verified_at: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(place.canonicalName, "龙岩");
  assert.equal(place.region, "福建");
  assert.equal(place.confidence, 0.96);
  assert.equal(place.updatedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(place.lastVerifiedAt, "2026-09-02T00:00:00.000Z");
});

test("route nodes exclude origin, normalize known names, and preserve waypoint order", () => {
  const nodes = routeNodesNeedingDiscovery(
    {
      origin: "厦门",
      destination: "黄山市",
      waypoints: ["龙岩", "龙岩市", "景德镇"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    new Set(["黄山"]),
  );

  assert.deepEqual(nodes, ["龙岩", "景德镇"]);
});

test("route node reporting can include every non-static route node without changing the default cap", () => {
  const route = {
    origin: "厦门",
    destination: "未知己",
    waypoints: ["未知甲", "未知乙", "未知丙", "未知丁", "未知戊"],
    roundTrip: false,
    returnMode: null,
    legs: [],
  };

  assert.equal(routeNodesNeedingDiscovery(route, new Set()).length, 5);
  assert.deepEqual(routeNodesNeedingDiscovery(route, new Set(), Number.POSITIVE_INFINITY), [
    "未知甲",
    "未知乙",
    "未知丙",
    "未知丁",
    "未知戊",
    "未知己",
  ]);
});

test("route nodes exclude a waypoint that normalizes to the origin", () => {
  const nodes = routeNodesNeedingDiscovery(
    {
      origin: "厦门",
      destination: "龙岩",
      waypoints: ["厦门市"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    new Set(),
  );

  assert.deepEqual(nodes, ["龙岩"]);
});

test("builds a place-specific Tavily query", () => {
  assert.deepEqual(buildPlaceSearchQueries("龙岩"), ["龙岩 所属地区 景点 一日游 推荐"]);
});
test("searches one place with advanced Tavily options and dedupes URLs", async () => {
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(
      JSON.stringify({
        results: [
          { title: "龙岩", url: "https://example.com/longyan", content: "龙岩景点", score: 0.9 },
          { title: "重复", url: "https://example.com/longyan", content: "重复来源" },
          { title: "福建", url: "https://example.com/fujian", content: "福建旅行" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const bundle = await searchPlaceSources("龙岩", "test-key", fetchImpl);

  assert.equal(bundle.inputName, "龙岩");
  assert.equal(bundle.normalizedName, "龙岩");
  assert.deepEqual(bundle.queries, ["龙岩 所属地区 景点 一日游 推荐"]);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    query: "龙岩 所属地区 景点 一日游 推荐",
    search_depth: "advanced",
    max_results: 8,
    include_answer: false,
    include_raw_content: false,
  });
  assert.deepEqual(
    bundle.results.map((result) => result.url),
    ["https://example.com/longyan", "https://example.com/fujian"],
  );
});

test("builds deterministic dynamic place records", () => {
  const canonicalKey = canonicalPlaceKey("龙岩", "福建");
  const record = buildDiscoveredPlaceRecord({
    canonicalName: "龙岩",
    region: "福建",
    country: "中国",
    placeType: "城市",
    summary: "福建西部城市",
    tags: ["客家文化"],
    sourceSnapshot: [
      { title: "龙岩", url: "https://example.com/longyan", content: "福建省龙岩市" },
    ],
    confidence: 0.96,
    status: "verified",
    art: "mountain",
    accent: "#45695d",
    visualSeed: 42,
    routeContext: ["厦门", "黄山"],
  });

  assert.equal(record.id, `dyn-${hashString(canonicalKey)}`);
  assert.equal(record.canonicalKey, canonicalKey);
  assert.equal(record.normalizedName, "龙岩");
  assert.equal(record.usageCount, 0);
  assert.deepEqual(record.routeContext, []);
});

function createFakeRepository() {
  const rows = new Map<string, DiscoveredPlaceRecord>();
  const seeds = new Set<number>();
  let upsertCalls = 0;
  let touchCalls = 0;

  return {
    rows,
    get upsertCalls() {
      return upsertCalls;
    },
    get touchCalls() {
      return touchCalls;
    },
    seed(record: DiscoveredPlaceRecord) {
      rows.set(record.canonicalKey, record);
      seeds.add(record.visualSeed);
    },
    async findDiscoveredPlaceByName(normalizedName: string) {
      return [...rows.values()].filter((record) => record.normalizedName === normalizedName);
    },
    async touchDiscoveredPlaceUsage(canonicalKey: string) {
      touchCalls += 1;
      const existing = rows.get(canonicalKey);
      if (!existing) return null;
      const touched = {
        ...existing,
        usageCount: existing.usageCount + 1,
      };
      rows.set(canonicalKey, touched);
      return touched;
    },
    async upsertDiscoveredPlace(record: DiscoveredPlaceRecord) {
      upsertCalls += 1;
      const existing = rows.get(record.canonicalKey);
      if (existing) {
        const updated = {
          ...existing,
          ...record,
          id: existing.id,
          visualSeed: existing.visualSeed,
          usageCount: existing.usageCount + 1,
        };
        rows.set(record.canonicalKey, updated);
        return updated;
      }

      if (seeds.has(record.visualSeed)) {
        throw Object.assign(new Error("duplicate key discovered_places_visual_seed_key"), {
          code: "23505",
          constraint: "discovered_places_visual_seed_key",
        });
      }

      seeds.add(record.visualSeed);
      rows.set(record.canonicalKey, record);
      return record;
    },
  } satisfies PlacePersistenceRepository & {
    rows: Map<string, DiscoveredPlaceRecord>;
    readonly upsertCalls: number;
    readonly touchCalls: number;
    seed(record: DiscoveredPlaceRecord): void;
  };
}

test("requests one DeepSeek object response and parses it through the whitelist", async () => {
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                places: [
                  {
                    inputName: "龙岩",
                    canonicalName: "龙岩",
                    region: "福建",
                    country: "中国",
                    placeType: "城市",
                    summary: "福建西部城市",
                    tags: ["客家文化"],
                    aliases: ["龙岩市"],
                    confidence: 0.96,
                    ambiguous: false,
                    reasons: ["来源明确"],
                    sourceUrls: ["https://example.com/longyan"],
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const groups = [
    {
      inputName: "龙岩",
      normalizedName: "龙岩",
      routeContext: ["厦门", "黄山"],
      results: [
        {
          title: "龙岩",
          url: "https://example.com/longyan",
          content: "福建省龙岩市",
        },
      ],
    },
  ];

  const result = await verifyPlaceGroupsWithDeepSeek({
    apiKey: "test-key",
    baseUrl: "https://deepseek.test/",
    groups,
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.equal(String(requests[0]?.input), "https://deepseek.test/chat/completions");
  const body = JSON.parse(String(requests[0]?.init?.body));
  assert.equal(body.model, process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat");
  assert.equal(body.temperature, 0.1);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(JSON.stringify(body.messages), /只输出 JSON 对象/);
  assert.match(JSON.stringify(body.messages), /allowedSourceUrls/);
  assert.deepEqual(
    result.map((place) => place.region),
    ["福建"],
  );
});

test("persists verified and candidate records but skips rejected results", async () => {
  const repo = createFakeRepository();
  const groups = [
    {
      inputName: "龙岩",
      normalizedName: "龙岩",
      routeContext: ["厦门", "黄山"],
      results: [
        {
          title: "龙岩",
          url: "https://example.com/longyan",
          content: "福建省龙岩市",
        },
      ],
    },
    {
      inputName: "黄山",
      normalizedName: "黄山",
      routeContext: ["龙岩", "厦门"],
      results: [
        {
          title: "黄山",
          url: "https://example.com/huangshan",
          content: "安徽省黄山市",
        },
      ],
    },
  ];
  const base = {
    country: "中国",
    placeType: "城市",
    summary: "摘要",
    tags: [],
    aliases: [],
    reasons: [],
    sourceUrls: [],
  };

  const outcome = await persistVerifiedPlaceResults(
    [
      {
        ...base,
        inputName: "龙岩",
        canonicalName: "龙岩",
        region: "福建",
        confidence: 0.96,
        ambiguous: false,
        sourceUrls: ["https://example.com/longyan"],
      },
      {
        ...base,
        inputName: "黄山",
        canonicalName: "黄山",
        region: "安徽",
        confidence: 0.7,
        ambiguous: false,
        sourceUrls: ["https://example.com/huangshan"],
      },
      {
        ...base,
        inputName: "龙岩",
        canonicalName: "龙岩",
        region: "未知",
        confidence: 0.4,
        ambiguous: false,
      },
    ],
    groups,
    repo,
  );

  assert.deepEqual(
    outcome.verified.map((place) => place.canonicalName),
    ["龙岩"],
  );
  assert.deepEqual(
    outcome.candidate.map((place) => place.canonicalName),
    ["黄山"],
  );
  assert.equal(outcome.rejected.length, 1);
  assert.equal(repo.upsertCalls, 2);
  assert.equal(repo.rows.size, 2);
});

test("preserves a known visual seed and retries a database seed collision", async () => {
  const repo = createFakeRepository();
  const canonicalKey = canonicalPlaceKey("龙岩", "福建");
  const longyanSeed = createUniqueVisualSeed(canonicalKey, new Set());
  const huangshanSeed = createUniqueVisualSeed(canonicalPlaceKey("黄山", "安徽"), new Set());
  repo.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "温泉",
      region: "福建",
      country: "中国",
      placeType: "景区",
      summary: "保留种子",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.9,
      status: "verified",
      art: "city",
      accent: "#4f7891",
      visualSeed: huangshanSeed,
      routeContext: [],
    }),
  );
  repo.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "龙岩",
      region: "福建",
      country: "中国",
      placeType: "城市",
      summary: "旧摘要",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.7,
      status: "candidate",
      art: "city",
      accent: "#4f7891",
      visualSeed: longyanSeed,
      routeContext: ["厦门"],
      usageCount: 2,
    }),
  );
  const groups = [
    {
      inputName: "龙岩",
      normalizedName: "龙岩",
      routeContext: ["厦门", "黄山"],
      results: [
        {
          title: "龙岩",
          url: "https://example.com/longyan",
          content: "福建省龙岩市",
        },
      ],
    },
    {
      inputName: "黄山",
      normalizedName: "黄山",
      routeContext: ["龙岩", "厦门"],
      results: [
        {
          title: "黄山",
          url: "https://example.com/huangshan",
          content: "安徽省黄山市",
        },
      ],
    },
  ];
  const base = {
    country: "中国",
    placeType: "城市",
    tags: [],
    aliases: [],
    reasons: [],
    ambiguous: false,
  };

  const outcome = await persistVerifiedPlaceResults(
    [
      {
        ...base,
        inputName: "龙岩",
        canonicalName: "龙岩",
        region: "福建",
        summary: "新摘要",
        confidence: 0.96,
        sourceUrls: ["https://example.com/longyan"],
      },
      {
        ...base,
        inputName: "黄山",
        canonicalName: "黄山",
        region: "安徽",
        summary: "黄山摘要",
        confidence: 0.91,
        sourceUrls: ["https://example.com/huangshan"],
      },
    ],
    groups,
    repo,
  );

  const updatedLongyan = repo.rows.get(canonicalKey);
  const huangshan = repo.rows.get(canonicalPlaceKey("黄山", "安徽"));
  assert.equal(updatedLongyan?.visualSeed, longyanSeed);
  assert.equal(updatedLongyan?.status, "verified");
  assert.equal(updatedLongyan?.usageCount, 3);
  assert.equal(updatedLongyan?.summary, "新摘要");
  assert.notEqual(huangshan?.visualSeed, huangshanSeed);
  assert.equal(outcome.verified.length, 2);
  assert.ok(repo.upsertCalls >= 3);
});

test("continues discovery when one place search fails", async () => {
  const repository = createFakeRepository();
  repository.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "泉州",
      region: "福建",
      country: "中国",
      placeType: "山岳",
      summary: "已校核地点",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.96,
      status: "verified",
      art: "mountain",
      accent: "#45695d",
      visualSeed: 101,
      routeContext: [],
      updatedAt: "2020-01-01T00:00:00.000Z",
    }),
  );

  let tavilyCalls = 0;
  let deepseekCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("deepseek")) {
      deepseekCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  places: [
                    {
                      inputName: "景德镇",
                      canonicalName: "景德镇",
                      region: "江西",
                      country: "中国",
                      placeType: "城市",
                      summary: "江西东北部城市，以陶瓷文化见长。",
                      tags: ["陶瓷"],
                      aliases: [],
                      confidence: 0.93,
                      ambiguous: false,
                      reasons: ["来源明确"],
                      sourceUrls: ["https://example.com/jingdezhen"],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    tavilyCalls += 1;
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes("龙岩")) {
      return new Response("search unavailable", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "景德镇",
            url: "https://example.com/jingdezhen",
            content: "江西省景德镇市",
            score: 0.9,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await discoverRoutePlaces({
    route: {
      origin: "厦门",
      destination: "泉州",
      waypoints: ["龙岩", "景德镇"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: "deepseek-test-key",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.equal(result.notices.find((notice) => notice.inputName === "龙岩")?.status, "failed");
  assert.equal(result.notices.find((notice) => notice.inputName === "景德镇")?.status, "published");
  assert.deepEqual(
    result.searchResults.map((source) => source.url),
    ["https://example.com/jingdezhen"],
  );
  assert.ok(result.verifiedPlaces.some((place) => place.canonicalName === "景德镇"));
  assert.ok(result.verifiedPlaces.some((place) => place.canonicalName === "泉州"));
  assert.equal(tavilyCalls, 2);
  assert.equal(deepseekCalls, 1);
  assert.equal(repository.upsertCalls, 1);
  assert.equal(repository.touchCalls, 1);
});

test("does not search static inspiration destinations", async () => {
  const repository = createFakeRepository();
  const tavilyQueries: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("deepseek")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  places: [
                    {
                      inputName: "景德镇",
                      canonicalName: "景德镇",
                      region: "江西",
                      country: "中国",
                      placeType: "城市",
                      summary: "江西东北部城市。",
                      tags: [],
                      aliases: [],
                      confidence: 0.93,
                      ambiguous: false,
                      reasons: ["来源明确"],
                      sourceUrls: ["https://example.com/jingdezhen"],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const body = JSON.parse(String(init?.body)) as { query: string };
    tavilyQueries.push(body.query);
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "景德镇",
            url: "https://example.com/jingdezhen",
            content: "江西省景德镇市",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await discoverRoutePlaces({
    route: {
      origin: "北京",
      destination: "黄山",
      waypoints: ["景德镇"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: "deepseek-test-key",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.deepEqual(tavilyQueries, ["景德镇 所属地区 景点 一日游 推荐"]);
  assert.deepEqual(
    result.notices.map((notice) => [notice.inputName, notice.status]),
    [["景德镇", "published"]],
  );
});

test("keeps a published notice when a later persistence write fails", async () => {
  const repository = createFakeRepository();
  repository.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "黄山",
      region: "安徽",
      country: "中国",
      placeType: "山岳",
      summary: "已校核地点",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.96,
      status: "verified",
      art: "mountain",
      accent: "#45695d",
      visualSeed: 107,
      routeContext: [],
    }),
  );
  const upsert = repository.upsertDiscoveredPlace.bind(repository);
  repository.upsertDiscoveredPlace = async (record: DiscoveredPlaceRecord) => {
    if (record.canonicalName === "景德镇") {
      throw new Error("写库失败：景德镇");
    }
    return upsert(record);
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("deepseek")) {
      const places = [
        {
          inputName: "龙岩",
          canonicalName: "龙岩",
          region: "福建",
          country: "中国",
          placeType: "城市",
          summary: "福建西部城市。",
          tags: [],
          aliases: [],
          confidence: 0.93,
          ambiguous: false,
          reasons: ["来源明确"],
          sourceUrls: ["https://example.com/longyan"],
        },
        {
          inputName: "景德镇",
          canonicalName: "景德镇",
          region: "江西",
          country: "中国",
          placeType: "城市",
          summary: "江西东北部城市。",
          tags: [],
          aliases: [],
          confidence: 0.92,
          ambiguous: false,
          reasons: ["来源明确"],
          sourceUrls: ["https://example.com/jingdezhen"],
        },
      ];
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ places }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes("龙岩")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "龙岩",
              url: "https://example.com/longyan",
              content: "福建省龙岩市",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "景德镇",
            url: "https://example.com/jingdezhen",
            content: "江西省景德镇市",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await discoverRoutePlaces({
    route: {
      origin: "厦门",
      destination: "龙岩",
      waypoints: ["龙岩", "景德镇"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: "deepseek-test-key",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.equal(result.notices.find((notice) => notice.inputName === "龙岩")?.status, "published");
  const failed = result.notices.find((notice) => notice.inputName === "景德镇");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.message ?? "", /写库失败：景德镇/);
  assert.ok(!result.verifiedPlaces.some((place) => place.canonicalName === "景德镇"));
});

test("verification receives the full route context around a waypoint", async () => {
  const repository = createFakeRepository();
  repository.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "黄山",
      region: "安徽",
      country: "中国",
      placeType: "山岳",
      summary: "已校核地点",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.96,
      status: "verified",
      art: "mountain",
      accent: "#45695d",
      visualSeed: 104,
      routeContext: [],
    }),
  );
  let routeContext: string[] | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("deepseek")) {
      const request = JSON.parse(String(init?.body)) as {
        messages: { content: string }[];
      };
      const userPayload = JSON.parse(request.messages[1]?.content ?? "{}") as {
        groups?: { routeContext: string[] }[];
      };
      routeContext = userPayload.groups?.[0]?.routeContext;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  places: [
                    {
                      inputName: "龙岩",
                      canonicalName: "龙岩",
                      region: "福建",
                      country: "中国",
                      placeType: "城市",
                      summary: "福建西部城市。",
                      tags: [],
                      aliases: [],
                      confidence: 0.93,
                      ambiguous: false,
                      reasons: ["来源明确"],
                      sourceUrls: ["https://example.com/longyan"],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        results: [
          {
            title: "龙岩",
            url: "https://example.com/longyan",
            content: "福建省龙岩市",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  await discoverRoutePlaces({
    route: {
      origin: "厦门",
      destination: "黄山",
      waypoints: ["龙岩"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: "deepseek-test-key",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.deepEqual(routeContext, ["厦门", "黄山"]);
});

test("missing keys return failed notices without network calls or database writes", async () => {
  const repository = createFakeRepository();
  let networkCalls = 0;
  const fetchImpl = (async () => {
    networkCalls += 1;
    throw new Error("network should not be called");
  }) as typeof fetch;

  const result = await discoverRoutePlaces({
    route: {
      origin: "厦门",
      destination: "龙岩",
      waypoints: [],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: " ",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.deepEqual(
    result.notices.map((notice) => [notice.inputName, notice.status]),
    [["龙岩", "failed"]],
  );
  assert.equal(networkCalls, 0);
  assert.equal(repository.upsertCalls, 0);
});

test("reuses a recent candidate without network calls", async () => {
  const repository = createFakeRepository();
  repository.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "龙岩",
      region: "福建",
      country: "中国",
      placeType: "城市",
      summary: "候选地点",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.7,
      status: "candidate",
      art: "mountain",
      accent: "#45695d",
      visualSeed: 102,
      routeContext: [],
      updatedAt: "2020-01-01T00:00:00.000Z",
      lastVerifiedAt: new Date().toISOString(),
    }),
  );
  let networkCalls = 0;
  const fetchImpl = (async () => {
    networkCalls += 1;
    throw new Error("network should not be called");
  }) as typeof fetch;

  const result = await discoverRoutePlaces({
    route: {
      origin: "厦门",
      destination: "龙岩",
      waypoints: [],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: "deepseek-test-key",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.equal(result.notices[0]?.status, "candidate");
  assert.equal(result.candidatePlaces[0]?.canonicalName, "龙岩");
  assert.equal(networkCalls, 0);
  assert.equal(repository.upsertCalls, 0);
});

test("searches again when a candidate's last verification is expired", async () => {
  const repository = createFakeRepository();
  repository.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "龙岩",
      region: "福建",
      country: "中国",
      placeType: "城市",
      summary: "过期候选地点",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.7,
      status: "candidate",
      art: "city",
      accent: "#4f7891",
      visualSeed: 108,
      routeContext: [],
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: "2020-01-01T00:00:00.000Z",
    }),
  );
  let networkCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    networkCalls += 1;
    if (String(input).includes("deepseek")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  places: [
                    {
                      inputName: "龙岩",
                      canonicalName: "龙岩",
                      region: "福建",
                      country: "中国",
                      placeType: "城市",
                      summary: "福建西部城市。",
                      tags: [],
                      aliases: [],
                      confidence: 0.93,
                      ambiguous: false,
                      reasons: ["来源明确"],
                      sourceUrls: ["https://example.com/longyan"],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "龙岩",
            url: "https://example.com/longyan",
            content: "福建省龙岩市",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await discoverRoutePlaces({
    route: {
      origin: "厦门",
      destination: "龙岩",
      waypoints: [],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: "deepseek-test-key",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.equal(result.notices[0]?.status, "published");
  assert.ok(networkCalls >= 2);
});

test("re-runs discovery when one normalized name has multiple canonical regions", async () => {
  const repository = createFakeRepository();
  repository.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "龙岩",
      region: "浙江",
      country: "中国",
      placeType: "山岳",
      summary: "同名候选地点",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.7,
      status: "candidate",
      art: "mountain",
      accent: "#45695d",
      visualSeed: 105,
      routeContext: [],
      updatedAt: new Date().toISOString(),
    }),
  );
  repository.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "龙岩",
      region: "福建",
      country: "中国",
      placeType: "山岳",
      summary: "同名已校核地点",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.96,
      status: "verified",
      art: "mountain",
      accent: "#45695d",
      visualSeed: 106,
      routeContext: [],
      updatedAt: "2020-01-01T00:00:00.000Z",
    }),
  );
  let tavilyCalls = 0;
  let routeContext: string[] | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("deepseek")) {
      const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const payload = JSON.parse(request.messages[1]?.content ?? "{}") as {
        groups?: { routeContext: string[] }[];
      };
      routeContext = payload.groups?.[0]?.routeContext;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  places: [
                    {
                      inputName: "龙岩",
                      canonicalName: "龙岩",
                      region: "福建",
                      country: "中国",
                      placeType: "城市",
                      summary: "福建西部城市。",
                      tags: [],
                      aliases: [],
                      confidence: 0.93,
                      ambiguous: false,
                      reasons: ["路线上下文与来源一致"],
                      sourceUrls: ["https://example.com/longyan"],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    tavilyCalls += 1;
    return new Response(
      JSON.stringify({
        results: [{ title: "龙岩", url: "https://example.com/longyan", content: "福建省龙岩市" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await discoverRoutePlaces({
    route: {
      origin: "厦门",
      destination: "龙岩",
      waypoints: [],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: "deepseek-test-key",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.equal(tavilyCalls, 1);
  assert.deepEqual(routeContext, ["厦门"]);
  assert.equal(result.notices[0]?.status, "published");
  assert.equal(result.notices[0]?.region, "福建");
});

test("reuses verified records by touching usage without refreshing verification time", async () => {
  const repository = createFakeRepository();
  const lastVerifiedAt = "2020-01-02T00:00:00.000Z";
  repository.seed(
    buildDiscoveredPlaceRecord({
      canonicalName: "龙岩",
      region: "福建",
      country: "中国",
      placeType: "山岳",
      summary: "长期校核地点",
      tags: [],
      sourceSnapshot: [],
      confidence: 0.96,
      status: "verified",
      art: "mountain",
      accent: "#45695d",
      visualSeed: 103,
      routeContext: [],
      updatedAt: "2020-01-01T00:00:00.000Z",
      lastVerifiedAt,
    }),
  );
  let networkCalls = 0;
  const fetchImpl = (async () => {
    networkCalls += 1;
    throw new Error("network should not be called");
  }) as typeof fetch;

  const result = await discoverRoutePlaces({
    route: {
      origin: "厦门",
      destination: "龙岩",
      waypoints: [],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: "deepseek-test-key",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.equal(result.notices[0]?.status, "published");
  assert.equal(result.verifiedPlaces[0]?.canonicalName, "龙岩");
  assert.equal(result.verifiedPlaces[0]?.usageCount, 1);
  assert.equal(result.verifiedPlaces[0]?.lastVerifiedAt, lastVerifiedAt);
  assert.equal(networkCalls, 0);
  assert.equal(repository.upsertCalls, 0);
  assert.equal(repository.touchCalls, 1);
});

test("does not publish a high-confidence result without allowed non-empty evidence", async () => {
  const repository = createFakeRepository();
  const group = {
    inputName: "龙岩",
    normalizedName: "龙岩",
    routeContext: ["厦门", "黄山"],
    results: [
      {
        title: "空内容",
        url: "https://example.com/longyan",
        content: "   ",
      },
    ],
  };
  const outcome = await persistVerifiedPlaceResults(
    [
      {
        inputName: "龙岩",
        canonicalName: "龙岩",
        region: "福建",
        country: "中国",
        placeType: "城市",
        summary: "高置信度但缺少有效证据。",
        tags: [],
        aliases: [],
        confidence: 0.96,
        ambiguous: false,
        reasons: [],
        sourceUrls: ["https://example.com/longyan"],
      },
    ],
    [group],
    repository,
  );

  assert.equal(outcome.verified.length, 0);
  assert.equal(outcome.candidate.length, 1);
  assert.equal(outcome.candidate[0]?.status, "candidate");
  assert.equal(repository.rows.size, 1);
});

test("continues valid persistence when another DeepSeek entry is outside the allowlist", async () => {
  const repository = createFakeRepository();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("deepseek")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  places: [
                    {
                      inputName: "龙岩",
                      canonicalName: "龙岩",
                      region: "福建",
                      country: "中国",
                      placeType: "城市",
                      summary: "福建西部城市。",
                      tags: [],
                      aliases: [],
                      confidence: 0.93,
                      ambiguous: false,
                      reasons: ["来源明确"],
                      sourceUrls: ["https://example.com/longyan"],
                    },
                    {
                      inputName: "景德镇",
                      canonicalName: "景德镇",
                      region: "江西",
                      country: "中国",
                      placeType: "城市",
                      summary: "江西东北部城市。",
                      tags: [],
                      aliases: [],
                      confidence: 0.93,
                      ambiguous: false,
                      reasons: ["来源错误"],
                      sourceUrls: ["https://attacker.example/jingdezhen"],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const body = JSON.parse(String(init?.body)) as { query: string };
    if (body.query.includes("龙岩")) {
      return new Response(
        JSON.stringify({
          results: [{ title: "龙岩", url: "https://example.com/longyan", content: "福建省龙岩市" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        results: [
          { title: "景德镇", url: "https://example.com/jingdezhen", content: "江西省景德镇市" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await discoverRoutePlaces({
    route: {
      origin: "厦门",
      destination: "黄山",
      waypoints: ["龙岩", "景德镇"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    deepseekKey: "deepseek-test-key",
    tavilyKey: "tavily-test-key",
    fetchImpl,
    repository,
  });

  assert.deepEqual(
    result.notices.map((notice) => [notice.inputName, notice.status]),
    [
      ["龙岩", "published"],
      ["景德镇", "failed"],
    ],
  );
  assert.match(
    result.notices.find((notice) => notice.inputName === "景德镇")?.message ?? "",
    /来源不在允许列表/,
  );
  assert.deepEqual(
    [...repository.rows.values()].map((record) => record.canonicalName),
    ["龙岩"],
  );
});
