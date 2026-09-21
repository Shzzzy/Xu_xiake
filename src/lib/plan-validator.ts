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
