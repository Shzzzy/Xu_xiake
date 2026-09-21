import type { Destination } from "../data/planner-destinations.ts";
import type { PlannerDayCopy } from "./planner-day-copy.ts";
import type { PlanViolation } from "./plan-validator.ts";
import type { PlannerSkeleton, PlannerSkeletonNode } from "./planner-skeleton.ts";
import {
  classifyWeather,
  type Pace,
  type Place,
  type PlannedDay,
  type WeatherDay,
} from "./planner.ts";
import { buildExecutionDays } from "./travel-schedule.ts";
import type { ReturnMode, RoutePlan, TransportMode } from "./route-planner.ts";
import {
  estimateBudget,
  type AttractionAudit,
  type Travelers,
  type TripBudget,
  type TripClosing,
  type TripDay,
  type TripPlan,
  type TransportPreference,
  type TripRoute,
  type TripTimelineNode,
} from "./travel-plan.ts";

export type PlanOutputBuilderInput = {
  origin: string;
  destination: Destination;
  startDate: string;
  days: number;
  pace: Pace;
  interests: string[];
  waypoints: string[];
  roundTrip: boolean;
  returnMode: ReturnMode;
  travelers: Travelers;
  totalBudget: number;
  startTime: string;
  endTime: string;
  plannedDays: PlannedDay[];
  routePlan: RoutePlan | null;
  title?: string;
  /** 旅行回望文案：由并行生成的 AI 结尾提供，缺省时退回确定性文案。 */
  closing?: TripClosing;
};

export type TripPlanFromSkeletonInput = {
  skeleton: PlannerSkeleton;
  dayCopy?: PlannerDayCopy[];
  /** 本 run 的候选景点；用于下游文案校验和 fallback。 */
  candidates?: readonly { name: string; summary?: string; source?: string }[];
  origin: string;
  destination: Destination;
  startDate: string;
  travelers: Travelers;
  totalBudget: number;
  pace: Pace;
  interests: string[];
  roundTrip: boolean;
  returnMode: ReturnMode;
  routePlan: RoutePlan;
  weather: WeatherDay[];
  closing?: TripClosing;
  violations?: PlanViolation[];
  /** 文案生成失败的日期（day 序号），用于在路书上标注「本页分析未能生成」。 */
  failedDays?: number[];
  transportPreference: TransportPreference;
};

const PACE_LABELS: Record<Pace, string> = {
  relaxed: "轻松",
  balanced: "适中",
  deep: "充实",
};

const DEFAULT_DAY_CAUTIONS = ["所有时间与费用均为估算，请以实际交通与景区开放情况为准。"] as const;

const FAILED_ANALYSIS_CAUTION = "本页分析未能生成，已改用基础行程与本地提示。";

const TRANSPORT_MINUTES: Record<TransportMode, number> = {
  economy: 45,
  balanced: 45,
  speed: 30,
  train: 120,
  flight: 180,
  drive: 60,
  bus: 90,
  ship: 120,
};

const TRANSPORT_LABELS: Record<TransportMode, string> = {
  economy: "经济交通",
  balanced: "均衡交通",
  speed: "快捷交通",
  train: "高铁 / 火车",
  flight: "飞机",
  drive: "自驾",
  bus: "大巴",
  ship: "轮渡",
};

const TRANSPORT_COST_PER_PERSON: Record<TransportMode, number> = {
  economy: 160,
  balanced: 220,
  speed: 320,
  train: 260,
  flight: 700,
  drive: 180,
  bus: 120,
  ship: 220,
};

const MINUTES_PER_DAY = 24 * 60;

function clampScore(value: number) {
  return Math.max(1, Math.min(10, Math.round(value)));
}

export function buildAttractionAudit(place: Place): AttractionAudit {
  const durationHours = Math.max(0.5, Math.round((place.duration / 60) * 10) / 10);
  const scale = durationHours >= 7 ? "large" : durationHours >= 3 ? "medium" : "small";

  return {
    scale,
    durationHours,
    physical: clampScore(place.indoor ? 2 : 3 + durationHours / 1.5),
    childFit: clampScore(place.indoor ? 8 : 7 - durationHours / 3),
    weatherSensitivity: clampScore(place.indoor ? 2 : 7),
    timeCost: clampScore(scale === "large" ? 8 : scale === "medium" ? 6 : 3),
    crowding: clampScore(place.indoor ? 5 : 6),
    bestTime: place.indoor ? "下午" : "上午",
  };
}

export function formatWeatherLabel(weather?: WeatherDay) {
  if (!weather) return undefined;
  return `${classifyWeather(weather.code).label} ${Math.round(weather.tempMin)}–${Math.round(weather.tempMax)}°`;
}

function transportPreferenceForRoute(
  routePlan: RoutePlan | null,
): TripPlan["meta"]["transportPreference"] {
  const firstMode = routePlan?.legs[0]?.transport;
  return firstMode === "economy" || firstMode === "speed" ? firstMode : "balanced";
}

export function buildTripRoute(
  routePlan: RoutePlan | null,
  roundTrip: boolean,
  returnMode: ReturnMode,
): TripRoute {
  const toSegment = (leg: RoutePlan["legs"][number]) => ({
    from: leg.from,
    to: leg.to,
    mode: leg.transport,
    distanceKm: 0,
    durationMinutes: 0,
    navigation: "",
  });
  const outboundSegments =
    routePlan?.legs.filter((leg) => leg.kind === "outbound").map(toSegment) ?? [];
  const returnSegments =
    routePlan?.legs.filter((leg) => leg.kind === "return").map(toSegment) ?? [];

  return {
    outbound: [],
    returnPath: [],
    outboundSegments,
    returnSegments,
    distanceKm: 0,
    durationMinutes: 0,
    returnMode: roundTrip ? returnMode : null,
  };
}

function parseClock(value: string | undefined) {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!matched) return null;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatClock(value: number) {
  const bounded = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(value)));
  return `${String(Math.floor(bounded / 60)).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
}

function travelHeadcount(travelers: Travelers) {
  return Math.max(1, travelers.adults + travelers.children);
}

function routeLegCost(mode: TransportMode, travelers: Travelers) {
  return Math.round(TRANSPORT_COST_PER_PERSON[mode] * travelHeadcount(travelers));
}

function routeLegTransferNode(
  leg: RoutePlan["legs"][number],
  travelers: Travelers,
): TripTimelineNode {
  const transportMinutes = TRANSPORT_MINUTES[leg.transport];
  const label = TRANSPORT_LABELS[leg.transport];

  return {
    startTime: "00:00",
    endTime: formatClock(transportMinutes),
    timeLabel: `00:00–${formatClock(transportMinutes)}`,
    type: "transfer",
    name: `${leg.from} → ${leg.to} · ${label}换乘`,
    location: `${leg.to}站 / 枢纽`,
    transportMode: leg.transport,
    transportMinutes,
    estimatedCost: routeLegCost(leg.transport, travelers),
    tips: `按${label}安排站间衔接，预留检票、换乘和行李整理时间。`,
    navigation: null,
  };
}

function insertRouteTransfers(
  days: TripDay[],
  routePlan: RoutePlan | null,
  travelers: Travelers,
): TripDay[] {
  if (!routePlan || routePlan.legs.length === 0 || days.length === 0) return days;

  const transfersByDay = new Map<number, TripTimelineNode[]>();
  routePlan.legs.forEach((leg, index) => {
    const dayIndex = Math.min(days.length - 1, index);
    const transfers = transfersByDay.get(dayIndex) ?? [];
    transfers.push(routeLegTransferNode(leg, travelers));
    transfersByDay.set(dayIndex, transfers);
  });

  return days.map((day, dayIndex) => {
    const transfers = transfersByDay.get(dayIndex) ?? [];
    if (transfers.length === 0) return day;

    const firstStart = parseClock(day.nodes[0]?.startTime) ?? 8 * 60 + 30;
    const totalTransferMinutes = transfers.reduce(
      (sum, node) => sum + (node.transportMinutes ?? 30),
      0,
    );
    let cursor = Math.max(0, firstStart - totalTransferMinutes);
    const positionedTransfers = transfers.map((node) => {
      const startTime = formatClock(cursor);
      cursor += node.transportMinutes ?? 30;
      const endTime = formatClock(cursor);
      return {
        ...node,
        startTime,
        endTime,
        timeLabel: `${startTime}–${endTime}`,
      };
    });
    const nodes = [...positionedTransfers, ...day.nodes];

    return {
      ...day,
      nodes,
      estimatedCost: nodes.reduce((sum, node) => sum + node.estimatedCost, 0),
    };
  });
}

type CostSummary = {
  transport: number;
  lodging: number;
  food: number;
  tickets: number;
  other: number;
};

function summarizeTripCosts(days: TripDay[]): CostSummary {
  const summary: CostSummary = { transport: 0, lodging: 0, food: 0, tickets: 0, other: 0 };

  for (const day of days) {
    for (const node of day.nodes) {
      if (node.type === "transport" || node.type === "transfer") {
        summary.transport += node.estimatedCost;
      } else if (node.type === "hotel") {
        summary.lodging += node.estimatedCost;
      } else if (node.type === "meal") {
        summary.food += node.estimatedCost;
      } else if (node.type === "attraction" || node.type === "night-activity") {
        summary.tickets += node.estimatedCost;
      } else {
        summary.other += node.estimatedCost;
      }
    }
  }

  return summary;
}

function buildBudgetFromDays(
  days: TripDay[],
  totalBudget: number,
  travelers: Travelers,
): TripBudget {
  const costs = summarizeTripCosts(days);
  const exact = (value: number) => ({ min: value, max: value });

  return estimateBudget({
    totalBudget: Math.max(0, totalBudget),
    travelers,
    transport: exact(costs.transport),
    lodging: exact(costs.lodging),
    food: exact(costs.food),
    tickets: exact(costs.tickets),
    other: costs.other > 0 ? exact(costs.other) : undefined,
  });
}

function addDays(isoDate: string, offset: number): string {
  const parsed = new Date(isoDate + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime())) return isoDate;
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}

function toTripTimelineNode(node: PlannerSkeletonNode): TripTimelineNode {
  const mapped: TripTimelineNode = {
    startTime: node.startTime,
    endTime: node.endTime,
    timeLabel: node.startTime + "–" + node.endTime,
    type: node.type,
    name: node.name,
    estimatedCost: node.estimatedCost,
    navigation: null,
  };

  if (node.location !== undefined) mapped.location = node.location;
  if (node.transportMode !== undefined) mapped.transportMode = node.transportMode;
  if (node.transportMinutes !== undefined) mapped.transportMinutes = node.transportMinutes;
  if (node.stayMinutes !== undefined) mapped.stayMinutes = node.stayMinutes;
  if (node.tips !== undefined) mapped.tips = node.tips;

  return mapped;
}

function buildFallbackDayCopy(
  day: PlannerSkeleton["days"][number],
  pace: Pace,
): Pick<PlannerDayCopy, "purpose" | "highlights" | "cautions"> {
  const attractions = day.nodes.filter(
    (node) => node.type === "attraction" || node.type === "night-activity",
  );
  const names = attractions.map((node) => node.name);
  const paceLabel = PACE_LABELS[pace] ?? PACE_LABELS.balanced;

  return {
    purpose:
      names.length > 0
        ? "以" +
          names.join("、") +
          "为核心安排当天行程，按" +
          paceLabel +
          "节奏在游览、用餐与休息之间留出缓冲。"
        : "当天没有安排核心景点，按" + paceLabel + "节奏保留自由活动与休整时间。",
    highlights:
      attractions.length > 0
        ? attractions.map(
            (node) =>
              node.name +
              "：" +
              (node.tips?.trim() || "按当天节奏安排游览，留意现场开放与排队情况。"),
          )
        : ["自由活动：按天气和体力灵活安排，保留机动时间。"],
    cautions: [
      "按" + paceLabel + "节奏安排当天行程，可按实际体力增减停留时间。",
      ...DEFAULT_DAY_CAUTIONS,
    ],
  };
}

/**
 * 把管家生成的骨架、每日文案与路线数据组装为统一的 TripPlan。
 * 文案失败只降级对应日期，不改变骨架中已经冻结的时间、节点与费用。
 */
export function buildTripPlanFromSkeleton(input: TripPlanFromSkeletonInput): TripPlan {
  const copyByDay = new Map((input.dayCopy ?? []).map((copy) => [copy.day, copy]));
  const failedDays = new Set(input.failedDays ?? []);

  const days = input.skeleton.days.map((skeletonDay, index) => {
    const analysisFailed = failedDays.has(skeletonDay.day);
    const copy = analysisFailed ? undefined : copyByDay.get(skeletonDay.day);
    const fallback = buildFallbackDayCopy(skeletonDay, input.pace);
    const nodes = skeletonDay.nodes.map(toTripTimelineNode);
    const estimatedCost = nodes.reduce((sum, node) => sum + node.estimatedCost, 0);
    const purpose = copy?.purpose.trim() ? copy.purpose : fallback.purpose;
    const highlights = copy && copy.highlights.length > 0 ? copy.highlights : fallback.highlights;
    const cautions = analysisFailed
      ? [FAILED_ANALYSIS_CAUTION, ...fallback.cautions]
      : copy && copy.cautions.length > 0
        ? copy.cautions
        : fallback.cautions;

    const tripDay: TripDay = {
      date: addDays(input.startDate, index),
      theme: skeletonDay.theme,
      nodes,
      estimatedCost,
      radar: { ...skeletonDay.radar },
      purpose,
      highlights,
      cautions,
    };
    const weather = formatWeatherLabel(input.weather[index]);
    if (weather !== undefined) tripDay.weather = weather;
    if (analysisFailed) tripDay.analysisFailed = true;
    if (copy && copy.history.length > 0) tripDay.history = copy.history;

    return tripDay;
  });

  const plan: TripPlan = {
    meta: {
      title: input.skeleton.title,
      origin: input.origin,
      waypoints: input.routePlan.waypoints,
      destination: input.destination.name,
      startDate: input.startDate,
      days: input.skeleton.days.length,
      travelers: input.travelers,
      perPersonBudget: Math.round(input.totalBudget / travelHeadcount(input.travelers)),
      transportPreference: input.transportPreference,
      pace: input.pace,
      interests: input.interests,
      allowedAttractions: [
        ...new Set(
          (input.candidates ?? [])
            .map((candidate) => candidate.name.trim())
            .filter((name) => name.length > 0),
        ),
      ],
      // 管家 dayCopy 是每日文案权威源，下游 preview/PDF 的 legacy enrichment 必须跳过。
      narrativeSource: "butler",
    },
    budget: buildBudgetFromDays(days, input.totalBudget, input.travelers),
    route: buildTripRoute(input.routePlan, input.roundTrip, input.returnMode),
    days,
    closing: input.closing ?? {
      quote: null,
      source: null,
      message: "行程节点已按时间与预算展开，出发前请再核对天气、开放时间和交通班次。",
    },
  };
  if (input.violations !== undefined) plan.violations = input.violations;

  return plan;
}

/**
 * 把管家骨架映射为结果页每日行程卡片所需的 PlannedDay。
 * 仅保留景点类节点（attraction / night-activity），其余交通、用餐、住宿节点不进卡片，
 * 保证结果页卡片与 executionPlan 同源，避免回退路线与骨架排程并存。
 */
export function buildPlannedDaysFromSkeleton(
  skeleton: PlannerSkeleton,
  weather: WeatherDay[],
  sources: { title: string; url: string; content?: string }[],
): PlannedDay[] {
  return skeleton.days.map((skeletonDay) => {
    const places: Place[] = skeletonDay.nodes
      .filter((node) => node.type === "attraction" || node.type === "night-activity")
      .map((node, nodeIndex) => {
        const source = sources.find((item) => item.title === node.name);
        return {
          id: `butler-${skeletonDay.day}-${nodeIndex}`,
          name: node.name,
          area: node.location ?? "",
          indoor: false,
          duration: node.stayMinutes ?? 120,
          summary: node.tips ?? source?.content ?? node.location ?? "",
          source: source?.url ?? "",
        };
      });
    return {
      day: skeletonDay.day,
      places,
      weather: weather[skeletonDay.day - 1],
      note: skeletonDay.theme,
    };
  });
}

export function buildTripPlanOutput(input: PlanOutputBuilderInput): TripPlan {
  const dayCount = Math.max(1, input.days, input.plannedDays.length);
  const plannedDays = Array.from({ length: dayCount }, (_, index) => {
    const planned = input.plannedDays[index];
    return (
      planned ?? {
        day: index + 1,
        places: [],
        note: "当天保留机动时间，可按天气与体力继续探索。",
      }
    );
  });
  const places = plannedDays.flatMap((day) => day.places);
  const audits = Object.fromEntries(
    places.map((place) => [place.name, buildAttractionAudit(place)]),
  );
  const nightActivities = plannedDays.map((day, index) => {
    if (dayCount > 1 && index === dayCount - 1) return "";
    const eveningPlace = day.places.find((place) =>
      /夜|晚|灯光|夜市|江畔|湖畔/.test(`${place.name}${place.summary}`),
    );
    return eveningPlace?.name ?? "城市夜游";
  });
  const scheduledDays = buildExecutionDays({
    startDate: input.startDate,
    days: dayCount,
    pace: input.pace,
    travelers: input.travelers,
    routeNodes: places.map((place) => place.name),
    audits,
    nightActivity: nightActivities,
    lodging: `${input.destination.name}精选酒店`,
    dayStart: input.startTime,
    dayEnd: input.endTime,
  });
  const days = insertRouteTransfers(
    scheduledDays.map((day, index) => ({
      ...day,
      weather: formatWeatherLabel(plannedDays[index]?.weather),
    })),
    input.routePlan,
    input.travelers,
  );
  const budget = buildBudgetFromDays(days, input.totalBudget, input.travelers);

  return {
    meta: {
      title: input.title ?? `${input.destination.name}${dayCount}日执行计划`,
      origin: input.origin,
      waypoints: input.waypoints,
      destination: input.destination.name,
      startDate: input.startDate,
      days: dayCount,
      travelers: input.travelers,
      perPersonBudget: Math.round(input.totalBudget / travelHeadcount(input.travelers)),
      transportPreference: transportPreferenceForRoute(input.routePlan),
      pace: input.pace,
      interests: input.interests,
    },
    budget,
    route: buildTripRoute(input.routePlan, input.roundTrip, input.returnMode),
    days,
    closing: input.closing ?? {
      quote: null,
      source: null,
      message: "行程节点已按时间与预算展开，出发前请再核对天气、开放时间和交通班次。",
    },
  };
}
