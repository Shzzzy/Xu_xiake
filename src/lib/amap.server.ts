export type AmapCoordinate = [longitude: number, latitude: number];

export type StaticMapPoint = {
  longitude: number;
  latitude: number;
};

export type StaticMapInput = {
  outbound: StaticMapPoint[];
  returnPath?: StaticMapPoint[];
  returnMode?: "fast" | "scenic" | null;
  apiKey?: string;
  zoom?: number;
  size?: { width: number; height: number };
};

export type NavigationInput = {
  from: AmapCoordinate;
  to: AmapCoordinate;
  mode: "car" | "walking" | "bicycling" | "transit" | "subway";
  fromName?: string;
  toName?: string;
};

const AMAP_STATIC_MAP_URL = "https://restapi.amap.com/v3/staticmap";
const AMAP_NAVIGATION_URL = "https://uri.amap.com/navigation";
const OUTBOUND_COLOR = "0x4A7C8A";
const RETURN_COLOR = "0xC96442";
const FAST_RETURN_COLOR = "0x8A6A58";

function formatPoint(point: StaticMapPoint): string {
  return `${point.longitude},${point.latitude}`;
}

function formatPath(points: StaticMapPoint[], color: string): string {
  return `10,${color},1,,:${points.map(formatPoint).join(";")}`;
}

function formatMarker(point: StaticMapPoint, label: string, color: string): string {
  return `mid,${color},${label}:${formatPoint(point)}`;
}

export function buildStaticMapUrl(input: StaticMapInput): string {
  const url = new URL(AMAP_STATIC_MAP_URL);
  const size = input.size ?? { width: 750, height: 500 };

  url.searchParams.set("zoom", String(input.zoom ?? 10));
  url.searchParams.set("size", `${size.width}*${size.height}`);

  const paths = [formatPath(input.outbound, OUTBOUND_COLOR)];
  if (input.returnPath?.length) {
    const color = input.returnMode === "fast" ? FAST_RETURN_COLOR : RETURN_COLOR;
    paths.push(formatPath(input.returnPath, color));
  }
  url.searchParams.set("paths", paths.join("|"));

  const markers = [
    formatMarker(input.outbound[0], "A", OUTBOUND_COLOR),
    formatMarker(input.outbound.at(-1) ?? input.outbound[0], "B", OUTBOUND_COLOR),
  ];
  if (input.returnPath?.length) {
    const color = input.returnMode === "fast" ? FAST_RETURN_COLOR : RETURN_COLOR;
    markers.push(formatMarker(input.returnPath.at(-1) as StaticMapPoint, "C", color));
  }
  url.searchParams.set("markers", markers.join("|"));

  if (input.apiKey) url.searchParams.set("key", input.apiKey);
  return url.toString();
}

export function buildNavigationUrl(input: NavigationInput): string {
  const url = new URL(AMAP_NAVIGATION_URL);
  const navigationMode = {
    car: "car",
    walking: "walk",
    bicycling: "ride",
    transit: "bus",
    subway: "bus",
  }[input.mode];
  const formatCoordinate = (coordinate: AmapCoordinate, name?: string) =>
    `${coordinate[0]},${coordinate[1]}${name ? `,${name}` : ""}`;

  url.searchParams.set("from", formatCoordinate(input.from, input.fromName));
  url.searchParams.set("to", formatCoordinate(input.to, input.toName));
  url.searchParams.set("mode", navigationMode);
  url.searchParams.set("coordinate", "gaode");
  url.searchParams.set("callnative", "0");
  return url.toString();
}
export type AmapRouteMode = "car" | "walking" | "bicycling" | "transit" | "subway";

export type AmapPoi = {
  id: string;
  name: string;
  type: string;
  address: string;
  location: AmapCoordinate;
  tel?: string;
  distanceMeters?: number;
};

export type AmapRouteStep = {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  path: AmapCoordinate[];
  lineName?: string;
};

export type AmapRoute = {
  mode: AmapRouteMode;
  origin: AmapCoordinate;
  destination: AmapCoordinate;
  distanceMeters: number;
  durationSeconds: number;
  path: AmapCoordinate[];
  steps: AmapRouteStep[];
};

export type AmapGeocode = {
  formattedAddress: string;
  province: string;
  city: string;
  district: string;
  adcode: string;
  location: AmapCoordinate;
  level?: string;
};

export type AmapWeatherForecast = {
  date: string;
  week: string;
  dayWeather: string;
  nightWeather: string;
  dayTemperature: number;
  nightTemperature: number;
  dayWind: string;
  nightWind: string;
  dayPower: string;
  nightPower: string;
};

export type AmapWeather = {
  city: string;
  province: string;
  reportTime: string;
  forecasts: AmapWeatherForecast[];
};

export type SearchPoiInput = {
  keywords: string;
  city?: string;
  page?: number;
  pageSize?: number;
};

export type RouteInput = {
  origin: AmapCoordinate;
  destination: AmapCoordinate;
  mode: AmapRouteMode;
  waypoints?: AmapCoordinate[];
  city?: string;
  destinationCity?: string;
  strategy?: number;
};

export type GeocodeInput = {
  address: string;
  city?: string;
};

export type WeatherInput = {
  city: string;
  extensions?: "base" | "all";
};

export type AmapClient = {
  searchPoi(input: SearchPoiInput): Promise<AmapPoi[]>;
  route(input: RouteInput): Promise<AmapRoute>;
  geocode(input: GeocodeInput): Promise<AmapGeocode[]>;
  weather(input: WeatherInput): Promise<AmapWeather[]>;
};

const AMAP_REST_API_URL = "https://restapi.amap.com";
const AMAP_REQUEST_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalText(value: unknown): string | undefined {
  const text = asText(value);
  return text || undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseCoordinate(value: unknown): AmapCoordinate | null {
  const text = asText(value);
  if (!text) return null;
  const [longitudeText, latitudeText] = text.split(",");
  const longitude = Number(longitudeText);
  const latitude = Number(latitudeText);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return [longitude, latitude];
}

function coordinateQuery(coordinate: AmapCoordinate): string {
  const [longitude, latitude] = coordinate;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error("高德坐标必须是有效的经度和纬度");
  }
  return `${longitude},${latitude}`;
}

function buildRestUrl(path: string, apiKey: string, params: Record<string, string | undefined>) {
  const url = new URL(path, AMAP_REST_API_URL);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

function errorDetail(payload: JsonRecord): string {
  const info = asText(payload.info) || asText(payload.errmsg) || "未知错误";
  const code =
    asText(payload.infocode) || (payload.errcode !== undefined ? String(payload.errcode) : "");
  return code ? `${info}（${code}）` : info;
}

async function requestAmapJson(
  operation: string,
  url: URL,
  fetchImpl: typeof fetch,
): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(AMAP_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const detail =
      error instanceof Error && error.name === "TimeoutError" ? "请求超时" : "网络请求失败";
    throw new Error(`高德 ${operation}失败：${detail}`);
  }

  if (!response.ok) {
    throw new Error(`高德 ${operation}失败（HTTP ${response.status}）`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`高德 ${operation}失败：返回内容不是合法 JSON`);
  }

  const record = asRecord(payload);
  const status = asText(record.status);
  const errorCode = asNumber(record.errcode);
  if ((status && status !== "1") || (errorCode !== undefined && errorCode !== 0)) {
    throw new Error(`高德 ${operation}失败：${errorDetail(record)}`);
  }
  return record;
}

function normalizePoi(value: unknown): AmapPoi | null {
  const poi = asRecord(value);
  const location = parseCoordinate(poi.location);
  const name = asText(poi.name);
  if (!location || !name) return null;
  const distanceMeters = asNumber(poi.distance);
  return {
    id: asText(poi.id),
    name,
    type: asText(poi.type),
    address: asText(poi.address),
    location,
    ...(asOptionalText(poi.tel) ? { tel: asText(poi.tel) } : {}),
    ...(distanceMeters !== undefined ? { distanceMeters } : {}),
  };
}

function normalizeStep(value: unknown, fallbackInstruction: string): AmapRouteStep | null {
  const step = asRecord(value);
  const path = parseCoordinateList(step.polyline);
  if (path.length === 0 && !asText(step.instruction)) return null;
  return {
    instruction: asText(step.instruction) || fallbackInstruction,
    distanceMeters: asNumber(step.distance) ?? 0,
    durationSeconds: asNumber(step.duration) ?? 0,
    path,
  };
}

function parseCoordinateList(value: unknown): AmapCoordinate[] {
  const text = asText(value);
  if (!text) return [];
  return text
    .split(";")
    .map(parseCoordinate)
    .filter((coordinate): coordinate is AmapCoordinate => coordinate !== null);
}

function appendPath(target: AmapCoordinate[], source: AmapCoordinate[]) {
  for (const coordinate of source) {
    const previous = target.at(-1);
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
      target.push(coordinate);
    }
  }
}

function normalizePathRoute(value: unknown, input: RouteInput): AmapRoute {
  const pathRow = asRecord(value);
  const steps = asArray(pathRow.steps)
    .map((step) => normalizeStep(step, "继续前行"))
    .filter((step): step is AmapRouteStep => step !== null);
  const path: AmapCoordinate[] = [];
  for (const step of steps) appendPath(path, step.path);

  return {
    mode: input.mode,
    origin: input.origin,
    destination: input.destination,
    distanceMeters: asNumber(pathRow.distance) ?? 0,
    durationSeconds: asNumber(pathRow.duration) ?? 0,
    path,
    steps,
  };
}

function normalizeTransitRoute(value: unknown, input: RouteInput): AmapRoute {
  const transit = asRecord(value);
  const steps: AmapRouteStep[] = [];

  for (const rawSegment of asArray(transit.segments)) {
    const segment = asRecord(rawSegment);
    const walking = asRecord(segment.walking);
    const walkingSteps = asArray(walking.steps)
      .map((step) => normalizeStep(step, "步行"))
      .filter((step): step is AmapRouteStep => step !== null);
    if (walkingSteps.length > 0) {
      steps.push(...walkingSteps);
    } else {
      const path = parseCoordinateList(walking.polyline);
      if (path.length > 0) {
        steps.push({
          instruction: "步行",
          distanceMeters: asNumber(walking.distance) ?? 0,
          durationSeconds: asNumber(walking.duration) ?? 0,
          path,
        });
      }
    }

    const bus = asRecord(segment.bus);
    for (const rawLine of asArray(bus.buslines)) {
      const line = asRecord(rawLine);
      const lineName = asText(line.name);
      const path = parseCoordinateList(line.polyline);
      if (!lineName && path.length === 0) continue;
      steps.push({
        instruction: lineName ? `乘坐${lineName}` : "乘坐公共交通",
        distanceMeters: asNumber(line.distance) ?? 0,
        durationSeconds: asNumber(line.duration) ?? 0,
        path,
        ...(lineName ? { lineName } : {}),
      });
    }
  }

  const path: AmapCoordinate[] = [];
  for (const step of steps) appendPath(path, step.path);

  return {
    mode: input.mode,
    origin: input.origin,
    destination: input.destination,
    distanceMeters:
      asNumber(transit.distance) ?? steps.reduce((total, step) => total + step.distanceMeters, 0),
    durationSeconds:
      asNumber(transit.duration) ?? steps.reduce((total, step) => total + step.durationSeconds, 0),
    path,
    steps,
  };
}

function routeEndpoint(mode: AmapRouteMode): string {
  return {
    car: "/v3/direction/driving",
    walking: "/v3/direction/walking",
    bicycling: "/v4/direction/bicycling",
    transit: "/v3/direction/transit/integrated",
    // 高德没有独立的地铁路线接口，地铁使用公交综合换乘接口计算。
    subway: "/v3/direction/transit/integrated",
  }[mode];
}

export function createAmapClient(apiKey: string, fetchImpl: typeof fetch = fetch): AmapClient {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) throw new Error("高德 API Key 不能为空");

  return {
    async searchPoi(input) {
      const url = buildRestUrl("/v3/place/text", normalizedKey, {
        keywords: input.keywords.trim(),
        city: input.city?.trim(),
        page: String(input.page ?? 1),
        offset: String(input.pageSize ?? 20),
        extensions: "all",
      });
      const payload = await requestAmapJson("POI 搜索", url, fetchImpl);
      return asArray(payload.pois)
        .map(normalizePoi)
        .filter((poi): poi is AmapPoi => poi !== null);
    },

    async route(input) {
      const waypoints = input.waypoints?.map(coordinateQuery).join(";");
      const isTransit = input.mode === "transit" || input.mode === "subway";
      const url = buildRestUrl(routeEndpoint(input.mode), normalizedKey, {
        origin: coordinateQuery(input.origin),
        destination: coordinateQuery(input.destination),
        waypoints,
        city: isTransit ? input.city?.trim() : undefined,
        cityd: isTransit ? input.destinationCity?.trim() : undefined,
        strategy:
          input.strategy !== undefined ? String(input.strategy) : isTransit ? "0" : undefined,
        extensions: input.mode === "car" || isTransit ? "all" : undefined,
      });
      const payload = await requestAmapJson(`${input.mode} 路线规划`, url, fetchImpl);

      if (isTransit) {
        const route = asRecord(payload.route);
        return normalizeTransitRoute(asArray(route.transits)[0], input);
      }

      const routeRoot =
        input.mode === "bicycling" ? asRecord(payload.data) : asRecord(payload.route);
      return normalizePathRoute(asArray(routeRoot.paths)[0], input);
    },

    async geocode(input) {
      const url = buildRestUrl("/v3/geocode/geo", normalizedKey, {
        address: input.address.trim(),
        city: input.city?.trim(),
      });
      const payload = await requestAmapJson("地理编码", url, fetchImpl);
      return asArray(payload.geocodes).flatMap((value) => {
        const geocode = asRecord(value);
        const location = parseCoordinate(geocode.location);
        if (!location) return [];
        return [
          {
            formattedAddress: asText(geocode.formatted_address),
            province: asText(geocode.province),
            city: asText(geocode.city),
            district: asText(geocode.district),
            adcode: asText(geocode.adcode),
            location,
            ...(asOptionalText(geocode.level) ? { level: asText(geocode.level) } : {}),
          },
        ];
      });
    },

    async weather(input) {
      const url = buildRestUrl("/v3/weather/weatherInfo", normalizedKey, {
        city: input.city.trim(),
        extensions: input.extensions ?? "all",
      });
      const payload = await requestAmapJson("天气查询", url, fetchImpl);
      const forecasts = asArray(payload.forecasts);
      if (forecasts.length > 0) {
        return forecasts.map((value) => {
          const forecast = asRecord(value);
          return {
            city: asText(forecast.city),
            province: asText(forecast.province),
            reportTime: asText(forecast.reporttime),
            forecasts: asArray(forecast.casts).map((castValue) => {
              const cast = asRecord(castValue);
              return {
                date: asText(cast.date),
                week: asText(cast.week),
                dayWeather: asText(cast.dayweather),
                nightWeather: asText(cast.nightweather),
                dayTemperature: asNumber(cast.daytemp) ?? 0,
                nightTemperature: asNumber(cast.nighttemp) ?? 0,
                dayWind: asText(cast.daywind),
                nightWind: asText(cast.nightwind),
                dayPower: asText(cast.daypower),
                nightPower: asText(cast.nightpower),
              };
            }),
          };
        });
      }

      return asArray(payload.lives).map((value) => {
        const live = asRecord(value);
        return {
          city: asText(live.city),
          province: asText(live.province),
          reportTime: asText(live.reporttime),
          forecasts: [
            {
              date: "",
              week: asText(live.week),
              dayWeather: asText(live.weather),
              nightWeather: asText(live.weather),
              dayTemperature: asNumber(live.temperature) ?? 0,
              nightTemperature: asNumber(live.temperature) ?? 0,
              dayWind: asText(live.winddirection),
              nightWind: asText(live.winddirection),
              dayPower: asText(live.windpower),
              nightPower: asText(live.windpower),
            },
          ],
        };
      });
    },
  };
}
