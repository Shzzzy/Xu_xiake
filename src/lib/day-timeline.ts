import type {
  PlannerSkeletonDay,
  PlannerSkeletonNode,
  PlannerSkeletonNodeType,
} from "./planner-skeleton.ts";

export type TimelineBuildInput = {
  day: PlannerSkeletonDay;
  startTime: string;
  endTime: string;
  transportMinutes: number;
  meals: number[];
  restMinutes: number;
  attractions: { name: string; stayMinutes: number }[];
};

type TimelineSegment = {
  type: PlannerSkeletonNodeType;
  name: string;
  minutes: number;
  transportMinutes?: number;
  stayMinutes?: number;
};

const HOTEL_MINUTES = 30;
const TRANSFER_MINUTES = 20;

function normalizeMinutes(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function parseClock(value: string): number | null {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!matched) return null;
  return Number(matched[1]) * 60 + Number(matched[2]);
}

function formatClock(totalMinutes: number): string {
  const minutes = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function toNode(segment: TimelineSegment, cursor: number): PlannerSkeletonNode {
  const node: PlannerSkeletonNode = {
    type: segment.type,
    startTime: formatClock(cursor),
    endTime: formatClock(cursor + segment.minutes),
    name: segment.name,
    estimatedCost: 0,
  };

  if (segment.transportMinutes !== undefined) node.transportMinutes = segment.transportMinutes;
  if (segment.stayMinutes !== undefined) node.stayMinutes = segment.stayMinutes;
  return node;
}

/** 休息与机动时间的上限：超出部分留白，避免把可用游玩时间全部算作休息。 */
const MAX_REST_MINUTES = 90;

export function buildDayTimeline(input: TimelineBuildInput): PlannerSkeletonNode[] {
  const start = parseClock(input.startTime);
  const end = parseClock(input.endTime);
  if (start === null || end === null || end <= start) {
    throw new Error("每日时间窗必须是有效的 HH:MM，且结束时间晚于开始时间");
  }

  const windowMinutes = end - start;
  const hotelMinutes = Math.min(HOTEL_MINUTES, windowMinutes);
  const availableBeforeHotel = windowMinutes - hotelMinutes;
  const transportMinutes = normalizeMinutes(input.transportMinutes);

  // 交通是硬约束：不能把 260 分钟交通静默截成 230 分钟后继续输出不可能的时间轴。
  if (transportMinutes > availableBeforeHotel) {
    throw new Error(
      `交通时长超出每日时间窗：需要 ${transportMinutes} 分钟，扣除住宿后可用 ${availableBeforeHotel} 分钟`,
    );
  }

  const transportSegments: TimelineSegment[] = [];
  if (transportMinutes > 0) {
    const transferMinutes = Math.min(TRANSFER_MINUTES, transportMinutes);
    const rideMinutes = transportMinutes - transferMinutes;
    transportSegments.push({
      type: "transport",
      name: "交通出行",
      minutes: rideMinutes,
      transportMinutes: rideMinutes,
    });
    if (transferMinutes > 0) {
      transportSegments.push({
        type: "transfer",
        name: "抵达后换乘",
        minutes: transferMinutes,
        transportMinutes: transferMinutes,
      });
    }
  }

  const attractionSegments: TimelineSegment[] = [];
  const mealSegments: TimelineSegment[] = [];
  const restSegments: TimelineSegment[] = [];
  let remaining = availableBeforeHotel - transportMinutes;

  // 先按真实停留时长预留景点；放不下的长景点跳过，后置短景点仍可尝试。
  for (const attraction of input.attractions) {
    const stayMinutes = normalizeMinutes(attraction.stayMinutes);
    if (stayMinutes <= 0 || stayMinutes > remaining) continue;
    attractionSegments.push({
      type: "attraction",
      name: attraction.name,
      minutes: stayMinutes,
      stayMinutes,
    });
    remaining -= stayMinutes;
  }

  if (attractionSegments.length === 0 && input.attractions.length > 0) {
    // 物理容量不足以安排任何完整景点：降级为休整，再尽量保留一顿午餐。
    const restMinutes = Math.min(normalizeMinutes(input.restMinutes), remaining);
    if (restMinutes > 0) {
      restSegments.push({
        type: "rest",
        name: "自由活动与休整",
        minutes: restMinutes,
        stayMinutes: restMinutes,
      });
      remaining -= restMinutes;
    }
    input.meals.forEach((mealMinutes, index) => {
      const normalized = normalizeMinutes(mealMinutes);
      if (normalized <= 0 || normalized > remaining) return;
      mealSegments.push({
        type: "meal",
        name: index === 0 ? "午餐" : index === 1 ? "晚餐" : `第 ${index + 1} 餐`,
        minutes: normalized,
      });
      remaining -= normalized;
    });
  } else {
    // 景点优先后，再按顺序保留午餐、晚餐和必要休息；放不下就跳过。
    input.meals.forEach((mealMinutes, index) => {
      const normalized = normalizeMinutes(mealMinutes);
      if (normalized <= 0 || normalized > remaining) return;
      mealSegments.push({
        type: "meal",
        name: index === 0 ? "午餐" : index === 1 ? "晚餐" : `第 ${index + 1} 餐`,
        minutes: normalized,
      });
      remaining -= normalized;
    });

    const restMinutes = Math.min(normalizeMinutes(input.restMinutes), remaining);
    if (restMinutes > 0) {
      restSegments.push({
        type: "rest",
        name: "必要休息",
        minutes: restMinutes,
        stayMinutes: restMinutes,
      });
      remaining -= restMinutes;
    }
  }

  if (remaining > 0) {
    // 剩余时间不能整段并进休息：曾出现「必要休息 5 小时」把整天玩废的排程。
    // 休息/机动最多累计到 MAX_REST_MINUTES，其余时间留白，交给用户自行安排。
    const existingRest = restSegments.at(-1);
    const currentRest = existingRest?.minutes ?? 0;
    const extra = Math.min(remaining, Math.max(0, MAX_REST_MINUTES - currentRest));
    if (extra > 0 && existingRest) {
      existingRest.minutes += extra;
      existingRest.stayMinutes = existingRest.minutes;
      remaining -= extra;
    } else if (extra > 0) {
      restSegments.push({
        type: "rest",
        name: "自由活动与休整",
        minutes: extra,
        stayMinutes: extra,
      });
      remaining -= extra;
    }
  }

  const hotelSegments: TimelineSegment[] = [];
  if (hotelMinutes > 0) {
    const dayNumber = Number.isFinite(input.day.day) && input.day.day > 0 ? input.day.day : 1;
    hotelSegments.push({
      type: "hotel",
      name: `第 ${dayNumber} 天酒店入住与休整`,
      minutes: hotelMinutes,
      stayMinutes: hotelMinutes,
    });
  }

  const firstMeal = mealSegments[0] ? [mealSegments[0]] : [];
  const laterMeals = mealSegments.slice(1);
  const segments = [
    ...transportSegments,
    ...firstMeal,
    ...attractionSegments,
    ...laterMeals,
    ...restSegments,
    ...hotelSegments,
  ];

  let cursor = start;
  return segments.map((segment) => {
    const node = toNode(segment, cursor);
    cursor += segment.minutes;
    return node;
  });
}
