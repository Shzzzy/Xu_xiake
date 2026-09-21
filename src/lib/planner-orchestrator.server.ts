import {
  buildSkeletonInstruction,
  buildSkeletonRepairInstruction,
  enforceTransportPriceFloors,
  parseAttractionSelection,
  parsePlannerSkeleton,
  type AttractionSelection,
  type PlannerSkeleton,
  type PlannerSkeletonDay,
  type PlannerSkeletonNode,
  type SkeletonInstructionInput,
} from "./planner-skeleton.ts";
import { buildDayTimeline } from "./day-timeline.ts";
import {
  calculateBudget,
  type BudgetPlan,
  type PriceReference as BudgetPriceReference,
} from "./budget-planner.ts";
import type { PlannerDestinationCandidate } from "./planner-context.server.ts";
import type { TransportPlanLeg } from "./transport-planner.server.ts";
import { validateSkeleton, type PlanViolation } from "./plan-validator.ts";
import {
  buildDayCopyInstruction,
  parsePlannerDayCopy,
  type PlannerDayCopy,
} from "./planner-day-copy.ts";
import { buildTripClosingWithDeepSeek, type TripClosingInput } from "./travel-plan.server.ts";
import type { TripClosing } from "./travel-plan.ts";
import type { Pace, WeatherDay } from "./planner.ts";
import type {
  RoutePlan,
  TransportMode,
  TransportPriceReference,
  TravelStyle,
} from "./route-planner.ts";

import {
  PLANNING_STAGES,
  canStartStage,
  createPlanningRun,
  setStageStatus,
  type PlanningRun,
  type PlanningStage,
} from "./planning-run.ts";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 60_000;

// 骨架、每日文案、结尾的 token 上限，与设计文档 §9 保持一致。
const SKELETON_MAX_TOKENS = 4000;
const DAY_COPY_MAX_TOKENS = 1200;
// 结尾调用 ≤ 800 tokens，与设计文档 §9 一致。
const CLOSING_MAX_TOKENS = 800;

// 骨架调用预算：正常 1 次 + 技术重试 1 次 + 内容重排 1 次，共用额度。
const MAX_SKELETON_ATTEMPTS = 3;

// 结尾调用的确定性中文兜底，避免结尾失败时整份路书缺页。
const FALLBACK_CLOSING_MESSAGE =
  "愿你把这段旅程的风景与记忆带回家，带着认真行走、认真观看的心，走向下一次出发。";

export type ButlerDeps = {
  /** 契约测试注入的假响应；缺省时使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  apiKey?: string;
  /** 兼容旧命名的 key，优先级低于 apiKey。 */
  deepseekKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** 保留字段：调用方可能传入 Tavily key；本编排器不直接调用 Tavily。 */
  tavilyKey?: string;
  /** 测试与观测使用：阶段真正启动时回调。 */
  onStage?: (stage: PlanningStage, run: PlanningRun) => void;
};

export type ButlerPlanInput = {
  origin: string;
  destination: string;
  region?: string;
  startDate: string;
  days: number;
  startTime: string;
  endTime: string;
  pace: Pace;
  totalBudget: number;
  travelers: { adults: number; children: number };
  interests: string[];
  transport: TransportMode | null;
  style?: TravelStyle;
  route: RoutePlan;
  weather: WeatherDay[];
  /** 高德候选必须保留真实 id、坐标和来源，selection 只能引用这里的 candidateId。 */
  candidates: PlannerDestinationCandidate[];
  /** 由 prepareRouteTransportPlan 产出，后续时间轴与预算只读这一份。 */
  transportLegs: TransportPlanLeg[];
  /** Tavily 摘要与本地最低价组成的交通价格参考。 */
  transportPriceReferences?: TransportPriceReference[];
};

export type ButlerPlanResult =
  | {
      status: "ok";
      skeleton: PlannerSkeleton;
      violations: PlanViolation[];
      dayCopy: PlannerDayCopy[];
      /** 文案生成失败的天序号，供 Task 8 渲染「本页分析未能生成」留痕。 */
      failedDays: number[];
      closing: TripClosing;
      attempts: number;
      candidates: PlannerDestinationCandidate[];
      transportLegs: TransportPlanLeg[];
      budget: BudgetPlan;
    }
  | { status: "needs_configuration"; missing: string[] }
  | { status: "failed"; stage: PlanningStage; reason: string }
  | { status: "fallback"; reason: string };

type SkeletonOutcome =
  | { kind: "ok"; skeleton: PlannerSkeleton; violations: PlanViolation[]; attempts: number }
  | { kind: "fallback"; reason: string };

function resolveApiKey(deps: ButlerDeps): string {
  return (
    deps.apiKey?.trim() ||
    deps.deepseekKey?.trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    ""
  ).trim();
}

// 统一的 DeepSeek Chat Completions 调用，供骨架与每日文案复用。
async function requestChatCompletion(
  instruction: string,
  deps: ButlerDeps,
  apiKey: string,
  maxTokens: number,
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = (deps.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const model = (deps.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: instruction }],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `DeepSeek 请求失败（${response.status}）${detail ? `：${detail.slice(0, 180)}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 未返回行程内容");
  return content;
}

function buildSkeletonInstructionInput(input: ButlerPlanInput): SkeletonInstructionInput {
  return {
    brief: {
      origin: input.origin,
      destination: input.destination,
      region: input.region,
      startDate: input.startDate,
      days: input.days,
      startTime: input.startTime,
      endTime: input.endTime,
      pace: input.pace,
      totalBudget: input.totalBudget,
      travelers: input.travelers,
      interests: input.interests,
      transport: input.transport,
      style: input.style,
    },
    route: input.route,
    weather: input.weather,
    candidates: input.candidates,
    transportPriceReferences: input.transportPriceReferences ?? [],
  };
}

// 解析/结构失败时的更严格指令：在上一条指令上追加格式硬约束。
function buildStricterSkeletonInstruction(previousInstruction: string): string {
  return [
    previousInstruction,
    "",
    "上一版输出未通过 JSON 结构校验，请严格修正后重新输出：",
    "- 只输出一个 JSON 对象，不要代码块围栏、不要解释文字、不要前后缀",
    "- 所有必填字段与类型必须和 requiredSchema 完全一致",
    "- 时间是 HH:MM 字符串，费用是非负数字，radar 五项都是 0–100 的数字",
  ].join("\n");
}

function buildValidationBrief(input: ButlerPlanInput): {
  days: number;
  startTime: string;
  endTime: string;
  totalBudget: number;
  pace: Pace;
  transport: TransportMode | null;
  style?: TravelStyle;
  waypoints: string[];
  destination: string;
} {
  return {
    days: input.days,
    startTime: input.startTime,
    endTime: input.endTime,
    totalBudget: input.totalBudget,
    pace: input.pace,
    transport: input.transport,
    style: input.style,
    waypoints: input.route.waypoints,
    destination: input.destination,
  };
}

// 重排请求必须回喂「违规指令 + 上一版骨架 + 与首次调用相同的输入」，
// 让模型能执行「只改违规处、其余保持原样」，而不是凭空重写一份。
function buildSkeletonRepairPrompt(
  input: SkeletonInstructionInput,
  skeleton: PlannerSkeleton,
  violations: PlanViolation[],
): string {
  return [
    buildSkeletonRepairInstruction(violations),
    "",
    "上一版骨架（只改被判定违规处，其余保持原样）：",
    JSON.stringify(skeleton, null, 2),
    "",
    "同一份输入（brief / route / weather / candidates）：",
    buildSkeletonInstruction(input),
  ].join("\n");
}

async function obtainSkeleton(
  input: ButlerPlanInput,
  deps: ButlerDeps,
  apiKey: string,
): Promise<SkeletonOutcome> {
  const instructionInput = buildSkeletonInstructionInput(input);
  let nextInstruction = buildSkeletonInstruction(instructionInput);
  let attempts = 0;
  let repaired = false;
  let sawNetworkFailure = false;
  let sawParseFailure = false;

  while (attempts < MAX_SKELETON_ATTEMPTS) {
    attempts += 1;
    const instruction = nextInstruction;

    let content: string;
    try {
      content = await requestChatCompletion(instruction, deps, apiKey, SKELETON_MAX_TOKENS);
    } catch {
      // 网络/超时：用同一条指令自动重试一次。
      if (sawNetworkFailure) {
        return { kind: "fallback", reason: "骨架请求连续失败，已退回本地兜底行程" };
      }
      sawNetworkFailure = true;
      nextInstruction = instruction;
      continue;
    }
    sawNetworkFailure = false;

    let skeleton: PlannerSkeleton;
    try {
      skeleton = enforceTransportPriceFloors(
        parsePlannerSkeleton(content),
        input.transportPriceReferences,
      );
    } catch {
      // 解析/结构失败：换更严格的格式指令重试一次。
      if (sawParseFailure) {
        return { kind: "fallback", reason: "骨架格式连续非法，已退回本地兜底行程" };
      }
      sawParseFailure = true;
      nextInstruction = buildStricterSkeletonInstruction(instruction);
      continue;
    }
    sawParseFailure = false;

    const violations = validateSkeleton({
      skeleton,
      brief: buildValidationBrief(input),
      candidates: input.candidates.map((candidate) => candidate.name),
    });

    if (violations.length === 0) {
      return { kind: "ok", skeleton, violations, attempts };
    }

    // 内容违规：只允许一次带清单重排。
    if (repaired) {
      // 重排后仍不合规：交付带提醒版本，attempts 报告真实调用次数。
      return { kind: "ok", skeleton, violations, attempts };
    }
    repaired = true;
    // 重排请求回喂违规清单 + 上一版骨架 + 同一份输入，见 buildSkeletonRepairPrompt。
    nextInstruction = buildSkeletonRepairPrompt(instructionInput, skeleton, violations);
  }

  return { kind: "fallback", reason: "骨架尝试次数已用尽，已退回本地兜底行程" };
}

function buildDayCopyInstructionForDay(day: PlannerSkeletonDay): string {
  return buildDayCopyInstruction({
    day: day.day,
    theme: day.theme,
    nodes: day.nodes.map((node) => ({ name: node.name, type: node.type })),
  });
}

function validateDayCopyForSchedule(copy: PlannerDayCopy, day: PlannerSkeletonDay): void {
  if (copy.day !== day.day) {
    throw new Error(`每日文案 day ${copy.day} 与请求第 ${day.day} 天不一致`);
  }
  if (!copy.purpose.trim()) {
    throw new Error(`第 ${day.day} 天缺少今日目的`);
  }
  for (const text of [...copy.highlights, ...copy.cautions, copy.purpose]) {
    if (/https?:\/\/|<[^>]+>/i.test(text)) {
      throw new Error(`第 ${day.day} 天文案包含 URL 或 HTML`);
    }
  }
}

function buildClosingInput(input: ButlerPlanInput): TripClosingInput {
  return {
    origin: input.origin,
    destination: input.destination,
    waypoints: input.route.waypoints,
    routeNodes: [input.origin, ...input.route.waypoints, input.destination],
    days: input.days,
    returnMode: input.route.returnMode ?? null,
    pace: input.pace,
    interests: input.interests,
    highlights: input.candidates.map((candidate) => candidate.name),
  };
}

const SELECTION_MAX_TOKENS = 1800;
const DEFAULT_LODGING_PER_NIGHT = 500;
const DEFAULT_FOOD_PER_PERSON_PER_DAY = 220;
const DEFAULT_TICKET_AMOUNT = 80;

const TRANSPORT_LABELS: Record<TransportPlanLeg["mode"], string> = {
  flight: "飞机",
  train: "高铁 / 火车",
  drive: "自驾",
  bus: "大巴",
  ship: "轮渡",
};

type DeterministicState = {
  candidates: PlannerDestinationCandidate[];
  transportLegs: TransportPlanLeg[];
  transportByDay: Map<number, TransportPlanLeg[]>;
  selection: AttractionSelection[];
  skeleton: PlannerSkeleton | null;
  budget: BudgetPlan | null;
  budgetPriceReferences: BudgetPriceReference[];
  dayCopy: PlannerDayCopy[];
  failedDays: number[];
  closing: TripClosing | null;
  selectionRepairReason: string | null;
  modelAttempts: number;
};

function headcount(travelers: { adults: number; children: number }): number {
  return Math.max(1, Math.round(travelers.adults + travelers.children));
}

function parseClockMinutes(value: string): number | null {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!matched) return null;
  return Number(matched[1]) * 60 + Number(matched[2]);
}

function mapTransportLegsToDays(
  route: RoutePlan,
  days: number,
  transportLegs: TransportPlanLeg[],
): Map<number, TransportPlanLeg[]> {
  const result = new Map<number, TransportPlanLeg[]>();
  const routeLegs = route.legs;
  const outbound = routeLegs.filter((leg) => leg.kind === "outbound");
  const returning = routeLegs.filter((leg) => leg.kind === "return");
  const add = (day: number, leg: RoutePlan["legs"][number]) => {
    const planLeg = transportLegs.find((candidate) => candidate.id === leg.id);
    if (!planLeg) return;
    const bucket = result.get(day) ?? [];
    bucket.push(planLeg);
    result.set(day, bucket);
  };

  // 去程按路线顺序从第 1 天开始；返程固定落在最后一天，避免回程被排到中段。
  outbound.forEach((leg, index) => add(Math.min(days, index + 1), leg));
  returning.forEach((leg, index) => add(Math.max(1, days - returning.length + index + 1), leg));
  return result;
}

/**
 * route 只接受已由 prepareRouteTransportPlan 归一化的 TransportPlanLeg[]。
 * 这里不重新猜交通方式，也不允许 generic economy/balanced/speed 穿透。
 */
function validateTransportPlan(input: ButlerPlanInput): TransportPlanLeg[] {
  if (input.transportLegs.length === 0) {
    throw new Error("缺少确定性交通计划，禁止进入时间轴与预算");
  }
  if (input.transportLegs.length !== input.route.legs.length) {
    throw new Error("交通 leg 数量与路线不一致");
  }

  const byId = new Map(input.transportLegs.map((leg) => [leg.id, leg]));
  return input.route.legs.map((routeLeg) => {
    const planLeg = byId.get(routeLeg.id);
    if (!planLeg) throw new Error(`交通计划缺少 leg ${routeLeg.id}`);
    if (planLeg.mode !== routeLeg.transport) {
      throw new Error(`交通 leg ${routeLeg.id} 未归一化：${routeLeg.transport} / ${planLeg.mode}`);
    }
    if (planLeg.distanceKm <= 0 || planLeg.doorToDoorMinutes <= 0) {
      throw new Error(`交通 leg ${routeLeg.id} 缺少有效距离或门到门时长`);
    }
    if (planLeg.minimumPerPersonCost <= 0) {
      throw new Error(`交通 leg ${routeLeg.id} 缺少有效单人最低价`);
    }
    return planLeg;
  });
}

function buildSelectionInstruction(
  input: ButlerPlanInput,
  transportByDay: Map<number, TransportPlanLeg[]>,
  repairReason?: string | null,
): string {
  const nonMovementDays = Array.from({ length: input.days }, (_, index) => index + 1).filter(
    (day) => (transportByDay.get(day)?.length ?? 0) === 0,
  );
  const payload = {
    task: "景点选择",
    brief: {
      origin: input.origin,
      destination: input.destination,
      region: input.region,
      days: input.days,
      pace: input.pace,
      style: input.style ?? "direct",
      interests: input.interests,
      travelers: input.travelers,
    },
    transport: [...transportByDay.entries()].map(([day, legs]) => ({
      day,
      legs: legs.map((leg) => ({
        id: leg.id,
        from: leg.from,
        to: leg.to,
        mode: leg.mode,
        distanceKm: leg.distanceKm,
        doorToDoorMinutes: leg.doorToDoorMinutes,
      })),
    })),
    nonMovementDays,
    candidates: input.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      summary: candidate.summary,
      areaKey: candidate.areaKey,
    })),
  };

  return [
    repairReason
      ? `上一版景点选择未通过校验：${repairReason}。请只修正以下问题后重新输出。`
      : "请完成景点选择。",
    "你是旅行管家，只能在候选列表内选择景点并给出游览顺序；不得修改交通、价格、人数或每日时间窗。",
    "每个非移动日必须至少选择一个候选景点；移动日可按剩余时间选择，也可以不选。",
    "只输出严格 JSON 对象：{ selections: [...] }，每个 selection 只能包含 day、candidateId、sequence、stayMinutes、reason。",
    "candidateId 必须逐字来自 candidates.id，不得输出名称代替 ID，不得输出 URL 或价格。",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function validateSelectionCoverage(
  input: ButlerPlanInput,
  selection: AttractionSelection[],
  transportByDay: Map<number, TransportPlanLeg[]>,
): void {
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
  for (const item of selection) {
    if (!candidateIds.has(item.candidateId)) {
      throw new Error(`景点选择包含候选集合之外的 candidateId：${item.candidateId}`);
    }
    if (item.day < 1 || item.day > input.days) {
      throw new Error(`景点选择 day ${item.day} 超出本次行程范围`);
    }
  }

  for (let day = 1; day <= input.days; day += 1) {
    if ((transportByDay.get(day)?.length ?? 0) > 0) continue;
    if (!selection.some((item) => item.day === day)) {
      throw new Error(`第 ${day} 天是非移动日，但没有选择任何候选景点`);
    }
  }
}

function buildDayRadar(pace: Pace): PlannerSkeletonDay["radar"] {
  const base = pace === "relaxed" ? 38 : pace === "deep" ? 68 : 52;
  return {
    physical: base,
    childFit: Math.max(20, 80 - base / 2),
    weatherSensitivity: 58,
    timeCost: base,
    crowding: 55,
  };
}

function validateDeterministicSkeleton(
  skeleton: PlannerSkeleton,
  input: ButlerPlanInput,
  transportByDay: Map<number, TransportPlanLeg[]>,
): void {
  const start = parseClockMinutes(input.startTime);
  const end = parseClockMinutes(input.endTime);
  if (start === null || end === null || end <= start) {
    throw new Error("每日时间窗非法，无法生成确定性时间轴");
  }
  const candidateNames = new Set(input.candidates.map((candidate) => candidate.name.trim()));

  for (const day of skeleton.days) {
    if (day.day < 1 || day.day > input.days) throw new Error(`时间轴 day ${day.day} 越界`);
    let cursor = start;
    for (const node of day.nodes) {
      const nodeStart = parseClockMinutes(node.startTime);
      const nodeEnd = parseClockMinutes(node.endTime);
      if (nodeStart === null || nodeEnd === null || nodeEnd <= nodeStart) {
        throw new Error(`第 ${day.day} 天存在非法时间节点`);
      }
      if (nodeStart < start || nodeEnd > end) {
        throw new Error(`第 ${day.day} 天节点超出每日时间窗`);
      }
      if (nodeStart < cursor) throw new Error(`第 ${day.day} 天节点发生重叠`);
      cursor = nodeEnd;
    }

    const attractions = day.nodes.filter((node) => node.type === "attraction");
    for (const attraction of attractions) {
      if (!candidateNames.has(attraction.name)) {
        throw new Error(`第 ${day.day} 天安排了候选之外的景点：${attraction.name}`);
      }
    }
    const isMovementDay = (transportByDay.get(day.day)?.length ?? 0) > 0;
    if (!isMovementDay && attractions.length === 0) {
      throw new Error(`第 ${day.day} 天是非移动日，必须包含真实候选景点`);
    }
    if (isMovementDay && !day.nodes.some((node) => node.type === "transport")) {
      throw new Error(`第 ${day.day} 天缺少确定性交通节点`);
    }
  }
}

function buildSkeletonFromSelection(
  input: ButlerPlanInput,
  state: DeterministicState,
): PlannerSkeleton {
  const selectedByDay = new Map<number, AttractionSelection[]>();
  for (const item of state.selection) {
    const bucket = selectedByDay.get(item.day) ?? [];
    bucket.push(item);
    selectedByDay.set(item.day, bucket);
  }
  const candidateById = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));

  const days: PlannerSkeletonDay[] = Array.from({ length: input.days }, (_, index) => {
    const day = index + 1;
    const transportLegs = state.transportByDay.get(day) ?? [];
    const transportMinutes = transportLegs.reduce((total, leg) => total + leg.doorToDoorMinutes, 0);
    const selections = (selectedByDay.get(day) ?? []).sort(
      (left, right) => left.sequence - right.sequence,
    );
    const attractions = selections.map((selection) => {
      const candidate = candidateById.get(selection.candidateId);
      if (!candidate) throw new Error(`景点选择引用了未知候选：${selection.candidateId}`);
      return {
        name: candidate.name,
        stayMinutes: Math.max(45, Math.min(480, Math.round(selection.stayMinutes))),
      };
    });
    const theme =
      attractions.length > 0
        ? attractions.map((attraction) => attraction.name).join(" · ")
        : transportLegs.length > 0
          ? `长途移动：${transportLegs.map((leg) => `${leg.from}至${leg.to}`).join("，")}`
          : "城市自由休整";

    const nodes = buildDayTimeline({
      day: {
        day,
        theme,
        nodes: [],
        radar: buildDayRadar(input.pace),
      },
      startTime: input.startTime,
      endTime: input.endTime,
      transportMinutes,
      meals: transportMinutes > 0 ? [45] : [60, 60],
      restMinutes: transportMinutes > 0 ? 20 : 30,
      attractions,
    });

    if (transportLegs.length > 0) {
      const pendingLeg = transportLegs[0];
      for (const node of nodes) {
        if (node.type !== "transport" || !pendingLeg) break;
        node.name = `${pendingLeg.from} → ${pendingLeg.to} · ${TRANSPORT_LABELS[pendingLeg.mode]}`;
        node.location = `${pendingLeg.to}交通枢纽`;
        node.transportMode = pendingLeg.mode;
        node.transportMinutes = transportMinutes;
        node.estimatedCost = pendingLeg.minimumPerPersonCost * headcount(input.travelers);
        node.tips = `门到门约 ${pendingLeg.doorToDoorMinutes} 分钟，已从当天可游览容量中先行扣除。`;
      }
    }

    return {
      day,
      theme,
      nodes,
      radar: buildDayRadar(input.pace),
    };
  });

  const title = `${input.origin}至${input.destination}${input.days}日行程`;
  const summary =
    days
      .flatMap((day) => day.nodes.filter((node) => node.type === "attraction"))
      .map((node) => node.name)
      .filter((name, index, names) => names.indexOf(name) === index)
      .join("、") || "按确定性交通与每日容量安排行程";

  const skeleton: PlannerSkeleton = { title, summary, days };
  validateDeterministicSkeleton(skeleton, input, state.transportByDay);
  return skeleton;
}

function buildDeterministicBudgetPriceReferences(input: ButlerPlanInput): BudgetPriceReference[] {
  return input.transportLegs.map((leg) => {
    const reference = input.transportPriceReferences?.find((item) => item.legId === leg.id);
    const source = reference?.sources[0]?.url;
    const price: BudgetPriceReference = {
      kind: "transport",
      label: `${leg.from}至${leg.to}${TRANSPORT_LABELS[leg.mode]}单人参考价`,
      // 模型与 Tavily 只能抬价参考，绝不能把价格压到本地单人最低价以下。
      amount: Math.max(leg.minimumPerPersonCost, reference?.minimumUnitPrice ?? 0),
      currency: "CNY",
      confidence: reference?.sources.length ? "reference" : "fallback",
    };
    if (source) price.source = source;
    return price;
  });
}

function buildTicketPriceReferences(state: DeterministicState): BudgetPriceReference[] {
  const seen = new Set<string>();
  return state.selection.flatMap((selection) => {
    if (seen.has(selection.candidateId)) return [];
    seen.add(selection.candidateId);
    const candidate = state.candidates.find((item) => item.id === selection.candidateId);
    if (!candidate) return [];
    const amount =
      selection.stayMinutes <= 90 ? 40 : selection.stayMinutes <= 180 ? DEFAULT_TICKET_AMOUNT : 120;
    return [
      {
        kind: "ticket" as const,
        label: `${candidate.name}门票参考价`,
        amount,
        currency: "CNY" as const,
        confidence: "fallback" as const,
        category: "uniform" as const,
      },
    ];
  });
}

function findFailedStage(run: PlanningRun): PlanningStage | null {
  return PLANNING_STAGES.find((stage) => run.stages[stage].status === "failed") ?? null;
}
export type StageHandlerResult = { handled: true };

export type DeterministicPipelineOptions = {
  id?: string;
  onStage?: (stage: PlanningStage, run: PlanningRun) => void;
  runStage?: (
    stage: PlanningStage,
    attempt: number,
    run: PlanningRun,
  ) => Promise<StageHandlerResult> | StageHandlerResult;
  repairSelection?: (error: unknown) => Promise<void> | void;
  /** 测试与故障边界使用：指定阶段失败后不再启动任何后续阶段。 */
  failAt?: PlanningStage;
};

function stageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 顺序推进确定性管线；selection 是唯一允许原地修复一次的阶段。
 * 任一步最终失败都会立即返回，时间轴与预算只能在前置阶段完成后启动。
 */
export async function runDeterministicPipeline(
  options: DeterministicPipelineOptions = {},
): Promise<PlanningRun> {
  let run = createPlanningRun(options.id ?? `run-${Date.now()}`);

  for (const stage of PLANNING_STAGES) {
    if (!canStartStage(run, stage)) break;
    options.onStage?.(stage, run);
    run = setStageStatus(run, stage, "running");

    let attempt = 0;
    for (;;) {
      try {
        if (options.failAt === stage) {
          throw new Error(`阶段 ${stage} 按测试要求失败`);
        }
        if (!options.runStage) {
          throw new Error(`缺少阶段处理器：${stage}`);
        }
        const result = await options.runStage(stage, attempt, run);
        if (result?.handled !== true) {
          throw new Error(`阶段处理器未处理：${stage}`);
        }
        run = setStageStatus(run, stage, "passed");
        break;
      } catch (error) {
        if (stage === "selection" && attempt === 0 && options.repairSelection) {
          try {
            await options.repairSelection(error);
            attempt += 1;
            continue;
          } catch (repairError) {
            run = setStageStatus(run, stage, "failed", stageErrorMessage(repairError));
            return run;
          }
        }

        run = setStageStatus(run, stage, "failed", stageErrorMessage(error));
        return run;
      }
    }
  }

  return run;
}
async function planWithButlerLegacy(
  input: ButlerPlanInput,
  deps: ButlerDeps = {},
): Promise<unknown> {
  const apiKey = resolveApiKey(deps);
  if (!apiKey) {
    return { status: "needs_configuration", missing: ["DEEPSEEK_API_KEY"] };
  }

  const skeletonOutcome = await obtainSkeleton(input, deps, apiKey);
  if (skeletonOutcome.kind === "fallback") {
    return { status: "fallback", reason: skeletonOutcome.reason };
  }

  const { skeleton, violations, attempts } = skeletonOutcome;

  // 骨架定稿后逐日生成、逐日校验；当天通过后才会开始下一天，单个失败只降级当天。
  const dayCopyResults: { day: number; copy: PlannerDayCopy; failed: boolean }[] = [];
  for (const day of skeleton.days) {
    try {
      const content = await requestChatCompletion(
        buildDayCopyInstructionForDay(day),
        deps,
        apiKey,
        DAY_COPY_MAX_TOKENS,
      );
      const copy = parsePlannerDayCopy(content);
      validateDayCopyForSchedule(copy, day);
      dayCopyResults.push({ day: day.day, copy, failed: false });
    } catch {
      // 某天文案失败时退回空文案并记录 failedDays，Task 8 组装器会用本地默认文案补齐并留痕。
      dayCopyResults.push({
        day: day.day,
        copy: { day: day.day, purpose: "", highlights: [], cautions: [], history: [] },
        failed: true,
      });
    }
  }

  const closing = await (async (): Promise<TripClosing> => {
    try {
      return await buildTripClosingWithDeepSeek(buildClosingInput(input), {
        apiKey,
        baseUrl: deps.baseUrl ?? process.env.DEEPSEEK_BASE_URL,
        model: deps.model ?? process.env.DEEPSEEK_MODEL,
        fetchImpl: deps.fetchImpl ?? fetch,
        timeoutMs: deps.timeoutMs,
        maxTokens: CLOSING_MAX_TOKENS,
      });
    } catch {
      return { quote: null, source: null, message: FALLBACK_CLOSING_MESSAGE };
    }
  })();
  const dayCopy = dayCopyResults.map((result) => result.copy);
  const failedDays = dayCopyResults.filter((result) => result.failed).map((result) => result.day);

  return {
    status: "ok",
    skeleton,
    violations,
    dayCopy,
    failedDays,
    closing,
    attempts,
    candidates: input.candidates,
  };
}

/**
 * BUTLER_PLANNER=1 的生产入口：只按 route→pois→selection→timeline→prices→budget→narrative→pages 推进。
 * 没有阶段处理器、任一阶段最终失败或 selection 越界时，整条链路 fail closed，绝不伪造后续结果。
 */
export async function planWithButler(
  input: ButlerPlanInput,
  deps: ButlerDeps = {},
): Promise<ButlerPlanResult> {
  const apiKey = resolveApiKey(deps);
  if (!apiKey) {
    return { status: "needs_configuration", missing: ["DEEPSEEK_API_KEY"] };
  }

  const state: DeterministicState = {
    candidates: [],
    transportLegs: [],
    transportByDay: new Map(),
    selection: [],
    skeleton: null,
    budget: null,
    budgetPriceReferences: [],
    dayCopy: [],
    failedDays: [],
    closing: null,
    selectionRepairReason: null,
    modelAttempts: 0,
  };

  const run = await runDeterministicPipeline({
    onStage: deps.onStage,
    runStage: async (stage, attempt) => {
      switch (stage) {
        case "route": {
          state.transportLegs = validateTransportPlan(input);
          state.transportByDay = mapTransportLegsToDays(
            input.route,
            input.days,
            state.transportLegs,
          );
          break;
        }
        case "pois": {
          const ids = new Set<string>();
          state.candidates = input.candidates.map((candidate) => {
            const id = candidate.id.trim();
            const name = candidate.name.trim();
            if (!id || !name) throw new Error("高德候选缺少 id 或名称，候选阶段失败");
            if (ids.has(id)) throw new Error(`高德候选 id 重复：${id}`);
            ids.add(id);
            if (!candidate.source.trim()) throw new Error(`候选景点 ${name} 缺少来源`);
            return { ...candidate, id, name };
          });
          if (state.candidates.length === 0) {
            throw new Error("候选景点不足，停止生成游玩计划");
          }
          break;
        }
        case "selection": {
          const instruction = buildSelectionInstruction(
            input,
            state.transportByDay,
            state.selectionRepairReason,
          );
          state.modelAttempts += 1;
          const content = await requestChatCompletion(
            instruction,
            deps,
            apiKey,
            SELECTION_MAX_TOKENS,
          );
          const selection = parseAttractionSelection(
            content,
            new Set(state.candidates.map((candidate) => candidate.id)),
          );
          validateSelectionCoverage(input, selection, state.transportByDay);
          state.selection = selection;
          break;
        }
        case "timeline": {
          state.skeleton = buildSkeletonFromSelection(input, state);
          break;
        }
        case "prices": {
          state.budgetPriceReferences = [
            ...buildDeterministicBudgetPriceReferences(input),
            ...buildTicketPriceReferences(state),
          ];
          break;
        }
        case "budget": {
          if (!state.skeleton) throw new Error("时间轴未通过，预算阶段无法启动");
          state.budget = calculateBudget({
            travelers: input.travelers,
            days: input.days,
            transport: state.transportLegs,
            transportPriceReferences: state.budgetPriceReferences,
            ticketPrices: state.budgetPriceReferences.filter(
              (reference) => reference.kind === "ticket",
            ),
            lodgingPerNight: DEFAULT_LODGING_PER_NIGHT,
            foodPerPersonPerDay: DEFAULT_FOOD_PER_PERSON_PER_DAY,
          });
          const transportFloor = state.transportLegs.reduce(
            (total, leg) => total + leg.minimumPerPersonCost * headcount(input.travelers),
            0,
          );
          if (state.budget.transport < transportFloor) {
            throw new Error(
              `交通预算低于本地最低总价：${state.budget.transport} < ${transportFloor}`,
            );
          }
          break;
        }
        case "narrative": {
          if (!state.skeleton || !state.budget) {
            throw new Error("预算未通过，逐日文案阶段无法启动");
          }
          state.dayCopy = [];
          state.failedDays = [];
          for (const day of state.skeleton.days) {
            try {
              state.modelAttempts += 1;
              const content = await requestChatCompletion(
                buildDayCopyInstructionForDay(day),
                deps,
                apiKey,
                DAY_COPY_MAX_TOKENS,
              );
              const copy = parsePlannerDayCopy(content);
              validateDayCopyForSchedule(copy, day);
              state.dayCopy.push(copy);
            } catch {
              // 单日文案失败只降级当天，后续日期继续逐日生成。
              state.failedDays.push(day.day);
              state.dayCopy.push({
                day: day.day,
                purpose: "",
                highlights: [],
                cautions: [],
                history: [],
              });
            }
          }
          break;
        }
        case "pages": {
          if (!state.skeleton || !state.budget || state.dayCopy.length !== input.days) {
            throw new Error("页面依赖的阶段未通过，不能进入逐页推送");
          }
          try {
            state.modelAttempts += 1;
            state.closing = await buildTripClosingWithDeepSeek(buildClosingInput(input), {
              apiKey,
              baseUrl: deps.baseUrl ?? process.env.DEEPSEEK_BASE_URL,
              model: deps.model ?? process.env.DEEPSEEK_MODEL,
              fetchImpl: deps.fetchImpl ?? fetch,
              timeoutMs: deps.timeoutMs,
              maxTokens: CLOSING_MAX_TOKENS,
            });
          } catch {
            state.closing = {
              quote: null,
              source: null,
              message: FALLBACK_CLOSING_MESSAGE,
            };
          }
          break;
        }
        default:
          throw new Error(`未知阶段：${stage satisfies never}`);
      }
      void attempt;
      return { handled: true };
    },
    repairSelection: (error) => {
      state.selectionRepairReason = error instanceof Error ? error.message : String(error);
    },
  });

  const failedStage = findFailedStage(run);
  if (failedStage) {
    return {
      status: "failed",
      stage: failedStage,
      reason: run.stages[failedStage].error ?? `阶段 ${failedStage} 失败`,
    };
  }
  if (!state.skeleton || !state.budget || !state.closing) {
    return {
      status: "failed",
      stage: "pages",
      reason: "确定性管线未产出完整页面依赖",
    };
  }

  return {
    status: "ok",
    skeleton: state.skeleton,
    violations: [],
    dayCopy: state.dayCopy,
    failedDays: state.failedDays,
    closing: state.closing,
    attempts: state.modelAttempts,
    candidates: state.candidates,
    transportLegs: state.transportLegs,
    budget: state.budget,
  };
}
