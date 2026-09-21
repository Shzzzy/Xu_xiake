import test from "node:test";
import assert from "node:assert/strict";
import type { AmapClient, AmapCoordinate, AmapRoute, RouteInput } from "./amap.server.ts";
import { prepareRouteTransportPlan } from "./planner-context.server.ts";
import type { RoutePlan, TransportMode } from "./route-planner.ts";
import {
  calculateTransportLeg,
  chooseLongDistanceMode,
} from "./transport-planner.server.ts";

const coordinates: Record<string, { location: AmapCoordinate; province: string }> = {
  北京: { location: [116.407526, 39.90403], province: "北京市" },
  四川: { location: [104.066541, 30.572269], province: "四川省" },
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

test("不满足跨省 800 公里阈值时通用偏好回落火车", () => {
  assert.equal(
    chooseLongDistanceMode({ explicit: "balanced", crossProvince: false, distanceKm: 1963 }),
    "train",
  );
  assert.equal(
    chooseLongDistanceMode({ explicit: "speed", crossProvince: true, distanceKm: 799 }),
    "train",
  );
});

test("飞机门到门至少 300 分钟且最低价按单人计算", () => {
  const leg = calculateTransportLeg({ mode: "flight", distanceKm: 1963, travelers: 5 });
  assert.ok(leg.minimumPerPersonCost >= 1000);
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
  assert.ok(leg.minimumPerPersonCost > 0);
});

test("5 人往返交通按两条 leg 的单人最低价汇总", async () => {
  const preparation = await prepareRouteTransportPlan({
    client: createFakeAmapClient(),
    route: createRoute("balanced"),
    startDate: "2026-10-01",
    travelers: { adults: 5, children: 0 },
    tavilyKey: "test-key",
    fetchImpl: (async () => Response.json({ results: [] })) as typeof fetch,
  });
  const expectedTotal = preparation.legs.reduce(
    (total, leg) => total + leg.minimumPerPersonCost * 5,
    0,
  );

  assert.equal(preparation.legs.length, 2);
  assert.equal(preparation.minimumTotal, expectedTotal);
  assert.ok(preparation.minimumTotal > (preparation.legs[0]?.minimumPerPersonCost ?? 0));
  assert.ok(preparation.minimumTotal >= 8000);
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

  assert.equal(preparation.legs.length, 2);
  assert.equal(preparation.legs[0]?.mode, "drive");
  assert.equal(preparation.legs[0]?.distanceKm, 420);
  assert.equal(preparation.legs[0]?.doorToDoorMinutes, 405);
  assert.ok(preparation.minimumTotal > (preparation.legs[0]?.minimumPerPersonCost ?? 0));
});
