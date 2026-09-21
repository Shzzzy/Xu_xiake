import { z } from "zod";
import type { Pace, WeatherDay } from "./planner.ts";
import type { RoutePlan, TransportMode, TravelStyle } from "./route-planner.ts";
import { violationSummary, type PlanViolation } from "./plan-validator.ts";

export type PlannerSkeletonNodeType =
  "transport" | "transfer" | "attraction" | "meal" | "rest" | "hotel" | "night-activity";

export type PlannerSkeletonNode = {
  type: PlannerSkeletonNodeType;
  startTime: string;
  endTime: string;
  name: string;
  location?: string;
  transportMode?: TransportMode;
  transportMinutes?: number;
  stayMinutes?: number;
  estimatedCost: number;
  tips?: string;
};

export type PlannerSkeletonRadar = {
  physical: number;
  childFit: number;
  weatherSensitivity: number;
  timeCost: number;
  crowding: number;
};

export type PlannerSkeletonDay = {
  day: number;
  theme: string;
  nodes: PlannerSkeletonNode[];
  radar: PlannerSkeletonRadar;
};

export type PlannerSkeleton = {
  title: string;
  summary: string;
  days: PlannerSkeletonDay[];
};

const timePattern = /^\d{2}:\d{2}$/;

// 雷达分值统一为 0–100，越界视为模型格式错误。
const radarScoreSchema = z.number().min(0).max(100);

const radarSchema = z.object({
  physical: radarScoreSchema,
  childFit: radarScoreSchema,
  weatherSensitivity: radarScoreSchema,
  timeCost: radarScoreSchema,
  crowding: radarScoreSchema,
});

const nodeSchema = z.object({
  type: z.enum(["transport", "transfer", "attraction", "meal", "rest", "hotel", "night-activity"]),
  startTime: z.string().regex(timePattern, "时间格式必须为 HH:MM"),
  endTime: z.string().regex(timePattern, "时间格式必须为 HH:MM"),
  name: z.string().min(1),
  location: z.string().optional(),
  transportMode: z
    .enum(["economy", "balanced", "speed", "train", "flight", "drive", "bus", "ship"])
    .optional(),
  transportMinutes: z.number().nonnegative().optional(),
  stayMinutes: z.number().nonnegative().optional(),
  estimatedCost: z.number().nonnegative(),
  tips: z.string().optional(),
});

const daySchema = z.object({
  day: z.number().int().positive(),
  theme: z.string().min(1),
  nodes: z.array(nodeSchema),
  radar: radarSchema,
});

// 模型偶尔会用 Markdown 代码块包裹 JSON，解析前先剥掉围栏。
const skeletonSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  days: z.array(daySchema).min(1),
});

export function parsePlannerSkeleton(content: string): PlannerSkeleton {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return skeletonSchema.parse(JSON.parse(cleaned));
}

export type SkeletonCandidate = { name: string; summary: string; source: string };

export type SkeletonInstructionBrief = {
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
};

export type SkeletonInstructionInput = {
  brief: SkeletonInstructionBrief;
  route: RoutePlan;
  weather: WeatherDay[];
  candidates: SkeletonCandidate[];
};

const paceLimits: Record<Pace, number> = { relaxed: 2, balanced: 3, deep: 4 };
const paceLabels: Record<Pace, string> = { relaxed: "轻松", balanced: "适中", deep: "充实" };

// 骨架调用的模型输出契约，只给字段格式，不给具体值。
const skeletonRequiredSchema = {
  title: "string，一句话标题，必须与逐日排程一致",
  summary: "string，整体印象，必须与逐日排程一致，不得写入排程里没有的安排",
  days: [
    {
      day: "number，从 1 连续编号",
      theme: "string，当天主题",
      nodes: [
        {
          type: "transport | transfer | attraction | meal | rest | hotel | night-activity",
          startTime: "string，HH:MM",
          endTime: "string，HH:MM",
          name: "string，景点类节点（attraction / night-activity）必须来自 candidates.name；其余节点（transport / transfer / meal / rest / hotel）自行给出合理名称，例如「午餐」「酒店入住」「返回酒店休息」",
          location: "string，可选",
          transportMode: "economy | balanced | speed | train | flight | drive | bus | ship，可选",
          transportMinutes: "number，可选，单位分钟",
          stayMinutes: "number，可选，单位分钟",
          estimatedCost: "number，单位元，不得为负",
          tips: "string，可选",
        },
      ],
      radar: {
        physical: "number 0–100",
        childFit: "number 0–100",
        weatherSensitivity: "number 0–100",
        timeCost: "number 0–100",
        crowding: "number 0–100",
      },
    },
  ],
};

export function buildSkeletonInstruction(input: SkeletonInstructionInput): string {
  const { brief } = input;
  const constraints = [
    "只输出严格 JSON，不要 Markdown、不要解释、不要多余文字",
    "只有景点类节点（attraction 与 night-activity）的 name 必须来自 candidates，不得编造候选清单之外的景点",
    "其余节点（transport / transfer / meal / rest / hotel）不受候选清单限制，自行给出合理名称，例如「午餐」「酒店入住」「返回酒店休息」",
    "不得输出 URL；来源链接一律由本地补齐",
    `每天全部节点的时间必须落在用户窗口 ${brief.startTime}–${brief.endTime} 内，且当天时间升序、不重叠`,
    "每天必须包含用餐（meal）、住宿（hotel）与收尾休息（rest）节点；夜游（night-activity）可选",
    "如果路线风格是 direct（直达）：途中不得为了景点绕路；到达后若剩余时间足够则安排景点，不足但附近有可在剩余时间内完成的小景点则安排周边游，否则休息，不强制安排景点",
    "如果路线风格是 wander（边走边玩）：沿途与到达后都应围绕候选景点安排，非纯交通移动日至少 1 个核心景点",
    `全部节点 estimatedCost 之和不得超过全团总预算 ${brief.totalBudget} 元`,
    `每天核心景点（attraction 与 night-activity）合计不得超过 ${paceLimits[brief.pace]} 个（${
      paceLabels[brief.pace]
    }档节奏）`,
    "标题与摘要必须与逐日排程保持一致，不得描述排程里没有的安排",
    `必须生成恰好 ${brief.days} 天，day 从 1 连续编号到 ${brief.days}`,
  ];

  const payload = {
    task: "生成逐日排程骨架",
    requiredSchema: skeletonRequiredSchema,
    brief,
    route: input.route,
    weather: input.weather,
    candidates: input.candidates,
    constraints,
  };

  return [
    "你是中文旅行规划师，擅长把候选景点排成时间与空间都合理的逐日骨架。",
    "生成前先在内部检查时间、交通与空间是否合理；不合理就自动调整交通、停留时长与密度后再输出，不展示失败草稿。",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

export function buildSkeletonRepairInstruction(violations: PlanViolation[]): string {
  return [
    "上一版排程骨架存在以下违规，请按清单重排后重新输出完整 JSON：",
    violationSummary(violations),
    "硬性重排约束：",
    "- 只改被判定违规处，其余保持原样",
    "- 不得引入候选清单之外的景点",
    "- 不得输出 URL，字段结构与上一版完全一致",
    "- 仍只输出严格 JSON，不要解释、不要 Markdown",
  ].join("\n");
}
