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

function createAmapAttraction(input: {
  id: string;
  name?: string;
  type?: string;
  province?: string;
  city: string;
  district: string;
  adcode: string;
  address: string;
  location: AmapCoordinate;
}): AmapPoi {
  return {
    id: input.id,
    name: input.name ?? "水乡古镇",
    type: input.type ?? "风景名胜;古镇",
    address: input.address,
    location: input.location,
    province: input.province ?? "浙江省",
    city: input.city,
    district: input.district,
    adcode: input.adcode,
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
  const exactIndex = calls.findIndex((call) => call.keywords === "北海银滩");
  const genericIndex = calls.findIndex((call) => call.keywords === "热门景点");
  assert.ok(exactIndex >= 0);
  assert.ok(genericIndex >= 0);
  assert.ok(exactIndex < genericIndex);
  assert.equal(calls[exactIndex]?.city, undefined);
  assert.equal(
    calls.some((call) => call.city === "广西"),
    false,
  );
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
      assert.equal(
        calls.some((call) => call.city === scenario.region),
        false,
      );
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

test("adcode 目标按行政前缀过滤同省异市同名 POI", async () => {
  const jinhuaWestLake: AmapPoi = {
    id: "JH-WEST-LAKE",
    name: "西湖风景名胜区",
    type: "风景名胜;风景名胜",
    address: "浙江省金华市婺城区",
    location: [119.65, 29.08],
    province: "浙江省",
    city: "金华市",
    district: "婺城区",
    adcode: "330700",
  };
  const hangzhouWestLake: AmapPoi = {
    id: "HZ-WEST-LAKE",
    name: "西湖风景名胜区",
    type: "风景名胜;风景名胜",
    address: "浙江省杭州市西湖区",
    location: [120.15, 30.25],
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    adcode: "330106",
  };
  const client = createFakeAmapClient(async (input) =>
    input.keywords === "西湖风景名胜区" ? [jinhuaWestLake, hangzhouWestLake] : [],
  );

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "西湖风景名胜区",
    region: "330100",
  });

  assert.deepEqual(
    result.map((candidate) => candidate.id),
    ["HZ-WEST-LAKE"],
  );
});

test("省级 region 无法唯一判城时保留同名异市候选，避免错误首条挤掉正确城市", async () => {
  const jinhuaWestLake: AmapPoi = {
    id: "JH-WEST-LAKE",
    name: "西湖风景名胜区",
    type: "风景名胜;风景名胜",
    address: "浙江省金华市婺城区",
    location: [119.65, 29.08],
    province: "浙江省",
    city: "金华市",
    district: "婺城区",
    adcode: "330700",
  };
  const hangzhouWestLake: AmapPoi = {
    id: "HZ-WEST-LAKE",
    name: "西湖风景名胜区",
    type: "风景名胜;风景名胜",
    address: "浙江省杭州市西湖区",
    location: [120.15, 30.25],
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    adcode: "330106",
  };
  const client = createFakeAmapClient(async (input) =>
    input.keywords === "西湖风景名胜区" ? [jinhuaWestLake, hangzhouWestLake] : [],
  );

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "西湖风景名胜区",
    region: "浙江省",
  });

  // 省级信息不能唯一判定城市，必须保留同名异市候选，不能按名称先到先得。
  assert.deepEqual(result.map((candidate) => candidate.id).sort(), [
    "HZ-WEST-LAKE",
    "JH-WEST-LAKE",
  ]);
});

test("短地址 POI 使用结构化城市字段通过，不因文本缺城市名被误杀", async () => {
  const lingyinTemple: AmapPoi = {
    id: "HZ-LINGYIN-TEMPLE",
    name: "灵隐寺",
    type: "风景名胜;寺庙道观",
    address: "法云弄1号",
    location: [120.1, 30.24],
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    adcode: "330106",
  };
  const client = createFakeAmapClient(async (input) =>
    input.keywords === "灵隐寺" ? [lingyinTemple] : [],
  );

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "灵隐寺",
    region: "浙江省杭州市",
  });

  assert.deepEqual(
    result.map((candidate) => candidate.id),
    ["HZ-LINGYIN-TEMPLE"],
  );
});

test("直辖市简称会作为城市查询上下文", async () => {
  const calls: { keywords: string; city?: string }[] = [];
  const forbiddenCity: AmapPoi = {
    id: "BJ-FORBIDDEN-CITY",
    name: "故宫博物院",
    type: "风景名胜;博物馆",
    address: "景山前街4号",
    location: [116.397, 39.918],
    province: "北京市",
    city: "北京市",
    district: "东城区",
    adcode: "110101",
  };
  const client = createFakeAmapClient(async (input) => {
    calls.push({ keywords: input.keywords, city: input.city });
    return input.keywords === "故宫博物院" ? [forbiddenCity] : [];
  });

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "故宫博物院",
    region: "北京",
  });

  assert.equal(calls.find((call) => call.keywords === "故宫博物院")?.city, "北京");
  assert.deepEqual(
    result.map((candidate) => candidate.id),
    ["BJ-FORBIDDEN-CITY"],
  );
});

test("多城市目的地支持任一结构化城市或文本地点匹配", async () => {
  const makePoi = (input: {
    id: string;
    city: string;
    district: string;
    adcode: string;
    address: string;
    location: AmapCoordinate;
  }): AmapPoi => ({
    id: input.id,
    name: "水乡古镇",
    type: "风景名胜;古镇",
    address: input.address,
    location: input.location,
    province: "浙江省",
    city: input.city,
    district: input.district,
    adcode: input.adcode,
  });
  const hangzhou = makePoi({
    id: "HZ-ANCIENT-TOWN",
    city: "杭州市",
    district: "西湖区",
    adcode: "330106",
    address: "浙江省杭州市西湖区",
    location: [120.15, 30.25],
  });
  const shaoxing = makePoi({
    id: "SX-ANCIENT-TOWN",
    city: "绍兴市",
    district: "越城区",
    adcode: "330602",
    address: "浙江省绍兴市越城区",
    location: [120.58, 30.03],
  });
  const wuzhen = makePoi({
    id: "WZ-ANCIENT-TOWN",
    city: "嘉兴市",
    district: "桐乡市",
    adcode: "330483",
    address: "浙江省嘉兴市桐乡市乌镇",
    location: [120.49, 30.74],
  });
  const ningbo = makePoi({
    id: "NB-ANCIENT-TOWN",
    city: "宁波市",
    district: "海曙区",
    adcode: "330203",
    address: "浙江省宁波市海曙区",
    location: [121.55, 29.87],
  });
  const client = createFakeAmapClient(async (input) =>
    input.keywords === "水乡古镇" ? [hangzhou, shaoxing, wuzhen, ningbo] : [],
  );

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "水乡古镇",
    region: "杭州 · 绍兴 · 乌镇",
  });

  assert.deepEqual(result.map((candidate) => candidate.id).sort(), [
    "HZ-ANCIENT-TOWN",
    "SX-ANCIENT-TOWN",
    "WZ-ANCIENT-TOWN",
  ]);
});

test("安徽 · 徽州软别名不会误杀黄山市和黄山区候选", async () => {
  const scenicArea = createAmapAttraction({
    id: "HS-SCENIC-AREA",
    name: "黄山风景区",
    type: "风景名胜;风景名胜",
    province: "安徽省",
    city: "黄山市",
    district: "黄山区",
    adcode: "341003",
    address: "安徽省黄山市黄山区汤口镇",
    location: [118.17, 30.07],
  });
  const hotSpring = createAmapAttraction({
    id: "HS-HOT-SPRING",
    name: "黄山温泉景区",
    type: "风景名胜;温泉",
    province: "安徽省",
    city: "黄山市",
    district: "黄山区",
    adcode: "341003",
    address: "安徽省黄山市黄山区汤泉路",
    location: [118.16, 30.08],
  });
  const client = createFakeAmapClient(async (input) =>
    input.keywords === "黄山" ? [scenicArea, hotSpring] : [],
  );

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "黄山",
    region: "安徽 · 徽州",
  });

  assert.deepEqual(result.map((candidate) => candidate.id).sort(), [
    "HS-HOT-SPRING",
    "HS-SCENIC-AREA",
  ]);
});

test("杭州市 · 乌镇允许可信城市和明确 locality 文本任一匹配", async () => {
  const hangzhou = createAmapAttraction({
    id: "HZ-WATER-TOWN",
    city: "杭州市",
    district: "西湖区",
    adcode: "330106",
    address: "浙江省杭州市西湖区",
    location: [120.15, 30.25],
  });
  const wuzhen = createAmapAttraction({
    id: "WZ-WATER-TOWN",
    city: "嘉兴市",
    district: "桐乡市",
    adcode: "330483",
    address: "浙江省嘉兴市桐乡市乌镇",
    location: [120.49, 30.74],
  });
  const ningbo = createAmapAttraction({
    id: "NB-WATER-TOWN",
    city: "宁波市",
    district: "海曙区",
    adcode: "330203",
    address: "浙江省宁波市海曙区",
    location: [121.55, 29.87],
  });
  const client = createFakeAmapClient(async (input) =>
    input.keywords === "水乡古镇" ? [hangzhou, wuzhen, ningbo] : [],
  );

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "水乡古镇",
    region: "杭州市 · 乌镇",
  });

  assert.deepEqual(result.map((candidate) => candidate.id).sort(), [
    "HZ-WATER-TOWN",
    "WZ-WATER-TOWN",
  ]);
});

test("嘉兴 · 乌镇保留嘉兴和乌镇候选并排除无关城市", async () => {
  const jiaxing = createAmapAttraction({
    id: "JX-WATER-TOWN",
    city: "嘉兴市",
    district: "南湖区",
    adcode: "330402",
    address: "浙江省嘉兴市南湖区",
    location: [120.75, 30.75],
  });
  const wuzhen = createAmapAttraction({
    id: "WZ-WATER-TOWN",
    city: "嘉兴市",
    district: "桐乡市",
    adcode: "330483",
    address: "浙江省嘉兴市桐乡市乌镇",
    location: [120.49, 30.74],
  });
  const ningbo = createAmapAttraction({
    id: "NB-WATER-TOWN",
    city: "宁波市",
    district: "海曙区",
    adcode: "330203",
    address: "浙江省宁波市海曙区",
    location: [121.55, 29.87],
  });
  const client = createFakeAmapClient(async (input) =>
    input.keywords === "水乡古镇" ? [jiaxing, wuzhen, ningbo] : [],
  );

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "水乡古镇",
    region: "嘉兴 · 乌镇",
  });

  assert.deepEqual(result.map((candidate) => candidate.id).sort(), [
    "JX-WATER-TOWN",
    "WZ-WATER-TOWN",
  ]);
});

test("长自治区名称可提取城市并过滤同自治区异地同名", async () => {
  const calls: { keywords: string; city?: string }[] = [];
  const urumqi = createAmapAttraction({
    id: "URUMQI-WATER-TOWN",
    province: "新疆维吾尔自治区",
    city: "乌鲁木齐市",
    district: "天山区",
    adcode: "650102",
    address: "新疆维吾尔自治区乌鲁木齐市天山区",
    location: [87.62, 43.83],
  });
  const turpan = createAmapAttraction({
    id: "TURPAN-WATER-TOWN",
    province: "新疆维吾尔自治区",
    city: "吐鲁番市",
    district: "高昌区",
    adcode: "650402",
    address: "新疆维吾尔自治区吐鲁番市高昌区",
    location: [89.19, 42.95],
  });
  const client = createFakeAmapClient(async (input) => {
    calls.push({ keywords: input.keywords, city: input.city });
    return input.keywords === "水乡古镇" ? [turpan, urumqi] : [];
  });

  const result = await searchAmapDestinationCandidates({
    client,
    destination: "水乡古镇",
    region: "新疆维吾尔自治区乌鲁木齐市",
  });

  assert.equal(calls.find((call) => call.keywords === "水乡古镇")?.city, "乌鲁木齐市");
  assert.deepEqual(
    result.map((candidate) => candidate.id),
    ["URUMQI-WATER-TOWN"],
  );
});

test("区县和县级市目标按结构化行政字段过滤", async () => {
  const westLakeTemple: AmapPoi = {
    id: "HZ-XIHU-TEMPLE",
    name: "灵隐寺",
    type: "风景名胜;寺庙道观",
    address: "法云弄1号",
    location: [120.1, 30.24],
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    adcode: "330106",
  };
  const yuhangTemple: AmapPoi = {
    id: "HZ-YUHANG-TEMPLE",
    name: "灵隐寺",
    type: "风景名胜;寺庙道观",
    address: "余杭塘路1号",
    location: [120.0, 30.3],
    province: "浙江省",
    city: "杭州市",
    district: "余杭区",
    adcode: "330110",
  };
  const districtClient = createFakeAmapClient(async (input) =>
    input.keywords === "灵隐寺" ? [westLakeTemple, yuhangTemple] : [],
  );

  const districtResult = await searchAmapDestinationCandidates({
    client: districtClient,
    destination: "灵隐寺",
    region: "浙江省杭州市西湖区",
  });

  assert.deepEqual(
    districtResult.map((candidate) => candidate.id),
    ["HZ-XIHU-TEMPLE"],
  );

  const yiwuOldStreet: AmapPoi = {
    id: "YW-OLD-STREET",
    name: "老街",
    type: "风景名胜;特色街区",
    address: "稠城街道",
    location: [120.08, 29.31],
    province: "浙江省",
    city: "义乌市",
    district: "",
    adcode: "330782",
  };
  const jinhuaOldStreet: AmapPoi = {
    id: "JH-OLD-STREET",
    name: "老街",
    type: "风景名胜;特色街区",
    address: "婺城区",
    location: [119.65, 29.08],
    province: "浙江省",
    city: "金华市",
    district: "婺城区",
    adcode: "330702",
  };
  const countyClient = createFakeAmapClient(async (input) =>
    input.keywords === "老街" ? [yiwuOldStreet, jinhuaOldStreet] : [],
  );

  const countyResult = await searchAmapDestinationCandidates({
    client: countyClient,
    destination: "老街",
    region: "浙江省义乌市",
  });

  assert.deepEqual(
    countyResult.map((candidate) => candidate.id),
    ["YW-OLD-STREET"],
  );
});

test("同名不同 areaKey 的候选在合并阶段不会互相去重", () => {
  const merged = mergePlannerCandidates({
    primary: [
      {
        name: "西湖风景名胜区",
        summary: "杭州西湖",
        source: "https://www.amap.com/place/hz-west-lake",
        areaKey: "杭州-西湖",
      },
      {
        name: "西湖风景名胜区",
        summary: "金华同名地点",
        source: "https://www.amap.com/place/jh-west-lake",
        areaKey: "金华-婺城",
      },
    ],
    fallback: [],
  });

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((candidate) => candidate.areaKey).sort(), ["杭州-西湖", "金华-婺城"]);
});

test("同名多 areaKey 候选只在 Tavily 补充可唯一匹配时写入", () => {
  const merged = mergePlannerCandidates({
    primary: [
      {
        name: "西湖风景名胜区",
        summary: "杭州西湖",
        source: "https://www.amap.com/place/hz-west-lake",
        areaKey: "杭州-西湖",
      },
      {
        name: "西湖风景名胜区",
        summary: "金华同名地点",
        source: "https://www.amap.com/place/jh-west-lake",
        areaKey: "金华-婺城",
      },
    ],
    fallback: [],
    supplements: [
      {
        title: "西湖风景名胜区",
        url: "https://example.com/hangzhou-west-lake",
        content: "杭州西湖资料",
        score: 0.9,
      },
      {
        title: "西湖风景名胜区",
        url: "https://example.com/generic",
        content: "通用补充资料",
        score: 0.5,
      },
    ],
  });

  assert.equal(merged[0]?.summary, "杭州西湖。杭州西湖资料");
  assert.equal(merged[1]?.summary, "金华同名地点");
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
  const candidates: DestinationCandidate[] = ["清风园", "明月湖", "望江亭"].map((name, index) => ({
    id: `candidate-${index}`,
    name,
    type: "风景名胜;风景名胜",
    address: "浙江省杭州市西湖区",
    location: [120.14 + index * 0.01, 30.24 + index * 0.01],
    publicUrl: `https://www.amap.com/place/candidate-${index}`,
    areaKey: "杭州市-西湖区",
  }));

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
