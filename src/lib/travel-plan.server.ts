import { estimateBudget } from "./travel-plan.ts";
import type {
  AttractionAudit,
  AttractionScale,
  CostEstimateInput,
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

export type DeepSeekTravelDeps = {
  /** 仅在服务端传入或由 DEEPSEEK_API_KEY 提供。 */
  apiKey?: string;
  deepseekKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
};

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
  vehicleEnergy?: string;
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

async function requestDeepSeekJson(
  context: string,
  messages: DeepSeekMessage[],
  deps: DeepSeekTravelDeps,
  defaultMaxTokens: number,
): Promise<JsonRecord> {
  const config = resolveDeepSeekConfig(deps);
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    response_format: { type: "json_object" },
    max_tokens: config.maxTokens ?? defaultMaxTokens,
    temperature: config.temperature ?? 0.2,
  };
  const response = await config.fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `DeepSeek ${context}失败（${response.status}）${message ? `：${message.slice(0, 180)}` : ""}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`DeepSeek ${context}未返回有效 JSON`);
  }

  const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  const message =
    isRecord(firstChoice) && isRecord(firstChoice.message) ? firstChoice.message : null;
  const content = message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`DeepSeek ${context}未返回内容`);
  }
  return parseJsonObject(content);
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
  return raw.map((entry) => {
    if (typeof entry === "string") return readString(entry, "景点名称");
    const record = readRecord(entry);
    return { ...record, name: readString(record.name, "景点名称") } as AttractionAuditEntry;
  });
}

function parseAttractionAudit(value: unknown): AttractionAudit {
  const record = readRecord(value);
  const scale = record.scale;
  if (!isAttractionScale(scale)) {
    throw new Error("景点规模必须是 small、medium、large 或 multi-day");
  }

  return {
    scale,
    durationHours: readNumber(record.durationHours, "建议停留时长", Number.EPSILON),
    physical: readScore(record.physical, "体力强度"),
    childFit: readScore(record.childFit, "亲子适宜度"),
    weatherSensitivity: readScore(record.weatherSensitivity, "天气敏感度"),
    timeCost: readScore(record.timeCost, "时间成本"),
    crowding: readScore(record.crowding, "拥挤程度"),
    bestTime: readString(record.bestTime, "最佳游玩时段"),
  };
}

function matchAuditsToNames(
  rawAudits: unknown[],
  expectedNames: readonly string[],
): AttractionAudit[] {
  const parsed = rawAudits.map((rawAudit) => {
    const record = readRecord(rawAudit);
    const modelName = readOptionalString(record.name);
    return {
      name: modelName,
      audit: parseAttractionAudit(rawAudit),
    };
  });

  if (expectedNames.length === 0) return parsed.map((entry) => entry.audit);

  const allNamed = parsed.every((entry) => Boolean(entry.name));
  if (allNamed) {
    const queues = new Map<string, AttractionAudit[]>();
    for (const entry of parsed) {
      const key = entry.name as string;
      queues.set(key, [...(queues.get(key) ?? []), entry.audit]);
    }
    return expectedNames.map((name) => {
      const queue = queues.get(name);
      const audit = queue?.shift();
      if (!audit) throw new Error(`DeepSeek 景点审核结果缺少「${name}」`);
      return audit;
    });
  }

  if (parsed.length !== expectedNames.length) {
    throw new Error("DeepSeek 景点审核结果数量与输入不一致");
  }
  return parsed.map((entry) => entry.audit);
}

export function parseAttractionAudits(
  value: unknown,
  expectedNames: readonly string[] = [],
): AttractionAudit[] {
  const record = readRecord(value);
  const rawAudits = record.audits ?? record.attractions;
  if (!Array.isArray(rawAudits)) throw new Error("DeepSeek 景点审核结果缺少 audits 数组");
  return matchAuditsToNames(rawAudits, expectedNames);
}

export async function auditAttractionsWithDeepSeek(
  input: AttractionAuditInput,
  deps: DeepSeekTravelDeps = {},
): Promise<AttractionAudit[]> {
  const attractions = normalizeAttractionEntries(input);
  if (attractions.length === 0) return [];

  const result = await requestDeepSeekJson(
    "景点审核",
    jsonMessages({
      system:
        "你是严谨的中国旅行景点审核员。按每个地点的实际游览特征判断规模、建议停留时长、体力强度、亲子适宜度、天气敏感度、时间成本和拥挤程度。五项评分使用 0 到 100 的数字。不得把估算写成实时数据。",
      task: "批量审核景点并保持输入顺序",
      schema: {
        audits: [
          {
            name: "必须与输入景点名称完全一致",
            scale: "small | medium | large | multi-day",
            durationHours: "建议停留小时数，数字",
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
}

function readCategoryAmount(value: unknown, label: string): number {
  if (typeof value === "number") return readNumber(value, label, 0) as number;
  const record = readRecord(value);
  if (record.amount !== undefined) return readNumber(record.amount, label, 0);

  const minimum = record.min ?? record.minimum;
  const maximum = record.max ?? record.maximum;
  if (minimum !== undefined || maximum !== undefined) {
    const min = readNumber(minimum, `${label}最小值`, 0);
    const max = readNumber(maximum, `${label}最大值`, 0);
    if (max < min) throw new Error(`${label}最大值不能小于最小值`);
    return (min + max) / 2;
  }

  throw new Error(`${label}缺少金额或估算区间`);
}

function findBudgetCategories(value: unknown): JsonRecord {
  const root = readRecord(value);
  const candidates = [root.categories, root.budget, root.estimates, root];
  const categoryKeys = ["transport", "lodging", "food", "tickets", "other"];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (categoryKeys.some((key) => candidate[key] !== undefined)) return candidate;
    const nested = candidate.categories;
    if (isRecord(nested)) return nested;
  }

  throw new Error("DeepSeek 预算结果缺少分类金额");
}

export function parseBudgetEstimate(
  value: unknown,
  totalBudget: number,
  travelers: Travelers,
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
  const transport = readCategoryAmount(categories.transport, "交通预算");
  const lodging = readCategoryAmount(categories.lodging, "住宿预算");
  const food = readCategoryAmount(categories.food, "餐饮预算");
  const tickets = readCategoryAmount(categories.tickets, "门票预算");
  const other = readCategoryAmount(categories.other, "其他预算");

  return estimateBudget({
    totalBudget,
    travelers,
    transport,
    lodging,
    food,
    tickets,
    other,
  });
}

export async function estimateBudgetWithDeepSeek(
  input: BudgetEstimateInput,
  deps: DeepSeekTravelDeps = {},
): Promise<TripBudget> {
  const result = await requestDeepSeekJson(
    "预算估算",
    jsonMessages({
      system:
        "你是中国旅行预算估算员。只给出全团费用估算区间和分类金额，不查询实时票价。儿童默认与成人同住，交通、住宿、餐饮、门票和其他必须分别给出 min、max 人民币金额。所有费用均为估算。",
      task: "估算旅行预算",
      schema: {
        categories: {
          transport: { min: "人民币数字", max: "人民币数字" },
          lodging: { min: "人民币数字", max: "人民币数字" },
          food: { min: "人民币数字", max: "人民币数字" },
          tickets: { min: "人民币数字", max: "人民币数字" },
          other: { min: "人民币数字", max: "人民币数字" },
        },
      },
      payload: input,
    }),
    deps,
    3_000,
  );

  return parseBudgetEstimate(result, input.totalBudget, input.travelers);
}

function readSummaryItems(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}必须是非空数组`);
  }

  return value.map((item, index) => {
    if (typeof item === "string") return readString(item, `${label}[${index}]`);
    const record = readRecord(item);
    const direct = readOptionalString(record.text ?? record.content ?? record.description);
    if (direct) return direct;
    const title = readOptionalString(record.title);
    const detail = readOptionalString(record.detail);
    if (title && detail) return `${title}：${detail}`;
    throw new Error(`${label}[${index}]必须是文字或带 text/content/title 的对象`);
  });
}

function unwrapPayload(value: unknown, keys: string[]): JsonRecord {
  const root = readRecord(value);
  for (const key of keys) {
    if (isRecord(root[key])) return root[key] as JsonRecord;
  }
  return root;
}

export function parseDaySummary(value: unknown): DaySummary {
  const record = unwrapPayload(value, ["daySummary", "summary", "day"]);
  const purpose = readString(record.purpose ?? record.todayPurpose ?? record.objective, "今日目的");
  const highlights = readSummaryItems(
    record.highlights ?? record.keyPoints ?? record.coreHighlights,
    "核心重点",
  );
  const cautions = readSummaryItems(record.cautions ?? record.notices, "注意事项");
  return { purpose, highlights, cautions };
}

export async function buildDaySummaryWithDeepSeek(
  input: DaySummaryInput,
  deps: DeepSeekTravelDeps = {},
): Promise<DaySummary> {
  const result = await requestDeepSeekJson(
    "每日总结",
    jsonMessages({
      system:
        "你是中文旅行路书编辑。今日目的写一段完整总结；核心重点按 1、2、3 写成字符串数组；注意事项写 2 到 5 条并优先说明安全、天气、拥堵和体力问题。不得编造实时开放信息。",
      task: "生成每日总结",
      schema: {
        purpose: "今日目的完整段落",
        highlights: ["核心重点，包含景点介绍、游览重点和历史背景"],
        cautions: ["按重要性排序的注意事项"],
      },
      payload: input,
    }),
    deps,
    4_000,
  );

  return parseDaySummary(result);
}

function isVerifiableSource(source: string): boolean {
  const normalized = source.trim();
  if (normalized.length < 2) return false;
  return !/^(未知|无|暂无|不适用|待核验|AI|模型|网络来源)$/i.test(normalized);
}

function composeClosingMessage(record: JsonRecord): string | undefined {
  const direct = readOptionalString(record.message);
  const fragments = [record.summary, record.evaluation, record.encouragement]
    .map((value) => readOptionalString(value))
    .filter((value): value is string => Boolean(value));
  const combined = [direct, ...fragments].filter((value): value is string => Boolean(value));
  return combined.length > 0 ? combined.join(" ") : undefined;
}

export function parseTripClosing(value: unknown): TripClosing {
  const record = readRecord(value);
  const quote = readOptionalString(record.quote) ?? null;
  const source = readOptionalString(record.source) ?? null;
  const message = composeClosingMessage(record);
  if (!message) throw new Error("结束语缺少 message");

  if (quote && (!source || !isVerifiableSource(source))) {
    throw new Error("历史引用必须提供可核验来源");
  }

  if (!quote) return { quote: null, source: null, message };
  return { quote, source, message };
}

function modernClosingMessage(value: unknown, input: TripClosingInput): string {
  const record = isRecord(value) ? value : {};
  const modelMessage = composeClosingMessage(record);
  const destination = input.destination?.trim();
  const routeSummary = destination
    ? `这段${input.days ? `${input.days}天` : ""}旅程从${input.origin?.trim() || "出发地"}走向${destination}，在行走中感受山河辽阔与人文温度。`
    : "这段旅程在行走中感受山河辽阔与人文温度。";
  const evaluation = modelMessage ? `旅行评价：${modelMessage}` : "旅行评价：一路所见，皆有回响。";
  return `${routeSummary}${evaluation} 愿你把沿途风景化成继续出发的力量。${MODERN_CLOSING}`;
}

export async function buildTripClosingWithDeepSeek(
  input: TripClosingInput,
  deps: DeepSeekTravelDeps = {},
): Promise<TripClosing> {
  const result = await requestDeepSeekJson(
    "旅行结束语",
    jsonMessages({
      system:
        "你是中文旅行路书编辑。结束语必须包含路线总结、旅行评价、继续出发的鼓励和寄语。历史引用只有在 quote 非空且 source 是真实可核验的篇名或来源时才能填写；没有可靠来源时 quote 和 source 必须为 null，并改用现代语言寄语。",
      task: "生成旅行回望与结束语",
      schema: {
        quote: "可核验原文，无法核验时为 null",
        source: "篇名或可核验来源，quote 为 null 时为 null",
        message: "路线总结、旅行评价、鼓励和现代寄语",
      },
      payload: input,
    }),
    deps,
    3_000,
  );

  try {
    return parseTripClosing(result);
  } catch {
    return { quote: null, source: null, message: modernClosingMessage(result, input) };
  }
}
