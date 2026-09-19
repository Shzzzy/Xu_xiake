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
import type { Pace, WeatherDay } from "./planner";
import type { RoutePlan } from "./route-planner";
import {
  discoverRoutePlaces,
  routeNodesNeedingDiscovery,
  type RouteDiscoveryNotice,
} from "./place-discovery.server";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export type DiscoveryNotice = RouteDiscoveryNotice;

const routeLegSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  transport: z.enum(["economy", "balanced", "speed", "train", "flight", "drive", "bus", "ship"]),
  style: z.enum(["direct", "wander"]),
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
      plan: ReturnType<typeof parsePlannerJson>;
      sources: SearchResult[];
      discoveries: DiscoveryNotice[];
    };

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
  const messages = buildPlannerMessages({ ...input, searchResults: input.sources });
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

export const generateLiveItinerary = createServerFn({ method: "POST" })
  .validator(
    z.object({
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
    }),
  )
  .handler(async ({ data }): Promise<LivePlanResult> => {
    const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
    const tavilyKey = process.env.TAVILY_API_KEY?.trim();
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
        route: data.route,
        deepseekKey,
        tavilyKey,
        fetchImpl: fetch,
      });
      discoveries = discovery.notices;
      discoverySourceGroups = discovery.sourceGroups;
      discoveredStops = mapDiscoveredStops({
        verifiedPlaces: discovery.verifiedPlaces,
        candidatePlaces: discovery.candidatePlaces,
      });
    } catch {
      discoveries = failedDiscoveryNotices(data.route);
    }

    const queries = [
      `${data.destination.name} 热门景区 周边游 推荐`,
      `${data.destination.name} 值得去的景点 路线`,
      `${data.destination.region} 一日游 景点`,
    ];
    const searchBatches = await Promise.all(
      queries.map((query) => searchTavily(tavilyKey, query, process.env.TAVILY_SEARCH_URL?.trim())),
    );
    const seedSources = data.seedPlaces.map((place) => ({
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

    const plan = await planWithDeepSeek({
      apiKey: deepseekKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL?.trim(),
      destinationName: data.destination.name,
      region: data.destination.region,
      startDate: data.startDate,
      days: data.days,
      dailyHours: data.dailyHours,
      pace: data.pace,
      interests: data.interests,
      weather: data.weather,
      sources,
      discoveredStops,
      route: data.route,
    });

    return { status: "ok", plan, sources, discoveries };
  });
