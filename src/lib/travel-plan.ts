import type { Pace } from "./planner";
import type { TransportMode } from "./route-planner";

export type TransportPreference = Extract<TransportMode, "economy" | "balanced" | "speed">;
export type Travelers = { adults: number; children: number };

export type BudgetCategory = { amount: number; ratio: number };

export type TripBudget = {
  totalBudget: number;
  estimatedTotal: number;
  remaining: number;
  overBudget: number;
  perPersonBudget: number;
  perPersonEstimated: number;
  transport: BudgetCategory;
  lodging: BudgetCategory;
  food: BudgetCategory;
  tickets: BudgetCategory;
  other: BudgetCategory;
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
};

export type BudgetInput = {
  totalBudget: number;
  travelers: Travelers;
  transport: number;
  lodging: number;
  food: number;
  tickets: number;
  other?: number;
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

function category(amount: number, estimatedTotal: number): BudgetCategory {
  return {
    amount,
    ratio: estimatedTotal === 0 ? 0 : amount / estimatedTotal,
  };
}

export function estimateBudget(input: BudgetInput): TripBudget;
export function estimateBudget(input: CostEstimateInput): CostEstimate;
export function estimateBudget(input: BudgetInput | CostEstimateInput): TripBudget | CostEstimate {
  const subtotal = input.transport + input.lodging + input.food + input.tickets;
  const other = input.other ?? Math.max(200, Math.round(subtotal * 0.1));
  const estimatedTotal = subtotal + other;

  if (!("totalBudget" in input) || !("travelers" in input)) {
    return { ...input, other, total: estimatedTotal };
  }

  const travelerCount = input.travelers.adults + input.travelers.children;
  const perPerson = (amount: number) => (travelerCount > 0 ? amount / travelerCount : 0);

  return {
    totalBudget: input.totalBudget,
    estimatedTotal,
    remaining: Math.max(0, input.totalBudget - estimatedTotal),
    overBudget: Math.max(0, estimatedTotal - input.totalBudget),
    perPersonBudget: perPerson(input.totalBudget),
    perPersonEstimated: perPerson(estimatedTotal),
    transport: category(input.transport, estimatedTotal),
    lodging: category(input.lodging, estimatedTotal),
    food: category(input.food, estimatedTotal),
    tickets: category(input.tickets, estimatedTotal),
    other: category(other, estimatedTotal),
  };
}
