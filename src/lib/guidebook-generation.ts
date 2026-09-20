export type GuidebookStageKey =
  "idle" | "preparing" | "rendering" | "finalizing" | "ready" | "failed";

export type GuidebookGenerationState = {
  stage: GuidebookStageKey;
  progress: number;
  message?: string;
};

export type GuidebookStage = {
  key: Exclude<GuidebookStageKey, "failed">;
  label: string;
  progress: number;
};

/**
 * 路书 PDF 的生成阶段。
 *
 * 服务端渲染耗时较长且是单次调用，客户端用这几个阶段表达可见进度：
 * 准备资料 → 渲染页面 → 生成文件 → 可下载。
 */
export const GUIDEBOOK_GENERATION_STAGES: readonly GuidebookStage[] = [
  { key: "idle", label: "等待生成路书", progress: 0 },
  { key: "preparing", label: "正在整理地图与每日资料", progress: 35 },
  { key: "rendering", label: "正在排版每日行程页面", progress: 75 },
  { key: "finalizing", label: "正在生成 PDF 文件", progress: 92 },
  { key: "ready", label: "路书已就绪", progress: 100 },
] as const;

function stageProgress(stage: GuidebookStageKey): number {
  if (stage === "failed") return 0;
  return GUIDEBOOK_GENERATION_STAGES.find((item) => item.key === stage)?.progress ?? 0;
}

export function guidebookStageLabel(stage: GuidebookStageKey): string {
  if (stage === "failed") return "路书生成失败";
  return GUIDEBOOK_GENERATION_STAGES.find((item) => item.key === stage)?.label ?? "等待生成路书";
}

/** 推进生成进度；已到达的阶段不会回退，避免进度条倒退。 */
export function advanceGuidebookProgress(
  state: GuidebookGenerationState,
  stage: GuidebookStageKey,
  message?: string,
): GuidebookGenerationState {
  if (stage === "failed") {
    return {
      stage: "failed",
      progress: Math.min(92, state.progress),
      ...(message ? { message } : {}),
    };
  }

  const next = Math.max(state.progress, stageProgress(stage));
  return { stage, progress: next };
}

export function isGuidebookReady(state: GuidebookGenerationState): boolean {
  return state.stage === "ready" && state.progress >= 100;
}
