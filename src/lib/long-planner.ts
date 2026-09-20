import { z } from "zod";
import type { DiscoveredStop } from "./live-planner";

export type { DiscoveredStop } from "./live-planner";
import type { Pace } from "./planner";
import type { RoutePlan } from "./route-planner";

export type LongPlanPhase = {
  dayStart: number;
  dayEnd: number;
  title: string;
  region: string;
  highlights: string[];
  transport: string;
  notes: string;
};

export type LongPlan = {
  title: string;
  summary: string;
  phases: LongPlanPhase[];
};

export type LongPlanInput = {
  destinationName: string;
  region: string;
  days: number;
  seedPlaces: string[];
  route?: RoutePlan;
};

const longPlanSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  phases: z
    .array(
      z.object({
        dayStart: z.number().int().positive(),
        dayEnd: z.number().int().positive(),
        title: z.string().min(1),
        region: z.string().min(1),
        highlights: z.array(z.string().min(1)).min(1),
        transport: z.string().min(1),
        notes: z.string().min(1),
      }),
    )
    .min(1)
    .max(12),
});

function targetPhaseCount(days: number) {
  if (days <= 30) return Math.ceil(days / 7);
  if (days <= 90) return Math.ceil(days / 14);
  return Math.min(12, Math.ceil(days / 30));
}

export function createLongPhaseRanges(days: number) {
  if (!Number.isInteger(days) || days < 17 || days > 365) {
    throw new Error("长线行程天数必须在 17–365 天之间");
  }

  const count = targetPhaseCount(days);
  const baseSize = Math.floor(days / count);
  const extra = days % count;
  let cursor = 1;

  return Array.from({ length: count }, (_, index) => {
    const size = baseSize + (index < extra ? 1 : 0);
    const range = { dayStart: cursor, dayEnd: cursor + size - 1 };
    cursor += size;
    return range;
  });
}

export function parseLongPlanJson(text: string, expectedDays: number): LongPlan {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const plan = longPlanSchema.parse(JSON.parse(cleaned));

  if (plan.phases[0]?.dayStart !== 1 || plan.phases.at(-1)?.dayEnd !== expectedDays) {
    throw new Error("阶段日期必须连续覆盖完整行程");
  }

  for (let index = 0; index < plan.phases.length; index += 1) {
    const phase = plan.phases[index];
    const previous = plan.phases[index - 1];
    if (phase.dayStart > phase.dayEnd || (previous && phase.dayStart !== previous.dayEnd + 1)) {
      throw new Error("阶段日期必须连续覆盖完整行程");
    }
  }

  return plan;
}

export type LongPlannerPromptInput = LongPlanInput & {
  startDate: string;
  pace: Pace;
  interests: string[];
  discoveredStops: DiscoveredStop[];
  route: RoutePlan;
};

export function buildLongPlannerMessages(input: LongPlannerPromptInput) {
  const ranges = createLongPhaseRanges(input.days);
  const rangeText = ranges
    .map((range) => `dayStart: ${range.dayStart}，dayEnd: ${range.dayEnd}`)
    .join("；");

  return [
    {
      role: "system",
      content:
        "你是中文长线旅行规划师。用户行程超过 16 天时，不按天展开，而是按周或路线阶段汇总。生成前先在内部检查时间与空间是否合理；不合理时自动调整交通、停留时长、休息阶段和路线密度，再输出最终结果。只输出严格 JSON，不要 Markdown。",
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "生成阶段式长线旅行规划",
        requiredSchema: {
          title: "string",
          summary: "string",
          phases: [
            {
              dayStart: "number",
              dayEnd: "number",
              title: "string",
              region: "string",
              highlights: ["string"],
              transport: "string",
              notes: "string",
            },
          ],
        },
        trip: {
          destination: input.destinationName,
          region: input.region,
          startDate: input.startDate,
          days: input.days,
          pace: input.pace,
          interests: input.interests,
          seedPlaces: input.seedPlaces,
          discoveredStops: input.discoveredStops,
          route: input.route,
        },
        phaseRanges: rangeText,
        constraints: [
          `必须完整覆盖 ${input.days} 天，从第 1 天到第 ${input.days} 天不能遗漏或重叠`,
          "阶段数量应简洁，最多 12 个阶段",
          "每个阶段给出建议区域、重点玩法、交通衔接和注意事项",
          "途经点顺序不可更改，目的地和途经点都表示到达附近后游玩",
          "使用校核后的地区和地点类型解释地理关系",
          "每一段必须遵循用户设置的 transport 和 style",
          "transport=economy 表示经济推荐：优先降低交通支出，可以接受更长交通时间",
          "transport=balanced 表示均衡推荐：综合费用、时间、换乘次数、可靠性和舒适度，默认采用此策略",
          "transport=speed 表示效率推荐：优先缩短交通时间，可以接受更高交通开销",
          "train/flight/drive/bus/ship 表示用户指定交通方式，不得擅自替换",
          "估算交通价格时给出区间并说明估算依据，不得伪造实时票价",
          "自驾成本按能源费、过路费、停车费估算；默认按自有车辆计算，不擅自加入租车费或车辆折旧",
          "style=wander 表示边走边玩，应减少固定景点、保留临时停留与机动时间",
          "roundTrip=true 且 returnMode=fast 时，快速回家；returnMode=scenic 时不走回头，优先规划不同返程路线",
          "每天至少预留 7 小时睡眠，并预留用餐、休息、换乘和交通缓冲",
          "先在内部判断时间与空间合理性，不合理则自动调整优化后再输出最终结果",
          "超过 16 天的天气不作为确定预报，只提示以实际为准",
          "不要输出 JSON 之外的解释",
        ],
      }),
    },
  ] as const;
}

export function buildFallbackLongPlan(input: LongPlanInput): LongPlan {
  const ranges = createLongPhaseRanges(input.days);
  const routeStops = input.route
    ? [...input.route.waypoints, input.route.destination].filter(Boolean)
    : [];
  const places = [...new Set([...routeStops, ...input.seedPlaces.filter(Boolean)])];
  const phases = ranges.map((range, index) => {
    const start = places.length > 0 ? Math.floor((index * places.length) / ranges.length) : 0;
    const selected = places.slice(start, Math.min(places.length, start + 3));
    const region = selected.length > 0 ? selected.slice(0, 2).join("、") : input.region;
    const routeText = input.route
      ? input.route.legs.map((leg) => `${leg.from}→${leg.to}`).join("；")
      : "城市间以高铁、包车或航班衔接";
    return {
      ...range,
      title: `${input.destinationName} · 第 ${index + 1} 阶段`,
      region,
      highlights: selected.length > 0 ? selected : [`${input.destinationName}核心区域`, "在地体验"],
      transport: `${routeText}；具体班次以实际查询为准。`,
      notes: "长线行程建议预留机动日，出发前复核天气、交通和景区开放信息。",
    };
  });

  return {
    title: `${input.destinationName} ${input.days} 天阶段路线`,
    summary: `按路线阶段汇总 ${input.days} 天行程，前 16 天可查看逐日天气趋势，后续以实际天气为准。`,
    phases,
  };
}
