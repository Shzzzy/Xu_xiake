import { useCallback, useEffect, useRef, useState } from "react";
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
  regenerate: () => void;
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
 * 生成前先缓存 PDF，避免下载时才现场渲染。
 *
 * 服务端渲染一次约十几秒，如果放到点击下载时再执行，大文件在传输中容易被
 * 截断，用户会拿到空白或残缺文件。这里改成结果页出现后自动预生成，下载时
 * 只取已经准备好的 Blob。
 */
export function useGuidebookExport(plan: TripPlan): GuidebookExportController {
  const exportGuidebookFn = useServerFn(exportGuidebook);
  const [state, setState] = useState<GuidebookGenerationState>({
    stage: "idle",
    progress: 0,
  });
  const [preparedPdf, setPreparedPdf] = useState<PreparedPdf | null>(null);
  const runRef = useRef(0);

  const generate = useCallback(async () => {
    const runId = runRef.current + 1;
    runRef.current = runId;
    setPreparedPdf(null);
    setState((current) => advanceGuidebookProgress(current, "preparing"));
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

      setPreparedPdf({ filename: result.filename, blob, readyAt: Date.now() });
      setState((current) => advanceGuidebookProgress(current, "ready"));
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
  }, [exportGuidebookFn, plan]);

  const planKey = JSON.stringify({
    title: plan.meta.title,
    origin: plan.meta.origin,
    waypoints: plan.meta.waypoints,
    destination: plan.meta.destination,
    startDate: plan.meta.startDate,
    days: plan.meta.days,
    travelers: plan.meta.travelers,
    nodeCount: plan.days.reduce((total, day) => total + day.nodes.length, 0),
    estimatedTotal: plan.budget.estimatedTotal,
  });
  const planKeyRef = useRef("");

  // 结果页出现后立即预生成；行程内容变化时才重新生成，避免父级重渲染触发重复请求。
  useEffect(() => {
    if (planKeyRef.current === planKey) return;
    planKeyRef.current = planKey;
    void generate();
  }, [generate, planKey]);

  const regenerate = useCallback(() => {
    void generate();
  }, [generate]);

  const download = useCallback(() => {
    if (!preparedPdf) {
      toast.info("路书还在生成中，完成后即可下载。");
      return;
    }

    const url = URL.createObjectURL(preparedPdf.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = preparedPdf.filename || fallbackPdfFilename(plan);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_RELEASE_MS);
    toast.success("路书 PDF 已开始下载");
  }, [plan, preparedPdf]);

  return { state, preparedPdf, regenerate, download };
}
