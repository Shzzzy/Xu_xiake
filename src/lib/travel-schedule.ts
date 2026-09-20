import type { Pace } from "./planner.ts";
import { normalizeRadarScores } from "./travel-plan.ts";
import type {
  AttractionAudit,
  AttractionScale,
  DailyRadar,
  TimelineNodeType,
  Travelers,
  TripDay,
  TripTimelineNode,
} from "./travel-plan.ts";

export type ExecutionScheduleInput = {
  /** 出发日期，ISO 格式（例如 2026-09-20）。 */
  startDate: string;
  /** 行程总天数，至少 1 天。 */
  days: number;
  /** 旅行节奏，决定每日起止时间、核心景点额度与时间粒度。 */
  pace: Pace;
  /** 成人与儿童人数，用于餐费与休息安排。 */
  travelers: Travelers;
  /** 途经点与目的地名称，按行程顺序传入。 */
  routeNodes: string[];
  /** 每个景点的审核结果，缺失时按中型景点降级估算。 */
  audits: Record<string, AttractionAudit>;
  /** 夜游或夜间活动；传字符串时只作用于第一天，传数组时按天索引。 */
  nightActivity?: string | string[];
  /** 当晚住宿名称，默认「酒店入住」。 */
  lodging?: string;
  /** 覆盖默认出发时间（HH:MM）。 */
  dayStart?: string;
  /** 覆盖默认结束时间（HH:MM）。 */
  dayEnd?: string;
  /** 相邻景点之间的交通耗时估算，默认 15 分钟。 */
  transportMinutes?: number;
  /** 各景点门票（每人），缺失时按景点规模估算。 */
  ticketCosts?: Record<string, number>;
  /** 每餐人均餐费，默认 60 元。 */
  mealCostPerPerson?: number;
  /** 每晚住宿费用（全团），默认 420 元。 */
  lodgingCost?: number;
  /** 夜游费用（全团），默认 0 元。 */
  nightActivityCost?: number;
  /** 跨日景点占用天数，缺失时按建议停留时长推算，至少 2 天。 */
  multiDayDays?: Record<string, number>;
  /** 高德导航链接解析器，返回 null 表示已降级。 */
  navigation?: (name: string) => string | null;
};

/** 每日固定时段分钟数。 */
const LUNCH_MINUTES = 60;
const DINNER_MINUTES = 60;
const HOTEL_CHECK_IN_MINUTES = 30;
const NIGHT_ACTIVITY_MINUTES = 90;
const FINAL_REST_MINUTES = 30;
const LUNCH_WINDOW_START = 12 * 60;
const LUNCH_WINDOW_END = 13 * 60;

const DEFAULT_TRANSPORT_MINUTES = 15;
const DEFAULT_MEAL_COST_PER_PERSON = 60;
const DEFAULT_LODGING_COST = 420;
const MEAL_TIP = "费用为人均估算，可按当地实际价格调整。";
const DISCLAIMER = "所有时间与费用均为估算，请以实际交通与景区开放情况为准。";

/** 节奏对应的默认每日起止时间。 */
const PACE_BOUNDS: Record<Pace, { start: string; end: string }> = {
  relaxed: { start: "09:30", end: "19:30" },
  balanced: { start: "08:30", end: "21:00" },
  deep: { start: "08:00", end: "22:00" },
};

/** 每日核心景点额度：小型与中型占 1 格，大型与跨日型占 2 格。 */
const PACE_UNITS: Record<Pace, number> = { relaxed: 2, balanced: 3, deep: 4 };

/** 时间粒度：轻松按半小时，适中与充实按一刻钟，避免零碎时间。 */
const PACE_GRANULARITY: Record<Pace, number> = { relaxed: 30, balanced: 15, deep: 15 };
const PACE_LABEL: Record<Pace, string> = { relaxed: "轻松", balanced: "适中", deep: "充实" };

/** 没有核心景点时的基准雷达，避免出现空图或全零。 */
const PACE_BASE_RADAR: Record<Pace, DailyRadar> = {
  relaxed: { physical: 30, childFit: 70, weatherSensitivity: 40, timeCost: 30, crowding: 40 },
  balanced: { physical: 50, childFit: 60, weatherSensitivity: 50, timeCost: 50, crowding: 50 },
  deep: { physical: 70, childFit: 50, weatherSensitivity: 60, timeCost: 70, crowding: 60 },
};

const SCALE_UNITS: Record<AttractionScale, number> = { small: 1, medium: 1, large: 2, "multi-day": 2 };
const SCALE_RANK: Record<AttractionScale, number> = { "multi-day": 3, large: 2, medium: 1, small: 0 };
const SCALE_LABEL: Record<AttractionScale, string> = {
  small: "小型",
  medium: "中型",
  large: "大型",
  "multi-day": "跨日型",
};
const SCALE_TICKET_PER_PERSON: Record<AttractionScale, number> = {
  small: 40,
  medium: 80,
  large: 160,
  "multi-day": 240,
};

/** 缺少审核结果时的降级估算，按中型景点处理。 */
const FALLBACK_AUDIT: AttractionAudit = {
  scale: "medium",
  durationHours: 3,
  physical: 50,
  childFit: 60,
  weatherSensitivity: 40,
  timeCost: 50,
  crowding: 50,
  bestTime: "上午",
};

type PreparedAttraction = {
  name: string;
  /** 原始路线顺序，用于排序时保持稳定。 */
  index: number;
  audit: AttractionAudit;
  scale: AttractionScale;
  bestTimeRank: number;
  /** 单个旅行日的建议停留分钟数。 */
  stayMinutes: number;
  /** 跨日景点的总占用天数。 */
  multiDaySpan: number;
  missingAudit: boolean;
};

type DaySegment = {
  item: PreparedAttraction;
  /** 跨日景点的每日拆分段；普通景点为 null。 */
  segment: { index: number; total: number } | null;
  /** 当天额度不足时的兜底安排。 */
  overflow: boolean;
};

type DayAllocation = {
  segments: DaySegment[];
  /** 跨日景点独占当天核心额度，不再塞入其他景点。 */
  exclusive: boolean;
  overflow: boolean;
};

type NodeDraft = {
  type: TimelineNodeType;
  name: string;
  start: number;
  end: number;
  cost: number;
  location?: string;
  tips?: string;
  transportMinutes?: number;
  stayMinutes?: number;
};

type FittedEntry = {
  segment: DaySegment;
  transportUnits: number;
  stayUnits: number;
};

type DayContext = {
  date: string;
  pace: Pace;
  bounds: { start: string; end: string };
  allocation: DayAllocation;
  input: ExecutionScheduleInput;
  headcount: number;
  nightActivity: string | null;
};

/** 返回节奏对应的默认每日起止时间。 */
export function resolveDayBounds(pace: Pace): { start: string; end: string } {
  const bounds = PACE_BOUNDS[pace] ?? PACE_BOUNDS.balanced;
  return { start: bounds.start, end: bounds.end };
}

/**
 * 把路线节点编排成可执行的每日时间轴。
 * 输出严格复用 travel-plan.ts 的 TripDay / TripTimelineNode，不另造平行类型。
 */
export function buildExecutionDays(input: ExecutionScheduleInput): TripDay[] {
  const dayCount = Math.max(1, Math.floor(Number.isFinite(input.days) ? input.days : 1));
  const pace: Pace = PACE_BOUNDS[input.pace] ? input.pace : "balanced";
  const headcount = Math.max(
    1,
    Math.round((input.travelers?.adults ?? 1) + (input.travelers?.children ?? 0)),
  );
  const bounds = resolveDayBounds(pace);
  const items = prepareAttractions(input);
  const allocations = allocateDays(items, dayCount, pace);

  return allocations.map((allocation, dayIndex) =>
    buildDay({
      date: addDays(input.startDate, dayIndex),
      pace,
      bounds,
      allocation,
      input,
      headcount,
      nightActivity: nightActivityFor(input, dayIndex),
    }),
  );
}

function buildDay(context: DayContext): TripDay {
  const { allocation, bounds, date, headcount, input, nightActivity, pace } = context;
  const unit = PACE_GRANULARITY[pace];
  const startMinutes = parseClock(input.dayStart) ?? parseClock(bounds.start) ?? 8 * 60;
  const plannedEnd = parseClock(input.dayEnd) ?? parseClock(bounds.end) ?? startMinutes + 8 * 60;
  const endMinutes = Math.max(startMinutes + unit * 2, plannedEnd);
  const totalUnits = Math.max(1, Math.floor((endMinutes - startMinutes) / unit));

  // 午餐只在当天跨越午间时安排；晚餐、入住、夜游与收尾休息固定锚定在当天结尾。
  const lunchApplicable = startMinutes < LUNCH_WINDOW_START && endMinutes > LUNCH_WINDOW_END;
  const lunchUnits = lunchApplicable ? Math.max(1, Math.round(LUNCH_MINUTES / unit)) : 0;
  const eveningMinutes =
    DINNER_MINUTES +
    HOTEL_CHECK_IN_MINUTES +
    FINAL_REST_MINUTES +
    (nightActivity ? NIGHT_ACTIVITY_MINUTES : 0);
  const eveningUnits = Math.max(1, Math.round(eveningMinutes / unit));
  const windowUnits = Math.max(0, totalUnits - eveningUnits - lunchUnits);

  const fitted = fitSegments(allocation.segments, windowUnits, input, unit);
  const nodes: TripTimelineNode[] = [];
  const lunchCost = mealCost(input, headcount);
  let cursor = startMinutes;
  let lunchPlaced = !lunchApplicable;

  const pushNode = (draft: NodeDraft) => {
    nodes.push(toTimelineNode(draft, input));
  };
  const pushMeal = (name: string, minutes: number, cost: number, tips: string) => {
    pushNode({ type: "meal", name, start: cursor, end: cursor + minutes, cost, tips });
    cursor += minutes;
  };

  for (const entry of fitted.entries) {
    const { item, segment } = entry.segment;
    const label = segmentLabel(item, segment);
    const transportMinutes = entry.transportUnits * unit;

    if (transportMinutes > 0) {
      pushNode({
        type: "transport",
        name: `前往${label}`,
        start: cursor,
        end: cursor + transportMinutes,
        cost: 0,
        transportMinutes,
        tips: "交通耗时按估算预留，实际以当时路况为准。",
      });
      cursor += transportMinutes;
    }

    let stay = entry.stayUnits * unit;
    let pendingCost = ticketCostFor(item, segment, input, headcount);
    const pushAttraction = (name: string, minutes: number) => {
      pushNode({
        type: "attraction",
        name,
        start: cursor,
        end: cursor + minutes,
        cost: pendingCost,
        location: item.name,
        stayMinutes: minutes,
        tips: attractionTip(item),
      });
      pendingCost = 0;
      cursor += minutes;
    };

    // 景点跨过午间时先完成上午段，用餐后继续下午段，保证午餐落在正常饭点。
    if (!lunchPlaced && cursor < LUNCH_WINDOW_START && cursor + stay > LUNCH_WINDOW_START) {
      const before = LUNCH_WINDOW_START - cursor;
      if (before >= unit) {
        pushAttraction(label, before);
        stay -= before;
      }
      pushMeal("午餐", lunchUnits * unit, lunchCost, MEAL_TIP);
      lunchPlaced = true;
    } else if (!lunchPlaced && cursor >= LUNCH_WINDOW_START) {
      pushMeal("午餐", lunchUnits * unit, lunchCost, MEAL_TIP);
      lunchPlaced = true;
    }

    pushAttraction(stay < entry.stayUnits * unit ? `${label}（续）` : label, stay);
  }

  if (lunchApplicable && !lunchPlaced) {
    // 景点在午前结束或当天没有核心景点时，把午餐放回午间。
    if (allocation.segments.length === 0 && cursor < LUNCH_WINDOW_START) {
      pushNode({
        type: "rest",
        name: "上午自由活动",
        start: cursor,
        end: LUNCH_WINDOW_START,
        cost: 0,
        tips: "按体力自由安排周边漫步或提前回酒店休整。",
      });
      cursor = LUNCH_WINDOW_START;
    }
    pushMeal("午餐", lunchUnits * unit, lunchCost, MEAL_TIP);
  }

  const eveningAnchor = endMinutes - eveningUnits * unit;
  if (cursor < eveningAnchor && eveningAnchor - cursor >= unit * 2) {
    pushNode({
      type: "rest",
      name: "自由活动与休整",
      start: cursor,
      end: eveningAnchor,
      cost: 0,
      tips: "留白时段，可按体力增减周边漫步或提前回酒店。",
    });
  }

  cursor = Math.max(cursor, eveningAnchor);
  const overrun = cursor + eveningUnits * unit > endMinutes;

  pushMeal("晚餐", DINNER_MINUTES, lunchCost, MEAL_TIP);
  pushNode({
    type: "hotel",
    name: input.lodging ? `${input.lodging} 入住` : "酒店入住",
    location: input.lodging ?? "当晚住宿",
    start: cursor,
    end: cursor + HOTEL_CHECK_IN_MINUTES,
    cost: lodgingCost(input),
    tips: "办理入住并稍作休整，放下随身行李。",
  });
  cursor += HOTEL_CHECK_IN_MINUTES;

  if (nightActivity) {
    pushNode({
      type: "night-activity",
      name: nightActivity,
      location: nightActivity,
      start: cursor,
      end: cursor + NIGHT_ACTIVITY_MINUTES,
      cost: nightActivityCost(input),
      tips: "夜间活动安排在住宿地附近，结束后步行返回酒店。",
    });
    cursor += NIGHT_ACTIVITY_MINUTES;
  }

  pushNode({
    type: "rest",
    name: "返回酒店休息",
    start: cursor,
    end: cursor + FINAL_REST_MINUTES,
    cost: 0,
    tips: "当天行程收尾，整理次日随身物品。",
  });

  const attractions = allocation.segments.map((daySegment) => daySegment.item);
  const names = attractions.map((item) => item.name);

  return {
    date,
    theme: names.length > 0 ? names.join(" · ") : "城市漫步与休整",
    nodes,
    estimatedCost: nodes.reduce((sum, node) => sum + node.estimatedCost, 0),
    radar: buildDailyRadar(attractions, pace),
    purpose:
      names.length > 0
        ? `以${names.join("、")}为核心安排当天行程，按${PACE_LABEL[pace]}节奏在游览、用餐与休息之间留出缓冲。`
        : `当天没有安排核心景点，按${PACE_LABEL[pace]}节奏保留自由活动与休整时间。`,
    highlights: allocation.segments.map(
      ({ item, segment }) => `${segmentLabel(item, segment)}：${attractionTip(item)}`,
    ),
    cautions: collectCautions(allocation, input, pace, {
      compressed: fitted.compressed,
      overrun,
    }, bounds.end),
  };
}

function prepareAttractions(input: ExecutionScheduleInput): PreparedAttraction[] {
  const items = input.routeNodes.map((name, index) => {
    const found: AttractionAudit | undefined = input.audits?.[name];
    const audit = found ?? FALLBACK_AUDIT;
    const hours = Number.isFinite(audit.durationHours) && audit.durationHours > 0 ? audit.durationHours : 3;

    return {
      name,
      index,
      audit,
      scale: audit.scale,
      bestTimeRank: bestTimeRankOf(audit.bestTime),
      stayMinutes: Math.round(hours * 60),
      multiDaySpan: multiDaySpanOf(audit, input.multiDayDays?.[name]),
      missingAudit: found === undefined,
    };
  });

  // 规模大的景点优先占位，规模相同时按最佳时段与原始顺序排列。
  items.sort(compareForAllocation);
  return items;
}

function compareForAllocation(a: PreparedAttraction, b: PreparedAttraction): number {
  return (
    SCALE_RANK[b.scale] - SCALE_RANK[a.scale] ||
    a.bestTimeRank - b.bestTimeRank ||
    a.index - b.index
  );
}

function compareForTimeline(a: DaySegment, b: DaySegment): number {
  return (
    a.item.bestTimeRank - b.item.bestTimeRank ||
    SCALE_RANK[b.item.scale] - SCALE_RANK[a.item.scale] ||
    a.item.index - b.item.index
  );
}

function bestTimeRankOf(bestTime: string): number {
  const text = typeof bestTime === "string" ? bestTime : "";
  if (/清晨|上午|早上|早/.test(text)) return 0;
  if (/中午|正午/.test(text)) return 1;
  if (/下午/.test(text)) return 2;
  if (/傍晚/.test(text)) return 3;
  if (/晚上|夜间|夜|晚/.test(text)) return 4;
  // 未给出最佳时段时按下午处理，避免所有景点都挤在上午。
  return 2;
}

function multiDaySpanOf(audit: AttractionAudit, explicit: number | undefined): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 1) {
    return Math.floor(explicit);
  }
  if (audit.scale !== "multi-day") return 1;
  const hours = Number.isFinite(audit.durationHours) && audit.durationHours > 0 ? audit.durationHours : 16;
  // 跨日景点默认按每天 8 小时折算，至少占用 2 天。
  return Math.max(2, Math.ceil(hours / 8));
}

function findFreeSpan(days: DayAllocation[], span: number): number {
  for (let start = 0; start + span <= days.length; start += 1) {
    let free = true;
    for (let offset = 0; offset < span; offset += 1) {
      if (days[start + offset].segments.length > 0) {
        free = false;
        break;
      }
    }
    if (free) return start;
  }
  return -1;
}

function allocateDays(items: PreparedAttraction[], dayCount: number, pace: Pace): DayAllocation[] {
  const days: DayAllocation[] = Array.from({ length: dayCount }, () => ({
    segments: [],
    exclusive: false,
    overflow: false,
  }));
  const usedUnits = new Array<number>(dayCount).fill(0);
  const capacity = PACE_UNITS[pace];

  for (const item of items) {
    if (item.scale === "multi-day") {
      const span = Math.min(Math.max(item.multiDaySpan, 1), dayCount);
      let start = findFreeSpan(days, span);
      let overflow = span < item.multiDaySpan;
      if (start === -1) {
        // 没有连续空闲天数时兜底到末尾的连续天数，并在注意事项中提示。
        start = Math.max(0, dayCount - span);
        overflow = true;
      }
      for (let offset = 0; offset < span; offset += 1) {
        const day = days[start + offset];
        if (!day) break;
        day.exclusive = true;
        day.overflow = day.overflow || overflow;
        usedUnits[start + offset] = capacity;
        day.segments.push({ item, segment: { index: offset + 1, total: span }, overflow });
      }
      continue;
    }

    const weight = SCALE_UNITS[item.scale];
    let target = -1;
    for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
      if (days[dayIndex].exclusive) continue;
      if (usedUnits[dayIndex] + weight <= capacity) {
        target = dayIndex;
        break;
      }
    }

    let overflow = false;
    if (target === -1) {
      // 天数不足时顺延到最后一天，由时间窗压缩，避免直接丢景点。
      target = days.reduce((best, day, dayIndex) => (day.exclusive ? best : dayIndex), dayCount - 1);
      overflow = true;
    }

    usedUnits[target] += weight;
    days[target].overflow = days[target].overflow || overflow;
    days[target].segments.push({ item, segment: null, overflow });
  }

  for (const day of days) {
    day.segments.sort(compareForTimeline);
  }

  return days;
}

function fitSegments(
  segments: DaySegment[],
  windowUnits: number,
  input: ExecutionScheduleInput,
  unit: number,
): { entries: FittedEntry[]; compressed: boolean } {
  if (segments.length === 0) return { entries: [], compressed: false };

  const transportUnit = Math.max(1, Math.round(transportMinutesOf(input) / unit));
  const entries: FittedEntry[] = segments.map((segment, position) => {
    const transportUnits = position === 0 ? 0 : transportUnit;
    const stayUnits =
      segment.item.scale === "multi-day"
        ? Math.max(1, windowUnits - transportUnits)
        : Math.max(1, Math.round(segment.item.stayMinutes / unit));
    return { segment, transportUnits, stayUnits };
  });

  const transportTotal = entries.reduce((sum, entry) => sum + entry.transportUnits, 0);
  const stayTotal = entries.reduce((sum, entry) => sum + entry.stayUnits, 0);
  const available = Math.max(0, windowUnits - transportTotal);
  if (stayTotal <= available) return { entries, compressed: false };

  // 时间窗不够时按比例压缩停留时长，每段至少保留一个时间格。
  const ratio = stayTotal === 0 ? 0 : available / stayTotal;
  for (const entry of entries) {
    entry.stayUnits = Math.max(1, Math.round(entry.stayUnits * ratio));
  }

  let excess = entries.reduce((sum, entry) => sum + entry.stayUnits, 0) - available;
  while (excess > 0) {
    const longest = entries.reduce((best, entry) => (entry.stayUnits > best.stayUnits ? entry : best), entries[0]);
    if (longest.stayUnits <= 1) break;
    longest.stayUnits -= 1;
    excess -= 1;
  }

  return { entries, compressed: true };
}

function collectCautions(
  allocation: DayAllocation,
  input: ExecutionScheduleInput,
  pace: Pace,
  flags: { compressed: boolean; overrun: boolean },
  endTime: string,
): string[] {
  const derived: string[] = [`按${PACE_LABEL[pace]}节奏安排当天行程，可按实际体力增减停留时间。`];

  if (flags.overrun) derived.push(`当天内容偏多，结束时间会晚于 ${endTime}，建议增加天数或删减景点。`);
  if (flags.compressed) derived.push("当天可游览时间不足，景点停留时长已按当日时间窗压缩，可考虑增加天数。");
  if (allocation.overflow) derived.push("行程天数或每日额度不足，部分景点被安排在同一天，建议增加天数。");

  for (const { item } of allocation.segments) {
    if (item.missingAudit) derived.push(`${item.name}缺少审核结果，按中型景点估算停留时间。`);
    if (toPercentScore(item.audit.crowding) >= 80) {
      derived.push(`${item.name}人流较大，建议开园即到或错峰前往。`);
    }
    if (toPercentScore(item.audit.weatherSensitivity) >= 70) {
      derived.push(`${item.name}对天气敏感，请留意预报并准备备选方案。`);
    }
    if (toPercentScore(item.audit.physical) >= 80) {
      derived.push(`${item.name}体力消耗较大，注意补水与中途休息。`);
    }
    if ((input.travelers?.children ?? 0) > 0 && toPercentScore(item.audit.childFit) <= 50) {
      derived.push(`${item.name}对儿童不算轻松，请关注孩子的体力与兴趣。`);
    }
  }

  return [...new Set(derived)].slice(0, 5).concat(DISCLAIMER);
}

function buildDailyRadar(attractions: PreparedAttraction[], pace: Pace): DailyRadar {
  if (attractions.length === 0) return { ...PACE_BASE_RADAR[pace] };

  const average = (read: (audit: AttractionAudit) => number) =>
    Math.round(attractions.reduce((sum, item) => sum + clampScore(read(item.audit)), 0) / attractions.length);

  // 同日分数集中时做相对拉伸，保证五边形能看出差异且不改变排序。
  const [physical, childFit, weatherSensitivity, timeCost, crowding] = normalizeRadarScores([
    average((audit) => audit.physical),
    average((audit) => audit.childFit),
    average((audit) => audit.weatherSensitivity),
    average((audit) => audit.timeCost),
    average((audit) => audit.crowding),
  ]);

  return { physical, childFit, weatherSensitivity, timeCost, crowding };
}

function segmentLabel(item: PreparedAttraction, segment: { index: number; total: number } | null): string {
  return segment ? `${item.name}（第 ${segment.index}/${segment.total} 天）` : item.name;
}

function attractionTip(item: PreparedAttraction): string {
  return `${SCALE_LABEL[item.scale]}景点，建议停留约 ${item.audit.durationHours} 小时，最佳时段为${item.audit.bestTime}`;
}

function ticketCostFor(
  item: PreparedAttraction,
  segment: { index: number; total: number } | null,
  input: ExecutionScheduleInput,
  headcount: number,
): number {
  const configured = input.ticketCosts?.[item.name];
  const perPerson =
    typeof configured === "number" && Number.isFinite(configured)
      ? configured
      : SCALE_TICKET_PER_PERSON[item.scale];
  const total = perPerson * headcount;
  // 跨日景点把门票平摊到每一天，避免重复计入当日费用。
  return segment ? Math.round(total / segment.total) : Math.round(total);
}

function mealCost(input: ExecutionScheduleInput, headcount: number): number {
  const perPerson =
    typeof input.mealCostPerPerson === "number" && Number.isFinite(input.mealCostPerPerson)
      ? input.mealCostPerPerson
      : DEFAULT_MEAL_COST_PER_PERSON;
  return Math.round(perPerson * headcount);
}

function lodgingCost(input: ExecutionScheduleInput): number {
  return typeof input.lodgingCost === "number" && Number.isFinite(input.lodgingCost)
    ? Math.round(input.lodgingCost)
    : DEFAULT_LODGING_COST;
}

function nightActivityCost(input: ExecutionScheduleInput): number {
  return typeof input.nightActivityCost === "number" && Number.isFinite(input.nightActivityCost)
    ? Math.round(input.nightActivityCost)
    : 0;
}

function nightActivityFor(input: ExecutionScheduleInput, dayIndex: number): string | null {
  const value = input.nightActivity;
  if (!value) return null;
  const entry = Array.isArray(value) ? value[dayIndex] : dayIndex === 0 ? value : "";
  return typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null;
}

function transportMinutesOf(input: ExecutionScheduleInput): number {
  return typeof input.transportMinutes === "number" && Number.isFinite(input.transportMinutes) && input.transportMinutes > 0
    ? input.transportMinutes
    : DEFAULT_TRANSPORT_MINUTES;
}

function toPercentScore(value: number): number {
  if (!Number.isFinite(value)) return 50;
  // 审核分数可能来自 0-10 或 0-100 量纲，统一折算后再比较。
  return value <= 10 ? value * 10 : value;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseClock(value: string | undefined): number | null {
  if (!value) return null;
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!matched) return null;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatClock(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(totalMinutes)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function addDays(isoDate: string, offset: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}

function toTimelineNode(draft: NodeDraft, input: ExecutionScheduleInput): TripTimelineNode {
  const node: TripTimelineNode = {
    startTime: formatClock(draft.start),
    endTime: formatClock(draft.end),
    type: draft.type,
    name: draft.name,
    estimatedCost: Math.round(draft.cost),
    navigation: input.navigation ? (input.navigation(draft.name) ?? null) : null,
  };

  if (draft.location) node.location = draft.location;
  if (draft.tips) node.tips = draft.tips;
  if (draft.transportMinutes && draft.transportMinutes > 0) node.transportMinutes = draft.transportMinutes;
  if (draft.stayMinutes && draft.stayMinutes > 0) node.stayMinutes = draft.stayMinutes;

  return node;
}
