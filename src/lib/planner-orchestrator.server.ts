import {
  buildSkeletonInstruction,
  buildSkeletonRepairInstruction,
  enforceTransportPriceFloors,
  parsePlannerSkeleton,
  type PlannerSkeleton,
  type PlannerSkeletonDay,
  type SkeletonInstructionInput,
} from "./planner-skeleton.ts";
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
  /** 候选资料由调用方抓取后传入；结果原样回传供结果页展示「N 个候选景区」。 */
  candidates: { name: string; summary: string; source: string }[];
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
      candidates: { name: string; summary: string; source: string }[];
    }
  | { status: "needs_configuration"; missing: string[] }
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
  const baseUrl = (
    deps.baseUrl ??
    process.env.DEEPSEEK_BASE_URL ??
    DEFAULT_BASE_URL
  )
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

export async function planWithButler(
  input: ButlerPlanInput,
  deps: ButlerDeps = {},
): Promise<ButlerPlanResult> {
  const apiKey = resolveApiKey(deps);
  if (!apiKey) {
    return { status: "needs_configuration", missing: ["DEEPSEEK_API_KEY"] };
  }

  const skeletonOutcome = await obtainSkeleton(input, deps, apiKey);
  if (skeletonOutcome.kind === "fallback") {
    return { status: "fallback", reason: skeletonOutcome.reason };
  }

  const { skeleton, violations, attempts } = skeletonOutcome;

  // 骨架定稿后，每天文案与结尾并行发出；单个失败只降级该份内容，不影响整体。
  const dayCopyJobs = skeleton.days.map(
    async (day): Promise<{ day: number; copy: PlannerDayCopy; failed: boolean }> => {
      try {
        const content = await requestChatCompletion(
          buildDayCopyInstructionForDay(day),
          deps,
          apiKey,
          DAY_COPY_MAX_TOKENS,
        );
        return { day: day.day, copy: parsePlannerDayCopy(content), failed: false };
      } catch {
        // 某天文案失败时退回空文案并记录 failedDays，Task 8 组装器会用本地默认文案补齐并留痕。
        return {
          day: day.day,
          copy: { day: day.day, purpose: "", highlights: [], cautions: [], history: [] },
          failed: true,
        };
      }
    },
  );

  const closingJob = (async (): Promise<TripClosing> => {
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

  const [dayCopyResults, closing] = await Promise.all([Promise.all(dayCopyJobs), closingJob]);
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
