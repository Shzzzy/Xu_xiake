import { AlertCircle, Download, LoaderCircle, RefreshCw } from "lucide-react";
import type { TripPlan } from "@/lib/travel-plan";
import { Button } from "@/components/ui/button";
import { isGuidebookReady } from "@/lib/guidebook-generation";
import { useGuidebookExport } from "./use-guidebook-export";

type ExportGuidebookButtonProps = {
  plan: TripPlan;
};

/**
 * 路书导出按钮。
 *
 * PDF 在结果页出现后自动预生成，按钮旁的进度条反映准备状态；只有文件已经
 * 就绪时才允许下载，避免用户拿到空白或残缺的 PDF。
 */
export function ExportGuidebookButton({ plan }: ExportGuidebookButtonProps) {
  const { state, preparedPdf, regenerate, download } = useGuidebookExport(plan);
  const ready = isGuidebookReady(state) && Boolean(preparedPdf);

  return (
    <div className="flex min-w-[240px] flex-col items-stretch gap-2">
      {ready ? (
        <Button type="button" size="sm" onClick={download}>
          <Download className="size-4" />
          下载路书 PDF
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled>
          {state.stage === "failed" ? (
            <AlertCircle className="size-4" />
          ) : (
            <LoaderCircle className="size-4 animate-spin" />
          )}
          {state.stage === "failed" ? "路书生成失败" : "正在生成路书"}
        </Button>
      )}

      <div className="rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-left">
        <div className="flex items-center justify-between gap-3 text-[11px] leading-5 text-white/80">
          <span className="truncate">{state.message ?? getStageLabel(state.stage)}</span>
          <span className="font-mono">{state.progress}%</span>
        </div>
        <div
          className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/20"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.progress}
          aria-label="路书生成进度"
        >
          <div
            className="h-full rounded-full bg-white transition-[width] duration-500"
            style={{ width: `${state.progress}%` }}
          />
        </div>
        {state.stage === "failed" ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] leading-5 text-white/70">
              可重试生成，或先查看行程页。
            </span>
            <Button type="button" variant="outline" size="sm" onClick={regenerate}>
              <RefreshCw className="size-3.5" />
              重试
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getStageLabel(stage: string): string {
  switch (stage) {
    case "preparing":
      return "正在整理地图与每日资料";
    case "rendering":
      return "正在排版每日行程页面";
    case "finalizing":
      return "正在生成 PDF 文件";
    case "ready":
      return "路书已就绪";
    case "failed":
      return "路书生成失败";
    default:
      return "等待生成路书";
  }
}
