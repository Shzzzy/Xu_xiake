import { AlertCircle, Download, FileDown, LoaderCircle, RefreshCw } from "lucide-react";
import type { TripPlan } from "@/lib/travel-plan";
import { Button } from "@/components/ui/button";
import { isGuidebookReady } from "@/lib/guidebook-generation";
import { useGuidebookExport } from "./use-guidebook-export";

type ExportGuidebookButtonProps = {
  plan: TripPlan;
  /** 路书页面还没排完时禁用导出，避免拿到半成品。 */
  disabled?: boolean;
  disabledHint?: string;
};

/**
 * 路书导出按钮。
 *
 * PDF 不再在结果页出现时自动渲染（无头浏览器 + 高德静态地图都要花钱），改为
 * 用户点击后才生成，生成完自动下载，之后按钮可直接重复下载。
 */
export function ExportGuidebookButton({
  plan,
  disabled = false,
  disabledHint,
}: ExportGuidebookButtonProps) {
  const { state, preparedPdf, isGenerating, generate, download } = useGuidebookExport(plan);
  const ready = isGuidebookReady(state) && Boolean(preparedPdf);
  const failed = state.stage === "failed";

  const handleClick = () => {
    if (isGenerating) return;
    if (ready) {
      download();
      return;
    }
    void generate();
  };

  return (
    <div className="flex min-w-[240px] flex-col items-stretch gap-2">
      <Button type="button" size="sm" onClick={handleClick} disabled={disabled || isGenerating}>
        {isGenerating ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : ready ? (
          <Download className="size-4" />
        ) : failed ? (
          <RefreshCw className="size-4" />
        ) : (
          <FileDown className="size-4" />
        )}
        {isGenerating
          ? "正在生成路书 PDF"
          : ready
            ? "下载路书 PDF"
            : failed
              ? "重新生成路书 PDF"
              : "生成路书 PDF"}
      </Button>

      <div className="rounded-lg border border-[var(--v-line)] bg-[var(--v-soft)] px-3 py-2 text-left">
        <div className="flex items-center justify-between gap-3 text-[11px] leading-5 text-[var(--v-muted)]">
          <span className="truncate">
            {disabled && !isGenerating && !ready
              ? (disabledHint ?? "路书页面生成完成后即可导出")
              : (state.message ?? getStageLabel(state.stage))}
          </span>
          <span className="font-mono">{state.progress}%</span>
        </div>
        <div
          className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--v-line)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.progress}
          aria-label="路书 PDF 生成进度"
        >
          <div
            className="h-full bg-[var(--v-accent)] transition-[width] duration-500"
            style={{ width: `${state.progress}%` }}
          />
        </div>
        {failed ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[11px] leading-5 text-[var(--v-muted)]">
              <AlertCircle className="size-3.5" />
              可重试生成。
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void generate()}>
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
      return "路书已就绪，可重复下载";
    case "failed":
      return "路书生成失败";
    default:
      return "点击后生成 PDF";
  }
}
