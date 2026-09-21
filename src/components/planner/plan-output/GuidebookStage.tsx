import type { ReactNode } from "react";

export type GuidebookStageState = "idle" | "loading" | "ready" | "fallback";

type GuidebookStageProps = {
  state: GuidebookStageState;
  message: string;
  children: ReactNode;
};

/**
 * 路书预览的挂载闸门：只有 ready 状态允许插进 iframe 预览。
 * fallback 只展示错误/配置提示，避免本地兜底路书被误当成可导出的正式结果。
 */
export function GuidebookStage({ state, message, children }: GuidebookStageProps) {
  if (state === "ready") return <>{children}</>;

  const loading = state === "idle" || state === "loading";
  return (
    <div
      role={state === "fallback" ? "alert" : "status"}
      className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-soft)] px-4 py-3 text-xs leading-6 text-[var(--v-muted)]"
    >
      {loading ? "正在加载路书预览…" : message || "当前路书未能生成，请检查配置后重试。"}
    </div>
  );
}
