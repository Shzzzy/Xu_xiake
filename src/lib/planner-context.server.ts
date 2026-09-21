import {
  createAmapClient,
  type AmapClient,
  type AmapCoordinate,
  type AmapGeocode,
  type AmapPoi,
} from "./amap.server.ts";
import {
  calculateTransportLeg,
  chooseLongDistanceMode,
  type TransportPlanLeg,
} from "./transport-planner.server.ts";
import type { SearchResult } from "./live-planner.ts";
import type {
  RouteLeg,
  RoutePlan,
  TransportMode,
  TransportPriceReference,
} from "./route-planner.ts";
import { dedupeSources, searchTavily } from "./tavily.server.ts";

export type PlannerCandidate = {
  name: string;
  summary: string;
  source: string;
};

export type DestinationCandidate = {
  id: string;
  name: string;
  address: string;
  type: string;
  location: AmapCoordinate;
  publicUrl: string;
  areaKey: string;
};

// 保留现有候选合并所需的摘要和来源字段，同时向新管线暴露结构化目的地信息。
export type PlannerDestinationCandidate = DestinationCandidate & PlannerCandidate;

export type TransportPlanningInput = {
  client: AmapClient | null;
  route: RoutePlan;
  startDate: string;
  travelers: { adults: number; children: number };
  tavilyKey: string;
  tavilyEndpoint?: string;
  fetchImpl?: typeof fetch;
};

export type TransportPlanningReady = {
  status: "ready";
  route: RoutePlan;
  legs: TransportPlanLeg[];
  references: TransportPriceReference[];
  minimumTotal: number;
};

export type TransportPlanningDegraded = {
  status: "degraded";
  reason: string;
  route: RoutePlan;
  legs: [];
  references: [];
  minimumTotal: 0;
};

export type TransportPlanningResult = TransportPlanningReady | TransportPlanningDegraded;

const GENERIC_TRANSPORT_MODES = new Set<TransportMode>(["economy", "balanced", "speed"]);
const LONG_DISTANCE_FLIGHT_KM = 800;
const AMAP_POI_QUERIES = ["热门景点", "风景名胜", "博物馆", "公园", "地标"];
const MAX_DESTINATION_CANDIDATES = 16;
const MAX_TAVILY_SOURCES_PER_LEG = 3;
const AREA_CLUSTER_RADIUS_KM = 15;

const PROVINCE_ALIASES: ReadonlyArray<{ key: string; aliases: string[] }> = [
  { key: "北京", aliases: ["北京市", "北京"] },
  { key: "天津", aliases: ["天津市", "天津"] },
  { key: "上海", aliases: ["上海市", "上海"] },
  { key: "重庆", aliases: ["重庆市", "重庆"] },
  { key: "河北", aliases: ["河北省", "河北"] },
  { key: "山西", aliases: ["山西省", "山西"] },
  { key: "辽宁", aliases: ["辽宁省", "辽宁"] },
  { key: "吉林", aliases: ["吉林省", "吉林"] },
  { key: "黑龙江", aliases: ["黑龙江省", "黑龙江"] },
  { key: "江苏", aliases: ["江苏省", "江苏"] },
  { key: "浙江", aliases: ["浙江省", "浙江"] },
  { key: "安徽", aliases: ["安徽省", "安徽"] },
  { key: "福建", aliases: ["福建省", "福建"] },
  { key: "江西", aliases: ["江西省", "江西"] },
  { key: "山东", aliases: ["山东省", "山东"] },
  { key: "河南", aliases: ["河南省", "河南"] },
  { key: "湖北", aliases: ["湖北省", "湖北"] },
  { key: "湖南", aliases: ["湖南省", "湖南"] },
  { key: "广东", aliases: ["广东省", "广东"] },
  { key: "广西", aliases: ["广西壮族自治区", "广西"] },
  { key: "海南", aliases: ["海南省", "海南"] },
  { key: "四川", aliases: ["四川省", "四川"] },
  { key: "贵州", aliases: ["贵州省", "贵州"] },
  { key: "云南", aliases: ["云南省", "云南"] },
  { key: "西藏", aliases: ["西藏自治区", "西藏"] },
  { key: "陕西", aliases: ["陕西省", "陕西"] },
  { key: "甘肃", aliases: ["甘肃省", "甘肃"] },
  { key: "青海", aliases: ["青海省", "青海"] },
  { key: "内蒙古", aliases: ["内蒙古自治区", "内蒙古"] },
  { key: "宁夏", aliases: ["宁夏回族自治区", "宁夏"] },
  { key: "新疆", aliases: ["新疆维吾尔自治区", "新疆"] },
  { key: "台湾", aliases: ["台湾省", "台湾"] },
  { key: "香港", aliases: ["香港特别行政区", "香港"] },
  { key: "澳门", aliases: ["澳门特别行政区", "澳门"] },
];

const TRANSPORT_LABELS: Record<TransportMode, string> = {
  economy: "经济交通",
  balanced: "均衡交通",
  speed: "快捷交通",
  train: "高铁或火车",
  flight: "飞机",
  drive: "自驾",
  bus: "长途汽车",
  ship: "轮船",
};

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

function extractAmapCityQuery(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const adcode = value?.match(/(?:^|\D)(\d{6})(?:\D|$)/u)?.[1];
    if (adcode) return adcode;
  }

  for (const value of values) {
    const city = value?.match(/[\u4e00-\u9fa5]{2,10}?市/u)?.[0];
    if (!city) continue;

    let normalizedCity = normalizeName(city);
    for (const province of PROVINCE_ALIASES) {
      const alias = province.aliases.find((item) => normalizedCity.startsWith(item));
      if (alias && normalizedCity.length > alias.length) {
        normalizedCity = normalizedCity.slice(alias.length);
        break;
      }
    }
    if (normalizedCity.endsWith("市")) return normalizedCity;
  }

  return undefined;
}

function findProvinces(value: string): string[] {
  const normalizedValue = normalizeName(value);
  return PROVINCE_ALIASES.filter((province) =>
    province.aliases.some((alias) => normalizedValue.includes(normalizeName(alias))),
  ).map((province) => province.key);
}

function isRelevantAmapPoi(poi: AmapPoi, destination: string, region: string): boolean {
  const poiText = normalizeName([poi.name, poi.address, poi.type].join(" "));
  const destinationText = normalizeName(destination);
  if (!destinationText || !poiText.includes(destinationText)) return false;

  const expectedProvince = findProvinces(region)[0] ?? findProvinces(destination)[0];
  const mentionedProvinces = findProvinces(poiText);
  if (
    expectedProvince &&
    mentionedProvinces.length > 0 &&
    !mentionedProvinces.includes(expectedProvince)
  ) {
    return false;
  }

  const expectedCity = extractAmapCityQuery(region, destination);
  if (expectedCity && !/^\d{6}$/u.test(expectedCity)) {
    const cityToken = normalizeName(expectedCity.replace(/市$/u, ""));
    if (cityToken && !poiText.includes(cityToken)) return false;
  }

  return true;
}

function buildAreaKey(address: string, location: AmapCoordinate): string {
  const administrativeAreas = Array.from(
    address.matchAll(/([\u4e00-\u9fa5]{2,10}?(?:省|自治区|市|区|县|旗))/gu),
    (match) => match[1],
  );
  const area = administrativeAreas.slice(-2).join("-");
  if (area) return normalizeName(area);

  // 地址无法识别行政区时，按约 20 公里网格生成稳定的坐标区域键。
  const longitudeCell = Math.floor(location[0] / 0.2);
  const latitudeCell = Math.floor(location[1] / 0.2);
  return `coord-${longitudeCell}-${latitudeCell}`;
}

function appendSummary(prefix: string, supplement: string): string {
  const normalizedSupplement = supplement.trim();
  if (!normalizedSupplement || prefix.includes(normalizedSupplement)) return prefix;
  return `${prefix}。${normalizedSupplement}`.slice(0, 800);
}

function isSameCandidateName(left: string, right: string): boolean {
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

/**
 * AMap 是目的地景点的主来源；Tavily 只允许补充已有候选的摘要，不能新增或清空候选。
 */
export function mergePlannerCandidates(input: {
  primary: PlannerCandidate[];
  fallback: PlannerCandidate[];
  supplements?: SearchResult[];
}): PlannerCandidate[] {
  const merged: PlannerCandidate[] = [];
  const seenNames = new Set<string>();

  for (const candidate of [...input.primary, ...input.fallback]) {
    const key = normalizeName(candidate.name);
    if (!key || seenNames.has(key)) continue;
    seenNames.add(key);
    merged.push({ ...candidate });
  }

  for (const supplement of input.supplements ?? []) {
    const target = merged.find((candidate) => isSameCandidateName(candidate.name, supplement.title));
    if (!target || !supplement.content.trim()) continue;
    target.summary = appendSummary(target.summary, supplement.content);
  }

  return merged;
}

export function buildAmapDestinationCandidates(pois: AmapPoi[]): PlannerDestinationCandidate[] {
  const candidates: PlannerDestinationCandidate[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const poi of pois) {
    const poiType = poi.type.trim();
    if (/住宿服务|餐饮服务|购物服务|生活服务|公司企业/u.test(poiType)) continue;

    const id = poi.id.trim();
    const name = poi.name.trim();
    const key = normalizeName(name);
    if ((id && seenIds.has(id)) || !name || seenNames.has(key)) continue;
    if (id) seenIds.add(id);
    seenNames.add(key);

    const location = [poi.type, poi.address]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("｜");
    const publicUrl = poi.id.trim()
      ? `https://www.amap.com/place/${encodeURIComponent(poi.id.trim())}`
      : `https://www.amap.com/search?query=${encodeURIComponent(name)}`;
    candidates.push({
      id,
      name,
      address: poi.address.trim(),
      type: poiType,
      location: [...poi.location],
      publicUrl,
      areaKey: buildAreaKey(poi.address, poi.location),
      summary: location || "高德地点资料",
      source: publicUrl,
    });
  }

  return candidates.slice(0, MAX_DESTINATION_CANDIDATES);
}

export function clusterCandidates(
  candidates: DestinationCandidate[],
  maxPerDay: number,
): DestinationCandidate[][] {
  if (candidates.length === 0) return [];

  const dayLimit = Number.isFinite(maxPerDay) ? Math.max(1, Math.floor(maxPerDay)) : 1;
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const areas: { areaKey: string; centroid: AmapCoordinate; candidates: DestinationCandidate[] }[] =
    [];

  for (const candidate of candidates) {
    const id = candidate.id.trim();
    const nameKey = normalizeName(candidate.name);
    if ((id && seenIds.has(id)) || !nameKey || seenNames.has(nameKey)) continue;
    if (id) seenIds.add(id);
    seenNames.add(nameKey);

    const areaKey = candidate.areaKey.trim() || buildAreaKey(candidate.address, candidate.location);
    const sameArea = areas.filter((area) => area.areaKey === areaKey);
    const nearestSameArea = findNearestArea(candidate.location, sameArea);
    const nearestArea = findNearestArea(candidate.location, areas);
    const nearestSameAreaDistance = nearestSameArea
      ? distanceKm(candidate.location, nearestSameArea.centroid)
      : Number.POSITIVE_INFINITY;
    const nearestAreaDistance = nearestArea
      ? distanceKm(candidate.location, nearestArea.centroid)
      : Number.POSITIVE_INFINITY;
    const target =
      nearestSameAreaDistance <= AREA_CLUSTER_RADIUS_KM
        ? nearestSameArea
        : nearestAreaDistance <= AREA_CLUSTER_RADIUS_KM
          ? nearestArea
          : undefined;

    if (target) {
      target.candidates.push(candidate);
      const count = target.candidates.length;
      target.centroid = [
        (target.centroid[0] * (count - 1) + candidate.location[0]) / count,
        (target.centroid[1] * (count - 1) + candidate.location[1]) / count,
      ];
      continue;
    }

    areas.push({
      areaKey,
      centroid: [...candidate.location],
      candidates: [candidate],
    });
  }

  return areas.flatMap((area) => {
    const groups: DestinationCandidate[][] = [];
    for (let index = 0; index < area.candidates.length; index += dayLimit) {
      groups.push(area.candidates.slice(index, index + dayLimit));
    }
    return groups;
  });
}

function findNearestArea<T extends { centroid: AmapCoordinate }>(
  location: AmapCoordinate,
  areas: T[],
): T | undefined {
  let nearest: T | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const area of areas) {
    const currentDistance = distanceKm(location, area.centroid);
    if (currentDistance < nearestDistance) {
      nearest = area;
      nearestDistance = currentDistance;
    }
  }

  return nearest;
}

export async function searchAmapDestinationCandidates(input: {
  client: AmapClient | null;
  destination: string;
  region?: string;
}): Promise<PlannerDestinationCandidate[]> {
  if (!input.client) return [];
  const destination = input.destination.trim();
  if (!destination) return [];
  const region = input.region?.trim() ?? "";
  const city = extractAmapCityQuery(region, destination);

  const search = async (keywords: string, scopedCity?: string) => {
    try {
      return await input.client?.searchPoi({
        keywords,
        ...(scopedCity ? { city: scopedCity } : {}),
        pageSize: 10,
      });
    } catch {
      return [];
    }
  };

  // 先执行精确查询；只有能识别合法城市/adcode 时才限定 AMap city。
  const exactBatch = await search(destination, city);
  const exactRetryBatch = city ? await search(destination) : [];
  const genericBatches = await Promise.all([
    ...AMAP_POI_QUERIES.map((keywords) => search(keywords, city)),
    ...AMAP_POI_QUERIES.map((keywords) => search(destination + " " + keywords, city)),
  ]);
  const relevant = [exactBatch, exactRetryBatch, ...genericBatches]
    .flatMap((batch) => batch ?? [])
    .filter((poi) => isRelevantAmapPoi(poi, destination, region));

  return buildAmapDestinationCandidates(relevant);
}

function travelerCount(travelers: { adults: number; children: number }): number {
  return Math.max(1, Math.round(travelers.adults + travelers.children));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function distanceKm(from: AmapCoordinate, to: AmapCoordinate): number {
  const [longitude1, latitude1] = from;
  const [longitude2, latitude2] = to;
  const latitudeDelta = toRadians(latitude2 - latitude1);
  const longitudeDelta = toRadians(longitude2 - longitude1);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitude1)) *
      Math.cos(toRadians(latitude2)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeProvince(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/u, "");
}

function isCrossProvince(from: AmapGeocode | undefined, to: AmapGeocode | undefined): boolean {
  const fromProvince = normalizeProvince(from?.province);
  const toProvince = normalizeProvince(to?.province);
  return Boolean(fromProvince && toProvince && fromProvince !== toProvince);
}

async function geocodeRouteNodes(
  client: AmapClient | null,
  route: RoutePlan,
): Promise<Map<string, AmapGeocode>> {
  if (!client) return new Map();
  const names = [...new Set(route.legs.flatMap((leg) => [leg.from, leg.to]))];
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        const geocodes = await client.geocode({ address: name });
        return [name, geocodes[0]] as const;
      } catch {
        return [name, undefined] as const;
      }
    }),
  );
  return new Map(
    results.filter((entry): entry is readonly [string, AmapGeocode] => Boolean(entry[1])),
  );
}

function resolveTransportMode(
  mode: TransportMode,
  legDistanceKm: number,
  from: AmapGeocode | undefined,
  to: AmapGeocode | undefined,
): TransportPlanLeg["mode"] {
  const genericPreference = GENERIC_TRANSPORT_MODES.has(mode);
  return chooseLongDistanceMode({
    explicit: genericPreference ? null : mode,
    crossProvince:
      isCrossProvince(from, to) && legDistanceKm >= LONG_DISTANCE_FLIGHT_KM,
    distanceKm: legDistanceKm,
  });
}

type DriveRouteResult =
  | { status: "ready"; distanceKm: number; durationMinutes: number }
  | { status: "degraded"; reason: string };

type ResolvedLegResult =
  | { status: "ready"; routeLeg: RouteLeg; planLeg: TransportPlanLeg }
  | { status: "degraded"; reason: string };

function createDegradedTransportPlan(route: RoutePlan, reason: string): TransportPlanningDegraded {
  return {
    status: "degraded",
    reason,
    route,
    legs: [],
    references: [],
    minimumTotal: 0,
  };
}

async function resolveDriveRoute(input: {
  client: AmapClient | null;
  from: AmapGeocode | undefined;
  to: AmapGeocode | undefined;
}): Promise<DriveRouteResult> {
  if (!input.client || !input.from || !input.to) {
    return { status: "degraded", reason: "缺少高德 AMap client 或驾车路线端点坐标" };
  }

  try {
    const route = await input.client.route({
      origin: input.from.location,
      destination: input.to.location,
      mode: "car",
    });
    if (!(route.distanceMeters > 0)) {
      return { status: "degraded", reason: "高德驾车路线缺少有效距离" };
    }
    if (!(route.durationSeconds > 0)) {
      return { status: "degraded", reason: "高德驾车路线缺少有效时长" };
    }
    return {
      status: "ready",
      distanceKm: route.distanceMeters / 1000,
      durationMinutes: route.durationSeconds / 60,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知错误";
    return { status: "degraded", reason: "高德驾车路线查询失败：" + detail };
  }
}

async function searchTransportPriceSources(
  leg: RouteLeg,
  input: TransportPlanningInput,
  legDistanceKm: number,
): Promise<SearchResult[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const query = [
    `${leg.from} 到 ${leg.to}`,
    TRANSPORT_LABELS[leg.transport],
    "票价",
    input.startDate,
    `${Math.round(legDistanceKm)} 公里`,
    "单程",
  ].join(" ");

  try {
    return dedupeSources(
      await searchTavily(input.tavilyKey, query, input.tavilyEndpoint, fetchImpl),
    ).slice(0, MAX_TAVILY_SOURCES_PER_LEG);
  } catch {
    // Tavily 不可用时仍保留本地最低价兜底，不让交通估算阻塞整份行程。
    return [];
  }
}

async function buildPriceReference(
  leg: RouteLeg,
  input: TransportPlanningInput,
  planLeg: TransportPlanLeg,
  headcount: number,
): Promise<TransportPriceReference> {
  return {
    legId: leg.id,
    from: leg.from,
    to: leg.to,
    mode: leg.transport,
    distanceKm: planLeg.distanceKm,
    minimumUnitPrice: planLeg.minimumPerPersonCost,
    minimumPartyTotal: planLeg.minimumPerPersonCost * headcount,
    travelerCount: headcount,
    basis: "本地最低参考价按距离、交通方式与人数计算，Tavily 摘要只用于综合区间。",
    sources: await searchTransportPriceSources(leg, input, planLeg.distanceKm),
  };
}

export async function prepareRouteTransportPlan(
  input: TransportPlanningInput,
): Promise<TransportPlanningResult> {
  if (!input.client) {
    return createDegradedTransportPlan(input.route, "缺少高德 AMap client，无法计算确定性交通计划");
  }

  const nodeNames = [...new Set(input.route.legs.flatMap((leg) => [leg.from, leg.to]))];
  const geocoded = await geocodeRouteNodes(input.client, input.route);
  const missingNodes = nodeNames.filter((name) => !geocoded.has(name));
  if (missingNodes.length > 0) {
    return createDegradedTransportPlan(
      input.route,
      "高德地理编码失败：无法定位 " + missingNodes.join("、"),
    );
  }

  const headcount = travelerCount(input.travelers);
  const legResults = await Promise.all(
    input.route.legs.map(async (leg): Promise<ResolvedLegResult> => {
      const fromGeocode = geocoded.get(leg.from);
      const toGeocode = geocoded.get(leg.to);
      if (!fromGeocode || !toGeocode) {
        return { status: "degraded", reason: "高德地理编码缺少 " + leg.from + " 或 " + leg.to };
      }

      const straightLineDistance = distanceKm(fromGeocode.location, toGeocode.location);
      let legDistanceKm = Math.round(straightLineDistance * 10) / 10;
      let routeDurationMinutes: number | undefined;

      if (leg.transport === "drive") {
        const driveRoute = await resolveDriveRoute({
          client: input.client,
          from: fromGeocode,
          to: toGeocode,
        });
        if (driveRoute.status === "degraded") return driveRoute;
        legDistanceKm = Math.round(driveRoute.distanceKm * 10) / 10;
        routeDurationMinutes = driveRoute.durationMinutes;
      }

      if (!(legDistanceKm > 0)) {
        return { status: "degraded", reason: "无法计算 " + leg.from + " 到 " + leg.to + " 的有效距离" };
      }

      const mode = resolveTransportMode(
        leg.transport,
        legDistanceKm,
        fromGeocode,
        toGeocode,
      );
      const calculation = calculateTransportLeg({
        mode,
        distanceKm: legDistanceKm,
        travelers: headcount,
        routeDurationMinutes,
      });

      return {
        status: "ready",
        routeLeg: { ...leg, transport: mode },
        planLeg: {
          id: leg.id,
          kind: leg.kind,
          from: leg.from,
          to: leg.to,
          distanceKm: legDistanceKm,
          mode,
          ...calculation,
        },
      };
    }),
  );
  const rejectedLeg = legResults.find((result) => result.status === "degraded");
  if (rejectedLeg?.status === "degraded") {
    return createDegradedTransportPlan(input.route, rejectedLeg.reason);
  }

  const resolvedLegs = legResults.filter(
    (result): result is Extract<ResolvedLegResult, { status: "ready" }> =>
      result.status === "ready",
  );
  const routeLegs = resolvedLegs.map(({ routeLeg }) => routeLeg);
  const route: RoutePlan = { ...input.route, legs: routeLegs };
  const legs = resolvedLegs.map(({ planLeg }) => planLeg);
  const references = await Promise.all(
    resolvedLegs
      .filter(({ planLeg }) => planLeg.mode !== "drive")
      .map(({ routeLeg, planLeg }) =>
        buildPriceReference(routeLeg, input, planLeg, headcount),
      ),
  );

  return {
    status: "ready",
    route,
    legs,
    references,
    minimumTotal: legs.reduce(
      (total, leg) => total + leg.minimumPerPersonCost * headcount,
      0,
    ),
  };
}

export function resolvePlannerAmapKey(input: {
  webServiceKey?: string;
  apiKey?: string;
  key?: string;
}): string {
  return input.webServiceKey?.trim() || input.apiKey?.trim() || input.key?.trim() || "";
}

export function createPlannerAmapClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): AmapClient | null {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) return null;
  return createAmapClient(normalizedKey, fetchImpl);
}
