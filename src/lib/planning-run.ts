export const PLANNING_STAGES = [
  "route",
  "pois",
  "selection",
  "timeline",
  "prices",
  "budget",
  "narrative",
  "pages",
] as const;

export type PlanningStage = (typeof PLANNING_STAGES)[number];

export type StageStatus = "pending" | "running" | "passed" | "failed" | "degraded";

export type PlanningRun = {
  id: string;
  stages: Record<PlanningStage, { status: StageStatus; error?: string }>;
};

const COMPLETED_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set(["passed", "degraded"]);

export function createPlanningRun(id: string): PlanningRun {
  const stages = {} as PlanningRun["stages"];

  for (const stage of PLANNING_STAGES) {
    stages[stage] = { status: "pending" };
  }

  return { id, stages };
}

export function canStartStage(run: PlanningRun, stage: PlanningStage): boolean {
  const stageIndex = PLANNING_STAGES.indexOf(stage);
  if (run.stages[stage].status !== "pending") return false;

  return PLANNING_STAGES.slice(0, stageIndex).every((previousStage) =>
    COMPLETED_STAGE_STATUSES.has(run.stages[previousStage].status),
  );
}

export function setStageStatus(
  run: PlanningRun,
  stage: PlanningStage,
  status: StageStatus,
  error?: string,
): PlanningRun {
  return {
    ...run,
    stages: {
      ...run.stages,
      [stage]: error === undefined ? { status } : { status, error },
    },
  };
}
