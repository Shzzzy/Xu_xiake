import type { AttractionSelection, PlannerSkeleton } from "./planner-skeleton";
import type { Pace } from "./planner";
import type { TransportMode, TravelStyle } from "./route-planner";

export type ViolationCode =
  | "TIME_WINDOW"
  | "DAY_COVERAGE"
  | "MISSING_SLOT"
  | "OVER_BUDGET"
  | "OVER_CAPACITY"
  | "PACE_EXCEEDED"
  | "UNKNOWN_PLACE"
  | "TRANSPORT_CONFLICT"
  | "SUMMARY_MISMATCH";

export type PlanViolation = {
  code: ViolationCode;
  day?: number;
  nodeIndex?: number;
  message: string;
  detail: { expected: string; actual: string };
};

export type PlanValidationInput = {
  skeleton: PlannerSkeleton;
  brief: {
    days: number;
    startTime: string;
    endTime: string;
    totalBudget: number;
    pace: Pace;
    transport: TransportMode | null;
    style?: TravelStyle;
    waypoints: string[];
    destination: string;
  };
  candidates: string[];
};

// 模型只能引用当前运行候选集合中的 ID，名称联想和即时编造一律拒绝。
export function validateAttractionSelection(
  selection: readonly AttractionSelection[],
  candidateIds: ReadonlySet<string>,
): void {
  for (const item of selection) {
    if (!candidateIds.has(item.candidateId)) {
      throw new Error(`景点选择包含候选集合之外的 candidateId：${item.candidateId}`);
    }
  }
}
// 违规代号对应的中文标签，供提示条与重排指令复用。
const violationLabels: Record<ViolationCode, string> = {
  TIME_WINDOW: "时间",
  DAY_COVERAGE: "天数",
  MISSING_SLOT: "缺少节点",
  OVER_BUDGET: "预算",
  OVER_CAPACITY: "容量",
  PACE_EXCEEDED: "节奏",
  UNKNOWN_PLACE: "地点",
  TRANSPORT_CONFLICT: "交通",
  SUMMARY_MISMATCH: "摘要",
};

// 把违规清单格式化成逐行中文，同时给出「期望 / 实际」差值供模型重排。
export function violationSummary(violations: PlanViolation[]): string {
  if (violations.length === 0) return "本次未发现违规。";

  return violations
    .map((violation) => {
      const scope = [
        violation.day === undefined ? "" : `第 ${violation.day} 天`,
        violation.nodeIndex === undefined ? "" : `第 ${violation.nodeIndex + 1} 个节点`,
      ]
        .filter((part) => part.length > 0)
        .join(" ");
      const prefix = scope.length > 0 ? `${scope} ` : "";
      const detail = `（期望 ${violation.detail.expected}，实际 ${violation.detail.actual}）`;
      return `- [${violationLabels[violation.code]}] ${prefix}${violation.message}${detail}`;
    })
    .join("\n");
}

// planner.ts 的 PACE_LIMIT 未导出，这里只能重复一份并保持数值一致，避免跨文件引用私有常量。
const PACE_LIMIT: Record<Pace, number> = { relaxed: 2, balanced: 3, deep: 4 };

// 校验 HH:MM 的时钟语义，而不只是格式：24:00、12:60、99:99 都视为无效。
function minutesOf(value: string): number | null {
  const matched = /^(\d{2}):(\d{2})$/.exec(value);
  if (!matched) return null;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// 候选景点的合法后缀白名单：只允许节点名与候选名完全相等，
// 或其中一方仅在另一方基础上追加这些常见后缀（例如「宏村」→「宏村古村落」）。
// 除此之外的加长名（如「宏村旁边凭空古城」）一律视为编造景点。
const KNOWN_PLACE_SUFFIXES = [
  "风景区", "景区", "旅游区", "保护区", "自然保护区",
  "古镇", "古村落", "古村", "古城", "古街", "老街", "步行街",
  "公园", "森林公园", "湿地公园", "植物园", "动物园",
  "博物馆", "纪念馆", "文化馆", "艺术馆", "美术馆",
  "广场", "温泉", "索道", "观景台", "大峡谷", "峡谷", "瀑布",
  "雪山", "冰川", "草原", "沙漠", "石窟", "遗址", "村落", "度假区", "度假村", "山庄",
];

// 去除全部空白，用于候选景点的名称归一化。
function normalizeName(value: string): string {
  return value.replace(/\s+/g, "");
}

// 判断节点名是否来自候选景点：要求完全相等，或只差一个白名单后缀。
function isKnownPlace(normalizedName: string, normalizedCandidates: string[]): boolean {
  if (normalizedName.length === 0) return false;
  return normalizedCandidates.some((candidate) => {
    if (candidate.length === 0) return false;
    if (candidate === normalizedName) return true;
    if (
      normalizedName.startsWith(candidate) &&
      KNOWN_PLACE_SUFFIXES.includes(normalizedName.slice(candidate.length))
    ) {
      return true;
    }
    if (
      candidate.startsWith(normalizedName) &&
      KNOWN_PLACE_SUFFIXES.includes(candidate.slice(normalizedName.length))
    ) {
      return true;
    }
    return false;
  });
}

const slotLabels = { meal: "用餐", hotel: "住宿", rest: "休息" } as const;

// 两个已归一化名称是否互为同一景点：完全相等，或只差白名单后缀。
function namesCompatible(left: string, right: string): boolean {
  return left === right || isKnownPlace(left, [right]) || isKnownPlace(right, [left]);
}

/**
 * 摘要与排程的一致性守卫：只用可确定的候选名/节点名做子串匹配，不做自由中文切词，
 * 因此能确定性地发现「摘要提到未排景点」与「摘要漏掉已排景点」。
 */
export function validateSummaryConsistency(
  skeleton: PlannerSkeleton,
  candidates: string[],
): PlanViolation[] {
  const violations: PlanViolation[] = [];
  const summary = normalizeName(skeleton.summary);
  const normalizedCandidates = candidates.map(normalizeName).filter((name) => name.length > 0);
  const attractionNodes = skeleton.days.flatMap((day) =>
    day.nodes.filter((node) => node.type === "attraction" || node.type === "night-activity"),
  );
  const scheduledNames = [
    ...new Set(attractionNodes.map((node) => normalizeName(node.name)).filter((name) => name.length > 0)),
  ];

  // 摘要中出现的候选名必须有排程景点兜底，否则就是「提到未排景点」。
  for (const candidate of normalizedCandidates) {
    if (!summary.includes(candidate)) continue;
    const scheduled = scheduledNames.some((name) => namesCompatible(name, candidate));
    if (!scheduled) {
      violations.push({
        code: "SUMMARY_MISMATCH",
        message: `摘要提到未排入行程的景点「${candidate}」`,
        detail: { expected: "摘要与排程一致", actual: `摘要出现「${candidate}」，排程无此景点` },
      });
    }
  }

  // 每个已排景点都必须能在摘要里按节点名或候选别名找到。
  const seenScheduled = new Set<string>();
  for (const node of attractionNodes) {
    const name = normalizeName(node.name);
    if (name.length === 0 || seenScheduled.has(name)) continue;
    seenScheduled.add(name);
    if (summary.includes(name)) continue;
    const mentionedByAlias = normalizedCandidates.some(
      (candidate) => namesCompatible(name, candidate) && summary.includes(candidate),
    );
    if (!mentionedByAlias) {
      violations.push({
        code: "SUMMARY_MISMATCH",
        message: `摘要未提及排程景点「${node.name}」`,
        detail: { expected: `摘要提及「${node.name}」`, actual: "摘要缺失" },
      });
    }
  }

  return violations;
}


export function validateSkeleton(input: PlanValidationInput): PlanViolation[] {
  const violations: PlanViolation[] = [];
  const { skeleton, brief, candidates } = input;

  const windowStart = minutesOf(brief.startTime);
  const windowEnd = minutesOf(brief.endTime);
  const windowMinutes =
    windowStart !== null && windowEnd !== null && windowEnd > windowStart ? windowEnd - windowStart : 0;

  // 1. TIME_WINDOW：解析失败、越界、与前一节点重叠，各报一条。
  for (const day of skeleton.days) {
    let previousEnd: number | null = null;
    day.nodes.forEach((node, nodeIndex) => {
      const start = minutesOf(node.startTime);
      const end = minutesOf(node.endTime);

      if (start === null) {
        violations.push({
          code: "TIME_WINDOW",
          day: day.day,
          nodeIndex,
          message: `开始时间 ${node.startTime} 不是有效时间`,
          detail: { expected: "HH:MM（00:00–23:59）", actual: node.startTime },
        });
      }
      if (end === null) {
        violations.push({
          code: "TIME_WINDOW",
          day: day.day,
          nodeIndex,
          message: `结束时间 ${node.endTime} 不是有效时间`,
          detail: { expected: "HH:MM（00:00–23:59）", actual: node.endTime },
        });
      }
      if (start !== null && end !== null && end <= start) {
        violations.push({
          code: "TIME_WINDOW",
          day: day.day,
          nodeIndex,
          message: `开始时间 ${node.startTime} 不早于结束时间 ${node.endTime}`,
          detail: { expected: "结束时间晚于开始时间", actual: `${node.startTime}–${node.endTime}` },
        });
      }
      if (start !== null && windowStart !== null && start < windowStart) {
        violations.push({
          code: "TIME_WINDOW",
          day: day.day,
          nodeIndex,
          message: `开始时间 ${node.startTime} 早于你设定的 ${brief.startTime}`,
          detail: { expected: `≥${brief.startTime}`, actual: node.startTime },
        });
      }
      if (end !== null && windowEnd !== null && end > windowEnd) {
        violations.push({
          code: "TIME_WINDOW",
          day: day.day,
          nodeIndex,
          message: `结束时间 ${node.endTime} 晚于你设定的 ${brief.endTime}`,
          detail: { expected: `≤${brief.endTime}`, actual: node.endTime },
        });
      }
      if (start !== null && previousEnd !== null && start < previousEnd) {
        violations.push({
          code: "TIME_WINDOW",
          day: day.day,
          nodeIndex,
          message: "与前一节点时间重叠",
          detail: { expected: `≥${formatMinutes(previousEnd)}`, actual: node.startTime },
        });
      }

      if (end !== null) previousEnd = end;
    });
  }

  // 2. DAY_COVERAGE：天数不一致一条；某天没有非休息节点时一天一条。
  if (skeleton.days.length !== brief.days) {
    violations.push({
      code: "DAY_COVERAGE",
      message: "行程天数与设定不符",
      detail: { expected: `${brief.days} 天`, actual: `${skeleton.days.length} 天` },
    });
  }
  // 骨架 day 编号必须按 1..N 连续；下游日期/天气/违规映射都依赖数字编号。
  skeleton.days.forEach((day, index) => {
    const expectedDay = index + 1;
    if (day.day !== expectedDay) {
      violations.push({
        code: "DAY_COVERAGE",
        day: day.day,
        message: `第 ${expectedDay} 个骨架日的 day 编号为 ${day.day}，应按 1..${skeleton.days.length} 连续编号`,
        detail: { expected: `day=${expectedDay}`, actual: `day=${day.day}` },
      });
    }
  });
  for (const day of skeleton.days) {
    const hasActiveNode = day.nodes.some((node) => node.type !== "rest");
    if (!hasActiveNode) {
      violations.push({
        code: "DAY_COVERAGE",
        day: day.day,
        message: `第 ${day.day} 天没有可执行的行程节点`,
        detail: { expected: "至少 1 个非休息节点", actual: "0 个非休息节点" },
      });
    }
    const hasCoreAttraction = day.nodes.some(
      (node) => node.type === "attraction" || node.type === "night-activity",
    );
    // 只有“边走边玩”要求每天有景点；“直达”由模型按到达后的剩余时间决定。
    if (brief.style === "wander" && !hasCoreAttraction) {
      violations.push({
        code: "DAY_COVERAGE",
        day: day.day,
        message: `第 ${day.day} 天未按边走边玩安排核心景点`,
        detail: { expected: "至少 1 个景点或夜游节点", actual: "0 个景点节点" },
      });
    }
  }

  // 3. MISSING_SLOT：每天必须包含用餐、住宿、休息，缺哪个报哪个。
  for (const day of skeleton.days) {
    const nodeTypes = new Set(day.nodes.map((node) => node.type));
    for (const slot of ["meal", "hotel", "rest"] as const) {
      if (!nodeTypes.has(slot)) {
        violations.push({
          code: "MISSING_SLOT",
          day: day.day,
          message: `第 ${day.day} 天缺少${slotLabels[slot]}节点`,
          detail: { expected: `${slotLabels[slot]}节点`, actual: "缺失" },
        });
      }
    }
  }

  // 4. OVER_BUDGET：全部节点花费求和，超过总预算报一条。
  const totalCost = skeleton.days.reduce(
    (dayTotal, day) => dayTotal + day.nodes.reduce((nodeTotal, node) => nodeTotal + node.estimatedCost, 0),
    0,
  );
  if (totalCost > brief.totalBudget) {
    violations.push({
      code: "OVER_BUDGET",
      message: "总预算超支",
      detail: { expected: `≤${brief.totalBudget} 元`, actual: `${totalCost} 元` },
    });
  }

  // 5. OVER_CAPACITY：当天景点停留总时长不得超过窗口扣除用餐/休息/交通后的余量。
  const baseCapacity = Math.max(0, windowMinutes - 60 - 30);
  for (const day of skeleton.days) {
    const transportMinutes = day.nodes.reduce((total, node) => total + (node.transportMinutes ?? 0), 0);
    const availableMinutes = Math.max(0, baseCapacity - transportMinutes);
    const stayTotal = day.nodes
      .filter((node) => node.type === "attraction" || node.type === "night-activity")
      .reduce((total, node) => total + (node.stayMinutes ?? 0), 0);
    if (stayTotal > availableMinutes) {
      violations.push({
        code: "OVER_CAPACITY",
        day: day.day,
        message: `第 ${day.day} 天容量超限`,
        detail: { expected: `≤${availableMinutes} 分钟`, actual: `${stayTotal} 分钟` },
      });
    }
  }

  // 6. PACE_EXCEEDED：当天景点数量超过节奏上限报一条。
  const paceLimit = PACE_LIMIT[brief.pace];
  for (const day of skeleton.days) {
    const attractionCount = day.nodes.filter(
      (node) => node.type === "attraction" || node.type === "night-activity",
    ).length;
    if (attractionCount > paceLimit) {
      violations.push({
        code: "PACE_EXCEEDED",
        day: day.day,
        message: `第 ${day.day} 天景点数量超过节奏限制`,
        detail: { expected: `≤${paceLimit} 个`, actual: `${attractionCount} 个` },
      });
    }
  }

  // 7. UNKNOWN_PLACE：节点名必须与候选名完全相等，或仅差一个白名单后缀。
  const normalizedCandidates = candidates.map(normalizeName);
  for (const day of skeleton.days) {
    day.nodes.forEach((node, nodeIndex) => {
      if (node.type !== "attraction" && node.type !== "night-activity") return;
      const normalized = normalizeName(node.name);
      const known = isKnownPlace(normalized, normalizedCandidates);
      if (!known) {
        violations.push({
          code: "UNKNOWN_PLACE",
          day: day.day,
          nodeIndex,
          message: `景点「${node.name}」不在候选清单内`,
          detail: { expected: "候选景点", actual: node.name },
        });
      }
    });
  }

  // 8. TRANSPORT_CONFLICT：设定了交通方式时，节点里出现不匹配的方式报一条。
  if (brief.transport) {
    outer: for (const day of skeleton.days) {
      for (const [nodeIndex, node] of day.nodes.entries()) {
        if (node.transportMode && node.transportMode !== brief.transport) {
          violations.push({
            code: "TRANSPORT_CONFLICT",
            day: day.day,
            nodeIndex,
            message: "交通方式与设定不一致",
            detail: { expected: brief.transport, actual: node.transportMode },
          });
          break outer;
        }
      }
    }
  }

  // 摘要一致性放在最后：先让结构/预算等硬违规显形，再判定摘要是否与最终骨架一致。
  violations.push(...validateSummaryConsistency(skeleton, candidates));

  return violations;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

