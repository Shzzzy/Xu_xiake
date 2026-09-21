import { calculateRooms, estimateBudget } from "./travel-plan.ts";
import type {
  AttractionAudit,
  AttractionScale,
  BudgetRange,
  CostEstimateInput,
  ReturnMode,
  RoadTripBudgetDetails,
  Travelers,
  TripBudget,
  TripClosing,
  TripDay,
} from "./travel-plan.ts";
import type { Pace } from "./planner.ts";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 60_000;
const MODERN_CLOSING =
  "山河万里，行者常新；愿每一次出发，都成为丈量祖国大好河山的珍贵记忆。每一个认真行走的人，都是当代徐霞客。";

export type DeepSeekErrorCode =
  | "missing_api_key"
  | "timeout"
  | "network"
  | "http_error"
  | "invalid_json"
  | "invalid_content"
  | "schema_error";

export type DeepSeekService = "audit" | "budget" | "daily-summary" | "closing";

export class DeepSeekTravelError extends Error {
  readonly code: DeepSeekErrorCode;
  readonly service: DeepSeekService;
  readonly status?: number;

  constructor(
    code: DeepSeekErrorCode,
    service: DeepSeekService,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DeepSeekTravelError";
    this.code = code;
    this.service = service;
    this.status = options.status;
  }
}

export type VerifiedQuote = {
  id: string;
  quote: string;
  source: string;
};

export const verifiedQuotes = [
  {
    id: "xuxiake-youtiantai-opening",
    quote: "癸丑之三月晦，自宁海出西门。云散日朗，人意山光，俱有喜态。",
    source: "《徐霞客游记·游天台山日记》",
  },
] as const satisfies readonly VerifiedQuote[];

const verifiedQuoteById = new Map<string, VerifiedQuote>(
  verifiedQuotes.map((entry) => [entry.id, entry] as const),
);

export type DeepSeekTravelDeps = {
  /** 仅在服务端传入或由 DEEPSEEK_API_KEY 提供。 */
  apiKey?: string;
  deepseekKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
};

export type VehicleEnergy = "fuel" | "electric" | "hybrid" | null;

export type DeepSeekMessage = {
  role: "system" | "user";
  content: string;
};

export type AttractionAuditSource = {
  title?: string;
  url?: string;
  content?: string;
};

export type AttractionAuditEntry =
  | string
  | {
      name: string;
      region?: string;
      description?: string;
      sourceSnapshot?: AttractionAuditSource[];
      sources?: AttractionAuditSource[];
    };

export type AttractionAuditInput = {
  attractions?: AttractionAuditEntry[];
  /** 兼容按地名批量审核时使用 places 命名的调用。 */
  places?: AttractionAuditEntry[];
  destination?: string;
  region?: string;
  startDate?: string;
  days?: number;
  travelers?: Travelers;
  pace?: Pace;
  interests?: string[];
  notes?: string;
};

export type BudgetEstimateInput = {
  totalBudget: number;
  travelers: Travelers;
  origin?: string;
  destination?: string;
  waypoints?: string[];
  routeNodes?: string[];
  days?: number;
  pace?: Pace;
  transportPreference?: string;
  interests?: string[];
  vehicleEnergy?: VehicleEnergy;
  selfDrive?: boolean;
  transportMode?: string;
  lodgingLevel?: "economy" | "comfort" | "premium" | string;
  baseline?: Partial<CostEstimateInput>;
  transport?: number;
  lodging?: number;
  food?: number;
  tickets?: number;
  other?: number;
  notes?: string;
};

export type DaySummaryInput = {
  day?: Partial<TripDay>;
  dayNumber?: number;
  date?: string;
  destination?: string;
  origin?: string;
  routeNodes?: string[];
  attractions?: AttractionAuditEntry[];
  weather?: string;
  travelers?: Travelers;
  pace?: Pace;
  interests?: string[];
  notes?: string;
};

export type TripClosingInput = {
  origin?: string;
  destination?: string;
  waypoints?: string[];
  routeNodes?: string[];
  days?: number;
  returnMode?: ReturnMode;
  pace?: Pace;
  transportPreference?: string;
  interests?: string[];
  highlights?: string[];
  travelSummary?: string;
  notes?: string;
};

export type DaySummary = {
  purpose: string;
  highlights: string[];
  cautions: string[];
};

type JsonRecord = Record<string, unknown>;

const attractionScaleSchema = ["small", "medium", "large", "multi-day"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("DeepSeek 返回的 JSON 必须是对象");
  return value;
}

function assertExactKeys(record: JsonRecord, allowedKeys: readonly string[], label: string): void {
  const extraKeys = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (extraKeys.length > 0) {
    throw new Error(`${label}包含不允许的额外字段：${extraKeys.join("、")}`);
  }
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}必须是非空字符串`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown, label: string, minimum = Number.NEGATIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label}必须是大于等于 ${minimum} 的有效数字`);
  }
  return value;
}

function readScore(value: unknown, label: string): number {
  const score = readNumber(value, label, 0);
  if (score > 100) throw new Error(`${label}必须在 0 到 100 之间`);
  return score;
}

function isAttractionScale(value: unknown): value is AttractionScale {
  return typeof value === "string" && attractionScaleSchema.includes(value as AttractionScale);
}

function resolveDeepSeekConfig(deps: DeepSeekTravelDeps) {
  const apiKey =
    deps.apiKey?.trim() || deps.deepseekKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || "";
  if (!apiKey) throw new Error("缺少 DEEPSEEK_API_KEY，无法调用 DeepSeek");

  return {
    apiKey,
    baseUrl: (
      deps.baseUrl?.trim() ||
      process.env.DEEPSEEK_BASE_URL?.trim() ||
      DEFAULT_DEEPSEEK_BASE_URL
    ).replace(/\/+$/, ""),
    model: deps.model?.trim() || process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
    fetchImpl: deps.fetchImpl ?? deps.fetch ?? fetch,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTokens: deps.maxTokens,
    temperature: deps.temperature,
  };
}

function parseJsonObject(content: string): JsonRecord {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const jsonText = fenced?.[1]?.trim() ?? trimmed;

  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new Error("DeepSeek 未返回有效 JSON");
  }

  return readRecord(value);
}

function asDeepSeekError(
  error: unknown,
  service: DeepSeekService,
  fallbackCode: DeepSeekErrorCode,
  message: string,
): DeepSeekTravelError {
  if (error instanceof DeepSeekTravelError) return error;
  return new DeepSeekTravelError(fallbackCode, service, message, { cause: error });
}

function requestFailureCode(error: unknown): DeepSeekErrorCode {
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "timeout";
  }
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "network";
}

async function requestDeepSeekJson(
  service: DeepSeekService,
  context: string,
  messages: DeepSeekMessage[],
  deps: DeepSeekTravelDeps,
  defaultMaxTokens: number,
): Promise<JsonRecord> {
  let config: ReturnType<typeof resolveDeepSeekConfig>;
  try {
    config = resolveDeepSeekConfig(deps);
  } catch (error) {
    throw asDeepSeekError(error, service, "missing_api_key", `DeepSeek ${context}缺少配置`);
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    response_format: { type: "json_object" },
    max_tokens: config.maxTokens ?? defaultMaxTokens,
    temperature: config.temperature ?? 0.2,
  };

  let response: Response;
  try {
    response = await config.fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: deps.signal
        ? AbortSignal.any([deps.signal, AbortSignal.timeout(config.timeoutMs)])
        : AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const code = requestFailureCode(error);
    throw new DeepSeekTravelError(
      code,
      service,
      code === "timeout" ? `DeepSeek ${context}超时` : `DeepSeek ${context}网络请求失败`,
      { cause: error },
    );
  }

  if (!response.ok) {
    let message = "";
    try {
      message = await response.text();
    } catch {
      // HTTP 状态仍足以提供可识别错误，正文读取失败不覆盖状态信息。
    }
    throw new DeepSeekTravelError(
      "http_error",
      service,
      `DeepSeek ${context}失败（${response.status}）${message ? `：${message.slice(0, 180)}` : ""}`,
      { status: response.status },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new DeepSeekTravelError("invalid_json", service, `DeepSeek ${context}未返回有效 JSON`, {
      cause: error,
    });
  }

  const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  const message =
    isRecord(firstChoice) && isRecord(firstChoice.message) ? firstChoice.message : null;
  const content = message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new DeepSeekTravelError("invalid_content", service, `DeepSeek ${context}未返回内容`);
  }

  try {
    return parseJsonObject(content);
  } catch (error) {
    throw new DeepSeekTravelError(
      "invalid_json",
      service,
      `DeepSeek ${context}未返回有效 JSON 对象`,
      { cause: error },
    );
  }
}

function jsonMessages(input: {
  system: string;
  task: string;
  schema: unknown;
  payload: unknown;
}): DeepSeekMessage[] {
  return [
    {
      role: "system",
      content: `${input.system} 只输出 JSON 对象，不要 Markdown、代码围栏或解释。所有时间和费用都写为估算值。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        task: input.task,
        requiredSchema: input.schema,
        input: input.payload,
      }),
    },
  ];
}

function normalizeAttractionEntries(input: AttractionAuditInput): AttractionAuditEntry[] {
  const raw = input.attractions ?? input.places ?? [];
  if (!Array.isArray(raw)) throw new Error("attractions 必须是数组");
  const names = new Set<string>();
  return raw.map((entry) => {
    const normalized =
      typeof entry === "string"
        ? entry
        : ({
            ...readRecord(entry),
            name: readString(readRecord(entry).name, "景点名称"),
          } as AttractionAuditEntry);
    const name = typeof normalized === "string" ? normalized : normalized.name;
    if (names.has(name)) throw new Error(`景点名称必须唯一：${name}`);
    names.add(name);
    return normalized;
  });
}

function assertScaleDuration(scale: AttractionScale, durationHours: number): void {
  const matches =
    (scale === "small" && durationHours >= 1 && durationHours <= 2) ||
    (scale === "medium" && durationHours >= 3 && durationHours <= 5) ||
    (scale === "large" && durationHours >= 6 && durationHours <= 10) ||
    (scale === "multi-day" && durationHours >= 48);
  if (!matches) {
    throw new Error(`景点规模 ${scale} 与建议停留时长 ${durationHours} 不一致`);
  }
}

function parseAttractionAudit(value: unknown): AttractionAudit {
  const record = readRecord(value);
  const scale = record.scale;
  if (!isAttractionScale(scale)) {
    throw new Error("景点规模必须是 small、medium、large 或 multi-day");
  }
  const durationHours = readNumber(record.durationHours, "建议停留时长", 0);
  if (durationHours <= 0) throw new Error("建议停留时长必须大于 0");
  assertScaleDuration(scale, durationHours);

  return {
    scale,
    durationHours,
    physical: readScore(record.physical, "体力强度"),
    childFit: readScore(record.childFit, "亲子适宜度"),
    weatherSensitivity: readScore(record.weatherSensitivity, "天气敏感度"),
    timeCost: readScore(record.timeCost, "时间成本"),
    crowding: readScore(record.crowding, "拥挤程度"),
    bestTime: readString(record.bestTime, "最佳游玩时段"),
  };
}

export function parseAttractionAudits(
  value: unknown,
  expectedNames: readonly string[] = [],
): AttractionAudit[] {
  const record = readRecord(value);
  const rawAudits = record.audits;
  if (!Array.isArray(rawAudits)) throw new Error("DeepSeek 景点审核结果缺少 audits 数组");

  const parsed = rawAudits.map((rawAudit) => {
    const auditRecord = readRecord(rawAudit);
    return {
      name: readString(auditRecord.name, "景点名称"),
      audit: parseAttractionAudit(rawAudit),
    };
  });

  const responseNames = new Set<string>();
  for (const entry of parsed) {
    if (responseNames.has(entry.name)) {
      throw new Error(`景点名称必须唯一：${entry.name}`);
    }
    responseNames.add(entry.name);
  }

  if (expectedNames.length === 0) return parsed.map((entry) => entry.audit);

  const expected = new Set<string>();
  for (const name of expectedNames) {
    if (expected.has(name)) throw new Error(`景点名称必须唯一：${name}`);
    expected.add(name);
  }
  if (parsed.length !== expectedNames.length) {
    throw new Error("DeepSeek 景点审核结果数量与输入不一致，不允许额外或缺失记录");
  }
  const byName = new Map(parsed.map((entry) => [entry.name, entry.audit] as const));
  return expectedNames.map((name) => {
    const audit = byName.get(name);
    if (!audit) throw new Error(`DeepSeek 景点审核结果缺少「${name}」`);
    return audit;
  });
}

export async function auditAttractionsWithDeepSeek(
  input: AttractionAuditInput,
  deps: DeepSeekTravelDeps = {},
): Promise<AttractionAudit[]> {
  try {
    const attractions = normalizeAttractionEntries(input);
    if (attractions.length === 0) return [];

    const result = await requestDeepSeekJson(
      "audit",
      "景点审核",
      jsonMessages({
        system:
          "你是严谨的中国旅行景点审核员。按每个地点的实际游览特征判断规模、建议停留时长、体力强度、亲子适宜度、天气敏感度、时间成本和拥挤程度。五项评分使用 0 到 100 的数字。不得把估算写成实时数据。",
        task: "批量审核景点并保持输入顺序",
        schema: {
          audits: [
            {
              name: "必填且必须与输入景点名称完全一致，不能重复或额外增加",
              scale: "small | medium | large | multi-day",
              durationHours:
                "建议停留小时数；small 为 1-2，medium 为 3-5，large 为 6-10，multi-day 不少于 48",
              physical: "0 到 100",
              childFit: "0 到 100",
              weatherSensitivity: "0 到 100",
              timeCost: "0 到 100",
              crowding: "0 到 100",
              bestTime: "推荐游玩时段",
            },
          ],
        },
        payload: {
          destination: input.destination,
          region: input.region,
          startDate: input.startDate,
          days: input.days,
          travelers: input.travelers,
          pace: input.pace,
          interests: input.interests,
          notes: input.notes,
          attractions,
        },
      }),
      deps,
      8_000,
    );

    return parseAttractionAudits(
      result,
      attractions.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    );
  } catch (error) {
    throw asDeepSeekError(error, "audit", "schema_error", "DeepSeek 景点审核结果不符合结构");
  }
}

function normalizeVehicleEnergy(value: unknown): VehicleEnergy {
  if (value === undefined || value === null) return null;
  if (value === "fuel" || value === "electric" || value === "hybrid") return value;
  throw new Error("vehicleEnergy 必须是 fuel、electric、hybrid 或 null");
}

function resolveBudgetMode(input: BudgetEstimateInput): {
  selfDrive: boolean;
  vehicleEnergy: VehicleEnergy;
} {
  const vehicleEnergy = normalizeVehicleEnergy(input.vehicleEnergy);
  const explicitDrive =
    input.selfDrive === true ||
    input.transportMode === "drive" ||
    input.transportPreference === "drive";
  const explicitNonDrive =
    input.selfDrive === false ||
    (input.transportMode !== undefined && input.transportMode !== "drive") ||
    (input.transportPreference !== undefined && input.transportPreference !== "drive");

  if (explicitNonDrive && vehicleEnergy !== null) {
    throw new Error("非自驾行程不得提供 vehicleEnergy");
  }
  return {
    selfDrive: explicitDrive || (!explicitNonDrive && vehicleEnergy !== null),
    vehicleEnergy,
  };
}

function readBudgetRange(value: unknown, label: string): BudgetRange {
  if (!isRecord(value)) throw new Error(`${label}必须使用 min 和 max 区间结构`);
  const record = value;
  if (!("min" in record) || !("max" in record)) {
    throw new Error(`${label}必须使用 min 和 max 区间结构`);
  }
  assertExactKeys(record, ["min", "max"], label);
  const min = readNumber(record.min, `${label}最小值`, 0);
  const max = readNumber(record.max, `${label}最大值`, 0);
  if (max < min) throw new Error(`${label}最大值不能小于最小值`);
  return { min, max };
}

function findBudgetCategories(value: unknown): JsonRecord {
  const root = readRecord(value);
  assertExactKeys(root, ["categories", "roadTrip"], "预算根对象");
  const categories = root.categories;
  if (!isRecord(categories)) throw new Error("DeepSeek 预算结果缺少 categories 对象");
  assertExactKeys(categories, ["transport", "lodging", "food", "tickets", "other"], "预算分类对象");
  return categories;
}

function parseRoadTripDetails(value: unknown): RoadTripBudgetDetails {
  const root = readRecord(value);
  const details = root.roadTrip;
  if (!isRecord(details)) {
    throw new Error("自驾预算必须包含 roadTrip 的能源费、高速费、节假日免费调整和停车费");
  }
  assertExactKeys(details, ["energy", "toll", "holidayFreeAdjustment", "parking"], "自驾预算明细");
  return {
    energy: readBudgetRange(details.energy, "能源费"),
    toll: readBudgetRange(details.toll, "高速费"),
    holidayFreeAdjustment: readBudgetRange(details.holidayFreeAdjustment, "节假日免费调整"),
    parking: readBudgetRange(details.parking, "停车费"),
  };
}

export function parseBudgetEstimate(
  value: unknown,
  totalBudget: number,
  travelers: Travelers,
  options: { selfDrive?: boolean } = {},
): TripBudget {
  if (!Number.isFinite(totalBudget) || totalBudget < 0) {
    throw new Error("totalBudget 必须是非负数字");
  }
  if (
    !Number.isFinite(travelers.adults) ||
    !Number.isFinite(travelers.children) ||
    travelers.adults < 0 ||
    travelers.children < 0
  ) {
    throw new Error("travelers 必须包含非负的成人和儿童人数");
  }

  const categories = findBudgetCategories(value);
  const budget = estimateBudget({
    totalBudget,
    travelers,
    transport: readBudgetRange(categories.transport, "交通预算"),
    lodging: readBudgetRange(categories.lodging, "住宿预算"),
    food: readBudgetRange(categories.food, "餐饮预算"),
    tickets: readBudgetRange(categories.tickets, "门票预算"),
    other: readBudgetRange(categories.other, "其他预算"),
  });

  if (!options.selfDrive) return budget;
  return { ...budget, roadTrip: parseRoadTripDetails(value) };
}

export async function estimateBudgetWithDeepSeek(
  input: BudgetEstimateInput,
  deps: DeepSeekTravelDeps = {},
): Promise<TripBudget> {
  try {
    const mode = resolveBudgetMode(input);
    const rooms = calculateRooms(input.travelers.adults);
    const budgetPolicy = {
      adults: input.travelers.adults,
      children: input.travelers.children,
      rooms,
      childDiscountRule:
        "儿童不增加房间；儿童门票和交通按景区及承运方优惠规则估算，未核实的免费或半价不得默认计入；餐饮可按儿童食量适度下调。",
      roomRule: "adults<=2 时为 1 间；adults>2 时 rooms=ceil(adults/2)；children 不增加房间数。",
    };
    const roadTripSchema = mode.selfDrive
      ? {
          roadTrip: {
            energy: { min: "人民币数字", max: "人民币数字" },
            toll: { min: "人民币数字", max: "人民币数字" },
            holidayFreeAdjustment: { min: "人民币数字", max: "人民币数字" },
            parking: { min: "人民币数字", max: "人民币数字" },
          },
        }
      : {};

    const result = await requestDeepSeekJson(
      "budget",
      "预算估算",
      jsonMessages({
        system:
          "你是中国旅行预算估算员。只返回 categories 的 min/max 人民币区间，不接受纯数字或 amount。必须遵守输入的成人数、儿童数、儿童优惠规则和房间数规则。自驾时必须额外返回 roadTrip 的能源费、高速费、节假日免费调整和停车费；非自驾不得返回 roadTrip 或这些自驾费用字段。所有费用均为估算。",
        task: "估算旅行预算",
        schema: {
          categories: {
            transport: { min: "人民币数字", max: "人民币数字" },
            lodging: { min: "人民币数字", max: "人民币数字" },
            food: { min: "人民币数字", max: "人民币数字" },
            tickets: { min: "人民币数字", max: "人民币数字" },
            other: { min: "人民币数字", max: "人民币数字" },
          },
          ...roadTripSchema,
        },
        payload: {
          ...input,
          vehicleEnergy: mode.vehicleEnergy,
          selfDrive: mode.selfDrive,
          budgetPolicy,
        },
      }),
      deps,
      3_000,
    );

    return parseBudgetEstimate(result, input.totalBudget, input.travelers, {
      selfDrive: mode.selfDrive,
    });
  } catch (error) {
    throw asDeepSeekError(error, "budget", "schema_error", "DeepSeek 预算结果不符合结构");
  }
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}必须是非空字符串数组`);
  }
  return value.map((item, index) => readString(item, `${label}[${index}]`));
}

export function parseDaySummary(value: unknown): DaySummary {
  const record = readRecord(value);
  assertExactKeys(record, ["purpose", "highlights", "cautions"], "每日总结");
  return {
    purpose: readString(record.purpose, "purpose"),
    highlights: readStringArray(record.highlights, "highlights"),
    cautions: readStringArray(record.cautions, "cautions"),
  };
}

export async function buildDaySummaryWithDeepSeek(
  input: DaySummaryInput,
  deps: DeepSeekTravelDeps = {},
): Promise<DaySummary> {
  try {
    const result = await requestDeepSeekJson(
      "daily-summary",
      "每日总结",
      jsonMessages({
        system:
          "你是中文旅行路书编辑。只返回 purpose、highlights、cautions 三个字段。今日目的写一段完整总结；核心重点按 1、2、3 写成字符串数组；注意事项写 2 到 5 条并优先说明安全、天气、拥堵和体力问题。不得编造实时开放信息。",
        task: "生成每日总结",
        schema: {
          purpose: "今日目的完整段落",
          highlights: ["核心重点字符串，包含景点介绍、游览重点和历史背景"],
          cautions: ["按重要性排序的注意事项字符串"],
        },
        payload: input,
      }),
      deps,
      4_000,
    );

    return parseDaySummary(result);
  } catch (error) {
    throw asDeepSeekError(error, "daily-summary", "schema_error", "DeepSeek 每日总结不符合结构");
  }
}
export function parseTripClosing(value: unknown): TripClosing {
  const record = readRecord(value);
  if ("quote" in record || "source" in record) {
    throw new Error("结束语只能返回 quoteId，不得返回模型自编 quote 或 source");
  }
  const message = readString(record.message, "message");
  const quoteId = readOptionalString(record.quoteId);
  const verified = quoteId ? verifiedQuoteById.get(quoteId) : undefined;
  if (!verified) return { quote: null, source: null, message };
  return { quote: verified.quote, source: verified.source, message };
}

function cleanStrings(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(
      values.flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : [])),
    ),
  ];
}

function journeyLabel(days: number | undefined): string {
  return typeof days === "number" && Number.isFinite(days) && days > 0
    ? `这趟${Math.round(days)}天旅程`
    : "这段旅程";
}

function buildRouteSummary(input: TripClosingInput): string {
  const explicitNodes = cleanStrings(input.routeNodes ?? []);
  const fallbackNodes = cleanStrings([input.origin, ...(input.waypoints ?? []), input.destination]);
  const nodes = explicitNodes.length >= 2 ? explicitNodes : fallbackNodes;
  const journey = journeyLabel(input.days);
  const returnMode = input.returnMode ?? null;

  if (returnMode === "fast") {
    return nodes.length > 0
      ? `${journey}沿${nodes.join(" → ")}展开，采用快速返程完成往返。`
      : `${journey}采用快速返程完成往返，在目的地停留后回到起点。`;
  }

  if (returnMode === "scenic") {
    return nodes.length > 0
      ? `${journey}沿${nodes.join(" → ")}展开，返程不走回头路，继续串联沿途风景。`
      : `${journey}返程不走回头路，继续串联沿途风景。`;
  }

  if (nodes.length > 0) {
    return `${journey}从${nodes[0]}到${nodes.at(-1)}，是一段从出发到目的地的一段完整探索。`;
  }

  const travelSummary = input.travelSummary?.trim();
  return travelSummary ? travelSummary : `${journey}是一段从出发到目的地的一段完整探索。`;
}

function buildTravelEvaluation(input: TripClosingInput, modelMessage?: string): string {
  if (modelMessage) return modelMessage;

  const highlights = cleanStrings(input.highlights ?? []);
  if (highlights.length > 0) {
    return `这趟旅程把${highlights.slice(0, 3).join("、")}串成连续体验，让风景不只停留在抵达，也成为观察地方与生活的窗口。`;
  }

  const interests = cleanStrings(input.interests ?? []);
  if (interests.length > 0) {
    return `一路围绕${interests.slice(0, 3).join("、")}展开，所见所感让地图上的名字有了更具体的温度。`;
  }

  return "一路所见所感让地图上的名字变成真实的风物与人情，也让行程有了可回想的层次。";
}

function buildEncouragement(input: TripClosingInput): string {
  const destination = input.destination?.trim();
  const place = destination ? `${destination}的山水与街巷` : "沿途的山水与街巷";
  const pace =
    input.pace === "relaxed"
      ? "从容节奏"
      : input.pace === "deep"
        ? "深入探索的节奏"
        : "张弛有度的节奏";
  const interest = cleanStrings(input.interests ?? [])[0];
  const interestCopy = interest ? `，也把对${interest}的好奇带向下一程` : "";
  return `愿${place}继续提醒你放慢脚步、认真观看${interestCopy}，带着${pace}走向下一次出发。`;
}

function buildClosingWish(input: TripClosingInput): string {
  const destination = input.destination?.trim();
  const memory = destination ? `${destination}的记忆` : "这段旅程的记忆";
  return `愿${memory}不只在相册里，而成为理解世界、尊重相遇的坐标。${MODERN_CLOSING}`;
}

function composeTripClosingMessage(input: TripClosingInput, modelMessage?: string): string {
  const message = `路线总结：${buildRouteSummary(input)} 旅行评价：${buildTravelEvaluation(input, modelMessage)} 继续出发：${buildEncouragement(input)} 寄语：${buildClosingWish(input)}`;
  return (input.returnMode ?? null) === null ? message.replaceAll("返程", "后续") : message;
}

function readModelEvaluation(value: unknown): string | undefined {
  const record = isRecord(value) ? value : {};
  if ("quote" in record || "source" in record) return undefined;
  const quoteId = readOptionalString(record.quoteId);
  if (quoteId && !verifiedQuoteById.has(quoteId)) return undefined;
  return readOptionalString(record.message);
}

export async function buildTripClosingWithDeepSeek(
  input: TripClosingInput,
  deps: DeepSeekTravelDeps = {},
): Promise<TripClosing> {
  let result: JsonRecord = {};
  try {
    result = await requestDeepSeekJson(
      "closing",
      "旅行结束语",
      jsonMessages({
        system:
          "你是中文旅行路书编辑。只返回 quoteId 和 message。quoteId 只能从输入 allowedQuotes 中选择 id；没有合适引用时必须返回 null。禁止返回 quote 原文、source 或自行编造引用。message 只写旅行评价，路线总结、继续出发的鼓励和现代寄语由服务端组合。",
        task: "生成旅行回望与结束语",
        schema: {
          quoteId: "allowedQuotes 中的 id 或 null",
          message: "旅行评价正文，不要重复路线总结、鼓励或寄语",
        },
        payload: {
          ...input,
          allowedQuotes: verifiedQuotes.map((entry) => ({
            id: entry.id,
            quote: entry.quote,
            source: entry.source,
          })),
        },
      }),
      deps,
      3_000,
    );
    const parsed = parseTripClosing(result);
    return { ...parsed, message: composeTripClosingMessage(input, readModelEvaluation(result)) };
  } catch {
    return {
      quote: null,
      source: null,
      message: composeTripClosingMessage(input, readModelEvaluation(result)),
    };
  }
}
