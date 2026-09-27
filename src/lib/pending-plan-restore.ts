import type { TripBrief as TravelerBudgetTripBrief, TripPlan } from "./travel-plan.ts";
import type { Pace } from "./planner.ts";
import type { ReturnMode, TravelStyle, RouteLegPreference } from "./route-planner.ts";

export type PendingPlanAction = "export" | "share" | "preview";

export type PendingPlanClaim = {
  planId: string;
  requestFingerprint: string;
  entitlementToken: string;
  executionPlan: TripPlan;
  action: PendingPlanAction;
};

export type RestoredTripBrief = TravelerBudgetTripBrief & {
  origin: string;
  destinationId: string;
  destinationName: string;
  latitude?: number;
  longitude?: number;
  startDate: string;
  days: number;
  dailyHours: number;
  pace: Pace;
  interests: string[];
  waypoints: string[];
  roundTrip: boolean;
  returnMode: ReturnMode;
  defaultTravelStyle: TravelStyle;
  legPreferences: Record<string, RouteLegPreference>;
};

export type RestoredPlanResult = {
  screen: "result";
  brief: RestoredTripBrief;
  planId: string;
  action: PendingPlanAction;
  executionPlan: TripPlan;
};

/** 从已生成的 TripPlan 还原结果页最小输入，避免登录回跳后重新生成一遍。 */
export function briefFromPlan(plan: TripPlan): RestoredTripBrief {
  const meta = plan.meta;
  const travelers = meta.travelers ?? { adults: 1, children: 0 };
  const totalTravelers = travelers.adults + travelers.children;
  const totalBudget = plan.budget?.totalBudget ?? meta.perPersonBudget * totalTravelers;
  return {
    origin: meta.origin,
    destinationId: meta.destination,
    destinationName: meta.destination,
    startDate: meta.startDate,
    days: meta.days,
    dailyHours: 8,
    startTime: "09:00",
    endTime: "21:00",
    adults: travelers.adults,
    children: travelers.children,
    totalBudget,
    vehicleEnergy: null,
    pace: meta.pace ?? "balanced",
    interests: meta.interests ?? [],
    waypoints: meta.waypoints ?? [],
    roundTrip: Boolean(plan.route?.returnMode),
    returnMode: plan.route?.returnMode ?? "fast",
    defaultTravelStyle: meta.transportPreference === "speed" ? "direct" : "wander",
    legPreferences: {},
  };
}

/** 登录成功后把待领取计划转换成结果页恢复状态。 */
export function applyPendingPlanRestore(claim: PendingPlanClaim): RestoredPlanResult {
  return {
    screen: "result",
    brief: briefFromPlan(claim.executionPlan),
    planId: claim.planId,
    action: claim.action,
    executionPlan: claim.executionPlan,
  };
}

export function pendingPlanActionLabel(action: PendingPlanAction): string {
  if (action === "export") return "继续导出 PDF";
  if (action === "share") return "继续分享路书";
  return "继续查看路书";
}
