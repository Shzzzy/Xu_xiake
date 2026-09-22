import test from "node:test";
import assert from "node:assert/strict";
import type { AmapClient, AmapCoordinate, AmapRoute, RouteInput } from "./amap.server.ts";
import { prepareRouteTransportPlan } from "./planner-context.server.ts";
import type { RoutePlan, TransportMode } from "./route-planner.ts";
import { calculateTransportLeg, chooseLongDistanceMode } from "./transport-planner.server.ts";

const coordinates: Record<string, { location: AmapCoordinate; province: string }> = {
  北京: { location: [116.407526, 39.90403], province: "北京市" },
  四川: { location: [104.066541, 30.572269], province: "四川省" },
  起点: { location: [0, 0], province: "甲省" },
  终点: { location: [17.65, 0], province: "乙省" },
};

function createRoute(transport: TransportMode): RoutePlan {
  return {
    origin: "北京",
    destination: "四川",
    waypoints: [],
    roundTrip: true,
    returnMode: "fast",
    legs: [
      {
        id: "outbound:0",
        from: "北京",
        to: "四川",
        transport,
        style: "direct",
        kind: "outbound",
      },
      {
        id: "return",
        from: "四川",
        to: "北京",
        transport,
        style: "direct",
        kind: "return",
      },
    ],
  };
}

function createExact1963Route(transport: TransportMode): RoutePlan {
  return {
    origin: "起点",
    destination: "终点",
    waypoints: [],
    roundTrip: true,
    returnMode: "fast",
    legs: [
      {
        id: "outbound:0",
        from: "起点",
        to: "终点",
        transport,
        style: "direct",
        kind: "outbound",
      },
      {
        id: "return",
        from: "终点",
        to: "起点",
        transport,
        style: "direct",
        kind: "return",
      },
    ],
  };
}

function createFakeAmapClient(
  driveRoute?: Pick<AmapRoute, "distanceMeters" | "durationSeconds">,
): AmapClient {
  return {
    async searchPoi() {
      return [];
    },
    async fetchStaticMap() {
      return new Uint8Array();
    },
    async route(input: RouteInput): Promise<AmapRoute> {
      if (!driveRoute) throw new Error("本测试不应调用路线规划");
      return {
        mode: input.mode,
        origin: input.origin,
        destination: input.destination,
        distanceMeters: driveRoute.distanceMeters,
        durationSeconds: driveRoute.durationSeconds,
        path: [input.origin, input.destination],
        steps: [],
      };
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

test("跨省 1963 公里通用偏好默认飞机", () => {
  assert.equal(
    chooseLongDistanceMode({ explicit: "balanced", crossProvince: true, distanceKm: 1963 }),
    "flight",
  );
});

test("显式交通方式优先于长途默认飞机", () => {
  for (const mode of ["drive", "train", "flight", "bus", "ship"] as const) {
    assert.equal(
      chooseLongDistanceMode({ explicit: mode, crossProvince: true, distanceKm: 1963 }),
      mode,
    );
  }
});

test("跨省 800 公里边界默认飞机，799 公里回落火车", () => {
  assert.equal(
    chooseLongDistanceMode({ explicit: "balanced", crossProvince: true, distanceKm: 800 }),
    "flight",
  );
  assert.equal(
    chooseLongDistanceMode({ explicit: "balanced", crossProvince: false, distanceKm: 1963 }),
    "train",
  );
  assert.equal(
    chooseLongDistanceMode({ explicit: "speed", crossProvince: true, distanceKm: 799 }),
    "train",
  );
});

test("1963 公里飞机最低价精确为单人 1080 元", () => {
  const leg = calculateTransportLeg({ mode: "flight", distanceKm: 1963, travelers: 5 });
  assert.equal(leg.minimumPerPersonCost, 1080);
  assert.equal(1080 * 5, 5400);
  assert.equal(1080 * 5 * 2, 10800);
  assert.ok(leg.doorToDoorMinutes >= 300);
});

test("火车门到门至少 180 分钟", () => {
  const leg = calculateTransportLeg({ mode: "train", distanceKm: 1963, travelers: 5 });
  assert.ok(leg.minimumPerPersonCost > 0);
  assert.ok(leg.doorToDoorMinutes >= 180);
});

test("自驾按 AMap 时长并额外计入休息", () => {
  const leg = calculateTransportLeg({
    mode: "drive",
    distanceKm: 420,
    travelers: 5,
    routeDurationMinutes: 360,
  });

  assert.equal(leg.doorToDoorMinutes, 405);
  assert.equal(leg.minimumPerPersonCost, 101);
});

test("自驾按 5 人一车分摊并在 6 人以上拆车", () => {
  const fiveTravelers = calculateTransportLeg({
    mode: "drive",
    distanceKm: 420,
    travelers: 5,
    routeDurationMinutes: 360,
  });
  const sixTravelers = calculateTransportLeg({
    mode: "drive",
    distanceKm: 420,
    travelers: 6,
    routeDurationMinutes: 360,
  });

  assert.equal(fiveTravelers.minimumPerPersonCost, 101);
  assert.equal(sixTravelers.minimumPerPersonCost, 168);
});

test("1963 公里 5 人来回精确汇总为 10800 元", async () => {
  const preparation = await prepareRouteTransportPlan({
    client: createFakeAmapClient(),
    route: createExact1963Route("balanced"),
    startDate: "2026-10-01",
    travelers: { adults: 5, children: 0 },
    tavilyKey: "test-key",
    fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
  });

  assert.equal(preparation.status, "ready");
  assert.equal(preparation.legs.length, 2);
  assert.equal(preparation.legs[0]?.minimumPerPersonCost, 1080);
  assert.equal(preparation.legs[1]?.minimumPerPersonCost, 1080);
  assert.equal(preparation.references[0]?.minimumPartyTotal, 5400);
  assert.equal(preparation.references[1]?.minimumPartyTotal, 5400);
  assert.equal(preparation.minimumTotal, 10800);
});

test("自驾集成使用 AMap 距离和时长，同时生成每条 leg 的确定性结果", async () => {
  const preparation = await prepareRouteTransportPlan({
    client: createFakeAmapClient({ distanceMeters: 420_000, durationSeconds: 21_600 }),
    route: createRoute("drive"),
    startDate: "2026-10-01",
    travelers: { adults: 5, children: 0 },
    tavilyKey: "test-key",
    fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
  });

  assert.equal(preparation.status, "ready");
  assert.equal(preparation.legs.length, 2);
  assert.equal(preparation.legs[0]?.mode, "drive");
  assert.equal(preparation.legs[0]?.distanceKm, 420);
  assert.equal(preparation.legs[0]?.doorToDoorMinutes, 405);
  assert.equal(preparation.legs[0]?.minimumPerPersonCost, 101);
  assert.equal(preparation.minimumTotal, 1010);
});

test("缺少 AMap client 时显式 degraded 且不生成交通 leg", async () => {
  const preparation = await prepareRouteTransportPlan({
    client: null,
    route: createRoute("balanced"),
    startDate: "2026-10-01",
    travelers: { adults: 2, children: 0 },
    tavilyKey: "test-key",
    fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
  });

  assert.equal(preparation.status, "degraded");
  assert.equal(preparation.legs.length, 0);
  assert.equal(preparation.references.length, 0);
  assert.equal(preparation.minimumTotal, 0);
  assert.match(preparation.reason, /client|AMap|高德/i);
});

test("geocode 全失败时显式 degraded 且不生成交通 leg", async () => {
  const client = createFakeAmapClient();
  const preparation = await prepareRouteTransportPlan({
    client: {
      ...client,
      async geocode() {
        return [];
      },
    },
    route: createRoute("balanced"),
    startDate: "2026-10-01",
    travelers: { adults: 2, children: 0 },
    tavilyKey: "test-key",
    fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
  });

  assert.equal(preparation.status, "degraded");
  assert.equal(preparation.legs.length, 0);
  assert.equal(preparation.minimumTotal, 0);
  assert.match(preparation.reason, /geocode|地理编码|地点|高德/i);
});

test("自驾 route 抛错时显式 degraded 且不伪造时长", async () => {
  const preparation = await prepareRouteTransportPlan({
    client: createFakeAmapClient(),
    route: createRoute("drive"),
    startDate: "2026-10-01",
    travelers: { adults: 2, children: 0 },
    tavilyKey: "test-key",
    fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
  });

  assert.equal(preparation.status, "degraded");
  assert.equal(preparation.legs.length, 0);
  assert.equal(preparation.minimumTotal, 0);
  assert.match(preparation.reason, /route|路线|驾车|高德/i);
});

test("自驾 route 缺 duration 时显式 degraded 且不伪造时长", async () => {
  const preparation = await prepareRouteTransportPlan({
    client: createFakeAmapClient({ distanceMeters: 420_000, durationSeconds: 0 }),
    route: createRoute("drive"),
    startDate: "2026-10-01",
    travelers: { adults: 2, children: 0 },
    tavilyKey: "test-key",
    fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
  });

  assert.equal(preparation.status, "degraded");
  assert.equal(preparation.legs.length, 0);
  assert.equal(preparation.minimumTotal, 0);
  assert.match(preparation.reason, /duration|时长|驾车|路线|高德/i);
});
test("超长自驾在 prepareRouteTransportPlan 中按每日上限生成守恒分段", async () => {
  const preparation = await prepareRouteTransportPlan({
    client: createFakeAmapClient({ distanceMeters: 2_651_700, durationSeconds: 100_860 }),
    route: createRoute("drive"),
    startDate: "2026-10-01",
    travelers: { adults: 3, children: 0 },
    tavilyKey: "test-key",
    dailyDriveLimitMinutes: 330,
    fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
  });

  assert.equal(preparation.status, "ready");
  const driveLeg = preparation.legs[0];
  assert.ok(driveLeg?.executionSegments && driveLeg.executionSegments.length >= 3);
  assert.ok(driveLeg.executionSegments.every((segment) => segment.doorToDoorMinutes <= 330));
  assert.equal(
    driveLeg.executionSegments.reduce((total, segment) => total + segment.doorToDoorMinutes, 0),
    driveLeg.doorToDoorMinutes,
  );
  assert.ok(
    Math.abs(
      driveLeg.executionSegments.reduce((total, segment) => total + segment.distanceKm, 0) -
        driveLeg.distanceKm,
    ) < 0.2,
  );
});
