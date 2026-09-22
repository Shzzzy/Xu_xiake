import { useEffect, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

export type GuidebookStageState = "idle" | "loading" | "ready" | "fallback";

// 生成期间轮播的进度文案：让用户知道系统正在做什么，而不是只看一句静止的加载提示。
const LOADING_STEPS = [
  "正在查看地图…",
  "正在思考旅行路线…",
  "正在询问当地导游…",
  "正在规划每日饮食…",
  "正在核对预算与时间…",
  "正在撰写旅书…",
];

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
  const loading = state === "idle" || state === "loading";
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => {
      setStep((value) => (value + 1) % LOADING_STEPS.length);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [loading]);

  if (state === "ready") return <>{children}</>;

  return (
    <div
      role={state === "fallback" ? "alert" : "status"}
      className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-soft)] px-4 py-3 text-xs leading-6 text-[var(--v-muted)]"
    >
      {loading ? (
        <span className="flex items-center gap-2" aria-live="polite">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-[var(--v-accent)]" />
          <span key={step} className="transition-opacity duration-200">
            {LOADING_STEPS[step]}
          </span>
        </span>
      ) : (
        message || "当前路书未能生成，请检查配置后重试。"
      )}
    </div>
  );
}
