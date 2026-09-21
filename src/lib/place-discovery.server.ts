import {
  buildDiscoveredPlaceRecord,
  canonicalPlaceKey,
  classifyPlaceConfidence,
  normalizePlaceName,
  sanitizePlaceText,
  type DiscoveredPlaceRecord,
  type DiscoveredPlaceSource,
  type PlacePersistenceRepository,
} from "./place-discovery.ts";
import type { DiscoverySourceGroup, SearchResult } from "./live-planner.ts";
import type { RoutePlan } from "./route-planner.ts";
import {
  parsePlaceVerificationBatch,
  parsePlaceVerificationJson,
  type PlaceVerificationGroup,
  type VerifiedPlaceResult,
} from "./place-verification.ts";
import { createUniqueVisualSeed } from "./scene-art.ts";
import { dedupeSources, searchTavily } from "./tavily.server.ts";
import { sceneDestinations } from "../data/scene-catalog.ts";

export type PlaceSearchBundle = {
  inputName: string;
  normalizedName: string;
  queries: string[];
  results: SearchResult[];
};

export type PersistedPlaceResults = {
  verified: DiscoveredPlaceRecord[];
  candidate: DiscoveredPlaceRecord[];
  rejected: VerifiedPlaceResult[];
  failed: { result: VerifiedPlaceResult; message: string }[];
};

export type RouteDiscoveryNotice = {
  inputName: string;
  status: "published" | "candidate" | "rejected" | "failed";
  canonicalName?: string;
  region?: string;
  message: string;
};

export type RouteDiscoveryResult = {
  notices: RouteDiscoveryNotice[];
  searchResults: SearchResult[];
  sourceGroups: DiscoverySourceGroup[];
  verifiedPlaces: DiscoveredPlaceRecord[];
  candidatePlaces: DiscoveredPlaceRecord[];
};

type RouteDiscoveryInput = {
  route: RoutePlan;
  deepseekKey?: string;
  tavilyKey?: string;
  fetchImpl?: typeof fetch;
  maxUnknown?: number;
  repository?: PlacePersistenceRepository;
  /** live planner 的目的地景点由 AMap 负责，可关闭 Tavily 目的地发现。 */
  includeDestination?: boolean;
};

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const CANDIDATE_REUSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_UNKNOWN = 5;
const STATIC_DESTINATION_NAMES = new Set(
  sceneDestinations.map((destination) => normalizePlaceName(destination.name)),
);

const PLACE_ART_ACCENTS = {
  "ancient-city": "#8b704d",
  architecture: "#8a6654",
  canyon: "#8c705f",
  city: "#4f7891",
  coast: "#2f8295",
  danxia: "#b45f48",
  desert: "#b77a42",
  forest: "#577c61",
  grassland: "#648b5f",
  grotto: "#8b725b",
  island: "#317f8f",
  lake: "#337da4",
  mountain: "#45695d",
  snow: "#688ba5",
  temple: "#8a6848",
  tulou: "#8d694e",
  waterfall: "#3a8796",
} as const;

const PLACE_ART_RULES: { art: keyof typeof PLACE_ART_ACCENTS; pattern: RegExp }[] = [
  { art: "tulou", pattern: /土楼|围屋/ },
  { art: "ancient-city", pattern: /古城|古镇|古村|水乡|老街/ },
  { art: "grotto", pattern: /石窟|溶洞|洞穴/ },
  { art: "temple", pattern: /寺庙|寺院|道观|祠堂|教堂|祠|庙|寺/ },
  { art: "waterfall", pattern: /瀑布/ },
  { art: "canyon", pattern: /峡谷/ },
  { art: "danxia", pattern: /丹霞/ },
  { art: "island", pattern: /海岛|岛屿|岛/ },
  { art: "coast", pattern: /海滨|海岸|海滩|沙滩|滨海/ },
  { art: "lake", pattern: /湖泊|湖景|天池|湖/ },
  { art: "snow", pattern: /雪山|冰川|雪乡|雪景/ },
  { art: "mountain", pattern: /山脉|山岳|山峰|山/ },
  { art: "grassland", pattern: /草原|牧场/ },
  { art: "desert", pattern: /沙漠|戈壁/ },
  { art: "forest", pattern: /森林|雨林/ },
  { art: "architecture", pattern: /建筑|楼阁|楼|桥/ },
  { art: "city", pattern: /城市|市区/ },
];

export function buildPlaceSearchQueries(name: string): string[] {
  return [`${name} 所属地区 景点 一日游 推荐`];
}

export async function searchPlaceSources(
  name: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PlaceSearchBundle> {
  const normalizedName = normalizePlaceName(name);
  const queries = buildPlaceSearchQueries(normalizedName);
  const searchBatches = await Promise.all(
    queries.map((query) =>
      searchTavily(apiKey, query, process.env.TAVILY_SEARCH_URL?.trim(), fetchImpl),
    ),
  );

  return {
    inputName: name,
    normalizedName,
    queries,
    results: dedupeSources(searchBatches.flat()),
  };
}

export function routeNodesNeedingDiscovery(
  route: RoutePlan,
  knownNames: ReadonlySet<string>,
  maxUnknown = DEFAULT_MAX_UNKNOWN,
  includeDestination = true,
): string[] {
  const known = new Set(
    [...knownNames, ...STATIC_DESTINATION_NAMES]
      .map((name) => normalizePlaceName(name))
      .filter((name) => name),
  );
  const seen = new Set<string>();
  const nodes: string[] = [];
  const limit = Number.isFinite(maxUnknown)
    ? Math.max(0, Math.floor(maxUnknown))
    : Number.POSITIVE_INFINITY;
  const normalizedOrigin = normalizePlaceName(route.origin);
  if (normalizedOrigin) seen.add(normalizedOrigin);

  const discoveryNodes = includeDestination
    ? [...route.waypoints, route.destination]
    : route.waypoints;
  for (const rawNode of discoveryNodes) {
    if (nodes.length >= limit) break;
    const node = sanitizePlaceText(rawNode);
    const normalized = normalizePlaceName(node);
    if (!normalized || known.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    nodes.push(node);
  }

  return nodes;
}

function routeContextFor(route: RoutePlan, inputName: string): string[] {
  const nodes = [route.origin, ...route.waypoints, route.destination]
    .map((node) => sanitizePlaceText(node))
    .filter(Boolean);
  const index = nodes.findIndex(
    (node) => normalizePlaceName(node) === normalizePlaceName(inputName),
  );
  if (index < 0) return [];
  return [nodes[index - 1], nodes[index + 1]].filter((node): node is string => Boolean(node));
}

function buildDiscoverySourceGroups(
  routeNodes: string[],
  cachedByNormalizedName: Map<string, DiscoveredPlaceRecord>,
  successfulSearches: { inputName: string; bundle: PlaceSearchBundle }[],
): DiscoverySourceGroup[] {
  const sourcesByNormalizedName = new Map<string, SearchResult[]>();
  for (const record of cachedByNormalizedName.values()) {
    sourcesByNormalizedName.set(
      record.normalizedName,
      record.sourceSnapshot.map(({ title, url, content }) => ({
        title,
        url,
        content,
      })),
    );
  }
  for (const { bundle } of successfulSearches) {
    sourcesByNormalizedName.set(bundle.normalizedName, bundle.results);
  }

  return routeNodes.flatMap((inputName) => {
    const normalizedName = normalizePlaceName(inputName);
    const sources = sourcesByNormalizedName.get(normalizedName);
    if (!sources || sources.length === 0) return [];
    return [
      {
        inputName,
        sources: dedupeSources(sources),
      },
    ];
  });
}

function isReusableCandidate(record: DiscoveredPlaceRecord, now: number): boolean {
  const lastVerifiedAt = Date.parse(record.lastVerifiedAt);
  return Number.isFinite(lastVerifiedAt) && now - lastVerifiedAt <= CANDIDATE_REUSE_WINDOW_MS;
}

function noticeForCachedPlace(
  inputName: string,
  record: DiscoveredPlaceRecord,
): RouteDiscoveryNotice {
  if (record.status === "verified") {
    return {
      inputName,
      status: "published",
      canonicalName: record.canonicalName,
      region: record.region,
      message: `已复用已校核地点「${record.canonicalName}」`,
    };
  }
  return {
    inputName,
    status: "candidate",
    canonicalName: record.canonicalName,
    region: record.region,
    message: `已复用 30 天内的候选地点「${record.canonicalName}」`,
  };
}

function errorMessage(error: unknown): string {
  return sanitizePlaceText(error instanceof Error ? error.message : String(error), 180);
}

export async function discoverRoutePlaces(
  input: RouteDiscoveryInput,
): Promise<RouteDiscoveryResult> {
  const deepseekKey = input.deepseekKey?.trim();
  const tavilyKey = input.tavilyKey?.trim();
  if (!deepseekKey || !tavilyKey) {
    const missing = [!deepseekKey ? "DeepSeek" : null, !tavilyKey ? "Tavily" : null].filter(
      (name): name is string => Boolean(name),
    );
    return {
      notices: routeNodesNeedingDiscovery(
        input.route,
        new Set(),
        input.maxUnknown,
        input.includeDestination !== false,
      ).map(
        (inputName) => ({
          inputName,
          status: "failed",
          message: `缺少 ${missing.join("、")} 密钥，无法发现地点`,
        }),
      ),
      searchResults: [],
      sourceGroups: [],
      verifiedPlaces: [],
      candidatePlaces: [],
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const persistence = input.repository ?? (await import("./discovered-places.server.ts"));
  const routeNodes = routeNodesNeedingDiscovery(
    input.route,
    new Set(),
    Number.POSITIVE_INFINITY,
    input.includeDestination !== false,
  );
  const now = Date.now();
  const cachedByNormalizedName = new Map<string, DiscoveredPlaceRecord>();
  const cachedNoticesByNormalizedName = new Map<string, RouteDiscoveryNotice>();
  const cachedSearchResults: SearchResult[] = [];

  for (const inputName of routeNodes) {
    const normalizedName = normalizePlaceName(inputName);
    let records: DiscoveredPlaceRecord[] = [];
    try {
      records = await persistence.findDiscoveredPlaceByName(normalizedName);
    } catch {
      records = [];
    }

    // A normalized input name may legitimately map to several regions. Reusing
    // one of those rows would silently choose a region, so force a fresh search
    // and let verification use the in-memory route context instead.
    if (new Set(records.map((record) => record.canonicalKey)).size > 1) {
      continue;
    }

    const record =
      records.find((candidate) => candidate.status === "verified") ??
      records.find((candidate) => isReusableCandidate(candidate, now));
    if (!record) continue;

    let reusableRecord = record;
    if (persistence.touchDiscoveredPlaceUsage) {
      try {
        reusableRecord =
          (await persistence.touchDiscoveredPlaceUsage(record.canonicalKey)) ?? record;
      } catch {
        reusableRecord = record;
      }
    }

    cachedByNormalizedName.set(normalizedName, reusableRecord);
    cachedNoticesByNormalizedName.set(
      normalizedName,
      noticeForCachedPlace(inputName, reusableRecord),
    );
    cachedSearchResults.push(
      ...reusableRecord.sourceSnapshot.map(({ title, url, content }) => ({
        title,
        url,
        content,
      })),
    );
  }

  const knownNames = new Set(cachedByNormalizedName.keys());
  const unknownNames = routeNodesNeedingDiscovery(
    input.route,
    knownNames,
    input.maxUnknown,
    input.includeDestination !== false,
  );
  const searchSettled = await Promise.allSettled(
    unknownNames.map((inputName) => searchPlaceSources(inputName, tavilyKey, fetchImpl)),
  );
  const successfulSearches: { inputName: string; bundle: PlaceSearchBundle }[] = [];
  const searchedNoticesByNormalizedName = new Map<string, RouteDiscoveryNotice>();

  searchSettled.forEach((outcome, index) => {
    const inputName = unknownNames[index];
    if (!inputName) return;
    const normalizedName = normalizePlaceName(inputName);
    if (outcome.status === "rejected") {
      searchedNoticesByNormalizedName.set(normalizedName, {
        inputName,
        status: "failed",
        message: `地点搜索失败：${errorMessage(outcome.reason)}`,
      });
      return;
    }
    if (outcome.value.results.length === 0) {
      searchedNoticesByNormalizedName.set(normalizedName, {
        inputName,
        status: "failed",
        message: "地点搜索未返回可用来源",
      });
      return;
    }
    successfulSearches.push({ inputName, bundle: outcome.value });
  });

  const sourceGroups = buildDiscoverySourceGroups(
    routeNodes,
    cachedByNormalizedName,
    successfulSearches,
  );
  const searchResults = dedupeSources([
    ...cachedSearchResults,
    ...successfulSearches.flatMap(({ bundle }) => bundle.results),
  ]);
  const groups: PlaceVerificationGroup[] = successfulSearches.map(({ inputName, bundle }) => ({
    inputName: bundle.inputName,
    normalizedName: bundle.normalizedName,
    routeContext: routeContextFor(input.route, inputName),
    results: bundle.results,
  }));

  let verifiedResults: VerifiedPlaceResult[] = [];
  if (groups.length > 0) {
    try {
      const verification = await verifyPlaceGroupsWithDeepSeekSafe({
        apiKey: deepseekKey,
        groups,
        fetchImpl,
      });
      verifiedResults = verification.results;
      for (const failure of verification.failures) {
        const successfulSearch = successfulSearches.find(
          ({ bundle }) =>
            sanitizePlaceText(bundle.inputName) === sanitizePlaceText(failure.inputName),
        );
        if (!successfulSearch) continue;
        searchedNoticesByNormalizedName.set(normalizePlaceName(successfulSearch.inputName), {
          inputName: successfulSearch.inputName,
          status: "failed",
          message: failure.message,
        });
      }
    } catch (error) {
      const message = `地点校核失败：${errorMessage(error)}`;
      for (const { inputName } of successfulSearches) {
        searchedNoticesByNormalizedName.set(normalizePlaceName(inputName), {
          inputName,
          status: "failed",
          message,
        });
      }
      return {
        notices: routeNodes.flatMap((inputName) => {
          const normalizedName = normalizePlaceName(inputName);
          const notice =
            cachedNoticesByNormalizedName.get(normalizedName) ??
            searchedNoticesByNormalizedName.get(normalizedName);
          return notice ? [notice] : [];
        }),
        searchResults,
        sourceGroups,
        verifiedPlaces: [...cachedByNormalizedName.values()].filter(
          (place) => place.status === "verified",
        ),
        candidatePlaces: [...cachedByNormalizedName.values()].filter(
          (place) => place.status === "candidate",
        ),
      };
    }
  }

  let persisted: PersistedPlaceResults = { verified: [], candidate: [], rejected: [], failed: [] };
  if (verifiedResults.length > 0) {
    persisted = await persistVerifiedPlaceResults(verifiedResults, groups, persistence);
  }

  const rejectedByInputName = new Map(
    persisted.rejected.map((result) => [sanitizePlaceText(result.inputName), result] as const),
  );
  const failedByInputName = new Map(
    persisted.failed.map(
      (failure) => [sanitizePlaceText(failure.result.inputName), failure] as const,
    ),
  );
  const savedByCanonicalKey = new Map(
    [...persisted.verified, ...persisted.candidate].map((place) => [place.canonicalKey, place]),
  );

  for (const { inputName, bundle } of successfulSearches) {
    const normalizedName = normalizePlaceName(inputName);
    const result = verifiedResults.find(
      (place) => sanitizePlaceText(place.inputName) === sanitizePlaceText(bundle.inputName),
    );
    if (!result) {
      if (!searchedNoticesByNormalizedName.has(normalizedName)) {
        searchedNoticesByNormalizedName.set(normalizedName, {
          inputName,
          status: "failed",
          message: "地点校核未返回结果",
        });
      }
      continue;
    }
    if (rejectedByInputName.has(sanitizePlaceText(result.inputName))) {
      searchedNoticesByNormalizedName.set(normalizedName, {
        inputName,
        status: "rejected",
        canonicalName: result.canonicalName,
        region: result.region,
        message: "地点证据不足或存在地区冲突，未收录",
      });
      continue;
    }
    const failed = failedByInputName.get(sanitizePlaceText(result.inputName));
    if (failed) {
      searchedNoticesByNormalizedName.set(normalizedName, {
        inputName,
        status: "failed",
        canonicalName: result.canonicalName,
        region: result.region,
        message: `地点入库失败：${failed.message}`,
      });
      continue;
    }

    const saved = savedByCanonicalKey.get(canonicalPlaceKey(result.canonicalName, result.region));
    if (!saved) {
      searchedNoticesByNormalizedName.set(normalizedName, {
        inputName,
        status: "failed",
        message: "地点校核结果未入库",
      });
      continue;
    }
    searchedNoticesByNormalizedName.set(normalizedName, {
      inputName,
      status: saved.status === "verified" ? "published" : "candidate",
      canonicalName: saved.canonicalName,
      region: saved.region,
      message:
        saved.status === "verified"
          ? `已校核并收录地点「${saved.canonicalName}」`
          : `已记录候选地点「${saved.canonicalName}」`,
    });
  }

  const verifiedPlaces = [...cachedByNormalizedName.values(), ...persisted.verified].filter(
    (place) => place.status === "verified",
  );
  const candidatePlaces = [...cachedByNormalizedName.values(), ...persisted.candidate].filter(
    (place) => place.status === "candidate",
  );

  return {
    notices: routeNodes.flatMap((inputName) => {
      const normalizedName = normalizePlaceName(inputName);
      const notice =
        cachedNoticesByNormalizedName.get(normalizedName) ??
        searchedNoticesByNormalizedName.get(normalizedName);
      return notice ? [notice] : [];
    }),
    searchResults,
    sourceGroups,
    verifiedPlaces,
    candidatePlaces,
  };
}

function buildPlaceVerificationMessages(groups: PlaceVerificationGroup[]) {
  const payload = groups.map((group) => ({
    inputName: group.inputName,
    normalizedName: group.normalizedName,
    routeContext: group.routeContext,
    allowedSourceUrls: group.results.map((result) => result.url),
    sources: group.results.slice(0, 8).map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content.slice(0, 1200),
    })),
  }));

  return [
    {
      role: "system",
      content:
        '你是中文地点校核员。只能使用用户提供的 sources、allowedSourceUrls 和 routeContext，不得使用未提供的地区证据，也不得补造来源。校核规范名称、所属地区、国家、地点类型，并给出摘要、标签、别名、0 到 1 的置信度和理由。同名异地、行政区证据冲突或证据不足时必须把 ambiguous 设为 true。每个 sourceUrls 只能引用本地点 allowedSourceUrls 中的链接。只输出 JSON 对象 { "places": [...] }，不要 Markdown。',
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "批量校核旅行地点",
        requiredSchema: {
          places: [
            {
              inputName: "必须与输入地点完全一致",
              canonicalName: "规范化地点名称",
              region: "所属省、市或地区",
              country: "国家或地区",
              placeType: "城市、景区、古镇、自然地貌等",
              summary: "简短介绍",
              tags: ["看点或玩法"],
              aliases: ["别名"],
              confidence: "0 到 1 的数字",
              ambiguous: "同名异地、证据冲突或证据不足时为 true",
              reasons: ["判断依据"],
              sourceUrls: ["只能来自该地点的 allowedSourceUrls"],
            },
          ],
        },
        groups: payload,
      }),
    },
  ];
}

type VerifyPlaceGroupsInput = {
  apiKey: string;
  baseUrl?: string;
  groups: PlaceVerificationGroup[];
  fetchImpl?: typeof fetch;
};

async function requestPlaceVerificationContent(input: VerifyPlaceGroupsInput): Promise<string> {
  const baseUrl = (input.baseUrl?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat",
      messages: buildPlaceVerificationMessages(input.groups),
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `DeepSeek 地点校核失败（${response.status}）${message ? `：${message.slice(0, 180)}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("DeepSeek 未返回地点校核内容");
  }
  return content;
}

export async function verifyPlaceGroupsWithDeepSeek(
  input: VerifyPlaceGroupsInput,
): Promise<VerifiedPlaceResult[]> {
  if (input.groups.length === 0) return [];
  const content = await requestPlaceVerificationContent(input);
  return parsePlaceVerificationJson(content, input.groups);
}

export async function verifyPlaceGroupsWithDeepSeekSafe(
  input: VerifyPlaceGroupsInput,
): Promise<ReturnType<typeof parsePlaceVerificationBatch>> {
  if (input.groups.length === 0) return { results: [], failures: [] };
  const content = await requestPlaceVerificationContent(input);
  return parsePlaceVerificationBatch(content, input.groups);
}

function inferPlaceArt(result: VerifiedPlaceResult): keyof typeof PLACE_ART_ACCENTS {
  const haystack = [result.canonicalName, result.placeType, ...result.tags].join(" ");
  return PLACE_ART_RULES.find((rule) => rule.pattern.test(haystack))?.art ?? "city";
}

function sourceSnapshotFor(
  result: VerifiedPlaceResult,
  group: PlaceVerificationGroup,
): DiscoveredPlaceSource[] {
  const byUrl = new Map(group.results.map((source) => [source.url.trim(), source] as const));
  const seen = new Set<string>();
  return result.sourceUrls.flatMap((url) => {
    if (seen.has(url)) return [];
    seen.add(url);
    const source = byUrl.get(url);
    return source ? [{ title: source.title, url: source.url.trim(), content: source.content }] : [];
  });
}

function isVisualSeedConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return (
    candidate.code === "23505" &&
    (candidate.constraint === "discovered_places_visual_seed_key" ||
      (typeof candidate.message === "string" && /visual_seed/i.test(candidate.message)))
  );
}

async function upsertNewPlace(
  repository: PlacePersistenceRepository,
  buildRecord: (visualSeed: number) => DiscoveredPlaceRecord,
  canonicalKey: string,
  usedSeeds: Set<number>,
): Promise<DiscoveredPlaceRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const visualSeed = createUniqueVisualSeed(canonicalKey, usedSeeds);
    try {
      const saved = await repository.upsertDiscoveredPlace(buildRecord(visualSeed));
      usedSeeds.add(visualSeed);
      return saved;
    } catch (error) {
      if (!isVisualSeedConflict(error)) throw error;
      usedSeeds.add(visualSeed);
    }
  }
  throw new Error("无法分配唯一视觉种子");
}

function hasPublishableEvidence(
  result: VerifiedPlaceResult,
  group: PlaceVerificationGroup,
): boolean {
  return sourceSnapshotFor(result, group).some((source) => source.content.trim().length > 0);
}

export async function persistVerifiedPlaceResults(
  results: VerifiedPlaceResult[],
  groups: PlaceVerificationGroup[],
  repository?: PlacePersistenceRepository,
): Promise<PersistedPlaceResults> {
  const persistence = repository ?? (await import("./discovered-places.server.ts"));
  const groupsByName = new Map(
    groups.map((group) => [sanitizePlaceText(group.inputName), group] as const),
  );
  const existingByName = new Map<string, DiscoveredPlaceRecord[]>();
  const usedSeeds = new Set<number>();
  const persisted: PersistedPlaceResults = {
    verified: [],
    candidate: [],
    rejected: [],
    failed: [],
  };

  async function findExisting(normalizedName: string): Promise<DiscoveredPlaceRecord[]> {
    const cached = existingByName.get(normalizedName);
    if (cached) return cached;
    const rows = await persistence.findDiscoveredPlaceByName(normalizedName);
    existingByName.set(normalizedName, rows);
    for (const row of rows) usedSeeds.add(row.visualSeed);
    return rows;
  }

  for (const result of results) {
    try {
      const confidenceStatus = classifyPlaceConfidence(result.confidence, result.ambiguous);
      if (confidenceStatus === "rejected") {
        persisted.rejected.push(result);
        continue;
      }

      const group = groupsByName.get(result.inputName);
      if (!group) {
        throw new Error(`地点「${result.inputName}」未找到匹配的输入地点`);
      }

      const canonicalKey = canonicalPlaceKey(result.canonicalName, result.region);
      const normalizedName = normalizePlaceName(result.canonicalName);
      const existingRows = await findExisting(normalizedName);
      const existing = existingRows.find((row) => row.canonicalKey === canonicalKey);
      const art = inferPlaceArt(result);
      const accent = PLACE_ART_ACCENTS[art];
      const sourceSnapshot = sourceSnapshotFor(result, group);
      // A confidence score is not evidence. High-confidence claims without an
      // allowed source carrying real content remain candidates, never verified.
      const status =
        confidenceStatus === "verified" && !hasPublishableEvidence(result, group)
          ? "candidate"
          : confidenceStatus;
      const buildRecord = (visualSeed: number) =>
        buildDiscoveredPlaceRecord({
          canonicalName: result.canonicalName,
          region: result.region,
          country: result.country,
          placeType: result.placeType,
          summary: result.summary,
          tags: result.tags,
          sourceSnapshot,
          confidence: result.confidence,
          status,
          art,
          accent,
          visualSeed,
          routeContext: [],
          usageCount: existing?.usageCount,
        });

      const saved = existing
        ? await persistence.upsertDiscoveredPlace(buildRecord(existing.visualSeed))
        : await upsertNewPlace(persistence, buildRecord, canonicalKey, usedSeeds);

      persisted[status].push(saved);
      existingByName.set(normalizedName, [
        ...existingRows.filter((row) => row.canonicalKey !== canonicalKey),
        saved,
      ]);
    } catch (error) {
      persisted.failed.push({ result, message: errorMessage(error) });
    }
  }

  return persisted;
}
