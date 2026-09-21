import type { Pace } from "./planner";
import type { TransportMode } from "./route-planner";
import type { PlanViolation } from "./plan-validator";

export type TransportPreference = Extract<TransportMode, "economy" | "balanced" | "speed">;
export type Travelers = { adults: number; children: number };

export type VehicleEnergy = "fuel" | "electric" | "hybrid";

export type TripBrief = Travelers & {
  startTime: string;
  endTime: string;
  totalBudget: number;
  vehicleEnergy: VehicleEnergy | null;
};

export type BudgetRange = { min: number; max: number };
export type BudgetCategoryInput = number | BudgetRange;
export type BudgetCategory = BudgetRange & { amount: number; ratio: number };
export type RoadTripBudgetDetails = {
  energy: BudgetRange;
  toll: BudgetRange;
  holidayFreeAdjustment: BudgetRange;
  parking: BudgetRange;
};

export type TripBudget = {
  totalBudget: number;
  estimatedTotal: number;
  totalMin: number;
  totalMax: number;
  remaining: number;
  overBudget: number;
  perPersonBudget: number;
  perPersonEstimated: number;
  rooms: number;
  transport: BudgetCategory;
  lodging: BudgetCategory;
  food: BudgetCategory;
  tickets: BudgetCategory;
  other: BudgetCategory;
  roadTrip?: RoadTripBudgetDetails;
};

export type AttractionScale = "small" | "medium" | "large" | "multi-day";

export type AttractionAudit = {
  scale: AttractionScale;
  durationHours: number;
  physical: number;
  childFit: number;
  weatherSensitivity: number;
  timeCost: number;
  crowding: number;
  bestTime: string;
};

export type DailyRadar = {
  physical: number;
  childFit: number;
  weatherSensitivity: number;
  timeCost: number;
  crowding: number;
};

export type TimelineNodeType =
  "transport" | "transfer" | "attraction" | "meal" | "rest" | "hotel" | "night-activity";

export type Coordinate = [longitude: number, latitude: number];

export type TripTimelineNode = {
  startTime: string;
  endTime: string;
  // 展示用时段：轻松档写「上午/中午/下午/晚上」等宽松时段，适中与充实档写具体时刻。
  timeLabel: string;
  type: TimelineNodeType;
  name: string;
  location?: string;
  coordinates?: Coordinate;
  transportMode?: TransportMode;
  transportMinutes?: number;
  stayMinutes?: number;
  estimatedCost: number;
  tips?: string;
  // 无法生成导航链接时必须显式写入 null，表示已降级。
  navigation: string | null;
};

// 每日历史背景必须与可核验来源一起提供，执行提示不得冒充史实。
export type TripHistoryNote = {
  title: string;
  background: string;
  source: string;
};

export type TripDay = {
  date: string;
  theme: string;
  weather?: string;
  mapUrl?: string;
  navigationUrl?: string;
  qrCodeUrl?: string;
  nodes: TripTimelineNode[];
  estimatedCost: number;
  radar: DailyRadar;
  purpose: string;
  highlights: string[];
  cautions: string[];
  history?: TripHistoryNote[];
  /** 当日 AI 文案分析失败；UI 可据此显示「本页分析未能生成」。 */
  analysisFailed?: boolean;
};

export type RouteSegment = {
  from: string;
  to: string;
  mode: TransportMode;
  distanceKm: number;
  durationMinutes: number;
  navigation: string;
};

export type ReturnMode = "fast" | "scenic" | null;

export type TripRoute = {
  staticMapUrl?: string;
  outbound: Coordinate[];
  returnPath: Coordinate[];
  outboundSegments: RouteSegment[];
  returnSegments: RouteSegment[];
  distanceKm: number;
  durationMinutes: number;
  returnMode: ReturnMode;
};

export type TripMeta = {
  title: string;
  origin: string;
  waypoints: string[];
  destination: string;
  startDate: string;
  days: number;
  travelers: Travelers;
  perPersonBudget: number;
  transportPreference: TransportPreference;
  pace: Pace;
  interests: string[];
};

export type TripClosing = {
  quote: string | null;
  source: string | null;
  message: string;
};

export type TripPlan = {
  meta: TripMeta;
  budget: TripBudget;
  route: TripRoute;
  days: TripDay[];
  closing: TripClosing;
  /** 骨架校验违规原样保留，供结果页提示与后续修订使用。 */
  violations?: PlanViolation[];
};

export type BudgetInput = {
  totalBudget: number;
  travelers: Travelers;
  transport: BudgetCategoryInput;
  lodging: BudgetCategoryInput;
  food: BudgetCategoryInput;
  tickets: BudgetCategoryInput;
  other?: BudgetCategoryInput;
};

export type CostEstimateInput = {
  transport: number;
  lodging: number;
  food: number;
  tickets: number;
  other?: number;
};

export type CostEstimate = CostEstimateInput & {
  other: number;
  total: number;
};

const expandedRadarAnchors = [
  { position: 0, score: 22 },
  { position: 0.25, score: 43 },
  { position: 0.5, score: 64 },
  { position: 0.75, score: 85 },
  { position: 1, score: 94 },
] as const;

// 将聚集分数单调拉伸到更易辨识的区间，不改变原始顺序。
function expandClusteredScore(score: number, min: number, max: number): number {
  const position = (score - min) / (max - min);

  for (let index = 1; index < expandedRadarAnchors.length; index += 1) {
    const lower = expandedRadarAnchors[index - 1];
    const upper = expandedRadarAnchors[index];

    if (position <= upper.position) {
      const progress = (position - lower.position) / (upper.position - lower.position);
      return Math.round(lower.score + (upper.score - lower.score) * progress);
    }
  }

  return expandedRadarAnchors.at(-1)?.score ?? score;
}

export function normalizeRadarScores(scores: number[], minimumSpread = 60): number[] {
  if (scores.length === 0) return [];

  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max - min >= minimumSpread) return scores.map((score) => Math.round(score));
  if (max === min) return scores.map((score) => Math.round(score));

  return scores.map((score) => expandClusteredScore(score, min, max));
}

function normalizeBudgetRange(value: BudgetCategoryInput, label: string): BudgetRange {
  const range =
    typeof value === "number" ? { min: value, max: value } : { min: value?.min, max: value?.max };
  if (
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new Error(`${label}必须是有效且不小于 0 的 min/max 区间`);
  }
  return { min: range.min, max: range.max };
}

function rangeMidpoint(range: BudgetRange): number {
  return (range.min + range.max) / 2;
}

function category(range: BudgetRange, estimatedTotal: number): BudgetCategory {
  const amount = rangeMidpoint(range);
  return {
    ...range,
    amount,
    ratio: estimatedTotal === 0 ? 0 : amount / estimatedTotal,
  };
}

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type TripBriefValidationOptions = { selfDrive?: boolean };

// 在进入规划流程前集中校验出行人数、预算和每日可用时间。
export function validateTripBrief(
  brief: TripBrief,
  options: TripBriefValidationOptions = {},
): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(brief.adults) || brief.adults < 1) {
    errors.push("至少需要 1 位成人");
  }
  if (!Number.isInteger(brief.children) || brief.children < 0) {
    errors.push("儿童人数必须是非负整数");
  }
  if (!Number.isFinite(brief.totalBudget) || brief.totalBudget <= 0) {
    errors.push("请填写全团总预算");
  }
  if (!timePattern.test(brief.startTime)) {
    errors.push("请填写有效的每日出发时间");
  }
  if (!timePattern.test(brief.endTime)) {
    errors.push("请填写有效的每日最晚结束时间");
  } else if (timePattern.test(brief.startTime) && brief.endTime <= brief.startTime) {
    errors.push("每日最晚结束时间必须晚于出发时间");
  }
  if (options.selfDrive && (brief.vehicleEnergy === null || brief.vehicleEnergy === undefined)) {
    errors.push("请选择自驾车辆能源类型");
  }
  return errors;
}

export function calculateRooms(adults: number): number {
  if (!Number.isFinite(adults) || adults < 0) {
    throw new Error("成人数必须是非负数字");
  }
  return adults <= 2 ? 1 : Math.ceil(adults / 2);
}

export function estimateBudget(input: BudgetInput): TripBudget;
export function estimateBudget(input: CostEstimateInput): CostEstimate;
export function estimateBudget(input: BudgetInput | CostEstimateInput): TripBudget | CostEstimate {
  const transport = normalizeBudgetRange(input.transport, "交通预算");
  const lodging = normalizeBudgetRange(input.lodging, "住宿预算");
  const food = normalizeBudgetRange(input.food, "餐饮预算");
  const tickets = normalizeBudgetRange(input.tickets, "门票预算");
  const subtotalMidpoint =
    rangeMidpoint(transport) +
    rangeMidpoint(lodging) +
    rangeMidpoint(food) +
    rangeMidpoint(tickets);
  const defaultOther = Math.max(200, Math.round(subtotalMidpoint * 0.1));
  const other =
    input.other === undefined
      ? { min: defaultOther, max: defaultOther }
      : normalizeBudgetRange(input.other, "其他预算");
  const totalMin = transport.min + lodging.min + food.min + tickets.min + other.min;
  const totalMax = transport.max + lodging.max + food.max + tickets.max + other.max;
  const estimatedTotal = rangeMidpoint({ min: totalMin, max: totalMax });

  if (!("totalBudget" in input) || !("travelers" in input)) {
    return {
      transport: rangeMidpoint(transport),
      lodging: rangeMidpoint(lodging),
      food: rangeMidpoint(food),
      tickets: rangeMidpoint(tickets),
      other: rangeMidpoint(other),
      total: estimatedTotal,
    };
  }

  const travelerCount = input.travelers.adults + input.travelers.children;
  const perPerson = (amount: number) => (travelerCount > 0 ? amount / travelerCount : 0);

  return {
    totalBudget: input.totalBudget,
    estimatedTotal,
    totalMin,
    totalMax,
    // 超支风险以区间上限判断，避免中值低估实际超支。
    remaining: Math.max(0, input.totalBudget - totalMax),
    overBudget: Math.max(0, totalMax - input.totalBudget),
    perPersonBudget: perPerson(input.totalBudget),
    perPersonEstimated: perPerson(estimatedTotal),
    rooms: calculateRooms(input.travelers.adults),
    transport: category(transport, estimatedTotal),
    lodging: category(lodging, estimatedTotal),
    food: category(food, estimatedTotal),
    tickets: category(tickets, estimatedTotal),
    other: category(other, estimatedTotal),
  };
}
