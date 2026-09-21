import test from "node:test";
import assert from "node:assert/strict";
import type { AmapClient, AmapCoordinate, AmapPoi } from "./amap.server.ts";
import {
  buildAmapDestinationCandidates,
  mergePlannerCandidates,
  prepareRouteTransportPlan,
  resolvePlannerAmapKey,
} from "./planner-context.server.ts";
import type { RoutePlan, TransportMode } from "./route-planner.ts";

const coordinates: Record<string, { location: AmapCoordinate; province: string }> = {
  厦门: { location: [118.089425, 24.479834], province: "福建省" },
  北京: { location: [116.407526, 39.90403], province: "北京市" },
};

function createRoute(transport: TransportMode): RoutePlan {
  return {
    origin: "厦门",
    destination: "北京",
    waypoints: [],
    roundTrip: true,
    returnMode: "fast",
    legs: [
      {
        id: "outbound:0",
        from: "厦门",
        to: "北京",
        transport,
        style: "direct",
        kind: "outbound",
      },
      {
        id: "return",
        from: "北京",
        to: "厦门",
        transport,
        style: "direct",
        kind: "return",
      },
    ],
  };
}

function createFakeAmapClient(): AmapClient {
  return {
    async searchPoi() {
      return [];
    },
    async fetchStaticMap() {
      return new Uint8Array();
    },
    async route() {
      throw new Error("本测试不应调用路线规划");
    },
    async geocode(input) {
      const point = coordinates[input.address.trim()];
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
}

test("高德 POI 转为候选景点，来源不含 key 且优先合并", () => {
  const pois: AmapPoi[] = [
    {
      id: "B000A8UIN8",
      name: "故宫博物院",
      type: "风景名胜;博物馆",
      address: "北京市东城区景山前街4号",
      location: [116.397, 39.918],
    },
  ];

  const candidates = buildAmapDestinationCandidates(pois);
  const merged = mergePlannerCandidates({
    primary: candidates,
    fallback: [
      {
        name: "故宫博物院",
        summary: "本地 seed 资料",
        source: "https://example.com/forbidden-city",
      },
      {
        name: "天坛公园",
        summary: "本地 seed 资料",
        source: "https://example.com/temple-of-heaven",
      },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.name, "故宫博物院");
  assert.match(candidates[0]?.source ?? "", /^https:\/\/www\.amap\.com\/place\//);
  assert.doesNotMatch(candidates[0]?.source ?? "", /key=/i);
  assert.deepEqual(
    merged.map((candidate) => candidate.name),
    ["故宫博物院", "天坛公园"],
  );
  assert.match(merged[0]?.source ?? "", /amap\.com/);
});

test("高德 key 按现有环境变量优先级读取并跳过空值", () => {
  assert.equal(
    resolvePlannerAmapKey({ webServiceKey: "  ", apiKey: "api-key", key: "legacy-key" }),
    "api-key",
  );
  assert.equal(resolvePlannerAmapKey({ key: "legacy-key" }), "legacy-key");
});

test("高德无候选时保留已有候选，Tavily 只补充资料不清空列表", () => {
  const existing = [
    {
      name: "北京故宫",
      summary: "原有候选摘要",
      source: "https://example.com/existing-candidate",
    },
  ];

  const merged = mergePlannerCandidates({
    primary: [],
    fallback: existing,
    supplements: [
      {
        title: "北京故宫",
        url: "https://example.com/price-source",
        content: "补充资料：建议提前预约。",
      },
    ],
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.source, existing[0]?.source);
  assert.match(merged[0]?.summary ?? "", /提前预约/);
});

test("跨省单程约八百公里时通用偏好切为飞机", async () => {
  const preparation = await prepareRouteTransportPlan({
    client: createFakeAmapClient(),
    route: createRoute("balanced"),
    startDate: "2026-10-01",
    travelers: { adults: 2, children: 1 },
    tavilyKey: "test-key",
    fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
  });

  assert.deepEqual(
    preparation.route.legs.map((leg) => leg.transport),
    ["flight", "flight"],
  );
  assert.ok(preparation.references.every((reference) => reference.distanceKm >= 800));
});

test("用户显式选择 drive 或 train 时不强制改飞机", async () => {
  for (const mode of ["drive", "train"] as const) {
    const preparation = await prepareRouteTransportPlan({
      client: createFakeAmapClient(),
      route: createRoute(mode),
      startDate: "2026-10-01",
      travelers: { adults: 1, children: 0 },
      tavilyKey: "test-key",
      fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
    });

    assert.deepEqual(
      preparation.route.legs.map((leg) => leg.transport),
      [mode, mode],
    );
  }
});

test("非自驾交通参考价包含 Tavily 摘要和本地最低总价", async () => {
  const fetchImpl = (async () =>
    Response.json({
      results: [
        {
          title: "厦门到北京机票价格",
          url: "https://example.com/flight-price",
          content: "近期单程经济舱约九百元，节假日可能上浮。",
          score: 0.9,
        },
      ],
    })) as typeof fetch;

  const preparation = await prepareRouteTransportPlan({
    client: createFakeAmapClient(),
    route: createRoute("balanced"),
    startDate: "2026-10-01",
    travelers: { adults: 2, children: 1 },
    tavilyKey: "test-key",
    fetchImpl,
  });

  assert.equal(preparation.references.length, 2);
  assert.ok(preparation.references.every((reference) => reference.minimumPartyTotal >= 1500));
  assert.ok(preparation.minimumTotal >= 5000);
  assert.match(preparation.references[0]?.sources[0]?.content ?? "", /经济舱/);
});
