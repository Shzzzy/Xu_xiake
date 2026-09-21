import { createHash } from "node:crypto";
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
const DEFAULT_ENRICHMENT_TIMEOUT_MS = 20_000;
const ENRICHMENT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ENRICHMENT_CACHE_ENTRIES = 200;
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
  /** 整个 enrichment 的总预算；默认 20 秒。 */
  timeoutMs?: number;
  /** 调用方取消预览/导出时联动停止地图请求。 */
  signal?: AbortSignal;
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

type RouteResolver = (input: {
  origin: AmapCoordinate;
  destination: AmapCoordinate;
  mode: AmapRouteMode;
  city?: string;
  destinationCity?: string;
}) => Promise<AmapRoute | null>;

type OperationDeadline = {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
};

type EnrichmentCacheEntry = {
  expiresAt: number;
  promise: Promise<TripPlan>;
};

type RouteDecision =
  | {
      kind: "route";
      routeMode: AmapRouteMode;
      navigationMode: NavigationInput["mode"] | null;
      city?: string;
      destinationCity?: string;
      durationFromRoute: boolean;
    }
  | {
      kind: "unsupported";
      navigationMode: null;
    };
type EnrichedRoute = {
  route: TripRoute;
  routeStops: Map<string, AmapCoordinate>;
};

function cleanText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function mapEnrichmentSource(plan: TripPlan) {
  return {
    meta: {
      origin: plan.meta.origin,
      waypoints: plan.meta.waypoints,
      destination: plan.meta.destination,
      startDate: plan.meta.startDate,
      days: plan.meta.days,
      transportPreference: plan.meta.transportPreference,
    },
    route: {
      outbound: plan.route.outbound,
      returnPath: plan.route.returnPath,
      outboundSegments: plan.route.outboundSegments,
      returnSegments: plan.route.returnSegments,
      returnMode: plan.route.returnMode,
      staticMapUrl: plan.route.staticMapUrl ?? null,
    },
    days: plan.days.map((day) => ({
      date: day.date,
      weather: day.weather ?? null,
      mapUrl: day.mapUrl ?? null,
      navigationUrl: day.navigationUrl ?? null,
      qrCodeUrl: day.qrCodeUrl ?? null,
      nodes: day.nodes.map((node) => ({
        type: node.type,
        name: node.name,
        location: node.location ?? null,
        coordinates: node.coordinates ?? null,
        transportMode: node.transportMode ?? null,
        navigation: node.navigation,
      })),
    })),
  };
}

function mapEnrichmentKey(plan: TripPlan, amapKey: string, timeoutMs: number): string {
  const keyHash = amapKey ? createHash("sha256").update(amapKey).digest("hex") : "injected-client";
  return createHash("sha256")
    .update(stableSerialize(mapEnrichmentSource(plan)))
    .update(`|${keyHash}|${timeoutMs}`)
    .digest("hex");
}

const sharedEnrichmentCache = new Map<string, EnrichmentCacheEntry>();
const injectedEnrichmentCaches = new WeakMap<AmapClient, Map<string, EnrichmentCacheEntry>>();
const fetchEnrichmentCaches = new WeakMap<typeof fetch, Map<string, EnrichmentCacheEntry>>();

function weakCacheFor<T extends object>(
  owner: T,
  store: WeakMap<T, Map<string, EnrichmentCacheEntry>>,
): Map<string, EnrichmentCacheEntry> {
  const cached = store.get(owner);
  if (cached) return cached;
  const cache = new Map<string, EnrichmentCacheEntry>();
  store.set(owner, cache);
  return cache;
}

function enrichmentCacheFor(
  options: GuidebookMapEnrichmentOptions,
): Map<string, EnrichmentCacheEntry> {
  if (options.amapClient) return weakCacheFor(options.amapClient, injectedEnrichmentCaches);
  if (options.fetchImpl) return weakCacheFor(options.fetchImpl, fetchEnrichmentCaches);
  return sharedEnrichmentCache;
}

function rememberEnrichment(
  cache: Map<string, EnrichmentCacheEntry>,
  key: string,
  promise: Promise<TripPlan>,
): void {
  if (cache.size >= MAX_ENRICHMENT_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: Date.now() + ENRICHMENT_CACHE_TTL_MS, promise });
}

export function clearGuidebookMapCache(): void {
  sharedEnrichmentCache.clear();
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function createDeadline(options: GuidebookMapEnrichmentOptions): OperationDeadline {
  const controller = new AbortController();
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.round(options.timeoutMs as number)
      : DEFAULT_ENRICHMENT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("地图 enrichment 超过总预算"));
  }, timeoutMs);
  const onAbort = () =>
    controller.abort(options.signal?.reason ?? new Error("地图 enrichment 已取消"));
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("地图 enrichment 已取消");
}

function withDeadline<T>(promise: Promise<T>, deadline: OperationDeadline): Promise<T> {
  if (deadline.signal.aborted) return Promise.reject(abortReason(deadline.signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(deadline.signal));
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        deadline.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        deadline.signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function withAbortSignal(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestSignal = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
    return fetchImpl(input, { ...init, signal: requestSignal });
  }) as typeof fetch;
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

function cityForPlace(plan: TripPlan, value: string): string {
  const text = cleanText(value);
  const stops = [plan.meta.origin, ...plan.meta.waypoints, plan.meta.destination];
  const matched = stops.find(
    (stop) => text.includes(cleanText(stop)) || cleanText(stop).includes(text),
  );
  return cleanText(matched) || text;
}

function routeDecision(plan: TripPlan, segment: RouteSegment): RouteDecision {
  switch (segment.mode) {
    case "train":
      return {
        kind: "route",
        routeMode: "transit",
        navigationMode: "transit",
        city: cityForPlace(plan, segment.from),
        destinationCity: cityForPlace(plan, segment.to),
        durationFromRoute: true,
      };
    case "bus":
      // 公交仍沿道路取路径和距离，但耗时使用本产品的公交估算，不用驾车耗时覆盖。
      return {
        kind: "route",
        routeMode: "car",
        navigationMode: "transit",
        durationFromRoute: false,
      };
    case "drive":
    case "economy":
    case "balanced":
    case "speed":
      return {
        kind: "route",
        routeMode: "car",
        navigationMode: "car",
        durationFromRoute: true,
      };
    case "flight":
    case "ship":
      return { kind: "unsupported", navigationMode: null };
  }
}

function toNavigationMode(mode: RouteSegment["mode"] | undefined): NavigationInput["mode"] | null {
  if (!mode) return "walking";
  if (mode === "train" || mode === "bus") return "transit";
  if (mode === "drive" || mode === "economy" || mode === "balanced" || mode === "speed") {
    return "car";
  }
  return null;
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

function createCoordinateResolver(
  client: AmapClient,
  report: ErrorReporter,
  deadline: OperationDeadline,
): CoordinateResolver {
  const geocodeCache = new Map<string, Promise<AmapCoordinate | null>>();
  const poiCache = new Map<string, Promise<AmapCoordinate | null>>();

  const geocode = (address: string, city?: string): Promise<AmapCoordinate | null> => {
    const normalizedAddress = cleanText(address);
    if (!normalizedAddress) return Promise.resolve(null);
    if (deadline.signal.aborted) return Promise.resolve(null);
    const key = `${normalizedAddress}|${cleanText(city)}`;
    const cached = geocodeCache.get(key);
    if (cached) return cached;

    const pending = withDeadline(
      client.geocode({ address: normalizedAddress, city: cleanText(city) || undefined }),
      deadline,
    )
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
    if (deadline.signal.aborted) return Promise.resolve(null);
    const key = `${normalizedKeywords}|${cleanText(city)}`;
    const cached = poiCache.get(key);
    if (cached) return cached;

    const pending = withDeadline(
      client.searchPoi({ keywords: normalizedKeywords, city: cleanText(city) || undefined }),
      deadline,
    )
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
function createRouteResolver(
  client: AmapClient,
  report: ErrorReporter,
  deadline: OperationDeadline,
): RouteResolver {
  const cache = new Map<string, Promise<AmapRoute | null>>();
  return (input) => {
    if (deadline.signal.aborted) return Promise.resolve(null);
    const key = `${input.mode}|${coordinateKey(input.origin)}|${coordinateKey(input.destination)}|${input.city ?? ""}|${input.destinationCity ?? ""}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const pending = withDeadline(
      client.route({
        origin: input.origin,
        destination: input.destination,
        mode: input.mode,
        city: input.city,
        destinationCity: input.destinationCity,
      }),
      deadline,
    ).catch((error) => {
      report(`${input.mode} 路线规划失败：${errorText(error)}`);
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
  plan: TripPlan,
  resolver: CoordinateResolver,
  routeResolver: RouteResolver,
): Promise<{ segment: RouteSegment; path: AmapCoordinate[] }> {
  const decision = routeDecision(plan, segment);
  const [origin, destination] = await Promise.all([
    resolver.resolveAddress(segment.from),
    resolver.resolveAddress(segment.to),
  ]);

  if (decision.kind === "unsupported") {
    const path = origin && destination ? [origin, destination] : [];
    const estimatedDistance =
      segment.distanceKm > 0
        ? segment.distanceKm
        : origin && destination
          ? distanceKm(origin, destination)
          : 0;
    const estimatedMinutes =
      segment.durationMinutes > 0
        ? segment.durationMinutes
        : estimateDurationMinutes(estimatedDistance, segment.mode);
    return {
      segment: {
        ...segment,
        distanceKm: estimatedDistance,
        durationMinutes: estimatedMinutes,
        navigation: "",
      },
      path,
    };
  }

  if (!origin || !destination) {
    return {
      segment: {
        ...segment,
        navigation: sanitizePublicUrl(segment.navigation) ?? "",
      },
      path: [],
    };
  }

  const navigation = decision.navigationMode
    ? buildNavigationUrl({
        from: origin,
        to: destination,
        mode: decision.navigationMode,
        fromName: segment.from,
        toName: segment.to,
      })
    : "";
  const route = await routeResolver({
    origin,
    destination,
    mode: decision.routeMode,
    city: decision.city,
    destinationCity: decision.destinationCity,
  });
  const path = route?.path.length ? route.path : [origin, destination];
  const estimatedDistance =
    route !== null
      ? route.distanceMeters / 1000
      : segment.distanceKm > 0
        ? segment.distanceKm
        : distanceKm(origin, destination);
  const estimatedMinutes =
    route !== null && decision.durationFromRoute
      ? route.durationSeconds / 60
      : segment.durationMinutes > 0
        ? segment.durationMinutes
        : estimateDurationMinutes(estimatedDistance, segment.mode);

  return {
    segment: {
      ...segment,
      distanceKm: Math.round(estimatedDistance * 10) / 10,
      durationMinutes: Math.max(1, Math.round(estimatedMinutes)),
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
      enrichSegment(segment, plan, resolver, routeResolver),
    ),
    mapWithConcurrency(returnSegments, MAP_OPERATION_CONCURRENCY, (segment) =>
      enrichSegment(segment, plan, resolver, routeResolver),
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

type DayCityContext = {
  name: string;
  coordinate?: AmapCoordinate;
  routeIndex: number;
};

function deriveDayCityContexts(
  plan: TripPlan,
  routeStops: Map<string, AmapCoordinate>,
): DayCityContext[] {
  const stops = [plan.meta.origin, ...plan.meta.waypoints, plan.meta.destination].map(cleanText);
  let lastIndex = 0;

  return plan.days.map((day, dayIndex) => {
    const text = day.nodes
      .map((node) => `${node.name} ${node.location ?? ""}`)
      .join(" ")
      .trim();
    const matches = stops.flatMap((stop, index) => (stop && text.includes(stop) ? [index] : []));
    const forwardMatches = matches.filter((index) => index >= lastIndex);
    const fallbackIndex = dayIndex === 0 ? lastIndex : Math.min(stops.length - 1, lastIndex + 1);
    const routeIndex = forwardMatches.at(-1) ?? matches.at(-1) ?? fallbackIndex;
    lastIndex = Math.max(0, routeIndex);
    const name = stops[lastIndex] ?? plan.meta.destination;
    return {
      name,
      ...(routeStops.get(name) ? { coordinate: routeStops.get(name) } : {}),
      routeIndex: lastIndex,
    };
  });
}

function dayMapPoints(
  nodes: TripTimelineNode[],
  start: AmapCoordinate | undefined,
  end: AmapCoordinate | undefined,
  plan: TripPlan,
  route: TripRoute,
  routeStops: Map<string, AmapCoordinate>,
): AmapCoordinate[] {
  const points = uniqueCoordinates([
    ...(start ? [start] : []),
    ...nodes.flatMap((node) => (node.coordinates ? [node.coordinates] : [])),
    ...(end ? [end] : []),
  ]);
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
  const cityContexts = deriveDayCityContexts(plan, routeStops);
  const candidates: { key: string; node: TripTimelineNode; city: string }[] = [];
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
        candidates.push({
          key,
          node,
          city: cityContexts[dayIndex]?.name ?? plan.meta.destination,
        });
      }
    });
  });

  const resolvedCandidates = await mapWithConcurrency(
    candidates,
    MAP_OPERATION_CONCURRENCY,
    async ({ key, node, city }) => {
      const routeStop = routeStops.get(cleanText(node.name));
      const coordinate = routeStop ?? (await resolver.resolvePlace(node.name, node.location, city));
      return { key, coordinate };
    },
  );
  for (const { key, coordinate } of resolvedCandidates) {
    if (coordinate) existing.set(key, coordinate);
  }

  const result: TripDay[] = [];
  let previousDayEnd: AmapCoordinate | undefined;

  for (let dayIndex = 0; dayIndex < plan.days.length; dayIndex += 1) {
    const day = plan.days[dayIndex];
    if (!day) continue;
    const context = cityContexts[dayIndex];
    const origin = routeStops.get(plan.meta.origin);
    const dayStart =
      dayIndex === 0
        ? (origin ?? context?.coordinate ?? route.outbound[0] ?? route.returnPath[0])
        : (previousDayEnd ?? context?.coordinate ?? route.outbound[0] ?? route.returnPath[0]);
    let previousCoordinate = dayStart;

    const nodes = day.nodes.map((node, nodeIndex) => {
      const key = routeNodeKey(dayIndex, nodeIndex);
      const coordinate = existing.get(key) ?? node.coordinates;
      const navigationMode = toNavigationMode(node.transportMode);
      const navigation =
        coordinate && previousCoordinate && navigationMode
          ? buildNavigationUrl({
              from: previousCoordinate,
              to: coordinate,
              mode: navigationMode,
              fromName: node.location ?? node.name,
              toName: node.name,
            })
          : navigationMode === null
            ? null
            : sanitizePublicUrl(node.navigation);
      if (coordinate) previousCoordinate = coordinate;
      return {
        ...node,
        ...(coordinate ? { coordinates: coordinate } : {}),
        navigation: navigation ?? null,
      };
    });

    const hotelEnd = [...nodes]
      .reverse()
      .find((node) => node.type === "hotel" && node.coordinates)?.coordinates;
    const lastNodeEnd = [...nodes].reverse().find((node) => node.coordinates)?.coordinates;
    const dayEnd = hotelEnd ?? lastNodeEnd ?? context?.coordinate ?? dayStart;
    const points = dayMapPoints(nodes, dayStart, dayEnd, plan, route, routeStops);
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
    const firstPoint = dayStart ?? points[0];
    const lastPoint = dayEnd ?? points.at(-1);
    const requestedNavigationMode = toNavigationMode(
      day.nodes.find((node) => node.transportMode)?.transportMode,
    );
    const navigationUrl =
      firstPoint && lastPoint && requestedNavigationMode
        ? buildNavigationUrl({
            from: firstPoint,
            to: lastPoint,
            mode: requestedNavigationMode,
            fromName: day.nodes[0]?.location ?? day.nodes[0]?.name,
            toName: day.nodes.at(-1)?.name,
          })
        : requestedNavigationMode === null
          ? undefined
          : sanitizePublicUrl(day.navigationUrl);

    result.push({
      ...day,
      nodes,
      mapUrl: mapUrl ?? sanitizePublicUrl(day.mapUrl),
      navigationUrl,
      qrCodeUrl: buildQrCodeUrl(navigationUrl) ?? sanitizePublicUrl(day.qrCodeUrl),
    });
    previousDayEnd = dayEnd ?? previousCoordinate ?? dayStart;
  }

  return result;
}
async function performEnrichment(
  plan: TripPlan,
  options: GuidebookMapEnrichmentOptions,
  amapKey: string,
  client: AmapClient,
  deadline: OperationDeadline,
): Promise<TripPlan> {
  const observed = Boolean(options.amapClient || amapKey);
  const reported = new Set<string>();
  const report: ErrorReporter = (message) => {
    if (reported.has(message)) return;
    reported.add(message);
    if (options.onError) options.onError(message);
    else if (observed && process.env.NODE_ENV === "production") {
      console.warn(`[guidebook-map] ${message}`);
    }
  };
  const safeReport: ErrorReporter = (message) => {
    report(amapKey ? message.split(amapKey).join("[redacted]") : message);
  };

  try {
    const resolver = createCoordinateResolver(client, safeReport, deadline);
    const routeResolver = createRouteResolver(client, safeReport, deadline);
    const enrichedRoute = await enrichRoute(plan, resolver, routeResolver, safeReport);
    const days = await enrichDays(
      plan,
      enrichedRoute.route,
      enrichedRoute.routeStops,
      resolver,
      safeReport,
    );
    if (deadline.timedOut()) {
      safeReport("地图 enrichment 达到总预算，已返回已完成字段并继续使用本地降级。");
    } else if (deadline.signal.aborted) {
      safeReport("地图 enrichment 已取消，已返回已完成字段并继续使用本地降级。");
    }
    return deepFreeze({ ...plan, route: enrichedRoute.route, days });
  } catch (error) {
    safeReport(`地图 enrichment 失败，已保留本地降级内容：${errorText(error)}`);
    return deepFreeze(plan);
  }
}

/**
 * 用高德补齐 TripPlan 的地图、路线、坐标与导航数据。
 *
 * 该函数以“永不阻塞路书生成”为约束：缺少 Key、某一项地理服务失败或返回无效数据时，
 * 都只保留原字段或交给现有 schematic / placeholder 降级，不向调用方抛错。
 * 相同地图输入会在服务进程内复用同一份不可变结果，预览与 PDF 不重复请求高德。
 */
export async function enrichGuidebookPlanWithMaps(
  plan: TripPlan,
  options: GuidebookMapEnrichmentOptions = {},
): Promise<TripPlan> {
  const amapKey = resolveGuidebookAmapKey(options.amapKey);
  if (!options.amapClient && !amapKey) return plan;

  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.round(options.timeoutMs as number)
      : DEFAULT_ENRICHMENT_TIMEOUT_MS;
  const cache = enrichmentCacheFor(options);
  const cacheKey = mapEnrichmentKey(plan, amapKey, timeoutMs);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) cache.delete(cacheKey);

  if (options.signal?.aborted) return plan;
  const deadline = createDeadline({ ...options, timeoutMs });
  let client: AmapClient;
  try {
    client =
      options.amapClient ??
      createAmapClient(amapKey, withAbortSignal(options.fetchImpl ?? fetch, deadline.signal));
  } catch (error) {
    deadline.cleanup();
    if (options.onError) options.onError(`地图客户端初始化失败：${errorText(error)}`);
    return plan;
  }

  const promise = performEnrichment(plan, options, amapKey, client, deadline).finally(
    deadline.cleanup,
  );
  rememberEnrichment(cache, cacheKey, promise);
  return promise;
}
