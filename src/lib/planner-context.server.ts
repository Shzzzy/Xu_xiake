import {
  createAmapClient,
  type AmapClient,
  type AmapCoordinate,
  type AmapGeocode,
  type AmapPoi,
} from "./amap.server.ts";
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

export type TransportPlanningInput = {
  client: AmapClient | null;
  route: RoutePlan;
  startDate: string;
  travelers: { adults: number; children: number };
  tavilyKey: string;
  tavilyEndpoint?: string;
  fetchImpl?: typeof fetch;
};

export type TransportPlanningResult = {
  route: RoutePlan;
  references: TransportPriceReference[];
  minimumTotal: number;
};

const GENERIC_TRANSPORT_MODES = new Set<TransportMode>(["economy", "balanced", "speed"]);
const LONG_DISTANCE_FLIGHT_KM = 800;
const AMAP_POI_QUERIES = ["热门景点", "风景名胜", "博物馆", "公园", "地标"];
const MAX_DESTINATION_CANDIDATES = 16;
const MAX_TAVILY_SOURCES_PER_LEG = 3;

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

export function buildAmapDestinationCandidates(pois: AmapPoi[]): PlannerCandidate[] {
  const candidates: PlannerCandidate[] = [];
  const seen = new Set<string>();

  for (const poi of pois) {
    const name = poi.name.trim();
    const key = normalizeName(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);

    const location = [poi.type, poi.address].map((value) => value.trim()).filter(Boolean).join("｜");
    const source = poi.id.trim()
      ? `https://www.amap.com/place/${encodeURIComponent(poi.id.trim())}`
      : `https://www.amap.com/search?query=${encodeURIComponent(name)}`;
    candidates.push({
      name,
      summary: location || "高德地点资料",
      source,
    });
  }

  return candidates.slice(0, MAX_DESTINATION_CANDIDATES);
}

export async function searchAmapDestinationCandidates(input: {
  client: AmapClient | null;
  destination: string;
  region?: string;
}): Promise<PlannerCandidate[]> {
  if (!input.client) return [];
  const city = input.destination.trim() || input.region?.trim();
  if (!city) return [];

  const batches = await Promise.all(
    AMAP_POI_QUERIES.map(async (keywords) => {
      try {
        const scoped = await input.client?.searchPoi({ keywords, city, pageSize: 10 });
        if (scoped && scoped.length > 0) return scoped;
      } catch {
        // 城市名不是合法城市时继续做无城市范围搜索。
      }
      try {
        // “江南水乡”“桂林与阳朔”这类目的地不是城市名，不能强制传 city。
        return await input.client?.searchPoi({ keywords, pageSize: 10 });
      } catch {
        // 单个关键词失败不应阻断其余高德候选；最终由调用方决定是否使用本地 seed。
        return [];
      }
    }),
  );

  return buildAmapDestinationCandidates(batches.flatMap((batch) => batch ?? []));
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

function shouldUpgradeToFlight(
  mode: TransportMode,
  legDistanceKm: number,
  from: AmapGeocode | undefined,
  to: AmapGeocode | undefined,
): boolean {
  return (
    GENERIC_TRANSPORT_MODES.has(mode) &&
    legDistanceKm >= LONG_DISTANCE_FLIGHT_KM &&
    isCrossProvince(from, to)
  );
}

function minimumUnitPrice(mode: TransportMode, legDistanceKm: number): number {
  switch (mode) {
    case "flight":
      return Math.ceil(Math.max(500, 0.55 * legDistanceKm));
    case "train":
      return Math.ceil(Math.max(150, 0.35 * legDistanceKm));
    case "bus":
      return Math.ceil(Math.max(80, 0.22 * legDistanceKm));
    case "ship":
      return Math.ceil(Math.max(100, 0.3 * legDistanceKm));
    default:
      return Math.ceil(Math.max(150, 0.35 * legDistanceKm));
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
  legDistanceKm: number,
  headcount: number,
): Promise<TransportPriceReference> {
  const unitPrice = minimumUnitPrice(leg.transport, legDistanceKm);
  return {
    legId: leg.id,
    from: leg.from,
    to: leg.to,
    mode: leg.transport,
    distanceKm: Math.round(legDistanceKm * 10) / 10,
    minimumUnitPrice: unitPrice,
    minimumPartyTotal: unitPrice * headcount,
    travelerCount: headcount,
    basis: "本地最低参考价按距离、交通方式与人数计算，Tavily 摘要只用于综合区间。",
    sources: await searchTransportPriceSources(leg, input, legDistanceKm),
  };
}

export async function prepareRouteTransportPlan(
  input: TransportPlanningInput,
): Promise<TransportPlanningResult> {
  const geocoded = await geocodeRouteNodes(input.client, input.route);
  const legDistances = new Map<string, number>();
  const routeLegs = input.route.legs.map((leg) => {
    const fromGeocode = geocoded.get(leg.from);
    const toGeocode = geocoded.get(leg.to);
    const estimatedDistance =
      fromGeocode && toGeocode ? distanceKm(fromGeocode.location, toGeocode.location) : 0;
    legDistances.set(leg.id, estimatedDistance);
    return shouldUpgradeToFlight(leg.transport, estimatedDistance, fromGeocode, toGeocode)
      ? { ...leg, transport: "flight" as const }
      : leg;
  });
  const route: RoutePlan = { ...input.route, legs: routeLegs };
  const headcount = travelerCount(input.travelers);
  const references = await Promise.all(
    routeLegs
      .filter((leg) => leg.transport !== "drive")
      .map((leg) =>
        buildPriceReference(leg, input, legDistances.get(leg.id) ?? 0, headcount),
      ),
  );

  return {
    route,
    references,
    minimumTotal: references.reduce(
      (total, reference) => total + reference.minimumPartyTotal,
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
