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

const MIN_ATTRACTION_MINUTES = 75;
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

export function buildDayTimeline(input: TimelineBuildInput): PlannerSkeletonNode[] {
  const start = parseClock(input.startTime);
  const end = parseClock(input.endTime);
  if (start === null || end === null || end <= start) {
    throw new Error("每日时间窗必须是有效的 HH:MM，且结束时间晚于开始时间");
  }

  const windowMinutes = end - start;
  const hotelMinutes = Math.min(HOTEL_MINUTES, windowMinutes);
  const segments: TimelineSegment[] = [];
  let remainingBeforeHotel = windowMinutes - hotelMinutes;

  const pushFixedSegment = (segment: Omit<TimelineSegment, "minutes">, requestedMinutes: number) => {
    const minutes = Math.min(normalizeMinutes(requestedMinutes), remainingBeforeHotel);
    if (minutes <= 0) return;
    segments.push({ ...segment, minutes });
    remainingBeforeHotel -= minutes;
  };

  const transportMinutes = normalizeMinutes(input.transportMinutes);
  if (transportMinutes > 0) {
    // 换乘属于交通总时长的一部分，单独列出但不会重复扣减容量。
    const transferMinutes = Math.min(TRANSFER_MINUTES, transportMinutes);
    const rideMinutes = transportMinutes - transferMinutes;
    pushFixedSegment({ type: "transport", name: "交通出行" }, rideMinutes);
    pushFixedSegment(
      {
        type: "transfer",
        name: "抵达后换乘",
        transportMinutes: transferMinutes,
      },
      transferMinutes,
    );
  }

  input.meals.forEach((mealMinutes, index) => {
    const name = index === 0 ? "午餐" : index === 1 ? "晚餐" : `第 ${index + 1} 餐`;
    pushFixedSegment({ type: "meal", name }, mealMinutes);
  });

  pushFixedSegment({ type: "rest", name: "必要休息" }, input.restMinutes);

  if (remainingBeforeHotel >= MIN_ATTRACTION_MINUTES) {
    for (const attraction of input.attractions) {
      const requestedStay = normalizeMinutes(attraction.stayMinutes);
      if (requestedStay <= 0) continue;

      const stayMinutes = Math.min(requestedStay, remainingBeforeHotel);
      if (stayMinutes < MIN_ATTRACTION_MINUTES) break;

      segments.push({
        type: "attraction",
        name: attraction.name,
        minutes: stayMinutes,
        stayMinutes,
      });
      remainingBeforeHotel -= stayMinutes;
    }
  }

  if (remainingBeforeHotel > 0) {
    segments.push({
      type: "rest",
      name: "自由活动与休整",
      minutes: remainingBeforeHotel,
      stayMinutes: remainingBeforeHotel,
    });
    remainingBeforeHotel = 0;
  }

  if (hotelMinutes > 0) {
    const dayNumber = Number.isFinite(input.day.day) && input.day.day > 0 ? input.day.day : 1;
    segments.push({
      type: "hotel",
      name: `第 ${dayNumber} 天酒店入住与休整`,
      minutes: hotelMinutes,
      stayMinutes: hotelMinutes,
    });
  }

  let cursor = start;
  return segments.map((segment) => {
    const node = toNode(segment, cursor);
    cursor += segment.minutes;
    return node;
  });
}
