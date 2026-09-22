import { applySuggestedBudget } from "./TravelerBudgetFields";

// 传给预算建议服务的请求体；只描述用到的字段，避免把服务端类型带到客户端。
export type BudgetAdviceInputLike = {
  origin: string;
  destination: string;
  region: string;
  days: number;
  travelers: { adults: number; children: number };
  transportPreference: string;
  roundTrip: boolean;
  returnMode: "scenic" | "fast" | null;
  routeLegs: {
    from: string;
    to: string;
    transport: string;
    kind: "outbound" | "return";
    style: "direct" | "wander";
  }[];
  pace: string;
  interests: string[];
};

// 服务端可能返回的三种结果；这里只依赖回写预算需要的字段。
export type RecommendBudgetResult =
  | { status: "ok"; advice: { total: number } }
  | { status: "needs_configuration"; message: string }
  | { status: "failed"; message: string };

export type BudgetAdviceApplyOutcome =
  | { status: "applied"; total: number }
  | { status: "unavailable" }
  | { status: "failed"; message: string };

// 把「请求 AI 预算建议并回写」的竞态敏感流程抽成纯函数，让普通单元测试能覆盖真正上线的逻辑。
// 约束只要求带 totalBudget：已知目的地表单与未知目的地向导用的是两套 brief 类型。
export async function requestAndApplyBudget<TBrief extends { totalBudget: number }>(input: {
  payload: BudgetAdviceInputLike;
  request: (payload: BudgetAdviceInputLike) => Promise<RecommendBudgetResult>;
  // 必须收到函数式更新，调用方才能基于最新 brief 合并，而不是用点击时的快照回写。
  apply: (updater: (prev: TBrief) => TBrief) => void;
}): Promise<BudgetAdviceApplyOutcome> {
  let result: RecommendBudgetResult;
  try {
    result = await input.request(input.payload);
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "预算建议失败",
    };
  }

  if (result.status === "ok") {
    const total = result.advice.total;
    // 只覆盖总预算，其余字段沿用最新状态；绝不能展开点击时的 brief 快照。
    input.apply((prev) => applySuggestedBudget(prev, total));
    return { status: "applied", total };
  }

  if (result.status === "needs_configuration") {
    // 配置缺失属于部署问题，不把原始提示透给终端用户。
    return { status: "unavailable" };
  }

  return { status: "failed", message: result.message };
}
