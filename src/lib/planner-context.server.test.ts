import test from "node:test";
import assert from "node:assert/strict";
import type { AmapClient, AmapCoordinate, AmapPoi } from "./amap.server.ts";
import {
  buildAmapDestinationCandidates,
  clusterCandidates,
  mergePlannerCandidates,
  prepareRouteTransportPlan,
  resolvePlannerAmapKey,
  searchAmapDestinationCandidates,
  type DestinationCandidate,
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

function createFakeAmapClient(searchPoi: AmapClient["searchPoi"] = async () => []): AmapClient {
  return {
    searchPoi,
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

test("特定景区名称优先按地区精确查询且不会返回北京地标", async () => {
  const calls: { keywords: string; city?: string }[] = [];
  const silverBeach: AmapPoi = {
    id: "B-SILVER-BEACH",
    name: "北海银滩",
    type: "风景名胜;风景名胜;海滩",
    address: "广西壮族自治区北海市银海区银滩中路",
    location: [109.116, 21.405],
  };
  const forbiddenCity: AmapPoi = {
    id: "B-FORBIDDEN-CITY",
    name: "故宫博物院",
    type: "风景名胜;博物馆",
    address: "北京市东城区景山前街4号",
    location: [116.397, 39.918],
  };
  const client = createFakeAmapClient(async (input) => {
    calls.push({ keywords: input.keywords, city: input.city });
    if (input.keywords === "北海银滩") return [silverBeach];
    return [forbiddenCity];
  });

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "北海银滩",
    region: "广西",
  });

  assert.deepEqual(
    result.map((candidate) => candidate.name),
    ["北海银滩"],
  );
  const exactIndex = calls.findIndex(
    (call) => call.keywords === "北海银滩",
  );
  const genericIndex = calls.findIndex((call) => call.keywords === "热门景点");
  assert.ok(exactIndex >= 0);
  assert.ok(genericIndex >= 0);
  assert.ok(exactIndex < genericIndex);
  assert.equal(calls[exactIndex]?.city, undefined);
  assert.equal(calls.some((call) => call.city === "广西"), false);
});

test("AMap city 只接受可识别城市或 adcode", async () => {
  const cases = [
    { destination: "北海银滩", region: "广西", expectedCity: undefined },
    { destination: "徽州古城", region: "安徽 · 徽州", expectedCity: undefined },
    { destination: "北海银滩", region: "自由输入", expectedCity: undefined },
    { destination: "北海银滩", region: "广西北海市", expectedCity: "北海市" },
    { destination: "西湖", region: "330100", expectedCity: "330100" },
  ] as const;

  for (const scenario of cases) {
    const calls: { keywords: string; city?: string }[] = [];
    const poi: AmapPoi = {
      id: `B-${scenario.destination}`,
      name: scenario.destination,
      type: "风景名胜;风景名胜",
      address:
        scenario.region === "安徽 · 徽州"
          ? "安徽省黄山市徽州区"
          : scenario.region === "330100"
            ? "浙江省杭州市西湖区"
            : "广西壮族自治区北海市银海区",
      location: [109.116, 21.405],
    };
    const client = createFakeAmapClient(async (input) => {
      calls.push({ keywords: input.keywords, city: input.city });
      return input.keywords === scenario.destination ? [poi] : [];
    });

    await searchAmapDestinationCandidates({
      client,
      destination: scenario.destination,
      region: scenario.region,
    });

    const exactCall = calls.find((call) => call.keywords === scenario.destination);
    assert.equal(exactCall?.city, scenario.expectedCity);
    if (scenario.expectedCity === undefined) {
      assert.equal(calls.some((call) => call.city === scenario.region), false);
    }
  }
});

test("无城市重试丢弃目的地同名但地区冲突的异地结果", async () => {
  const conflict: AmapPoi = {
    id: "B-QINGDAO-SILVER-BEACH",
    name: "北海银滩",
    type: "风景名胜;风景名胜;海滩",
    address: "山东省青岛市黄岛区银沙滩路",
    location: [120.24, 35.96],
  };
  const correct: AmapPoi = {
    id: "B-BEIHai-SILVER-BEACH",
    name: "北海银滩",
    type: "风景名胜;风景名胜;海滩",
    address: "广西壮族自治区北海市银海区银滩中路",
    location: [109.116, 21.405],
  };
  const client = createFakeAmapClient(async (input) =>
    input.keywords === "北海银滩" ? [conflict, correct] : [],
  );

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "北海银滩",
    region: "广西",
  });

  assert.deepEqual(
    result.map((candidate) => candidate.id),
    ["B-BEIHai-SILVER-BEACH"],
  );
});

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

test("高德候选过滤非景点并按名称稳定去重", () => {
  const pois: AmapPoi[] = [
    {
      id: "B-WEST-LAKE",
      name: "西湖风景名胜区",
      type: "风景名胜;公园广场;公园",
      address: "浙江省杭州市西湖区龙井路1号",
      location: [120.15, 30.27],
    },
    {
      id: "B-WEST-LAKE-DUPLICATE",
      name: " 西湖风景名胜区 ",
      type: "风景名胜;风景名胜",
      address: "浙江省杭州市西湖区北山街",
      location: [120.16, 30.28],
    },
    {
      id: "B-WEST-LAKE",
      name: "西湖景区",
      type: "风景名胜;风景名胜",
      address: "浙江省杭州市西湖区孤山路",
      location: [120.14, 30.25],
    },
    {
      id: "B-HOTEL",
      name: "西湖国宾馆",
      type: "住宿服务;宾馆酒店",
      address: "浙江省杭州市西湖区杨公堤18号",
      location: [120.13, 30.24],
    },
    {
      id: "B-RESTAURANT",
      name: "楼外楼",
      type: "餐饮服务;中餐厅",
      address: "浙江省杭州市西湖区孤山路30号",
      location: [120.14, 30.25],
    },
    {
      id: "B-SHOPPING",
      name: "湖滨银泰",
      type: "购物服务;商场",
      address: "浙江省杭州市上城区延安路",
      location: [120.17, 30.26],
    },
    {
      id: "B-LIFE-SERVICE",
      name: "西湖游客服务中心",
      type: "生活服务;生活服务场所",
      address: "浙江省杭州市西湖区龙井路",
      location: [120.15, 30.27],
    },
  ];

  const candidates = buildAmapDestinationCandidates(pois);

  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    ["西湖风景名胜区"],
  );
  assert.equal(candidates[0]?.id, "B-WEST-LAKE");
  assert.deepEqual(candidates[0]?.location, [120.15, 30.27]);
  assert.match(candidates[0]?.publicUrl ?? "", /^https:\/\/www\.amap\.com\/place\//);
  assert.ok(candidates[0]?.areaKey);
});

test("同区域景点优先聚到同一天且不同城市不混组", () => {
  const candidates: DestinationCandidate[] = [
    {
      id: "west-lake",
      name: "西湖",
      type: "风景名胜;湖泊",
      address: "浙江省杭州市西湖区龙井路1号",
      location: [120.15, 30.25],
      publicUrl: "https://www.amap.com/place/west-lake",
      areaKey: "杭州市-西湖区",
    },
    {
      id: "sudi",
      name: "苏堤春晓",
      type: "风景名胜;风景名胜",
      address: "浙江省杭州市西湖区苏堤",
      location: [120.14, 30.24],
      publicUrl: "https://www.amap.com/place/sudi",
      areaKey: "杭州市-西湖区",
    },
    {
      id: "lingyin",
      name: "灵隐寺",
      type: "风景名胜;寺庙道观",
      address: "浙江省杭州市西湖区法云弄1号",
      location: [120.1, 30.24],
      publicUrl: "https://www.amap.com/place/lingyin",
      areaKey: "杭州市-西湖区",
    },
    {
      id: "forbidden-city",
      name: "故宫博物院",
      type: "风景名胜;博物馆",
      address: "北京市东城区景山前街4号",
      location: [116.397, 39.918],
      publicUrl: "https://www.amap.com/place/forbidden-city",
      areaKey: "北京市-东城区",
    },
    {
      id: "temple-of-heaven",
      name: "天坛公园",
      type: "风景名胜;公园",
      address: "北京市东城区天坛东里甲1号",
      location: [116.407, 39.883],
      publicUrl: "https://www.amap.com/place/temple-of-heaven",
      areaKey: "北京市-东城区",
    },
  ];

  const groups = clusterCandidates(candidates, 3);
  const westLakeGroup = groups.find((group) =>
    group.some((candidate) => candidate.name === "西湖"),
  );
  const beijingGroup = groups.find((group) =>
    group.some((candidate) => candidate.name === "故宫博物院"),
  );

  assert.deepEqual(
    westLakeGroup?.map((candidate) => candidate.name),
    ["西湖", "苏堤春晓", "灵隐寺"],
  );
  assert.deepEqual(
    beijingGroup?.map((candidate) => candidate.name),
    ["故宫博物院", "天坛公园"],
  );
});

test("相同 areaKey 超过聚类距离时仍会拆分大型区县", () => {
  const candidates: DestinationCandidate[] = [
    {
      id: "shankou-mangrove",
      name: "山口红树林",
      type: "风景名胜;自然保护区",
      address: "广西壮族自治区北海市合浦县山口镇",
      location: [109.1, 21.4],
      publicUrl: "https://www.amap.com/place/shankou-mangrove",
      areaKey: "北海市-合浦县",
    },
    {
      id: "weizhou-island",
      name: "涠洲岛",
      type: "风景名胜;风景名胜",
      address: "广西壮族自治区北海市海城区涠洲镇",
      location: [109.5, 21.8],
      publicUrl: "https://www.amap.com/place/weizhou-island",
      areaKey: "北海市-合浦县",
    },
  ];

  const groups = clusterCandidates(candidates, 2);

  assert.deepEqual(
    groups.map((group) => group.map((candidate) => candidate.name)),
    [["山口红树林"], ["涠洲岛"]],
  );
});

test("maxPerDay 非有限值时回退为每个候选一天", () => {
  const candidates: DestinationCandidate[] = ["清风园", "明月湖", "望江亭"].map(
    (name, index) => ({
      id: `candidate-${index}`,
      name,
      type: "风景名胜;风景名胜",
      address: "浙江省杭州市西湖区",
      location: [120.14 + index * 0.01, 30.24 + index * 0.01],
      publicUrl: `https://www.amap.com/place/candidate-${index}`,
      areaKey: "杭州市-西湖区",
    }),
  );

  for (const maxPerDay of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const groups = clusterCandidates(candidates, maxPerDay);
    assert.deepEqual(
      groups.map((group) => group.map((candidate) => candidate.name)),
      [["清风园"], ["明月湖"], ["望江亭"]],
    );
  }
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
