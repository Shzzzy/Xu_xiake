import { useCallback, useRef, useState, type RefObject } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { claimCurrentPlan } from "@/lib/entitlements.functions";
import { resolveGuidebookExportGate } from "@/lib/guidebook-access";
import type { TripPlan } from "@/lib/travel-plan";
import { exportGuidebook } from "@/lib/travel-plan.functions";
import {
  advanceGuidebookProgress,
  type GuidebookGenerationState,
} from "@/lib/guidebook-generation";

/** 下载地址保留一段时间，确保浏览器把文件写完再回收。 */
const DOWNLOAD_URL_RELEASE_MS = 60_000;
const PENDING_PLAN_CLAIM_KEY = "xuxiake:pending-plan-claim:v1";

export type PendingPlanClaim = {
  planId: string;
  plan: TripPlan;
};

/** 未登录点击 PDF/分享时，把最终计划暂存在当前标签页，登录回跳后可以领取。 */
export function storePendingPlanClaim(planId: string, plan: TripPlan): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(PENDING_PLAN_CLAIM_KEY, JSON.stringify({ planId, plan }));
}

/** 读取待领取计划；损坏数据直接忽略，不能让登录回跳流程崩溃。 */
export function readPendingPlanClaim(): PendingPlanClaim | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(PENDING_PLAN_CLAIM_KEY) ?? "null",
    ) as PendingPlanClaim | null;
    if (!parsed || typeof parsed.planId !== "string" || !parsed.plan) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingPlanClaim(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(PENDING_PLAN_CLAIM_KEY);
}

function redirectToAuth(): void {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/auth?returnTo=${encodeURIComponent(returnTo)}`);
}

function redirectToPricing(): void {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/pricing?returnTo=${encodeURIComponent(returnTo)}`);
}

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

/**
 * 把预览 iframe 里的路书 HTML 复制到新窗口并调用浏览器打印。
 *
 * 路书 HTML 自带 \`@page{size:A4}\` 与逐页 \`break-after\`，浏览器打印的分页和字体质量
 * 都优于服务端截图方案；同时不依赖任何无头浏览器，serverless 部署也能用。
 */
function printPreviewDocument(frame: HTMLIFrameElement | null): "printed" | "blocked" | "empty" {
  const doc = frame?.contentDocument;
  if (!doc?.documentElement) return "empty";
  const html = "<!doctype html>" + doc.documentElement.outerHTML;
  const printWindow = window.open("", "_blank");
  if (!printWindow) return "blocked";
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();

  const triggerPrint = () => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch {
      // 打印被拦下时保留窗口，用户仍可手动按 Ctrl+P。
    }
  };
  // 图片都是内联 data URL，通常已就绪；等 load 并留一点兜底时间更稳。
  if (printWindow.document.readyState === "complete") {
    window.setTimeout(triggerPrint, 500);
  } else {
    printWindow.addEventListener("load", () => window.setTimeout(triggerPrint, 500), {
      once: true,
    });
  }
  return "printed";
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
export function useGuidebookExport(
  plan: TripPlan,
  previewFrameRef?: RefObject<HTMLIFrameElement | null>,
  planId = "",
): GuidebookExportController {
  const { user, isPending } = useCurrentUserState();
  const exportGuidebookFn = useServerFn(exportGuidebook);
  const claimPlanFn = useServerFn(claimCurrentPlan);
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

    const accessGate = resolveGuidebookExportGate({ isPending, hasUser: Boolean(user) });
    if (accessGate === "wait") {
      toast.info("正在确认账号状态，请稍候。");
      return;
    }
    if (accessGate === "login") {
      if (planId) storePendingPlanClaim(planId, plan);
      redirectToAuth();
      return;
    }

    try {
      if (!planId) throw new Error("缺少行程标识，无法保存路书");
      // 已登录也必须经过服务端幂等 claim：免费首次领取、已保存计划直接通过，未用权益会提示购买。
      await claimPlanFn({ data: { planId, plan } });
    } catch (error) {
      if (error instanceof Error && error.message.includes("免费体验已使用")) {
        toast.info("本次生成尚未保存，请先购买点数后重新生成。");
        redirectToPricing();
        return;
      }
      setState((current) =>
        advanceGuidebookProgress(
          current,
          "failed",
          error instanceof Error ? error.message : "保存路书失败，请重试。",
        ),
      );
      return;
    }

    // 部署到 serverless（如 Netlify）时没有可用的无头浏览器，
    // 直接把预览内容交给用户浏览器的打印功能，质量更好也不需要额外依赖。
    const printResult = printPreviewDocument(previewFrameRef?.current ?? null);
    if (printResult === "printed") {
      setState((current) =>
        advanceGuidebookProgress(current, "ready", "已打开打印窗口，选择「另存为 PDF」即可保存"),
      );
      toast.info("已打开打印窗口，目标选择「另存为 PDF」");
      return;
    }
    if (printResult === "blocked") {
      setState((current) =>
        advanceGuidebookProgress(current, "failed", "浏览器拦截了打印窗口，请允许弹窗后重试"),
      );
      toast.error("请允许本站弹出窗口后重试");
      return;
    }
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
  }, [
    claimPlanFn,
    downloadBlob,
    exportGuidebookFn,
    isPending,
    plan,
    planId,
    previewFrameRef,
    user,
  ]);

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
