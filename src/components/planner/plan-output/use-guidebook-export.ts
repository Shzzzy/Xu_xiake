import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { TripPlan } from "@/lib/travel-plan";
import { exportGuidebook } from "@/lib/travel-plan.functions";
import {
  advanceGuidebookProgress,
  type GuidebookGenerationState,
} from "@/lib/guidebook-generation";

/** 下载地址保留一段时间，确保浏览器把文件写完再回收。 */
const DOWNLOAD_URL_RELEASE_MS = 60_000;

type PreparedPdf = {
  filename: string;
  blob: Blob;
  readyAt: number;
};

export type GuidebookExportController = {
  state: GuidebookGenerationState;
  preparedPdf: PreparedPdf | null;
  isGenerating: boolean;
  generate: () => Promise<void>;
  download: () => void;
};

function base64ToPdfBlob(base64: string): Blob {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "application/pdf" });
}

function fallbackPdfFilename(plan: TripPlan): string {
  const rawName = plan.meta.title.trim() || plan.meta.destination.trim() || "旅行路书";
  return `${rawName}_guidebook.pdf`;
}

/**
 * 路书 PDF 导出控制器。
 *
 * PDF 渲染要起一次无头浏览器并拉取静态地图，成本高于页面预览，所以不再随
 * 结果页自动触发：用户点「生成路书 PDF」时才渲染，成功后立刻下载，之后按钮
 * 变成可重复下载。
 */
export function useGuidebookExport(plan: TripPlan): GuidebookExportController {
  const exportGuidebookFn = useServerFn(exportGuidebook);
  const [state, setState] = useState<GuidebookGenerationState>({
    stage: "idle",
    progress: 0,
  });
  const [preparedPdf, setPreparedPdf] = useState<PreparedPdf | null>(null);
  const runRef = useRef(0);

  const downloadBlob = useCallback((file: PreparedPdf) => {
    const url = URL.createObjectURL(file.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_RELEASE_MS);
  }, []);

  const generate = useCallback(async () => {
    const runId = runRef.current + 1;
    runRef.current = runId;
    setPreparedPdf(null);
    setState((current) => advanceGuidebookProgress(current, "preparing"));
    // 服务端单次渲染十几秒，中途没有更细的信号，这里给出可见的阶段推进。
    const finalizeTimer = window.setTimeout(() => {
      if (runRef.current === runId) {
        setState((current) => advanceGuidebookProgress(current, "finalizing"));
      }
    }, 12_000);

    try {
      const result = await exportGuidebookFn({ data: { plan } });
      if (runRef.current !== runId) return;

      if (result.status !== "ok") {
        setState((current) =>
          advanceGuidebookProgress(current, "failed", result.message || "PDF 生成失败，请重试。"),
        );
        return;
      }

      setState((current) => advanceGuidebookProgress(current, "rendering"));
      const blob = base64ToPdfBlob(result.pdfBase64);
      if (blob.size <= 0) {
        setState((current) =>
          advanceGuidebookProgress(current, "failed", "生成的 PDF 为空，请重试。"),
        );
        return;
      }

      const file: PreparedPdf = {
        filename: result.filename || fallbackPdfFilename(plan),
        blob,
        readyAt: Date.now(),
      };
      setPreparedPdf(file);
      setState((current) => advanceGuidebookProgress(current, "ready"));
      downloadBlob(file);
      toast.success("路书 PDF 已开始下载");
    } catch (error) {
      if (runRef.current !== runId) return;
      setState((current) =>
        advanceGuidebookProgress(
          current,
          "failed",
          error instanceof Error ? error.message : "路书生成失败，请重试。",
        ),
      );
    } finally {
      window.clearTimeout(finalizeTimer);
    }
  }, [downloadBlob, exportGuidebookFn, plan]);

  const download = useCallback(() => {
    if (!preparedPdf) {
      toast.info("路书 PDF 还没生成，先点生成。");
      return;
    }
    downloadBlob(preparedPdf);
    toast.success("路书 PDF 已开始下载");
  }, [downloadBlob, preparedPdf]);

  return {
    state,
    preparedPdf,
    isGenerating:
      state.stage === "preparing" || state.stage === "rendering" || state.stage === "finalizing",
    generate,
    download,
  };
}
