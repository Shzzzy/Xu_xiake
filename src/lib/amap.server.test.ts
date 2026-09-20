import test from "node:test";
import assert from "node:assert/strict";

import { buildNavigationUrl, buildStaticMapUrl } from "./amap.server.ts";

test("builds separate outbound and return path styles", () => {
  const url = buildStaticMapUrl({
    outbound: [
      { longitude: 120.15, latitude: 30.27 },
      { longitude: 120.49, latitude: 30.74 },
    ],
    returnPath: [
      { longitude: 120.49, latitude: 30.74 },
      { longitude: 120.15, latitude: 30.27 },
    ],
    returnMode: "scenic",
  });

  assert.match(url, /0x4A7C8A/);
  assert.match(url, /0xC96442/);
});

test("returns a navigation URL with coordinates", () => {
  const url = buildNavigationUrl({
    from: [120.15, 30.27],
    to: [120.49, 30.74],
    mode: "car",
  });

  assert.match(url, /uri\.amap\.com/);
  assert.match(url, /120\.15%2C30\.27/);
  assert.match(url, /120\.49%2C30\.74/);
});
import { createAmapClient } from "./amap.server.ts";

type FetchCall = { url: URL; init?: RequestInit };

function recordingFetch(payloadFor: (url: URL) => unknown) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return Response.json(payloadFor(url));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("searches POIs with server credentials and normalizes coordinates", async () => {
  const { calls, fetchImpl } = recordingFetch(() => ({
    status: "1",
    pois: [
      {
        id: "B023B0",
        name: "西湖风景名胜区",
        type: "风景名胜;公园广场",
        address: "龙井路1号",
        location: "120.15,30.27",
        tel: "0571-12345",
        distance: "850",
      },
    ],
  }));
  const client = createAmapClient("server-key", fetchImpl);

  const pois = await client.searchPoi({
    keywords: "西湖",
    city: "杭州",
    page: 2,
    pageSize: 10,
  });

  assert.deepEqual(pois, [
    {
      id: "B023B0",
      name: "西湖风景名胜区",
      type: "风景名胜;公园广场",
      address: "龙井路1号",
      location: [120.15, 30.27],
      tel: "0571-12345",
      distanceMeters: 850,
    },
  ]);
  const call = calls[0];
  assert.equal(call?.url.pathname, "/v3/place/text");
  assert.equal(call?.url.searchParams.get("key"), "server-key");
  assert.equal(call?.url.searchParams.get("keywords"), "西湖");
  assert.equal(call?.url.searchParams.get("city"), "杭州");
  assert.equal(call?.url.searchParams.get("page"), "2");
  assert.equal(call?.url.searchParams.get("offset"), "10");
  assert.equal(call?.url.searchParams.get("extensions"), "all");
  assert.ok(call?.init?.signal);
});

test("routes every supported travel mode through the matching AMap endpoint", async () => {
  const { calls, fetchImpl } = recordingFetch((url) => {
    if (url.pathname === "/v4/direction/bicycling") {
      return {
        errcode: 0,
        data: {
          paths: [
            {
              distance: "900",
              duration: "300",
              steps: [
                {
                  instruction: "沿西湖骑行",
                  distance: "900",
                  duration: "300",
                  polyline: "120.15,30.27;120.16,30.28",
                },
              ],
            },
          ],
        },
      };
    }
    if (url.pathname === "/v3/direction/transit/integrated") {
      return {
        status: "1",
        route: {
          transits: [
            {
              distance: "5000",
              duration: "1200",
              segments: [
                {
                  walking: {
                    distance: "300",
                    duration: "180",
                    steps: [
                      {
                        instruction: "步行至地铁站",
                        polyline: "120.15,30.27;120.16,30.28",
                      },
                    ],
                  },
                  bus: {
                    buslines: [
                      {
                        name: "地铁 1 号线",
                        distance: "4700",
                        duration: "1020",
                        polyline: "120.16,30.28;120.49,30.74",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      };
    }
    return {
      status: "1",
      route: {
        paths: [
          {
            distance: "1234",
            duration: "456",
            steps: [
              {
                instruction: "沿主路行驶",
                distance: "1234",
                duration: "456",
                polyline: "120.15,30.27;120.49,30.74",
              },
            ],
          },
        ],
      },
    };
  });
  const client = createAmapClient("server-key", fetchImpl);
  const routes = [];

  for (const mode of ["car", "walking", "bicycling", "transit", "subway"] as const) {
    routes.push(
      await client.route({
        origin: [120.15, 30.27],
        destination: [120.49, 30.74],
        mode,
        city: "0571",
        destinationCity: "0571",
      }),
    );
  }

  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    [
      "/v3/direction/driving",
      "/v3/direction/walking",
      "/v4/direction/bicycling",
      "/v3/direction/transit/integrated",
      "/v3/direction/transit/integrated",
    ],
  );
  assert.equal(calls[0]?.url.searchParams.get("origin"), "120.15,30.27");
  assert.equal(calls[0]?.url.searchParams.get("destination"), "120.49,30.74");
  assert.equal(calls[3]?.url.searchParams.get("city"), "0571");
  assert.equal(calls[3]?.url.searchParams.get("cityd"), "0571");
  assert.equal(routes[0]?.distanceMeters, 1234);
  assert.equal(routes[0]?.durationSeconds, 456);
  assert.deepEqual(routes[0]?.path, [
    [120.15, 30.27],
    [120.49, 30.74],
  ]);
  assert.equal(routes[2]?.distanceMeters, 900);
  assert.equal(routes[3]?.steps[1]?.lineName, "地铁 1 号线");
  assert.deepEqual(routes[3]?.path, [
    [120.15, 30.27],
    [120.16, 30.28],
    [120.49, 30.74],
  ]);
});

test("geocodes addresses and reads all weather forecasts", async () => {
  const { calls, fetchImpl } = recordingFetch((url) => {
    if (url.pathname === "/v3/geocode/geo") {
      return {
        status: "1",
        geocodes: [
          {
            formatted_address: "浙江省杭州市西湖区龙井路1号",
            province: "浙江省",
            city: "杭州市",
            district: "西湖区",
            adcode: "330106",
            location: "120.15,30.27",
            level: "门牌号",
          },
        ],
      };
    }
    return {
      status: "1",
      forecasts: [
        {
          city: "杭州市",
          province: "浙江省",
          reporttime: "2026-09-20 10:00:00",
          casts: [
            {
              date: "2026-09-20",
              week: "星期日",
              dayweather: "晴",
              nightweather: "多云",
              daytemp: "28",
              nighttemp: "19",
              daywind: "东",
              nightwind: "东南",
              daypower: "1-3",
              nightpower: "1-3",
            },
          ],
        },
      ],
    };
  });
  const client = createAmapClient("server-key", fetchImpl);

  const geocodes = await client.geocode({ address: "龙井路1号", city: "杭州" });
  const weather = await client.weather({ city: "杭州", extensions: "all" });

  assert.deepEqual(geocodes[0], {
    formattedAddress: "浙江省杭州市西湖区龙井路1号",
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    adcode: "330106",
    location: [120.15, 30.27],
    level: "门牌号",
  });
  assert.deepEqual(weather[0], {
    city: "杭州市",
    province: "浙江省",
    reportTime: "2026-09-20 10:00:00",
    forecasts: [
      {
        date: "2026-09-20",
        week: "星期日",
        dayWeather: "晴",
        nightWeather: "多云",
        dayTemperature: 28,
        nightTemperature: 19,
        dayWind: "东",
        nightWind: "东南",
        dayPower: "1-3",
        nightPower: "1-3",
      },
    ],
  });
  assert.equal(calls[0]?.url.pathname, "/v3/geocode/geo");
  assert.equal(calls[0]?.url.searchParams.get("address"), "龙井路1号");
  assert.equal(calls[1]?.url.pathname, "/v3/weather/weatherInfo");
  assert.equal(calls[1]?.url.searchParams.get("extensions"), "all");
});

test("reports AMap business errors with the operation name", async () => {
  const { fetchImpl } = recordingFetch(() => ({
    status: "0",
    info: "INVALID_USER_KEY",
    infocode: "10001",
  }));
  const client = createAmapClient("bad-key", fetchImpl);

  await assert.rejects(
    () => client.searchPoi({ keywords: "西湖" }),
    /高德 POI 搜索失败：INVALID_USER_KEY（10001）/,
  );
});

test("maps every navigation mode to the AMap URI API mode", () => {
  const expected = {
    car: "car",
    walking: "walk",
    bicycling: "ride",
    transit: "bus",
    subway: "bus",
  } as const;

  for (const [mode, uriMode] of Object.entries(expected)) {
    const url = new URL(
      buildNavigationUrl({
        from: [120.15, 30.27],
        to: [120.49, 30.74],
        mode: mode as keyof typeof expected,
      }),
    );
    assert.equal(url.searchParams.get("mode"), uriMode);
  }
});
