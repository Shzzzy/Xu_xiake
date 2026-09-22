import type { RouteLeg, RoutePlan } from "./route-planner.ts";
import type { TransportPlanLeg } from "./transport-planner.server.ts";

const LONG_WANDER_DRIVE_KM = 800;
const STOP_EXPLORATION_MINUTES = 240;
const MAX_TRIP_DAYS = 16;
const MAX_DAILY_DRIVE_MINUTES = 330;

export type TripFeasibilityDestination = {
  id: string;
  name: string;
  region: string;
};

export type TripFeasibilityPlanningInput = {
  origin: string;
  destination: TripFeasibilityDestination;
  days: number;
  dailyHours: number;
  startTime: string;
  endTime: string;
  route: RoutePlan;
  transportLegs: TransportPlanLeg[];
  seedPlaces?: unknown[];
};

export type TripFeasibilityChoice =
  { strategy: "direct" } | { strategy: "extend" } | { strategy: "focus"; focusTarget: string };

export type TripFeasibilityOption = {
  strategy:
    | { type: "direct"; legIds: string[] }
    | {
        type: "extend";
        recommendedDays: number;
        driveSegmentDays: number;
        dailyDriveLimitMinutes: number;
      }
    | { type: "focus"; targets: string[] };
  eyebrow: string;
  title: string;
  summary: string;
  detail: string;
  metrics: string[];
  recommended: boolean;
};

export type TripFeasibilityDecision = {
  status: "needs_decision";
  reason: string;
  summary: {
    days: number;
    dailyMinutes: number;
    availableMinutes: number;
    doorToDoorMinutes: number;
    stopMinutes: number;
    requiredMinutes: number;
    shortageMinutes: number;
    transportDays: number;
    stopDays: number;
    driveSegmentDays: number;
    dailyDriveLimitMinutes: number;
  };
  longDriveLegIds: string[];
  options: TripFeasibilityOption[];
};

function clampDays(days: number): number {
  return Math.min(MAX_TRIP_DAYS, Math.max(1, Math.ceil(days)));
}

function dailyMinutes(input: Pick<TripFeasibilityPlanningInput, "dailyHours">): number {
  return Math.max(60, Math.round(input.dailyHours * 60));
}

function clockMinutes(value: string | undefined): number | null {
  const matched = value ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null;
  if (!matched) return null;
  return Number(matched[1]) * 60 + Number(matched[2]);
}

export function resolveDailyDriveLimitMinutes(
  dailyHours: number,
  startTime?: string,
  endTime?: string,
): number {
  // 每天为住宿、用餐和机动留出至少 30 分钟，同时驾驶上限不超过 5.5 小时。
  const start = clockMinutes(startTime);
  const end = clockMinutes(endTime);
  const windowMinutes = start !== null && end !== null && end > start ? end - start : Infinity;
  const usable = Math.min(Math.max(60, Math.round(dailyHours * 60) - 30), windowMinutes - 30);
  return Math.max(60, Math.min(MAX_DAILY_DRIVE_MINUTES, usable));
}

function routeLegById(route: RoutePlan, id: string): RouteLeg | undefined {
  return route.legs.find((leg) => leg.id === id);
}

function estimateFlightMinutes(distanceKm: number): number {
  return Math.max(300, Math.ceil(180 + Math.max(0, distanceKm) / 12));
}

function isLongTravelLeg(route: RoutePlan, planLeg: TransportPlanLeg): boolean {
  const routeLeg = routeLegById(route, planLeg.id);
  return (
    planLeg.distanceKm >= LONG_WANDER_DRIVE_KM &&
    (routeLeg?.transport === "drive" || routeLeg?.style === "wander" || planLeg.mode === "drive")
  );
}

function buildFocusTargets(input: TripFeasibilityPlanningInput): string[] {
  return [
    ...new Set([...input.route.waypoints, input.route.destination].map((name) => name.trim())),
  ].filter((name) => name && name !== input.origin.trim());
}

function buildFocusRoute(input: TripFeasibilityPlanningInput, target: string): RoutePlan {
  const legs: RouteLeg[] = [
    {
      id: "outbound:0",
      from: input.origin,
      to: target,
      transport: "flight",
      style: "direct",
      kind: "outbound",
    },
  ];
  if (input.route.roundTrip) {
    legs.push({
      id: "return",
      from: target,
      to: input.origin,
      transport: "flight",
      style: "direct",
      kind: "return",
    });
  }
  return {
    origin: input.origin,
    destination: target,
    waypoints: [],
    roundTrip: input.route.roundTrip,
    returnMode: input.route.roundTrip ? (input.route.returnMode ?? "fast") : null,
    legs,
  };
}

function buildDirectRoute(input: TripFeasibilityPlanningInput, legIds: Set<string>): RoutePlan {
  return {
    ...input.route,
    legs: input.route.legs.map((leg) =>
      legIds.has(leg.id)
        ? { ...leg, transport: "flight" as const, style: "direct" as const }
        : { ...leg },
    ),
  };
}

export function evaluateTripFeasibility(
  input: TripFeasibilityPlanningInput,
): TripFeasibilityDecision | null {
  const longDriveLegIds = input.transportLegs
    .filter((leg) => isLongTravelLeg(input.route, leg))
    .map((leg) => leg.id);
  if (longDriveLegIds.length === 0) return null;

  const doorToDoorMinutes = input.transportLegs.reduce(
    (total, leg) => total + Math.max(0, leg.doorToDoorMinutes),
    0,
  );
  const stopNames = [...new Set([...input.route.waypoints, input.route.destination])].filter(
    (name) => name.trim() && name.trim() !== input.origin.trim(),
  );
  const stopMinutes = stopNames.length * STOP_EXPLORATION_MINUTES;
  const requiredMinutes = doorToDoorMinutes + stopMinutes;
  const availableMinutes = clampDays(input.days) * dailyMinutes(input);
  if (requiredMinutes <= availableMinutes) return null;

  const shortageMinutes = requiredMinutes - availableMinutes;
  const longDriveLegs = input.transportLegs.filter((leg) => longDriveLegIds.includes(leg.id));
  const driveMinutes = longDriveLegs.reduce(
    (total, leg) => total + Math.max(0, leg.doorToDoorMinutes),
    0,
  );
  const directMinutes = longDriveLegs.reduce(
    (total, leg) => total + estimateFlightMinutes(leg.distanceKm),
    0,
  );
  const savedMinutes = Math.max(0, driveMinutes - directMinutes);
  const directLegLabels = longDriveLegs.map((leg) => `「${leg.from} → ${leg.to}」`);
  const dailyDriveLimitMinutes = resolveDailyDriveLimitMinutes(
    input.dailyHours,
    input.startTime,
    input.endTime,
  );
  const driveSegmentDays = longDriveLegs.reduce(
    (total, leg) => total + Math.max(1, Math.ceil(leg.doorToDoorMinutes / dailyDriveLimitMinutes)),
    0,
  );
  const transportDays = input.transportLegs.reduce((total, leg) => {
    if (!longDriveLegIds.includes(leg.id)) return total + 1;
    return total + Math.max(1, Math.ceil(leg.doorToDoorMinutes / dailyDriveLimitMinutes));
  }, 0);
  const stopDays = Math.max(1, Math.ceil(stopMinutes / dailyMinutes(input)));
  const recommendedDays = Math.min(
    MAX_TRIP_DAYS,
    Math.max(clampDays(input.days) + 1, transportDays + stopDays),
  );
  const focusTargets = buildFocusTargets(input);
  const routeLabel = focusTargets.join("、") || input.route.destination;
  const driveLabel = directLegLabels.join("、");

  return {
    status: "needs_decision",
    reason:
      `扣除 ${routeLabel} 的停留游玩时间后，现有 ${clampDays(input.days)} 天` +
      `（每天约 ${Math.round(dailyMinutes(input) / 60)} 小时）不足以完成 ${driveLabel} 的沿途自驾，` +
      `仍缺约 ${shortageMinutes} 分钟。请先选择调整方案，系统不会静默改路线。`,
    summary: {
      days: clampDays(input.days),
      dailyMinutes: dailyMinutes(input),
      availableMinutes,
      doorToDoorMinutes,
      stopMinutes,
      requiredMinutes,
      shortageMinutes,
      transportDays,
      stopDays,
      driveSegmentDays,
      dailyDriveLimitMinutes,
    },
    longDriveLegIds,
    options: [
      {
        strategy: { type: "direct", legIds: longDriveLegIds },
        eyebrow: "A / 推荐",
        title: "直达落地",
        summary: `把 ${driveLabel} 改为直飞直达，抵达后再游玩。`,
        detail: `保留 ${routeLabel} 的城市顺序，减少路面长途和沿途折返，优先保证有限天数内的游玩质量。`,
        metrics: [`预计节省约 ${savedMinutes} 分钟`, `仍按 ${clampDays(input.days)} 天`],
        recommended: true,
      },
      {
        strategy: {
          type: "extend",
          recommendedDays,
          driveSegmentDays,
          dailyDriveLimitMinutes,
        },
        eyebrow: "B / 保留自驾",
        title: "延长自驾",
        summary: `保留 ${driveLabel} 的自驾与沿途景点，把行程延长到约 ${recommendedDays} 天。`,
        detail:
          "交通方式与沿途边玩边停不变，新增天数用于分摊驾驶、休息、用餐和景点停留，避免赶路。",
        metrics: [
          `建议 ${recommendedDays} 天`,
          `长途拆为 ${driveSegmentDays} 个驾驶日`,
          `每日驾驶 ≤ ${dailyDriveLimitMinutes} 分钟`,
        ],
        recommended: false,
      },
      {
        strategy: { type: "focus", targets: focusTargets },
        eyebrow: "C / 专注一地",
        title: "压缩为单区域",
        summary: `不再跨双城，从 ${focusTargets.join(" 或 ") || input.route.destination} 中选择一个区域深游。`,
        detail:
          "移除其余途经点，只保留出发地与所选区域之间的直达交通，把时间集中给一个区域的代表性景点。",
        metrics: [focusTargets.join(" / ") || input.route.destination, "不再跨双城"],
        recommended: false,
      },
    ],
  };
}

export function applyTripFeasibilityChoice<T extends TripFeasibilityPlanningInput>(
  input: T,
  choice: TripFeasibilityChoice,
): T {
  if (choice.strategy === "direct") {
    const legIds = new Set(
      input.transportLegs.filter((leg) => isLongTravelLeg(input.route, leg)).map((leg) => leg.id),
    );
    return { ...input, route: buildDirectRoute(input, legIds) } as T;
  }

  if (choice.strategy === "extend") {
    const decision = evaluateTripFeasibility(input);
    const extend = decision?.options.find((option) => option.strategy.type === "extend");
    const recommendedDays =
      extend?.strategy.type === "extend" ? extend.strategy.recommendedDays : input.days;
    return { ...input, days: recommendedDays } as T;
  }

  const target = choice.focusTarget.trim();
  const allowedTargets = buildFocusTargets(input);
  if (!target || !allowedTargets.includes(target)) {
    throw new Error(`无法聚焦未在路线中出现的区域：${choice.focusTarget}`);
  }
  const destination =
    target === input.destination.name
      ? input.destination
      : { id: `feasibility:${target}`, name: target, region: "自由输入" };
  const next = {
    ...input,
    destination,
    route: buildFocusRoute(input, target),
    transportLegs: [],
    transport: "flight" as const,
    seedPlaces: [],
  };
  return next as T;
}
