import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  buildPlannerMessages,
  mapDiscoveredStops,
  parsePlannerJson,
  selectPlannerSources,
  type DiscoverySourceGroup,
  type DiscoveredStop,
  type SearchResult,
} from "./live-planner";
import { searchTavily } from "./tavily.server";
import { buildLongPlannerMessages, parseLongPlanJson, type LongPlan } from "./long-planner";
import { buildTripClosingWithDeepSeek } from "./travel-plan.server.ts";
import type { TripClosing } from "./travel-plan.ts";
import type { Pace, WeatherDay } from "./planner";
import type { RoutePlan } from "./route-planner";
import {
  discoverRoutePlaces,
  routeNodesNeedingDiscovery,
  type RouteDiscoveryNotice,
} from "./place-discovery.server";
import type { PlacePersistenceRepository } from "./place-discovery.ts";
import { planWithButler, type ButlerPlanInput } from "./planner-orchestrator.server.ts";
import type { PlannerSkeleton } from "./planner-skeleton.ts";
import type { PlannerDayCopy } from "./planner-day-copy.ts";
import type { PlanViolation } from "./plan-validator.ts";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

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
      sources: SearchResult[];
      discoveries: DiscoveryNotice[];
    };

/** 可注入的环境变量：测试与 handler 都通过它读取，而不是直接读 process.env。 */
export type LivePlannerEnv = {
  BUTLER_PLANNER?: string;
  DEEPSEEK_API_KEY?: string;
  TAVILY_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  TAVILY_SEARCH_URL?: string;
  DEEPSEEK_MODEL?: string;
};

export type LivePlannerDeps = {
  env?: LivePlannerEnv;
  /** 契约测试注入的假响应；缺省时使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 地点发现注入的内存仓储，避免测试触碰真实数据库。 */
  repository?: PlacePersistenceRepository;
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

function failedDiscoveryNotices(route: RoutePlan): DiscoveryNotice[] {
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
      const discovery = await discoverRoutePlaces({
        route: data.route,
        deepseekKey,
        tavilyKey,
        fetchImpl: fetch,
      });
      discoveries = discovery.notices;
      discoveredStops = mapDiscoveredStops({
        verifiedPlaces: discovery.verifiedPlaces,
        candidatePlaces: [],
      });
    } catch {
      discoveries = failedDiscoveryNotices(data.route);
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
  const closingPromise = buildTripClosingWithDeepSeek(
    {
      origin: input.route.origin,
      destination: input.route.destination,
      waypoints: input.route.waypoints,
      routeNodes: [input.route.origin, ...input.route.waypoints, input.route.destination],
      days: input.days,
      returnMode: input.route.returnMode ?? null,
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
      route: input.route,
    }),
    closingPromise,
  ]);

  return {
    status: "ok",
    mode: "legacy",
    plan,
    sources: context.sources,
    discoveries: context.discoveries,
    closing,
  };
}

async function runButlerPlan(
  input: LiveItineraryInput,
  deps: LivePlannerDeps,
  context: SharedPlannerContext,
): Promise<LivePlanResult> {
  const candidates = context.sources.map((source) => ({
    name: source.title,
    summary: source.content,
    source: source.url,
  }));

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
    transport: input.transport,
    style: input.style,
    route: input.route,
    weather: input.weather,
    candidates,
  };

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
    // 管家骨架失败时退回现有实时链路，保证用户仍能得到可展示的行程。
    return runLegacyPlan(input, deps, context);
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
    // 结果页的「N 个候选景区」依赖 sources，绝不能返回空数组。
    sources: result.candidates.map((candidate) => ({
      title: candidate.name,
      url: candidate.source,
      content: candidate.summary,
      score: 1,
    })),
    discoveries: context.discoveries,
  };
}

export async function runLivePlannerWith(
  input: LiveItineraryInput,
  deps: LivePlannerDeps = {},
): Promise<LivePlanResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const deepseekKey = readLiveEnv(deps, "DEEPSEEK_API_KEY")?.trim();
  const tavilyKey = readLiveEnv(deps, "TAVILY_API_KEY")?.trim();
  const missing = [
    !deepseekKey ? "DEEPSEEK_API_KEY" : "",
    !tavilyKey ? "TAVILY_API_KEY" : "",
  ].filter(Boolean);

  if (!deepseekKey || !tavilyKey) {
    return { status: "needs_configuration", missing };
  }

  let discoveries: DiscoveryNotice[] = [];
  let discoverySourceGroups: DiscoverySourceGroup[] = [];
  let discoveredStops: DiscoveredStop[] = [];
  try {
    const discovery = await discoverRoutePlaces({
      route: input.route,
      deepseekKey,
      tavilyKey,
      fetchImpl,
      repository: deps.repository,
    });
    discoveries = discovery.notices;
    discoverySourceGroups = discovery.sourceGroups;
    discoveredStops = mapDiscoveredStops({
      verifiedPlaces: discovery.verifiedPlaces,
      candidatePlaces: discovery.candidatePlaces,
    });
  } catch {
    discoveries = failedDiscoveryNotices(input.route);
  }

  const queries = [
    `${input.destination.name} 热门景区 周边游 推荐`,
    `${input.destination.name} 值得去的景点 路线`,
    `${input.destination.region} 一日游 景点`,
  ];
  const tavilyUrl = readLiveEnv(deps, "TAVILY_SEARCH_URL")?.trim();
  const searchBatches = await Promise.all(
    queries.map((query) => searchTavily(tavilyKey, query, tavilyUrl, fetchImpl)),
  );
  const seedSources = input.seedPlaces.map((place) => ({
    title: place.name,
    url: place.source,
    content: `${place.area}。${place.summary}。建议停留 ${place.duration} 分钟。`,
    score: 1,
  }));
  const sources = selectPlannerSources({
    destinationSources: searchBatches.flat(),
    seedSources,
    discoverySourceGroups,
  });

  const context: SharedPlannerContext = {
    deepseekKey,
    discoveries,
    sources,
    discoveredStops,
    baseUrl: readLiveEnv(deps, "DEEPSEEK_BASE_URL")?.trim(),
    model: readLiveEnv(deps, "DEEPSEEK_MODEL")?.trim(),
  };

  if (readLiveEnv(deps, "BUTLER_PLANNER") === "1") {
    return runButlerPlan(input, deps, context);
  }

  return runLegacyPlan(input, deps, context);
}

export const generateLiveItinerary = createServerFn({ method: "POST" })
  .validator(liveItineraryInputSchema)
  .handler(async ({ data }): Promise<LivePlanResult> => runLivePlannerWith(data));
