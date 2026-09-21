import type { Destination } from "../data/planner-destinations.ts";
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
