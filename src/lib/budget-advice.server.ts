import { z } from "zod";
import { createAmapClient, type AmapCoordinate } from "./amap.server.ts";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_LODGING_PER_ROOM_PER_NIGHT = 600;
const DEFAULT_FOOD_PER_PERSON_PER_DAY = 150;
const DEFAULT_ADULT_TICKET_PRICE = 200;
const DEFAULT_CHILD_TICKET_PRICE = 100;
const DEFAULT_OTHER_MINIMUM = 200;
const DRIVE_VEHICLE_CAPACITY = 5;

const budgetAdviceSchema = z.object({
  total: z.number().nonnegative(),
  categories: z
    .object({
      transport: z.number().nonnegative(),
      lodging: z.number().nonnegative(),
      food: z.number().nonnegative(),
      tickets: z.number().nonnegative(),
      other: z.number().nonnegative(),
    })
    .strict(),
  note: z.string().min(1),
});

const budgetAdviceNoteSchema = z
  .object({
    note: z.string().trim().min(1).max(120),
  })
  .passthrough();

export type BudgetAdvice = {
  total: number;
  categories: {
    transport: number;
    lodging: number;
    food: number;
    tickets: number;
    other: number;
  };
  baseTotal: number;
  bufferRate: number;
  recommendedTotal: number;
  note: string;
};

export type BudgetAdviceCostInput = {
  /** 每间房每晚价格，默认 600 元。 */
  lodgingPerRoomPerNight?: number;
  /** 每人每天餐标，默认 150 元。 */
  foodPerPersonPerDay?: number;
  /** 成人整趟门票预算，默认 200 元。 */
  adultTicketPrice?: number;
  /** 儿童整趟门票预算，默认 100 元。 */
  childTicketPrice?: number;
  /** 统一票价时覆盖成人/儿童票价，按全部同行人数计算。 */
  uniformTicketPrice?: number;
  /** 数据可信度和行程复杂度；高不确定时使用 20% 缓冲。 */
  uncertainty?: "low" | "medium" | "high";
};

export type BudgetAdviceRouteLeg = {
  from: string;
  to: string;
  transport: string;
  kind: "outbound" | "return";
  style: "direct" | "wander";
  /** 高德实际里程；缺少显式价格时用于本地价格估算。 */
  distanceKm?: number;
  /** 单人票价或单车价格。 */
  unitCost?: number;
  /** 该 leg 的全团总价；优先级最高。 */
  totalCost?: number;
  /** unitCost 的计费基准，默认按人计价。 */
  costBasis?: "per-person" | "vehicle";
};

export type BudgetAdviceInput = {
  origin: string;
  destination: string;
  region: string;
  days: number;
  travelers: { adults: number; children: number };
  transportPreference: string;
  roundTrip: boolean;
  returnMode: "scenic" | "fast" | null;
  routeLegs: BudgetAdviceRouteLeg[];
  pace: string;
  interests: string[];
  /** 本地确定性预算的可选价格输入；缺失时使用保守参考价。 */
  costs?: BudgetAdviceCostInput;
};

export type BudgetAdviceDeps = {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  /** 高德 Key；显式传空字符串时禁止回退到环境变量。 */
  amapKey?: string;
  /** 高德网络桩；与 DeepSeek 的 fetchImpl 分离，避免测试互相污染。 */
  amapFetchImpl?: typeof fetch;
};

function stripJsonFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function parseBudgetAdvice(content: string): BudgetAdvice {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch (error) {
    throw new Error("预算建议不是有效 JSON", { cause: error });
  }

  try {
    const advice = budgetAdviceSchema.parse(parsed);
    // 兼容旧数据：无论传入 total 是多少，都以五类费用合计为权威总额。
    const categoryTotal = Object.values(advice.categories).reduce((sum, amount) => sum + amount, 0);
    return {
      total: categoryTotal,
      categories: advice.categories,
      baseTotal: categoryTotal,
      bufferRate: 0,
      recommendedTotal: categoryTotal,
      note: advice.note,
    };
  } catch (error) {
    throw new Error("预算建议 JSON 不符合结构", { cause: error });
  }
}

export function parseBudgetAdviceNote(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch (error) {
    throw new Error("预算解释不是有效 JSON", { cause: error });
  }

  try {
    return budgetAdviceNoteSchema.parse(parsed).note;
  } catch (error) {
    throw new Error("预算解释 JSON 不符合结构", { cause: error });
  }
}

type BudgetCategoryKey = keyof BudgetAdvice["categories"];

const BUDGET_CATEGORY_KEYS: BudgetCategoryKey[] = [
  "transport",
  "lodging",
  "food",
  "tickets",
  "other",
];

function normalizeCount(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : 0;
}

function normalizeAmount(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0;
}

function resolveConfiguredAmount(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : normalizeAmount(value);
}

function roundCurrency(value: number): number {
  return Math.max(0, Math.round(value));
}

function roundToHundred(value: number): number {
  return Math.max(0, Math.ceil(value / 100) * 100);
}

function vehicleCountForTravelers(travelerCount: number): number {
  return Math.max(1, Math.ceil(travelerCount / DRIVE_VEHICLE_CAPACITY));
}

function normalizeTransportMode(value: string): string {
  const mode = value.trim().toLowerCase();
  if (/(drive|car|自驾|租车|包车)/u.test(mode)) return "drive";
  if (/(flight|plane|air|飞机|航班)/u.test(mode)) return "flight";
  if (/(train|rail|高铁|火车|动车)/u.test(mode)) return "train";
  if (/(bus|巴士|客车)/u.test(mode)) return "bus";
  if (/(ship|ferry|轮渡|船)/u.test(mode)) return "ship";
  if (mode === "economy" || mode === "balanced" || mode === "speed") return mode;
  return mode;
}

function estimateCostByDistance(mode: string, distanceKm: number, travelerCount: number): number {
  const resolvedMode = normalizeTransportMode(mode);
  const effectiveMode =
    resolvedMode === "balanced" || resolvedMode === "economy" || resolvedMode === "speed"
      ? distanceKm >= 800
        ? "flight"
        : "train"
      : resolvedMode;

  switch (effectiveMode) {
    case "flight":
      return Math.ceil(Math.max(500, distanceKm * 0.55)) * travelerCount;
    case "train":
      return Math.ceil(Math.max(150, distanceKm * 0.35)) * travelerCount;
    case "bus":
      return Math.ceil(Math.max(80, distanceKm * 0.22)) * travelerCount;
    case "ship":
      return Math.ceil(Math.max(100, distanceKm * 0.3)) * travelerCount;
    case "drive":
      return Math.ceil(Math.max(200, distanceKm * 1.2)) * vehicleCountForTravelers(travelerCount);
    default:
      return Math.ceil(Math.max(150, distanceKm * 0.35)) * travelerCount;
  }
}

function estimateFallbackTransportCost(mode: string, travelerCount: number): number {
  const resolvedMode = normalizeTransportMode(mode);
  if (resolvedMode === "drive") {
    return 1_000 * vehicleCountForTravelers(travelerCount);
  }

  const perPersonCost: Record<string, number> = {
    flight: 1_000,
    train: 500,
    bus: 300,
    ship: 500,
    balanced: 700,
    economy: 500,
    speed: 1_000,
  };
  return (perPersonCost[resolvedMode] ?? 700) * travelerCount;
}

function estimateRouteLegCost(leg: BudgetAdviceRouteLeg, travelerCount: number): number {
  const explicitTotal = normalizeAmount(leg.totalCost);
  if (explicitTotal > 0) return explicitTotal;

  const unitCost = normalizeAmount(leg.unitCost);
  if (unitCost > 0) {
    if (leg.costBasis === "vehicle") {
      return unitCost * vehicleCountForTravelers(travelerCount);
    }
    return unitCost * travelerCount;
  }

  const distanceKm = normalizeAmount(leg.distanceKm);
  if (distanceKm > 0) {
    return estimateCostByDistance(leg.transport, distanceKm, travelerCount);
  }

  return estimateFallbackTransportCost(leg.transport, travelerCount);
}

function normalizeRouteLegCostBasis(leg: BudgetAdviceRouteLeg): BudgetAdviceRouteLeg {
  return {
    ...leg,
    // 自驾按车辆实际成本，其他交通统一按单人价格计算。
    costBasis: normalizeTransportMode(leg.transport) === "drive" ? "vehicle" : "per-person",
  };
}

function completeTransportLegs(input: BudgetAdviceInput): BudgetAdviceRouteLeg[] {
  const legs = input.routeLegs.map(normalizeRouteLegCostBasis);
  if (input.roundTrip && !legs.some((leg) => leg.kind === "return")) {
    legs.push({
      from: input.destination,
      to: input.origin,
      transport: input.transportPreference,
      kind: "return",
      style: input.returnMode === "scenic" ? "wander" : "direct",
    });
  }
  return legs;
}

function haversineDistanceKm(from: AmapCoordinate, to: AmapCoordinate): number {
  const earthRadiusKm = 6_371.0088;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const [fromLongitude, fromLatitude] = from;
  const [toLongitude, toLatitude] = to;
  const latitudeDelta = toRadians(toLatitude - fromLatitude);
  const longitudeDelta = toRadians(toLongitude - fromLongitude);
  const fromLatitudeRadians = toRadians(fromLatitude);
  const toLatitudeRadians = toRadians(toLatitude);

  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitudeRadians) * Math.cos(toLatitudeRadians) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function enrichBudgetAdviceInput(
  input: BudgetAdviceInput,
  deps: BudgetAdviceDeps,
): Promise<BudgetAdviceInput> {
  const routeLegs = completeTransportLegs(input);
  const amapKey =
    deps.amapKey !== undefined ? deps.amapKey.trim() : process.env.AMAP_API_KEY?.trim();
  const needsDistance = routeLegs.some((leg) => normalizeAmount(leg.distanceKm) === 0);
  if (!amapKey || !needsDistance) return { ...input, routeLegs };

  const client = createAmapClient(amapKey, deps.amapFetchImpl ?? fetch);
  const geocodeCache = new Map<string, Promise<AmapCoordinate | null>>();
  const geocode = (address: string): Promise<AmapCoordinate | null> => {
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return Promise.resolve(null);
    const cached = geocodeCache.get(normalizedAddress);
    if (cached) return cached;

    const pending = client
      .geocode({ address: normalizedAddress })
      .then((results) => results[0]?.location ?? null)
      // 单个地点定位失败时保留缺省里程，由本地保守公式兜底。
      .catch(() => null);
    geocodeCache.set(normalizedAddress, pending);
    return pending;
  };

  const enrichedLegs = await Promise.all(
    routeLegs.map(async (leg) => {
      if (normalizeAmount(leg.distanceKm) > 0) return leg;
      const [from, to] = await Promise.all([geocode(leg.from), geocode(leg.to)]);
      if (!from || !to) return leg;
      const distanceKm = Math.round(haversineDistanceKm(from, to) * 10) / 10;
      return distanceKm > 0 ? { ...leg, distanceKm } : leg;
    }),
  );

  return { ...input, routeLegs: enrichedLegs };
}

function resolveBufferRate(input: BudgetAdviceInput, legs: BudgetAdviceRouteLeg[]): number {
  const explicit = input.costs?.uncertainty;
  if (explicit === "low") return 0.1;
  if (explicit === "high") return 0.2;
  if (explicit === "medium") return 0.15;

  const hasUnknownTransportCost = legs.some(
    (leg) =>
      normalizeAmount(leg.totalCost) === 0 &&
      normalizeAmount(leg.unitCost) === 0 &&
      normalizeAmount(leg.distanceKm) === 0,
  );
  const isComplexTrip =
    legs.length >= 4 || input.days >= 10 || legs.some((leg) => leg.style === "wander");
  return hasUnknownTransportCost || isComplexTrip ? 0.2 : 0.15;
}

function distributeRecommendedTotal(
  baseCategories: BudgetAdvice["categories"],
  recommendedTotal: number,
): BudgetAdvice["categories"] {
  const baseTotal = BUDGET_CATEGORY_KEYS.reduce((sum, key) => sum + baseCategories[key], 0);
  if (baseTotal <= 0)
    return { transport: 0, lodging: 0, food: 0, tickets: 0, other: recommendedTotal };

  const ratio = recommendedTotal / baseTotal;
  const categories = {
    transport: 0,
    lodging: 0,
    food: 0,
    tickets: 0,
    other: 0,
  } satisfies BudgetAdvice["categories"];
  let allocated = 0;

  // 前四项向下取整，最后一项承接余数，确保分类合计严格等于推荐总额。
  BUDGET_CATEGORY_KEYS.forEach((key, index) => {
    if (index === BUDGET_CATEGORY_KEYS.length - 1) {
      categories[key] = recommendedTotal - allocated;
      return;
    }
    const amount = Math.floor(baseCategories[key] * ratio);
    categories[key] = amount;
    allocated += amount;
  });

  return categories;
}

export function buildBudgetAdvice(input: BudgetAdviceInput): BudgetAdvice {
  const travelerCount = Math.max(
    1,
    normalizeCount(input.travelers.adults) + normalizeCount(input.travelers.children),
  );
  const days = Math.max(1, normalizeCount(input.days));
  const nights = Math.max(0, days - 1);
  const rooms = travelerCount;
  const legs = completeTransportLegs(input);

  const transport = roundCurrency(
    legs.reduce((sum, leg) => sum + estimateRouteLegCost(leg, travelerCount), 0),
  );
  const lodgingPerRoomPerNight = resolveConfiguredAmount(
    input.costs?.lodgingPerRoomPerNight,
    DEFAULT_LODGING_PER_ROOM_PER_NIGHT,
  );
  const foodPerPersonPerDay = resolveConfiguredAmount(
    input.costs?.foodPerPersonPerDay,
    DEFAULT_FOOD_PER_PERSON_PER_DAY,
  );
  const lodging = roundCurrency(rooms * nights * lodgingPerRoomPerNight);
  const food = roundCurrency(travelerCount * days * foodPerPersonPerDay);

  const uniformTicketPrice = normalizeAmount(input.costs?.uniformTicketPrice);
  const adultTicketPrice = resolveConfiguredAmount(
    input.costs?.adultTicketPrice,
    DEFAULT_ADULT_TICKET_PRICE,
  );
  const childTicketPrice = resolveConfiguredAmount(
    input.costs?.childTicketPrice,
    DEFAULT_CHILD_TICKET_PRICE,
  );
  const tickets = roundCurrency(
    uniformTicketPrice > 0
      ? uniformTicketPrice * travelerCount
      : adultTicketPrice * normalizeCount(input.travelers.adults) +
          childTicketPrice * normalizeCount(input.travelers.children),
  );

  const baseBeforeOther = transport + lodging + food + tickets;
  const other = roundCurrency(Math.max(DEFAULT_OTHER_MINIMUM, baseBeforeOther * 0.1));
  const baseCategories = {
    transport,
    lodging,
    food,
    tickets,
    other,
  } satisfies BudgetAdvice["categories"];
  const baseTotal = BUDGET_CATEGORY_KEYS.reduce((sum, key) => sum + baseCategories[key], 0);
  const bufferRate = resolveBufferRate(input, legs);
  const recommendedTotal = roundToHundred(baseTotal * (1 + bufferRate));
  const categories = distributeRecommendedTotal(baseCategories, recommendedTotal);

  return {
    total: recommendedTotal,
    categories,
    baseTotal,
    bufferRate,
    recommendedTotal,
    note: `本地确定性预算：交通、住宿、餐饮、门票和其他合计基准 ¥${baseTotal}，含 ${Math.round(
      bufferRate * 100,
    )}% 行程缓冲。`,
  };
}

export function buildBudgetAdviceMessages(
  input: BudgetAdviceInput,
  baseline: BudgetAdvice = buildBudgetAdvice(input),
): unknown[] {
  const tripNights = Math.max(0, input.days - 1);
  const travelerCount = Math.max(1, input.travelers.adults + input.travelers.children);
  const hotelRooms = travelerCount;

  return [
    {
      role: "system",
      content:
        '你是中国旅行预算说明助手。预算金额已经由本地确定性公式计算完成，你只能整理一句预算解释，禁止修改、压低或重算任何金额、人数、房间数、天数、交通段或总价。住宿规则是每位同行者一间房。只输出严格 JSON，格式为 {"note":"不超过 120 个中文字符"}。',
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "根据本地预算基线整理说明，不得修改金额",
        requiredSchema: {
          note: "不超过 120 个中文字符，只能解释本地预算口径或主要开销",
        },
        baseline,
        input: {
          ...input,
          tripNights,
          hotelRooms,
        },
      }),
    },
  ];
}

export async function requestBudgetAdvice(
  input: BudgetAdviceInput,
  deps: BudgetAdviceDeps = {},
): Promise<BudgetAdvice> {
  const enrichedInput = await enrichBudgetAdviceInput(input, deps);
  const baseline = buildBudgetAdvice(enrichedInput);
  const apiKey =
    deps.apiKey !== undefined ? deps.apiKey.trim() : process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return baseline;

  const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
        messages: buildBudgetAdviceMessages(enrichedInput, baseline),
        response_format: { type: "json_object" },
        max_tokens: 800,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    // DeepSeek 只负责说明文案；服务不可用时仍返回同一份本地确定性预算。
    if (!response.ok) return baseline;

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return baseline;

    return { ...baseline, note: parseBudgetAdviceNote(content) };
  } catch {
    return baseline;
  }
}
