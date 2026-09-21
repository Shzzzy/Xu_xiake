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
        pname: "浙江省",
        cityname: "杭州市",
        adname: "西湖区",
        adcode: "330106",
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
      province: "浙江省",
      city: "杭州市",
      district: "西湖区",
      adcode: "330106",
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

test("encodes static map path order, colors, coordinates and marker ownership", () => {
  const url = new URL(
    buildStaticMapUrl({
      outbound: [
        { longitude: 120.15, latitude: 30.27 },
        { longitude: 120.49, latitude: 30.74 },
      ],
      returnPath: [
        { longitude: 120.49, latitude: 30.74 },
        { longitude: 120.15, latitude: 30.27 },
      ],
      returnMode: "scenic",
    }),
  );

  assert.equal(
    url.searchParams.get("paths"),
    "10,0x4A7C8A,1,,:120.15,30.27;120.49,30.74|10,0xC96442,1,,:120.49,30.74;120.15,30.27",
  );
  assert.equal(
    url.searchParams.get("markers"),
    "mid,0x4A7C8A,A:120.15,30.27|mid,0x4A7C8A,B:120.49,30.74|mid,0xC96442,C:120.15,30.27",
  );
});

test("keeps the AMap key out of public static map URLs and returned bytes", async () => {
  const input = {
    outbound: [
      { longitude: 120.15, latitude: 30.27 },
      { longitude: 120.49, latitude: 30.74 },
    ],
    returnPath: [
      { longitude: 120.49, latitude: 30.74 },
      { longitude: 120.15, latitude: 30.27 },
    ],
    returnMode: "scenic" as const,
    apiKey: "server-key-must-not-leak",
  };
  const publicUrl = new URL(buildStaticMapUrl(input));
  assert.equal(publicUrl.searchParams.has("key"), false);

  const calls: FetchCall[] = [];
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const fetchImpl = (async (request: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(request)), init });
    return new Response(imageBytes, { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  const client = createAmapClient("server-key-must-not-leak", fetchImpl);

  const bytes = await client.fetchStaticMap(input);

  assert.equal(calls[0]?.url.searchParams.get("key"), "server-key-must-not-leak");
  assert.deepEqual(Array.from(bytes), Array.from(imageBytes));
  assert.equal(new TextDecoder().decode(bytes).includes("server-key-must-not-leak"), false);
});

test("rejects a bus-only transit candidate when subway is requested", async () => {
  const { fetchImpl } = recordingFetch(() => ({
    status: "1",
    route: {
      transits: [
        {
          distance: "5000",
          duration: "1200",
          segments: [
            {
              bus: {
                buslines: [
                  {
                    name: "公交 7 路",
                    type: "公交线路",
                    distance: "5000",
                    duration: "1200",
                    polyline: "120.15,30.27;120.49,30.74",
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  }));
  const client = createAmapClient("server-key", fetchImpl);

  await assert.rejects(
    () =>
      client.route({
        origin: [120.15, 30.27],
        destination: [120.49, 30.74],
        mode: "subway",
        city: "0571",
        destinationCity: "0571",
      }),
    /未包含地铁线路/,
  );
});

test("keeps subway line metadata when a subway candidate is present", async () => {
  const { fetchImpl } = recordingFetch(() => ({
    status: "1",
    route: {
      transits: [
        {
          distance: "5000",
          duration: "1200",
          segments: [
            {
              bus: {
                buslines: [
                  {
                    name: "地铁 1 号线",
                    type: "地铁线路",
                    distance: "5000",
                    duration: "1200",
                    polyline: "120.15,30.27;120.49,30.74",
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  }));
  const client = createAmapClient("server-key", fetchImpl);

  const route = await client.route({
    origin: [120.15, 30.27],
    destination: [120.49, 30.74],
    mode: "subway",
    city: "0571",
    destinationCity: "0571",
  });

  assert.equal(route.steps[0]?.lineType, "地铁线路");
});

test("requires native v3 status and v4 errcode fields", async () => {
  const v3 = recordingFetch(() => ({ info: "OK" }));
  const v3Client = createAmapClient("server-key", v3.fetchImpl);
  await assert.rejects(() => v3Client.searchPoi({ keywords: "西湖" }), /缺少 status/);

  const v4 = recordingFetch(() => ({
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
  }));
  const v4Client = createAmapClient("server-key", v4.fetchImpl);
  await assert.rejects(
    () =>
      v4Client.route({ origin: [120.15, 30.27], destination: [120.49, 30.74], mode: "bicycling" }),
    /缺少 errcode/,
  );
});

test("rejects successful responses without a usable route candidate", async () => {
  const payloads = [
    { status: "1" },
    { status: "1", route: { paths: [] } },
    { status: "1", route: { transits: [] } },
  ];

  for (const [index, payload] of payloads.entries()) {
    const { fetchImpl } = recordingFetch(() => payload);
    const client = createAmapClient("server-key", fetchImpl);
    const mode = index === 2 ? "transit" : "car";
    const options = {
      origin: [120.15, 30.27] as [number, number],
      destination: [120.49, 30.74] as [number, number],
      mode,
      ...(mode === "transit" ? { city: "0571", destinationCity: "0571" } : {}),
    } as const;

    await assert.rejects(
      () => client.route(options),
      index === 2 ? /未找到有效的公共交通路线/ : /未返回可用的路线/,
    );
  }
});

test("rejects empty outbound routes and out-of-range coordinates", async () => {
  assert.throws(() => buildStaticMapUrl({ outbound: [] }), /至少需要去程坐标/);
  assert.throws(
    () => buildStaticMapUrl({ outbound: [{ longitude: 181, latitude: 30 }] }),
    /经度必须在 -180 到 180 之间/,
  );
  assert.throws(
    () => buildStaticMapUrl({ outbound: [{ longitude: 120, latitude: -91 }] }),
    /纬度必须在 -90 到 90 之间/,
  );
  assert.throws(
    () => buildNavigationUrl({ from: [181, 30], to: [120, 30], mode: "car" }),
    /经度必须在 -180 到 180 之间/,
  );

  const client = createAmapClient("server-key", (async () =>
    Response.json({ status: "1" })) as typeof fetch);
  await assert.rejects(
    () => client.route({ origin: [181, 30], destination: [120, 30], mode: "car" }),
    /经度必须在 -180 到 180 之间/,
  );
});
