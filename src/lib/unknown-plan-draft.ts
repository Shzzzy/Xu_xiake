import type { TripBrief } from "./travel-plan";

export type UnknownPlanAnswers = {
  mood: string;
  days: number | null;
  pace: string | null;
  interest: string;
  origin: string;
  startDate: string;
  transport: string | null;
  routeMode: string | null;
  confirm: null;
};

export type UnknownPlanDraft = {
  step: number;
  answers: UnknownPlanAnswers;
  travelerInput: TripBrief;
};

export function createUnknownPlanDraft(today: string): UnknownPlanDraft {
  return {
    step: 0,
    answers: {
      mood: "",
      days: null,
      pace: null,
      interest: "",
      origin: "",
      startDate: today,
      transport: null,
      routeMode: null,
      confirm: null,
    },
    travelerInput: {
      startTime: "09:00",
      endTime: "21:00",
      adults: 2,
      children: 0,
      totalBudget: 0,
      vehicleEnergy: null,
    },
  };
}

// 只替换指定字段，保证页面切换时同行、预算和答案草稿继续属于父组件状态。
export function updateUnknownPlanDraft(
  draft: UnknownPlanDraft,
  patch: Partial<UnknownPlanDraft>,
): UnknownPlanDraft {
  return { ...draft, ...patch };
}
