import {
  buildNavigationUrl,
  buildStaticMapUrl,
  createAmapClient,
  type AmapClient,
  type AmapCoordinate,
  type AmapRoute,
  type AmapRouteMode,
  type NavigationInput,
} from "./amap.server.ts";
import type {
  RouteSegment,
  TripDay,
  TripPlan,
  TripTimelineNode,
  TripRoute,
} from "./travel-plan.ts";

const MAX_POI_LOOKUPS = 24;
const MAX_ROUTE_MAP_POINTS = 40;
const MAX_DAY_MAP_POINTS = 24;
const MAP_OPERATION_CONCURRENCY = 6;
const SENSITIVE_QUERY_KEYS = new Set([
  "key",
  "api_key",
  "apikey",
  "access_key",
  "accesskey",
  "secret",
  "token",
]);

export type GuidebookMapEnrichmentOptions = {
  /** 仅允许服务端注入；传 null 表示显式禁用环境变量回退。 */
  amapKey?: string | null;
  /** 确定性测试和调用方可注入 fake client。 */
  amapClient?: AmapClient;
  fetchImpl?: typeof fetch;
  /** 上报降级原因，调用方可在不包含密钥的前提下记录日志。 */
  onError?: (message: string) => void;
};

type ErrorReporter = (message: string) => void;

type CoordinateResolver = {
  resolveAddress(address: string, city?: string): Promise<AmapCoordinate | null>;
  resolvePlace(
    name: string,
    location: string | undefined,
    city: string,
  ): Promise<AmapCoordinate | null>;
};

type RouteResolver = (
  origin: AmapCoordinate,
  destination: AmapCoordinate,
  mode: AmapRouteMode,
) => Promise<AmapRoute | null>;

type EnrichedRoute = {
  route: TripRoute;
  routeStops: Map<string, AmapCoordinate>;
};

function cleanText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function resolveGuidebookAmapKey(override?: string | null): string {
  if (override !== undefined) return cleanText(override);
  return (
    process.env.AMAP_WEB_SERVICE_KEY?.trim() ||
    process.env.AMAP_API_KEY?.trim() ||
    process.env.AMAP_KEY?.trim() ||
    ""
  );
}

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return (
    SENSITIVE_QUERY_KEYS.has(normalized) ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_access_key") ||
    normalized.endsWith("_token")
  );
}

function sanitizePublicUrl(value: string | null | undefined): string | undefined {
  const trimmed = cleanText(value);
  if (!trimmed) return undefined;
  if (/^data:image\//i.test(trimmed)) return trimmed;

  try {
    if (trimmed.startsWith("/")) {
      const relative = new URL(trimmed, "https://guidebook.invalid");
      for (const key of [...relative.searchParams.keys()]) {
        if (isSensitiveQueryKey(key)) relative.searchParams.delete(key);
      }
      relative.hash = "";
      return `${relative.pathname}${relative.search}`;
    }

    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveQueryKey(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? cleanText(error.message) : "未知错误";
}

function coordinateKey(coordinate: AmapCoordinate): string {
  return `${coordinate[0]},${coordinate[1]}`;
}

function sameCoordinate(
  left: AmapCoordinate | undefined,
  right: AmapCoordinate | undefined,
): boolean {
  return Boolean(left && right && left[0] === right[0] && left[1] === right[1]);
}

function appendPath(target: AmapCoordinate[], source: AmapCoordinate[]) {
  for (const coordinate of source) {
    if (!sameCoordinate(target.at(-1), coordinate)) target.push(coordinate);
  }
}

function uniqueCoordinates(values: AmapCoordinate[]): AmapCoordinate[] {
  const seen = new Set<string>();
  const result: AmapCoordinate[] = [];
  for (const coordinate of values) {
    const key = coordinateKey(coordinate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(coordinate);
  }
  return result;
}

function samplePath(points: AmapCoordinate[], maximum: number): AmapCoordinate[] {
  if (points.length <= maximum) return points;
  if (maximum <= 1) return points[0] ? [points[0]] : [];

  const sampled: AmapCoordinate[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maximum - 1));
    const point = points[sourceIndex];
    if (point) sampled.push(point);
  }
  return uniqueCoordinates(sampled);
}

function distanceKm(origin: AmapCoordinate, destination: AmapCoordinate): number {
  const [longitude1, latitude1] = origin;
  const [longitude2, latitude2] = destination;
  const radians = Math.PI / 180;
  const latitudeDelta = (latitude2 - latitude1) * radians;
  const longitudeDelta = (longitude2 - longitude1) * radians;
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1 * radians) *
      Math.cos(latitude2 * radians) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateDurationMinutes(distance: number, mode: RouteSegment["mode"]): number {
  const speedKmh: Record<RouteSegment["mode"], number> = {
    economy: 75,
    balanced: 80,
    speed: 95,
    train: 180,
    flight: 650,
    drive: 80,
    bus: 70,
    ship: 35,
  };
  return Math.max(1, Math.round((distance / speedKmh[mode]) * 60));
}

function toAmapRouteMode(mode: RouteSegment["mode"]): AmapRouteMode {
  return mode === "train" ? "transit" : "car";
}

function toNavigationMode(mode: RouteSegment["mode"] | undefined): NavigationInput["mode"] {
  if (!mode) return "walking";
  if (mode === "train") return "transit";
  return "car";
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index] as T, index);
    }
  };

  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), Math.max(1, values.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function createCoordinateResolver(client: AmapClient, report: ErrorReporter): CoordinateResolver {
  const geocodeCache = new Map<string, Promise<AmapCoordinate | null>>();
  const poiCache = new Map<string, Promise<AmapCoordinate | null>>();

  const geocode = (address: string, city?: string): Promise<AmapCoordinate | null> => {
    const normalizedAddress = cleanText(address);
    if (!normalizedAddress) return Promise.resolve(null);
    const key = `${normalizedAddress}|${cleanText(city)}`;
    const cached = geocodeCache.get(key);
    if (cached) return cached;

    const pending = client
      .geocode({ address: normalizedAddress, city: cleanText(city) || undefined })
      .then((results) => results[0]?.location ?? null)
      .catch((error) => {
        report(`地理编码失败：${errorText(error)}`);
        return null;
      });
    geocodeCache.set(key, pending);
    return pending;
  };

  const searchPoi = (keywords: string, city: string): Promise<AmapCoordinate | null> => {
    const normalizedKeywords = cleanText(keywords);
    if (!normalizedKeywords) return Promise.resolve(null);
    const key = `${normalizedKeywords}|${cleanText(city)}`;
    const cached = poiCache.get(key);
    if (cached) return cached;

    const pending = client
      .searchPoi({ keywords: normalizedKeywords, city: cleanText(city) || undefined })
      .then((results) => results[0]?.location ?? null)
      .catch((error) => {
        report(`地点解析失败：${errorText(error)}`);
        return null;
      });
    poiCache.set(key, pending);
    return pending;
  };

  return {
    resolveAddress: geocode,
    async resolvePlace(name, location, city) {
      const point = await searchPoi(name, city);
      if (point) return point;

      const normalizedLocation = cleanText(location);
      if (normalizedLocation && normalizedLocation !== cleanText(name)) {
        const locationPoint = await searchPoi(normalizedLocation, city);
        if (locationPoint) return locationPoint;
      }

      return geocode(normalizedLocation || name, city);
    },
  };
}

function createRouteResolver(client: AmapClient, report: ErrorReporter): RouteResolver {
  const cache = new Map<string, Promise<AmapRoute | null>>();
  return (origin, destination, mode) => {
    const key = `${mode}|${coordinateKey(origin)}|${coordinateKey(destination)}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const pending = client.route({ origin, destination, mode }).catch((error) => {
      report(`${mode} 路线规划失败：${errorText(error)}`);
      return null;
    });
    cache.set(key, pending);
    return pending;
  };
}

function fallbackSegments(names: string[], mode: RouteSegment["mode"]): RouteSegment[] {
  return names.slice(0, -1).map((from, index) => ({
    from,
    to: names[index + 1] ?? "",
    mode,
    distanceKm: 0,
    durationMinutes: 0,
    navigation: "",
  }));
}

function outboundSegmentsFor(plan: TripPlan): RouteSegment[] {
  if (plan.route.outboundSegments.length > 0) return plan.route.outboundSegments;
  return fallbackSegments(
    [plan.meta.origin, ...plan.meta.waypoints, plan.meta.destination],
    plan.meta.transportPreference,
  );
}

function returnSegmentsFor(plan: TripPlan): RouteSegment[] {
  if (plan.route.returnMode === null) return [];
  if (plan.route.returnSegments.length > 0) return plan.route.returnSegments;
  return fallbackSegments([plan.meta.destination, plan.meta.origin], plan.meta.transportPreference);
}

async function enrichSegment(
  segment: RouteSegment,
  resolver: CoordinateResolver,
  routeResolver: RouteResolver,
): Promise<{ segment: RouteSegment; path: AmapCoordinate[] }> {
  const [origin, destination] = await Promise.all([
    resolver.resolveAddress(segment.from),
    resolver.resolveAddress(segment.to),
  ]);

  if (!origin || !destination) {
    return {
      segment: {
        ...segment,
        navigation: sanitizePublicUrl(segment.navigation) ?? "",
      },
      path: [],
    };
  }

  const navigation = buildNavigationUrl({
    from: origin,
    to: destination,
    mode: toNavigationMode(segment.mode),
    fromName: segment.from,
    toName: segment.to,
  });
  const route = await routeResolver(origin, destination, toAmapRouteMode(segment.mode));
  const path = route?.path.length ? route.path : [origin, destination];
  const estimatedDistance = route ? route.distanceMeters / 1000 : distanceKm(origin, destination);

  return {
    segment: {
      ...segment,
      distanceKm: Math.round(estimatedDistance * 10) / 10,
      durationMinutes: Math.max(
        1,
        Math.round(
          route
            ? route.durationSeconds / 60
            : estimateDurationMinutes(estimatedDistance, segment.mode),
        ),
      ),
      navigation,
    },
    path,
  };
}

function buildStaticMapUrlSafely(
  input: Parameters<typeof buildStaticMapUrl>[0],
  report: ErrorReporter,
): string | undefined {
  try {
    return buildStaticMapUrl(input);
  } catch (error) {
    report(`静态地图 URL 生成失败：${errorText(error)}`);
    return undefined;
  }
}

async function enrichRoute(
  plan: TripPlan,
  resolver: CoordinateResolver,
  routeResolver: RouteResolver,
  report: ErrorReporter,
): Promise<EnrichedRoute> {
  const outboundSegments = outboundSegmentsFor(plan);
  const returnSegments = returnSegmentsFor(plan);

  const [outboundResults, returnResults] = await Promise.all([
    mapWithConcurrency(outboundSegments, MAP_OPERATION_CONCURRENCY, (segment) =>
      enrichSegment(segment, resolver, routeResolver),
    ),
    mapWithConcurrency(returnSegments, MAP_OPERATION_CONCURRENCY, (segment) =>
      enrichSegment(segment, resolver, routeResolver),
    ),
  ]);

  const outboundPath: AmapCoordinate[] = [];
  for (const result of outboundResults) appendPath(outboundPath, result.path);
  const returnPath: AmapCoordinate[] = [];
  for (const result of returnResults) appendPath(returnPath, result.path);

  const mappedOutboundSegments = outboundResults.map((result) => result.segment);
  const mappedReturnSegments = returnResults.map((result) => result.segment);
  const allSegments = [...mappedOutboundSegments, ...mappedReturnSegments];
  const routeDistanceKm = Math.round(
    allSegments.reduce((sum, segment) => sum + segment.distanceKm, 0),
  );
  const routeDurationMinutes = Math.round(
    allSegments.reduce((sum, segment) => sum + segment.durationMinutes, 0),
  );

  const mapOutbound = outboundPath.length > 0 ? outboundPath : plan.route.outbound;
  const mapReturnPath = returnPath.length > 0 ? returnPath : plan.route.returnPath;
  const staticMapUrl =
    mapOutbound.length > 0
      ? buildStaticMapUrlSafely(
          {
            outbound: samplePath(mapOutbound, MAX_ROUTE_MAP_POINTS).map(
              ([longitude, latitude]) => ({
                longitude,
                latitude,
              }),
            ),
            returnPath: samplePath(mapReturnPath, MAX_ROUTE_MAP_POINTS).map(
              ([longitude, latitude]) => ({ longitude, latitude }),
            ),
            returnMode: plan.route.returnMode,
            zoom: 7,
          },
          report,
        )
      : sanitizePublicUrl(plan.route.staticMapUrl);

  const routeStops = new Map<string, AmapCoordinate>();
  for (const name of [plan.meta.origin, ...plan.meta.waypoints, plan.meta.destination]) {
    const coordinate = await resolver.resolveAddress(name);
    if (coordinate) routeStops.set(cleanText(name), coordinate);
  }

  return {
    route: {
      ...plan.route,
      outbound: mapOutbound,
      returnPath: plan.route.returnMode === null ? [] : mapReturnPath,
      outboundSegments: mappedOutboundSegments,
      returnSegments: mappedReturnSegments,
      distanceKm: routeDistanceKm,
      durationMinutes: routeDurationMinutes,
      staticMapUrl: staticMapUrl ?? sanitizePublicUrl(plan.route.staticMapUrl),
    },
    routeStops,
  };
}

function dayMapPoints(
  nodes: TripTimelineNode[],
  plan: TripPlan,
  route: TripRoute,
  routeStops: Map<string, AmapCoordinate>,
): AmapCoordinate[] {
  const points = uniqueCoordinates(
    nodes.flatMap((node) => (node.coordinates ? [node.coordinates] : [])),
  );
  const destination = routeStops.get(plan.meta.destination);
  const origin = routeStops.get(plan.meta.origin);

  if (points.length < 2 && destination) points.push(destination);
  if (points.length < 2 && origin) points.push(origin);
  if (points.length < 2) points.push(...route.outbound.slice(0, 2));
  if (points.length < 2) points.push(...route.returnPath.slice(-2));

  return uniqueCoordinates(points);
}

function buildQrCodeUrl(navigationUrl: string | undefined): string | undefined {
  if (!navigationUrl) return undefined;
  const url = new URL("https://api.qrserver.com/v1/create-qr-code/");
  url.searchParams.set("size", "220x220");
  url.searchParams.set("data", navigationUrl);
  return url.toString();
}

function routeNodeKey(dayIndex: number, nodeIndex: number): string {
  return `${dayIndex}:${nodeIndex}`;
}

async function enrichDays(
  plan: TripPlan,
  route: TripRoute,
  routeStops: Map<string, AmapCoordinate>,
  resolver: CoordinateResolver,
  report: ErrorReporter,
): Promise<TripDay[]> {
  const candidates: { key: string; node: TripTimelineNode }[] = [];
  const existing = new Map<string, AmapCoordinate>();

  plan.days.forEach((day, dayIndex) => {
    day.nodes.forEach((node, nodeIndex) => {
      const key = routeNodeKey(dayIndex, nodeIndex);
      if (node.coordinates) {
        existing.set(key, node.coordinates);
        return;
      }
      if (
        candidates.length < MAX_POI_LOOKUPS &&
        (node.type === "attraction" ||
          node.type === "night-activity" ||
          node.type === "hotel" ||
          node.type === "meal")
      ) {
        candidates.push({ key, node });
      }
    });
  });

  const resolvedCandidates = await mapWithConcurrency(
    candidates,
    MAP_OPERATION_CONCURRENCY,
    async ({ key, node }) => {
      const routeStop = routeStops.get(cleanText(node.name));
      const coordinate =
        routeStop ?? (await resolver.resolvePlace(node.name, node.location, plan.meta.destination));
      return { key, coordinate };
    },
  );
  for (const { key, coordinate } of resolvedCandidates) {
    if (coordinate) existing.set(key, coordinate);
  }

  const destination = routeStops.get(plan.meta.destination);
  const origin = routeStops.get(plan.meta.origin);

  return plan.days.map((day, dayIndex) => {
    let previousCoordinate = origin ?? destination ?? route.outbound[0] ?? route.returnPath[0];
    const nodes = day.nodes.map((node, nodeIndex) => {
      const key = routeNodeKey(dayIndex, nodeIndex);
      const coordinate = existing.get(key) ?? node.coordinates;
      const navigation =
        coordinate && previousCoordinate
          ? buildNavigationUrl({
              from: previousCoordinate,
              to: coordinate,
              mode: toNavigationMode(node.transportMode),
              fromName: node.location ?? node.name,
              toName: node.name,
            })
          : sanitizePublicUrl(node.navigation);
      if (coordinate) previousCoordinate = coordinate;
      return {
        ...node,
        ...(coordinate ? { coordinates: coordinate } : {}),
        navigation: navigation ?? null,
      };
    });

    const points = dayMapPoints(nodes, plan, route, routeStops);
    const mapUrl =
      points.length > 0
        ? buildStaticMapUrlSafely(
            {
              outbound: samplePath(points, MAX_DAY_MAP_POINTS).map(([longitude, latitude]) => ({
                longitude,
                latitude,
              })),
              zoom: 12,
            },
            report,
          )
        : undefined;
    const firstPoint = points[0];
    const lastPoint = points.at(-1);
    const navigationUrl =
      firstPoint && lastPoint
        ? buildNavigationUrl({
            from: firstPoint,
            to: lastPoint,
            mode: toNavigationMode(day.nodes.find((node) => node.transportMode)?.transportMode),
            fromName: day.nodes[0]?.location ?? day.nodes[0]?.name,
            toName: day.nodes.at(-1)?.name,
          })
        : sanitizePublicUrl(day.navigationUrl);

    return {
      ...day,
      nodes,
      mapUrl: mapUrl ?? sanitizePublicUrl(day.mapUrl),
      navigationUrl,
      qrCodeUrl: buildQrCodeUrl(navigationUrl) ?? sanitizePublicUrl(day.qrCodeUrl),
    };
  });
}

function hasCompleteMapData(plan: TripPlan): boolean {
  const hasRoutePath =
    plan.route.outbound.length > 0 &&
    (plan.route.returnMode === null || plan.route.returnPath.length > 0);
  const hasRouteMap = Boolean(sanitizePublicUrl(plan.route.staticMapUrl));
  const everyDayHasMap = plan.days.every((day) => Boolean(sanitizePublicUrl(day.mapUrl)));
  return hasRoutePath && hasRouteMap && everyDayHasMap;
}

/**
 * 用高德补齐 TripPlan 的地图、路线、坐标与导航数据。
 *
 * 该函数以“永不阻塞路书生成”为约束：缺少 Key、某一项地理服务失败或返回无效数据时，
 * 都只保留原字段或交给现有 schematic / placeholder 降级，不向调用方抛错。
 */
export async function enrichGuidebookPlanWithMaps(
  plan: TripPlan,
  options: GuidebookMapEnrichmentOptions = {},
): Promise<TripPlan> {
  if (hasCompleteMapData(plan)) return plan;

  const amapKey = resolveGuidebookAmapKey(options.amapKey);
  const client =
    options.amapClient ?? (amapKey ? createAmapClient(amapKey, options.fetchImpl ?? fetch) : null);
  if (!client) return plan;

  const observed = Boolean(options.amapClient || amapKey);
  const report: ErrorReporter =
    options.onError ??
    ((message) => {
      if (observed) console.warn(`[guidebook-map] ${message}`);
    });
  const safeReport: ErrorReporter = (message) => {
    report(amapKey ? message.split(amapKey).join("[redacted]") : message);
  };

  try {
    const resolver = createCoordinateResolver(client, safeReport);
    const routeResolver = createRouteResolver(client, safeReport);
    const enrichedRoute = await enrichRoute(plan, resolver, routeResolver, safeReport);
    const days = await enrichDays(
      plan,
      enrichedRoute.route,
      enrichedRoute.routeStops,
      resolver,
      safeReport,
    );
    return { ...plan, route: enrichedRoute.route, days };
  } catch (error) {
    safeReport(`地图 enrichment 失败，已保留本地降级内容：${errorText(error)}`);
    return plan;
  }
}
