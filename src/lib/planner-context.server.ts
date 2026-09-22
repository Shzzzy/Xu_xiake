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
  splitTransportLegIntoSegments,
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
  areaKey?: string;
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
  /** 单日驾驶硬上限；只影响执行分段，不改变原始 leg 的总时长和总成本。 */
  dailyDriveLimitMinutes?: number;
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
const ATTRACTION_POI_TYPE_PATTERN = /风景名胜|公园|博物馆|展览馆|纪念馆|动物园|植物园|水族馆|游乐园|寺庙|教堂|古镇|旅游景点|自然保护区|海滩|湖泊|温泉|广场|地标/u;
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

const ADMIN_SUFFIX_PATTERN =
  /(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|地区|盟|省|市|区|县|旗)$/u;
const GENERIC_REGION_TOKENS = new Set([
  "自由输入",
  "不限",
  "任意",
  "不知道",
  "待定",
  "其他",
  "其他地区",
]);
const DIRECT_ADMIN_PROVINCE_KEYS = new Set(["北京", "天津", "上海", "重庆"]);
const ADMIN_SUFFIX_ONLY_PATTERN = /^(?:省|市|自治区|自治州|地区|盟|区|县|旗)$/u;
const LOCALITY_ALIAS_TARGETS: Record<
  string,
  { cityNames?: readonly string[]; districtNames?: readonly string[] }
> = {
  徽州: { cityNames: ["黄山市"] },
  黄山: { cityNames: ["黄山市"] },
};

function normalizeAdminName(value: string): string {
  let normalized = normalizeName(value);
  let previous = "";
  while (normalized && normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(ADMIN_SUFFIX_PATTERN, "");
  }
  return normalized;
}

function stripProvinceAliasPrefix(value: string): string {
  let normalized = normalizeName(value);
  const aliases = PROVINCE_ALIASES.flatMap((province) => province.aliases)
    .map((alias) => normalizeName(alias))
    .sort((left, right) => right.length - left.length);
  if (aliases.includes(normalized)) return normalized;
  for (const alias of aliases) {
    if (alias && normalized.startsWith(alias) && normalized.length > alias.length) {
      const remainder = normalized.slice(alias.length);
      if (
        !remainder ||
        ADMIN_SUFFIX_ONLY_PATTERN.test(remainder) ||
        /^(?:市|州|地区|盟|区|县|旗)/u.test(remainder)
      ) {
        continue;
      }
      normalized = remainder;
      break;
    }
  }
  return normalized;
}

function stripPrefecturePrefix(value: string): string {
  return normalizeName(value).replace(/^.*?(?:自治州|地区|盟)/u, "");
}

function stripAdministrativePrefix(value: string): string {
  let normalized = stripProvinceAliasPrefix(value);
  normalized = normalized.replace(/^.*?市/u, "");
  normalized = normalized.replace(/^.*?(?:自治州|地区|盟)/u, "");
  return normalized;
}

function extractAdcodes(value: string): string[] {
  return Array.from(value.matchAll(/(?:^|\D)(\d{6})(?=\D|$)/gu), (match) => match[1]);
}

function extractExplicitCityNames(value: string): string[] {
  const names = new Set<string>();
  for (const segment of normalizeName(value).split(/[·,，;；/|、\s]+/u)) {
    const withoutProvince = stripProvinceAliasPrefix(segment);
    const withoutPrefecture = stripPrefecturePrefix(withoutProvince);
    for (const match of withoutPrefecture.matchAll(/[\u4e00-\u9fa5]{2,12}?市/gu)) {
      const city = normalizeAdminName(match[0]);
      if (city) names.add(city);
    }
  }
  return [...names];
}

function extractDirectAdminCityNames(value: string): string[] {
  const normalized = normalizeName(value);
  return PROVINCE_ALIASES.filter(
    (province) =>
      DIRECT_ADMIN_PROVINCE_KEYS.has(province.key) &&
      province.aliases.some((alias) => normalized.includes(normalizeName(alias))),
  ).map((province) => province.key);
}

function extractExplicitDistrictNames(value: string): string[] {
  const names = new Set<string>();
  for (const match of normalizeName(value).matchAll(/[\u4e00-\u9fa5]{2,14}?(?:区|县|旗)/gu)) {
    const raw = match[0];
    if (stripProvinceAliasPrefix(raw) === raw && findProvinces(raw).length > 0) {
      continue;
    }
    const district = normalizeAdminName(stripAdministrativePrefix(raw));
    if (district) names.add(district);
  }
  return [...names];
}

function extractLocalityTokens(value: string): string[] {
  const tokens = normalizeName(value).split(/[·,，;；/|、\s]+/u);
  const names = new Set<string>();
  for (const token of tokens) {
    if (!token || /^\d{6}$/u.test(token) || GENERIC_REGION_TOKENS.has(token)) continue;
    if (findProvinces(token).length > 0) continue;
    if (
      extractExplicitCityNames(token).length > 0 ||
      extractExplicitDistrictNames(token).length > 0 ||
      extractDirectAdminCityNames(token).length > 0
    ) {
      continue;
    }
    const name = normalizeAdminName(token);
    if (name.length < 2 || name.length > 4) continue;
    names.add(name);
  }
  return [...names];
}

function extractAmapCityQuery(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const adcode = value?.match(/(?:^|\D)(\d{6})(?:\D|$)/u)?.[1];
    if (adcode) return adcode;
  }

  for (const value of values) {
    const withoutProvince = stripProvinceAliasPrefix(value ?? "");
    const withoutPrefecture = stripPrefecturePrefix(withoutProvince);
    const city = withoutPrefecture.match(/[\u4e00-\u9fa5]{2,10}?市/u)?.[0];
    if (city) return normalizeName(city);
  }

  for (const value of values) {
    const directAdmin = extractDirectAdminCityNames(value ?? "")[0];
    if (directAdmin) return directAdmin;
  }

  return undefined;
}

function findProvinces(value: string): string[] {
  const normalizedValue = normalizeName(value);
  return PROVINCE_ALIASES.filter((province) =>
    province.aliases.some((alias) => normalizedValue.includes(normalizeName(alias))),
  ).map((province) => province.key);
}

type AmapAdministrativeTarget = {
  provinceKeys: Set<string>;
  cityNames: Set<string>;
  districtNames: Set<string>;
  softLocalityHints: Set<string>;
  adcodes: string[];
};

function buildAmapAdministrativeTarget(
  destination: string,
  region: string,
): AmapAdministrativeTarget {
  const cityNames = new Set([
    ...extractExplicitCityNames(region),
    ...extractDirectAdminCityNames(region),
    ...extractExplicitCityNames(destination),
    ...extractDirectAdminCityNames(destination),
  ]);
  const districtNames = new Set(extractExplicitDistrictNames(region));
  const softLocalityHints = new Set(extractLocalityTokens(region));
  for (const hint of [...softLocalityHints]) {
    const aliasTarget = LOCALITY_ALIAS_TARGETS[hint];
    if (!aliasTarget) continue;
    for (const city of aliasTarget.cityNames ?? []) {
      cityNames.add(normalizeAdminName(city));
    }
    for (const district of aliasTarget.districtNames ?? []) {
      districtNames.add(normalizeAdminName(district));
    }
    softLocalityHints.delete(hint);
  }
  return {
    provinceKeys: new Set([...findProvinces(region), ...findProvinces(destination)]),
    cityNames,
    districtNames,
    softLocalityHints,
    adcodes: [...new Set([...extractAdcodes(region), ...extractAdcodes(destination)])],
  };
}

function isAdcodeCompatible(expected: string, actual: string): boolean {
  if (!/^\d{6}$/u.test(expected) || !/^\d{6}$/u.test(actual)) return false;
  if (expected === actual) return true;
  if (expected.slice(2) === "0000" || actual.slice(2) === "0000") {
    return expected.slice(0, 2) === actual.slice(0, 2);
  }
  if (expected.endsWith("00") || actual.endsWith("00")) {
    return expected.slice(0, 4) === actual.slice(0, 4);
  }
  return false;
}

function isTrustedAmapQuery(
  queryCity: string | undefined,
  target: AmapAdministrativeTarget,
): boolean {
  const normalizedQuery = queryCity?.trim();
  if (!normalizedQuery) return false;
  const queryAdcode = extractAdcodes(normalizedQuery)[0];
  if (queryAdcode && target.adcodes.some((expected) => isAdcodeCompatible(expected, queryAdcode))) {
    return true;
  }
  const normalizedCity = normalizeAdminName(normalizedQuery);
  return (
    target.cityNames.has(normalizedCity) ||
    target.districtNames.has(normalizedCity) ||
    target.softLocalityHints.has(normalizedCity)
  );
}

function resolveSoftCityHints(pois: AmapPoi[], softLocalityHints: Set<string>): Set<string> {
  const resolved = new Set<string>();
  for (const hint of softLocalityHints) {
    const normalizedHint = normalizeAdminName(hint);
    if (!normalizedHint) continue;
    if (pois.some((poi) => normalizeAdminName(poi.city ?? "") === normalizedHint)) {
      resolved.add(normalizedHint);
    }
  }
  return resolved;
}

function textHasAnyTargetToken(text: string, tokens: Iterable<string>): boolean {
  for (const token of tokens) {
    if (token && text.includes(token)) return true;
  }
  return false;
}

function isRelevantAmapPoi(
  poi: AmapPoi,
  destination: string,
  target: AmapAdministrativeTarget,
  searchContext: { queryCity?: string } = {},
): boolean {
  const poiText = normalizeName(
    [poi.name, poi.address, poi.type, poi.province, poi.city, poi.district, poi.adcode]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  const destinationText = normalizeName(destination);
  if (!destinationText || !poiText.includes(destinationText)) return false;

  if (target.provinceKeys.size > 0) {
    const mentionedProvinces = new Set([
      ...findProvinces(poi.province ?? ""),
      ...findProvinces(poi.address),
      ...findProvinces(poiText),
    ]);
    if (
      mentionedProvinces.size > 0 &&
      ![...mentionedProvinces].some((province) => target.provinceKeys.has(province))
    ) {
      return false;
    }
  }

  const trustedQuery = isTrustedAmapQuery(searchContext.queryCity, target);
  const poiAdcode = extractAdcodes(poi.adcode ?? "")[0] ?? extractAdcodes(poi.address)[0];
  if (target.adcodes.length > 0) {
    if (poiAdcode) {
      if (!target.adcodes.some((expected) => isAdcodeCompatible(expected, poiAdcode))) {
        return false;
      }
      return true;
    } else if (!trustedQuery) {
      // 目标只给 adcode 时，没有 POI adcode 就无从核对；无城市查询上下文则拒绝。
      return false;
    }
  }

  const poiCity = normalizeAdminName(poi.city ?? "");
  const poiDistrict = normalizeAdminName(poi.district ?? "");
  const cityMatches = Boolean(poiCity && target.cityNames.has(poiCity));
  const districtMatches = Boolean(poiDistrict && target.districtNames.has(poiDistrict));
  const softStructuredMatch = Boolean(
    (poiCity && target.softLocalityHints.has(poiCity)) ||
    (poiDistrict && target.softLocalityHints.has(poiDistrict)),
  );
  const textMatchesSoft = textHasAnyTargetToken(poiText, target.softLocalityHints);
  if (softStructuredMatch || textMatchesSoft) return true;

  const poiAdminText = normalizeName(
    [poi.address, poi.province, poi.city, poi.district, poi.adcode]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  const textMatchesTrustedCity = textHasAnyTargetToken(poiAdminText, target.cityNames);
  const textMatchesTrustedDistrict = textHasAnyTargetToken(poiAdminText, target.districtNames);
  const hasTrustedLocality = target.cityNames.size > 0 || target.districtNames.size > 0;
  if (!hasTrustedLocality) return true;

  const hasStructuredLocality = Boolean(poiCity || poiDistrict);
  if (!hasStructuredLocality) {
    // 结构化字段缺失时保守放行，避免短地址合法 POI 因文本信息不足被误杀。
    return true;
  }

  if (target.districtNames.size > 0 && poiDistrict && !districtMatches) {
    return false;
  }
  if (target.cityNames.size > 0 && poiCity && !cityMatches) {
    return false;
  }
  if (cityMatches || districtMatches) return true;
  if (!poiCity && textMatchesTrustedCity) return true;
  if (!poiDistrict && textMatchesTrustedDistrict) return true;
  // 结构化字段缺失时保守放行，避免短地址合法 POI 因文本信息不足被误杀。
  return true;
}

function buildAreaKey(
  address: string,
  location: AmapCoordinate,
  admin?: Pick<AmapPoi, "city" | "district">,
): string {
  const structuredAreas = [admin?.city, admin?.district]
    .map((value) => normalizeAdminName(value ?? ""))
    .filter(Boolean);
  if (structuredAreas.length > 0) {
    return normalizeName(structuredAreas.slice(-2).join("-"));
  }

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

function candidateAreaTokens(areaKey: string | undefined): string[] {
  if (!areaKey) return [];
  return areaKey
    .split(/[-|/·,，;；、\s]+/u)
    .map((token) => normalizeAdminName(token))
    .filter(Boolean);
}

function supplementMatchesCandidateArea(
  candidate: PlannerCandidate,
  supplement: SearchResult,
): boolean {
  const tokens = candidateAreaTokens(candidate.areaKey);
  if (tokens.length === 0) return false;
  const haystack = normalizeName([supplement.title, supplement.url, supplement.content].join(" "));
  return tokens.every((token) => haystack.includes(token));
}

function findSupplementTargets(
  candidates: PlannerCandidate[],
  supplement: SearchResult,
): PlannerCandidate[] {
  const nameMatches = candidates.filter((candidate) =>
    isSameCandidateName(candidate.name, supplement.title),
  );
  if (nameMatches.length <= 1) return nameMatches;

  const areaMatches = nameMatches.filter((candidate) =>
    supplementMatchesCandidateArea(candidate, supplement),
  );
  // 同名多候选只有能按 areaKey 唯一定位时才补充，避免跨城市污染摘要。
  return areaMatches.length === 1 ? areaMatches : [];
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
  const seenKeys = new Set<string>();
  const primaryNames = new Set(input.primary.map((candidate) => normalizeName(candidate.name)));

  for (const candidate of input.primary) {
    const nameKey = normalizeName(candidate.name);
    const key = `${nameKey}|${candidate.areaKey ?? ""}`;
    if (!nameKey || seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push({ ...candidate });
  }

  for (const candidate of input.fallback) {
    const nameKey = normalizeName(candidate.name);
    const key = `${nameKey}|${candidate.areaKey ?? ""}`;
    if (!nameKey || primaryNames.has(nameKey) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push({ ...candidate });
  }

  for (const supplement of input.supplements ?? []) {
    if (!supplement.content.trim()) continue;
    const targets = findSupplementTargets(merged, supplement);
    for (const target of targets) {
      target.summary = appendSummary(target.summary, supplement.content);
    }
  }

  return merged;
}

export function buildAmapDestinationCandidates(pois: AmapPoi[]): PlannerDestinationCandidate[] {
  const candidates: PlannerDestinationCandidate[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();

  for (const poi of pois) {
    const poiType = poi.type.trim();
    if (/住宿服务|餐饮服务|购物服务|生活服务|公司企业|政府机构|科教文化服务;学校|商务住宅/u.test(poiType)) continue;
    if (!ATTRACTION_POI_TYPE_PATTERN.test(poiType)) continue;

    const id = poi.id.trim();
    const name = poi.name.trim();
    const areaKey = buildAreaKey(poi.address, poi.location, poi);
    const key = `${normalizeName(name)}|${areaKey}`;
    if ((id && seenIds.has(id)) || !name || seenKeys.has(key)) continue;
    if (id) seenIds.add(id);
    seenKeys.add(key);

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
      areaKey,
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
  const seenKeys = new Set<string>();
  const areas: { areaKey: string; centroid: AmapCoordinate; candidates: DestinationCandidate[] }[] =
    [];

  for (const candidate of candidates) {
    const id = candidate.id.trim();
    const nameKey = normalizeName(candidate.name);
    const areaKey = candidate.areaKey.trim() || buildAreaKey(candidate.address, candidate.location);
    const key = `${nameKey}|${areaKey}`;
    if ((id && seenIds.has(id)) || !nameKey || seenKeys.has(key)) continue;
    if (id) seenIds.add(id);
    seenKeys.add(key);

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
  const entries = [
    { pois: exactBatch, queryCity: city },
    { pois: exactRetryBatch, queryCity: undefined },
    ...genericBatches.map((pois) => ({ pois, queryCity: city })),
  ].flatMap(({ pois, queryCity }) => (pois ?? []).map((poi) => ({ poi, queryCity })));
  const target = buildAmapAdministrativeTarget(destination, region);
  const resolvedSoftCityHints = resolveSoftCityHints(
    entries.map((entry) => entry.poi),
    target.softLocalityHints,
  );
  const effectiveTarget = {
    ...target,
    cityNames: new Set([...target.cityNames, ...resolvedSoftCityHints]),
  };
  const relevant = entries
    .filter(({ poi, queryCity }) =>
      isRelevantAmapPoi(poi, destination, effectiveTarget, { queryCity }),
    )
    .map(({ poi }) => poi);

  return buildAmapDestinationCandidates(relevant);
}

export async function searchAmapWaypointCandidates(input: {
  client: AmapClient | null;
  waypoint: string;
  region?: string;
  maxCandidates?: number;
}): Promise<PlannerDestinationCandidate[]> {
  if (!input.client) return [];
  const queryCity = input.region?.trim() || input.waypoint.trim();
  const batches = await Promise.all(
    ["热门景点", "风景名胜"].map((keywords) =>
      input.client!.searchPoi({ keywords, city: queryCity }).catch(() => []),
    ),
  );
  const target = buildAmapAdministrativeTarget(input.waypoint, input.region ?? input.waypoint);
  const relevant = batches
    .flat()
    .filter((poi) => ATTRACTION_POI_TYPE_PATTERN.test(poi.type))
    .filter((poi) => isRelevantAmapPoi(poi, input.waypoint, target));
  const maxCandidates = Math.max(1, Math.floor(input.maxCandidates ?? 6));
  return buildAmapDestinationCandidates(relevant).slice(0, maxCandidates);
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

/** 把 POI 搜索结果转成地理编码结构，供后续距离与交通计算复用。 */
function poiAsGeocode(poi: AmapPoi): AmapGeocode {
  return {
    formattedAddress: poi.address || poi.name,
    province: poi.province ?? "",
    city: poi.city ?? "",
    district: poi.district ?? "",
    adcode: poi.adcode ?? "",
    location: poi.location,
  };
}

const PLACE_SUFFIX_PATTERN = /(草原|风景区|景区|古城|古镇|度假区|旅游区|国家森林公园|森林公园|公园)$/u;

/**
 * 解析单个地点坐标：地理编码优先，失败后回退到 POI 搜索。
 * 「那拉提草原」这类景区/自然地名的正式 POI 名可能不同（如「那拉提旅游风景区」），
 * 只做地理编码会搜不到，导致整个行程被判为不可规划。
 */
async function resolveRouteNodeGeocode(
  client: AmapClient,
  name: string,
): Promise<AmapGeocode | undefined> {
  try {
    const geocodes = await client.geocode({ address: name });
    if (geocodes[0]) return geocodes[0];
  } catch {
    // 继续尝试 POI 搜索。
  }

  const tryPoi = async (keywords: string): Promise<AmapGeocode | undefined> => {
    try {
      const pois = await client.searchPoi({ keywords });
      const poi = pois[0];
      return poi ? poiAsGeocode(poi) : undefined;
    } catch {
      return undefined;
    }
  };

  const byPoi = await tryPoi(name);
  if (byPoi) return byPoi;

  // 去掉「草原 / 风景区 / 古城」等后缀再搜一次，例如「那拉提草原」→「那拉提」。
  const trimmed = name.replace(PLACE_SUFFIX_PATTERN, "").trim();
  if (trimmed && trimmed !== name) return tryPoi(trimmed);

  return undefined;
}

async function geocodeRouteNodes(
  client: AmapClient | null,
  route: RoutePlan,
): Promise<Map<string, AmapGeocode>> {
  if (!client) return new Map();
  const names = [...new Set(route.legs.flatMap((leg) => [leg.from, leg.to]))];
  const results = await Promise.all(
    names.map(async (name) => [name, await resolveRouteNodeGeocode(client, name)] as const),
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
    crossProvince: isCrossProvince(from, to) && legDistanceKm >= LONG_DISTANCE_FLIGHT_KM,
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
      "高德搜索不到旅行地点「" +
        missingNodes.join("、") +
        "」。请返回更换旅行地点，或改用附近城市名称。",
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
        return {
          status: "degraded",
          reason: "无法计算 " + leg.from + " 到 " + leg.to + " 的有效距离",
        };
      }

      const mode = resolveTransportMode(leg.transport, legDistanceKm, fromGeocode, toGeocode);
      const calculation = calculateTransportLeg({
        mode,
        distanceKm: legDistanceKm,
        travelers: headcount,
        routeDurationMinutes,
      });
      const planLeg: TransportPlanLeg = {
        id: leg.id,
        kind: leg.kind,
        from: leg.from,
        to: leg.to,
        distanceKm: legDistanceKm,
        mode,
        ...calculation,
      };
      if (mode === "drive") {
        const executionSegments = splitTransportLegIntoSegments(
          planLeg,
          input.dailyDriveLimitMinutes,
        );
        if (executionSegments.length > 1) planLeg.executionSegments = executionSegments;
      }

      return {
        status: "ready",
        routeLeg: { ...leg, transport: mode },
        planLeg,
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
      .map(({ routeLeg, planLeg }) => buildPriceReference(routeLeg, input, planLeg, headcount)),
  );

  return {
    status: "ready",
    route,
    legs,
    references,
    minimumTotal: legs.reduce((total, leg) => total + leg.minimumPerPersonCost * headcount, 0),
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
