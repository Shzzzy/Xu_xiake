import { resolveDailyDriveLimitMinutes } from "./trip-feasibility.ts";

export type TransportPlanSegment = {
  id: string;
  legId: string;
  order: number;
  totalSegments: number;
  from: string;
  to: string;
  distanceKm: number;
  mode: "drive";
  doorToDoorMinutes: number;
  dailyLimitMinutes: number;
};

export type TransportPlanLeg = {
  id: string;
  kind: "outbound" | "return";
  from: string;
  to: string;
  distanceKm: number;
  mode: "flight" | "train" | "drive" | "bus" | "ship";
  doorToDoorMinutes: number;
  minimumPerPersonCost: number;
  /** 超长自驾按每日驾驶上限生成的连续执行分段；预算仍只读取原始 leg。 */
  executionSegments?: TransportPlanSegment[];
};

export type TransportPlanMode = TransportPlanLeg["mode"];

type TransportPreference = string | null | undefined;

type TransportCalculationInput = {
  mode: TransportPlanMode;
  distanceKm: number;
  travelers: number;
  /** 高德驾车路线返回的实际分钟数；缺失时按距离估算。 */
  routeDurationMinutes?: number;
};

const GENERIC_TRANSPORT_MODES = new Set(["economy", "balanced", "speed"]);
const EXPLICIT_TRANSPORT_MODES = new Set<TransportPlanMode>([
  "flight",
  "train",
  "drive",
  "bus",
  "ship",
]);
const LONG_DISTANCE_FLIGHT_KM = 800;
const FLIGHT_MINIMUM_MINUTES = 300;
const TRAIN_MINIMUM_MINUTES = 180;
const DRIVE_VEHICLE_CAPACITY = 5;

function normalizeDistance(distanceKm: number): number {
  return Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : 0;
}

function normalizeTravelers(travelers: number): number {
  return Number.isFinite(travelers) && travelers > 0 ? Math.ceil(travelers) : 1;
}

function isExplicitTransportMode(value: TransportPreference): value is TransportPlanMode {
  return typeof value === "string" && EXPLICIT_TRANSPORT_MODES.has(value as TransportPlanMode);
}

export function chooseLongDistanceMode(input: {
  explicit?: string | null;
  crossProvince: boolean;
  distanceKm: number;
}): TransportPlanLeg["mode"] {
  if (isExplicitTransportMode(input.explicit) && !GENERIC_TRANSPORT_MODES.has(input.explicit)) {
    return input.explicit;
  }
  if (input.crossProvince && normalizeDistance(input.distanceKm) >= LONG_DISTANCE_FLIGHT_KM) {
    return "flight";
  }
  return "train";
}

function calculateDoorToDoorMinutes(input: TransportCalculationInput): number {
  const distanceKm = normalizeDistance(input.distanceKm);

  switch (input.mode) {
    case "flight":
      return Math.max(FLIGHT_MINIMUM_MINUTES, Math.ceil(180 + distanceKm / 12));
    case "train":
      return Math.max(TRAIN_MINIMUM_MINUTES, Math.ceil(distanceKm / 2.2));
    case "drive": {
      const routeMinutes =
        typeof input.routeDurationMinutes === "number" &&
        Number.isFinite(input.routeDurationMinutes) &&
        input.routeDurationMinutes > 0
          ? input.routeDurationMinutes
          : Math.ceil((distanceKm / 80) * 60);
      // 每连续驾驶两小时至少休息 15 分钟，并保留至少 30 分钟缓冲。
      const restMinutes = Math.max(30, Math.ceil(routeMinutes / 120) * 15);
      return Math.ceil(routeMinutes + restMinutes);
    }
    case "bus":
      return Math.max(TRAIN_MINIMUM_MINUTES, Math.ceil(distanceKm + 30));
    case "ship":
      return Math.max(TRAIN_MINIMUM_MINUTES, Math.ceil((distanceKm / 30) * 60));
  }
}

function calculateMinimumPerPersonCost(input: TransportCalculationInput): number {
  const distanceKm = normalizeDistance(input.distanceKm);
  const travelers = normalizeTravelers(input.travelers);

  switch (input.mode) {
    case "flight":
      return Math.ceil(Math.max(500, 0.55 * distanceKm));
    case "train":
      return Math.ceil(Math.max(150, 0.35 * distanceKm));
    case "bus":
      return Math.ceil(Math.max(80, 0.22 * distanceKm));
    case "ship":
      return Math.ceil(Math.max(100, 0.3 * distanceKm));
    case "drive": {
      // 自驾按车辆最低成本计算，超过单车上限时拆分车辆，再折算为单人分摊。
      const vehicleCount = Math.max(1, Math.ceil(travelers / DRIVE_VEHICLE_CAPACITY));
      const vehicleCost = Math.ceil(Math.max(200, distanceKm * 1.2));
      return Math.ceil((vehicleCost * vehicleCount) / travelers);
    }
  }
}

export function calculateTransportLeg(
  input: TransportCalculationInput,
): Pick<TransportPlanLeg, "doorToDoorMinutes" | "minimumPerPersonCost"> {
  return {
    doorToDoorMinutes: calculateDoorToDoorMinutes(input),
    minimumPerPersonCost: calculateMinimumPerPersonCost(input),
  };
}
export function splitTransportLegIntoSegments(
  leg: TransportPlanLeg,
  dailyLimitMinutes = resolveDailyDriveLimitMinutes(6),
): TransportPlanSegment[] {
  const safeLimit = Math.max(60, Math.round(dailyLimitMinutes));
  const totalMinutes = Math.max(1, Math.round(leg.doorToDoorMinutes));
  const totalSegments = Math.max(1, leg.mode === "drive" ? Math.ceil(totalMinutes / safeLimit) : 1);
  const baseMinutes = Math.floor(totalMinutes / totalSegments);
  const minuteRemainder = totalMinutes - baseMinutes * totalSegments;
  const minutes = Array.from({ length: totalSegments }, (_, index) =>
    index < minuteRemainder ? baseMinutes + 1 : baseMinutes,
  );

  let allocatedDistance = 0;
  return minutes.map((doorToDoorMinutes, index) => {
    const order = index + 1;
    const isLast = order === totalSegments;
    const distanceKm = isLast
      ? Math.max(0, Math.round((leg.distanceKm - allocatedDistance) * 10) / 10)
      : Math.round(((leg.distanceKm * doorToDoorMinutes) / totalMinutes) * 10) / 10;
    allocatedDistance += distanceKm;
    return {
      id: `${leg.id}:segment:${order}`,
      legId: leg.id,
      order,
      totalSegments,
      from: leg.from,
      to: leg.to,
      distanceKm,
      mode: "drive" as const,
      doorToDoorMinutes,
      dailyLimitMinutes: safeLimit,
    };
  });
}
