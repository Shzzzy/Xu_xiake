import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  buildPlannerMessages,
  mapDiscoveredStops,
  parsePlannerJson,
  selectPlannerSources,
  type DiscoverySourceGroup,
  type DiscoveredStop,
  type SearchResult,
} from "./live-planner.ts";
import { buildLongPlannerMessages, parseLongPlanJson, type LongPlan } from "./long-planner.ts";
import type { TripClosing } from "./travel-plan.ts";
import type { Pace, WeatherDay } from "./planner.ts";
import type { RoutePlan, TransportPriceReference } from "./route-planner.ts";
import type { AmapClient } from "./amap.server.ts";
import type { RouteDiscoveryNotice } from "./place-discovery.server.ts";
import type { PlacePersistenceRepository } from "./place-discovery.ts";
import type { ButlerPlanInput } from "./planner-orchestrator.server.ts";
import type { BudgetPlan } from "./budget-planner.ts";
import type { PlannerDestinationCandidate } from "./planner-context.server.ts";
import type { TransportPlanLeg } from "./transport-planner.server.ts";
import type { PlannerSkeleton } from "./planner-skeleton.ts";
import type { PlannerDayCopy } from "./planner-day-copy.ts";
import type { PlanViolation } from "./plan-validator.ts";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const loadPlaceDiscovery = createServerOnlyFn(async () => {
  const { discoverRoutePlaces, routeNodesNeedingDiscovery } =
    await import("./place-discovery.server.ts");
  return { discoverRoutePlaces, routeNodesNeedingDiscovery };
});

const loadTripClosing = createServerOnlyFn(async () => {
  const { buildTripClosingWithDeepSeek } = await import("./travel-plan.server.ts");
  return buildTripClosingWithDeepSeek;
});

const loadButler = createServerOnlyFn(async () => {
  const { planWithButler } = await import("./planner-orchestrator.server.ts");
  return planWithButler;
});

const loadPlannerContext = createServerOnlyFn(async () => {
  return import("./planner-context.server.ts");
});

const loadAmapE2eFixture = createServerOnlyFn(async () => {
  const { createAmapE2eFixtureClient } = await import("./amap-e2e-fixture.server.ts");
  return createAmapE2eFixtureClient;
});

export type DiscoveryNotice = RouteDiscoveryNotice;

const transportModes = [
  "economy",
  "balanced",
  "speed",
  "train",
  "flight",
  "drive",
  "bus",
  "ship",
] as const;

const travelStyles = ["direct", "wander"] as const;

const routeLegSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  transport: z.enum(transportModes),
  style: z.enum(travelStyles),
  kind: z.enum(["outbound", "return"]),
});

const routePlanSchema = z.object({
  origin: z.string().min(1),
  destination: z.string().min(1),
  waypoints: z.array(z.string().min(1)).max(5),
  roundTrip: z.boolean(),
  returnMode: z.enum(["scenic", "fast"]).nullable(),
  legs: z.array(routeLegSchema).min(1).max(7),
});

export type LivePlanResult =
  | {
      status: "needs_configuration";
      missing: string[];
    }
  | {
      status: "ok";
      /** 开关关闭时沿用现有实时链路。 */
      mode: "legacy";
      plan: ReturnType<typeof parsePlannerJson>;
      sources: SearchResult[];
      discoveries: DiscoveryNotice[];
      route: RoutePlan;
      /** 旅行回望：与主行程并行生成，失败时是确定性兜底文案。 */
      closing: TripClosing;
    }
  | {
      status: "ok";
      /** 开关打开时走管家排程，结果由 Task 10 消费。 */
      mode: "butler";
      skeleton: PlannerSkeleton;
      dayCopy: PlannerDayCopy[];
      failedDays: number[];
      violations: PlanViolation[];
      attempts: number;
      closing: TripClosing;
      candidates: PlannerDestinationCandidate[];
      transportLegs: TransportPlanLeg[];
      budget: BudgetPlan;
      sources: SearchResult[];
      discoveries: DiscoveryNotice[];
      route: RoutePlan;
    };

/** 可注入的环境变量：测试与 handler 都通过它读取，而不是直接读 process.env。 */
export type LivePlannerEnv = {
  BUTLER_PLANNER?: string;
  DEEPSEEK_API_KEY?: string;
  TAVILY_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  TAVILY_SEARCH_URL?: string;
  DEEPSEEK_MODEL?: string;
  AMAP_WEB_SERVICE_KEY?: string;
  AMAP_API_KEY?: string;
  AMAP_KEY?: string;
  /** 仅浏览器 E2E 使用的确定性高德替身开关。 */
  AMAP_E2E_FIXTURE?: string;
};

export type LivePlannerDeps = {
  env?: LivePlannerEnv;
  /** 契约测试注入的假响应；缺省时使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 地点发现注入的内存仓储，避免测试触碰真实数据库。 */
  repository?: PlacePersistenceRepository;
  /** 契约测试注入高德客户端，避免真实网络。 */
  amapClient?: AmapClient;
};

const liveItineraryInputSchema = z.object({
  destination: z.object({
    id: z.string(),
    name: z.string(),
    region: z.string(),
  }),
  startDate: z.string(),
  days: z.number().int().min(1).max(16),
  dailyHours: z.number().int().min(2).max(12),
  pace: z.enum(["relaxed", "balanced", "deep"]),
  interests: z.array(z.string()),
  route: routePlanSchema,
  weather: z.array(
    z.object({
      date: z.string(),
      code: z.number(),
      tempMax: z.number(),
      tempMin: z.number(),
      precipProb: z.number().optional(),
      windMax: z.number().optional(),
      sunrise: z.string().optional(),
      sunset: z.string().optional(),
    }),
  ),
  seedPlaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      area: z.string(),
      indoor: z.boolean(),
      duration: z.number(),
      summary: z.string(),
      source: z.string().url(),
    }),
  ),
  // 管家排程所需的用户条件；legacy 链路忽略这些字段。
  origin: z.string().min(1),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  totalBudget: z.number(),
  travelers: z.object({
    adults: z.number(),
    children: z.number(),
  }),
  transport: z.enum(transportModes).nullable(),
  style: z.enum(travelStyles).optional(),
});

export type LiveItineraryInput = z.infer<typeof liveItineraryInputSchema>;

function readLiveEnv(
  deps: LivePlannerDeps | undefined,
  key: keyof LivePlannerEnv,
): string | undefined {
  const injected = deps?.env?.[key];
  if (injected !== undefined) return injected;
  return process.env[key];
}

async function failedDiscoveryNotices(route: RoutePlan): Promise<DiscoveryNotice[]> {
  const { routeNodesNeedingDiscovery } = await loadPlaceDiscovery();
  return routeNodesNeedingDiscovery(route, new Set(), Number.POSITIVE_INFINITY).map(
    (inputName) => ({
      inputName,
      status: "failed",
      message: "地点发现失败，行程已继续生成",
    }),
  );
}

async function planWithDeepSeek(input: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  destinationName: string;
  region: string;
  startDate: string;
  days: number;
  dailyHours: number;
  pace: Pace;
  interests: string[];
  weather: WeatherDay[];
  sources: SearchResult[];
  discoveredStops: DiscoveredStop[];
  route: RoutePlan;
}) {
  const baseUrl = (input.baseUrl || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;
  const messages = buildPlannerMessages({ ...input, searchResults: input.sources });
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model || "deepseek-chat",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 8000,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `DeepSeek 规划失败（${response.status}）${message ? `：${message.slice(0, 180)}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 未返回行程内容");

  return parsePlannerJson(
    content,
    input.sources.map((source) => source.url),
  );
}

export type LongPlanResult =
  | {
      status: "needs_configuration";
      missing: string[];
    }
  | {
      status: "ok";
      plan: LongPlan;
      discoveries: DiscoveryNotice[];
    };

async function planLongTripWithDeepSeek(input: {
  apiKey: string;
  baseUrl?: string;
  destinationName: string;
  region: string;
  startDate: string;
  days: number;
  pace: Pace;
  interests: string[];
  seedPlaces: string[];
  discoveredStops: DiscoveredStop[];
  route: RoutePlan;
}) {
  const baseUrl = (input.baseUrl || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/$/, "");
  const messages = buildLongPlannerMessages(input);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 5000,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `DeepSeek 长线规划失败（${response.status}）${message ? `：${message.slice(0, 180)}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 未返回长线规划内容");

  return parseLongPlanJson(content, input.days);
}

export const generateLongItinerary = createServerFn({ method: "POST" })
  .validator(
    z.object({
      destination: z.object({
        id: z.string(),
        name: z.string(),
        region: z.string(),
      }),
      startDate: z.string(),
      days: z.number().int().min(17).max(365),
      pace: z.enum(["relaxed", "balanced", "deep"]),
      interests: z.array(z.string()),
      seedPlaces: z.array(z.string()),
      route: routePlanSchema,
    }),
  )
  .handler(async ({ data }): Promise<LongPlanResult> => {
    const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!deepseekKey) {
      return { status: "needs_configuration", missing: ["DEEPSEEK_API_KEY"] };
    }

    const tavilyKey = process.env.TAVILY_API_KEY?.trim();
    let discoveries: DiscoveryNotice[] = [];
    let discoveredStops: DiscoveredStop[] = [];
    try {
      const { discoverRoutePlaces } = await loadPlaceDiscovery();
      const discovery = await discoverRoutePlaces({
        route: data.route,
        deepseekKey,
        tavilyKey: tavilyKey ?? "",
        fetchImpl: fetch,
      });
      discoveries = discovery.notices;
      discoveredStops = mapDiscoveredStops({
        verifiedPlaces: discovery.verifiedPlaces,
        candidatePlaces: [],
      });
    } catch {
      discoveries = await failedDiscoveryNotices(data.route);
    }

    const plan = await planLongTripWithDeepSeek({
      apiKey: deepseekKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL?.trim(),
      destinationName: data.destination.name,
      region: data.destination.region,
      startDate: data.startDate,
      days: data.days,
      pace: data.pace,
      interests: data.interests,
      seedPlaces: data.seedPlaces,
      discoveredStops,
      route: data.route,
    });

    return { status: "ok", plan, discoveries };
  });

type SharedPlannerContext = {
  deepseekKey: string;
  discoveries: DiscoveryNotice[];
  sources: SearchResult[];
  discoveredStops: DiscoveredStop[];
  route: RoutePlan;
  candidates: PlannerDestinationCandidate[];
  transportLegs: TransportPlanLeg[];
  transportPriceReferences: TransportPriceReference[];
  baseUrl?: string;
  model?: string;
};

async function runLegacyPlan(
  input: LiveItineraryInput,
  deps: LivePlannerDeps,
  context: SharedPlannerContext,
): Promise<LivePlanResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  // 结尾只依赖路线与节奏，不等每日正文，所以和主行程同时发出，不占关键路径。
  const buildTripClosingWithDeepSeek = await loadTripClosing();
  const closingPromise = buildTripClosingWithDeepSeek(
    {
      origin: context.route.origin,
      destination: context.route.destination,
      waypoints: context.route.waypoints,
      routeNodes: [context.route.origin, ...context.route.waypoints, context.route.destination],
      days: input.days,
      returnMode: context.route.returnMode ?? null,
      pace: input.pace,
      interests: input.interests,
      highlights: input.seedPlaces.map((place) => place.name),
    },
    {
      apiKey: context.deepseekKey,
      baseUrl: context.baseUrl,
      model: context.model,
      fetchImpl,
    },
  );

  const [plan, closing] = await Promise.all([
    planWithDeepSeek({
      apiKey: context.deepseekKey,
      baseUrl: context.baseUrl,
      model: context.model,
      fetchImpl,
      destinationName: input.destination.name,
      region: input.destination.region,
      startDate: input.startDate,
      days: input.days,
      dailyHours: input.dailyHours,
      pace: input.pace,
      interests: input.interests,
      weather: input.weather,
      sources: context.sources,
      discoveredStops: context.discoveredStops,
      route: context.route,
    }),
    closingPromise,
  ]);

  return {
    status: "ok",
    mode: "legacy",
    plan,
    sources: context.sources,
    discoveries: context.discoveries,
    route: context.route,
    closing,
  };
}

async function runButlerPlan(
  input: LiveItineraryInput,
  deps: LivePlannerDeps,
  context: SharedPlannerContext,
): Promise<LivePlanResult> {
  const candidates = context.candidates;
  const briefTransport =
    input.transport && context.route.legs.every((leg) => leg.transport === input.transport)
      ? input.transport
      : null;

  const butlerInput: ButlerPlanInput = {
    origin: input.origin,
    destination: input.destination.name,
    region: input.destination.region,
    startDate: input.startDate,
    days: input.days,
    startTime: input.startTime,
    endTime: input.endTime,
    pace: input.pace,
    totalBudget: input.totalBudget,
    travelers: input.travelers,
    interests: input.interests,
    transport: briefTransport,
    style: input.style,
    route: context.route,
    weather: input.weather,
    candidates,
    transportLegs: context.transportLegs,
    transportPriceReferences: context.transportPriceReferences,
  };

  const planWithButler = await loadButler();
  const result = await planWithButler(butlerInput, {
    apiKey: context.deepseekKey,
    baseUrl: context.baseUrl,
    model: context.model,
    fetchImpl: deps.fetchImpl ?? fetch,
  });

  if (result.status === "needs_configuration") {
    return { status: "needs_configuration", missing: result.missing };
  }

  if (result.status === "fallback") {
    // 开关打开时 fail closed，不把旧骨架结果伪装成确定性管家结果。
    throw new Error(`管家规划失败：${result.reason}`);
  }
  if (result.status === "failed") {
    throw new Error(`管家规划失败于 ${result.stage} 阶段：${result.reason}`);
  }

  return {
    status: "ok",
    mode: "butler",
    skeleton: result.skeleton,
    dayCopy: result.dayCopy,
    failedDays: result.failedDays,
    violations: result.violations,
    attempts: result.attempts,
    closing: result.closing,
    candidates: result.candidates,
    transportLegs: result.transportLegs,
    budget: result.budget,
    // 结果页的「N 个候选景区」依赖 sources，绝不能返回空数组。
    sources: result.candidates.map((candidate) => ({
      title: candidate.name,
      url: candidate.source,
      content: candidate.summary,
      score: 1,
    })),
    discoveries: context.discoveries,
    route: context.route,
  };
}

export async function runLivePlannerWith(
  input: LiveItineraryInput,
  deps: LivePlannerDeps = {},
): Promise<LivePlanResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const deepseekKey = readLiveEnv(deps, "DEEPSEEK_API_KEY")?.trim();
  const tavilyKey = readLiveEnv(deps, "TAVILY_API_KEY")?.trim();
  const missing = [!deepseekKey ? "DEEPSEEK_API_KEY" : ""].filter(Boolean);
  if (!deepseekKey) {
    return { status: "needs_configuration", missing };
  }

  // 详细行程的景点与途经点都不再由 Tavily 发现；Tavily 仅在下方的交通价格查询中使用。
  const discoveries: DiscoveryNotice[] = [];
  const discoverySourceGroups: DiscoverySourceGroup[] = [];
  const discoveredStops: DiscoveredStop[] = [];

  const tavilyUrl = readLiveEnv(deps, "TAVILY_SEARCH_URL")?.trim();
  const plannerContext = await loadPlannerContext();
  const amapKey = plannerContext.resolvePlannerAmapKey({
    webServiceKey: readLiveEnv(deps, "AMAP_WEB_SERVICE_KEY")?.trim(),
    apiKey: readLiveEnv(deps, "AMAP_API_KEY")?.trim(),
    key: readLiveEnv(deps, "AMAP_KEY")?.trim(),
  });
  const amapClient =
    deps.amapClient ??
    (readLiveEnv(deps, "AMAP_E2E_FIXTURE") === "1"
      ? (await loadAmapE2eFixture())()
      : plannerContext.createPlannerAmapClient(amapKey, fetchImpl));
  const seedCandidates: PlannerDestinationCandidate[] = input.seedPlaces.map((place) => ({
    id: `seed:${place.id}`,
    name: place.name,
    summary: `${place.area}。${place.summary}。建议停留 ${place.duration} 分钟。`,
    source: place.source,
    address: place.area,
    type: "本地候选",
    location: [0, 0],
    publicUrl: place.source,
    areaKey: place.area,
  }));
  const [amapCandidates, transportPlan] = await Promise.all([
    plannerContext.searchAmapDestinationCandidates({
      client: amapClient,
      destination: input.destination.name,
      region: input.destination.region,
    }),
    plannerContext.prepareRouteTransportPlan({
      client: amapClient,
      route: input.route,
      startDate: input.startDate,
      travelers: input.travelers,
      tavilyKey: tavilyKey ?? "",
      tavilyEndpoint: tavilyUrl,
      fetchImpl,
    }),
  ]);
  if (transportPlan.status !== "ready") {
    // 交通阶段未通过时 fail closed，绝不让伪造的 0km 计划进入下游。
    throw new Error("交通规划不可用：" + transportPlan.reason);
  }
  const candidates = plannerContext.mergePlannerCandidates({
    primary: amapCandidates,
    fallback: seedCandidates,
  }) as PlannerDestinationCandidate[];
  const sources = selectPlannerSources({
    destinationSources: candidates.map((candidate) => ({
      title: candidate.name,
      url: candidate.source,
      content: candidate.summary,
      score: 1,
    })),
    seedSources: [],
    discoverySourceGroups,
  });

  const context: SharedPlannerContext = {
    deepseekKey,
    discoveries,
    sources,
    discoveredStops,
    route: transportPlan.route,
    candidates,
    transportLegs: transportPlan.legs,
    transportPriceReferences: transportPlan.references,
    baseUrl: readLiveEnv(deps, "DEEPSEEK_BASE_URL")?.trim(),
    model: readLiveEnv(deps, "DEEPSEEK_MODEL")?.trim(),
  };

  if (readLiveEnv(deps, "BUTLER_PLANNER") !== "0") {
    return runButlerPlan(input, deps, context);
  }

  return runLegacyPlan(input, deps, context);
}

export const generateLiveItinerary = createServerFn({ method: "POST" })
  .validator(liveItineraryInputSchema)
  .handler(async ({ data }): Promise<LivePlanResult> => runLivePlannerWith(data));
