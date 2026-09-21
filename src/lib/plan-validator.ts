import type { PlannerSkeleton } from "./planner-skeleton";
import type { Pace } from "./planner";
import type { TransportMode } from "./route-planner";

export type ViolationCode =
  | "TIME_WINDOW"
  | "DAY_COVERAGE"
  | "MISSING_SLOT"
  | "OVER_BUDGET"
  | "OVER_CAPACITY"
  | "PACE_EXCEEDED"
  | "UNKNOWN_PLACE"
  | "TRANSPORT_CONFLICT";

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
    waypoints: string[];
    destination: string;
  };
  candidates: string[];
};

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

// 去除全部空白，用于候选景点的子串匹配。
function normalizeName(value: string): string {
  return value.replace(/\s+/g, "");
}

const slotLabels = { meal: "用餐", hotel: "住宿", rest: "休息" } as const;

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

  // 7. UNKNOWN_PLACE：景点类节点必须能在候选清单中按去空格后的子串匹配。
  const normalizedCandidates = candidates.map(normalizeName);
  for (const day of skeleton.days) {
    day.nodes.forEach((node, nodeIndex) => {
      if (node.type !== "attraction" && node.type !== "night-activity") return;
      const normalized = normalizeName(node.name);
      const known = normalizedCandidates.some(
        (candidate) =>
          candidate.length > 0 && normalized.length > 0 && (candidate.includes(normalized) || normalized.includes(candidate)),
      );
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

  return violations;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

