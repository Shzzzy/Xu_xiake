import { useCallback, useRef, useState, type RefObject } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { ensurePlanExportableFn } from "@/lib/entitlements.functions";
import {
  resetGuidebookExportAfterPendingAuth,
  resolveGuidebookExportGate,
} from "@/lib/guidebook-access";
import type { TripPlan } from "@/lib/travel-plan";
import { exportGuidebook } from "@/lib/travel-plan.functions";
import type { PendingPlanAction, PendingPlanClaim } from "@/lib/pending-plan-restore";
import {
  advanceGuidebookProgress,
  type GuidebookGenerationState,
} from "@/lib/guidebook-generation";

/** 下载地址保留一段时间，确保浏览器把文件写完再回收。 */
const DOWNLOAD_URL_RELEASE_MS = 60_000;
const PENDING_PLAN_CLAIM_KEY = "xuxiake:pending-plan-claim:v1";

export type { PendingPlanAction, PendingPlanClaim } from "@/lib/pending-plan-restore";

type StoredPendingPlanClaim = Omit<PendingPlanClaim, "executionPlan"> & {
  executionPlan?: TripPlan;
  /** 兼容第二轮已写入 sessionStorage 的旧字段。 */
  plan?: TripPlan;
};

/** 未登录点击 PDF/分享时，把最终计划暂存在当前标签页，登录回跳后可以领取。 */
export function storePendingPlanClaim(
  planId: string,
  executionPlan: TripPlan,
  entitlementToken: string,
  requestFingerprint = planId,
  action: PendingPlanAction = "export",
  draftId?: string,
): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(
    PENDING_PLAN_CLAIM_KEY,
    JSON.stringify({ planId, requestFingerprint, entitlementToken, draftId, executionPlan, action }),
  );
}

/** 读取待领取计划；损坏数据直接忽略，不能让登录回跳流程崩溃。 */
export function readPendingPlanClaim(): PendingPlanClaim | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(PENDING_PLAN_CLAIM_KEY) ?? "null",
    ) as StoredPendingPlanClaim | null;
    const executionPlan = parsed?.executionPlan ?? parsed?.plan;
    if (
      !parsed ||
      typeof parsed.planId !== "string" ||
      typeof parsed.requestFingerprint !== "string" ||
      typeof parsed.entitlementToken !== "string" ||
      !executionPlan ||
      (parsed.action !== "finalize" &&
        parsed.action !== "export" &&
        parsed.action !== "share" &&
        parsed.action !== "preview")
    ) {
      return null;
    }
    return {
      planId: parsed.planId,
      requestFingerprint: parsed.requestFingerprint,
      entitlementToken: parsed.entitlementToken,
      draftId: parsed.draftId,
      executionPlan,
      action: parsed.action,
    };
  } catch {
    return null;
  }
}

export function clearPendingPlanClaim(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(PENDING_PLAN_CLAIM_KEY);
}

function isUnauthorizedExportError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; message?: unknown };
  return (
    candidate.status === 401 ||
    (typeof candidate.message === "string" && /unauthorized/i.test(candidate.message))
  );
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
type PreviewPrintResult = "printed" | "blocked" | "empty";

export function printPreviewDocument(frame: HTMLIFrameElement | null): PreviewPrintResult {
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

type GuidebookPdfResult =
  | { status: "ok"; pdfBase64: string; filename?: string }
  | { status: "html"; html: string; message?: string }
  | { status: "failed"; message?: string };

export type GuidebookExportAttemptDeps = {
  isPending: boolean;
  hasUser: boolean;
  plan: TripPlan;
  planId: string;
  entitlementToken: string;
  requestFingerprint: string;
  previewFrame?: HTMLIFrameElement | null;
  ensureExport: (input: {
    data: {
      planId: string;
      requestFingerprint: string;
      entitlementToken: string;
      plan: TripPlan;
    };
  }) => Promise<unknown>;
  exportPdf: (input: { data: { planId: string } }) => Promise<GuidebookPdfResult>;
  printDocument?: (frame: HTMLIFrameElement | null) => PreviewPrintResult;
  createPdfBlob?: (base64: string) => Blob;
  storePending?: typeof storePendingPlanClaim;
  redirectAuth?: () => void;
  redirectPricing?: () => void;
  now?: () => number;
};

export type GuidebookExportAttemptResult = {
  state: GuidebookGenerationState;
  preparedPdf: PreparedPdf | null;
  redirect: "auth" | "pricing" | null;
  notice?: { type: "info" | "success" | "error"; message: string };
};

/** 导出控制器：从登录闸门、权益幂等到打印或 PDF 下载共用同一条可测试路径。 */
export async function runGuidebookExportAttempt(
  deps: GuidebookExportAttemptDeps,
): Promise<GuidebookExportAttemptResult> {
  let state = advanceGuidebookProgress({ stage: "idle", progress: 0 }, "preparing");
  if (deps.isPending) {
    return {
      state: resetGuidebookExportAfterPendingAuth(),
      preparedPdf: null,
      redirect: null,
      notice: { type: "info", message: "账号状态仍在确认，已重置导出状态，请稍后重试。" },
    };
  }

  if (!deps.hasUser) {
    if (deps.planId && deps.plan) {
      (deps.storePending ?? storePendingPlanClaim)(
        deps.planId,
        deps.plan,
        deps.entitlementToken,
        deps.requestFingerprint,
        "export",
      );
    }
    (deps.redirectAuth ?? redirectToAuth)();
    return {
      state: resetGuidebookExportAfterPendingAuth(),
      preparedPdf: null,
      redirect: "auth",
      notice: { type: "info", message: "路书已暂存，登录后可继续导出。" },
    };
  }

  if (!deps.planId || !deps.entitlementToken) {
    return {
      state: advanceGuidebookProgress(state, "failed", "缺少生成权益凭证，无法保存路书"),
      preparedPdf: null,
      redirect: null,
      notice: { type: "error", message: "缺少生成权益凭证，无法保存路书" },
    };
  }

  try {
    await deps.ensureExport({
      data: {
        planId: deps.planId,
        requestFingerprint: deps.requestFingerprint,
        entitlementToken: deps.entitlementToken,
        plan: deps.plan,
      },
    });
  } catch (error) {
    if (isUnauthorizedExportError(error)) {
      if (deps.planId && deps.plan) {
        (deps.storePending ?? storePendingPlanClaim)(
          deps.planId,
          deps.plan,
          deps.entitlementToken,
          deps.requestFingerprint,
          "export",
        );
      }
      (deps.redirectAuth ?? redirectToAuth)();
      return {
        state: resetGuidebookExportAfterPendingAuth(),
        preparedPdf: null,
        redirect: "auth",
        notice: { type: "info", message: "登录状态已失效，路书已暂存，请重新登录后继续导出。" },
      };
    }
    if (error instanceof Error && error.message.includes("免费体验已使用")) {
      (deps.redirectPricing ?? redirectToPricing)();
      return {
        state: resetGuidebookExportAfterPendingAuth(),
        preparedPdf: null,
        redirect: "pricing",
        notice: { type: "info", message: "本次生成尚未保存，请先购买点数后重新生成。" },
      };
    }
    const message = error instanceof Error ? error.message : "保存路书失败，请重试。";
    return {
      state: advanceGuidebookProgress(state, "failed", message),
      preparedPdf: null,
      redirect: null,
      notice: { type: "error", message },
    };
  }

  const printResult = (deps.printDocument ?? printPreviewDocument)(deps.previewFrame ?? null);
  if (printResult === "printed") {
    return {
      state: advanceGuidebookProgress(state, "ready", "已打开打印窗口，选择「另存为 PDF」即可保存"),
      preparedPdf: null,
      redirect: null,
      notice: { type: "success", message: "已打开打印窗口，目标选择「另存为 PDF」" },
    };
  }
  if (printResult === "blocked") {
    const message = "浏览器拦截了打印窗口，请允许弹窗后重试";
    return {
      state: advanceGuidebookProgress(state, "failed", message),
      preparedPdf: null,
      redirect: null,
      notice: { type: "error", message },
    };
  }

  try {
    const result = await deps.exportPdf({ data: { planId: deps.planId } });
    if (result.status !== "ok") {
      const message = result.message || "PDF 生成失败，请重试。";
      if (/unauthorized/i.test(message)) {
        if (deps.planId && deps.plan) {
          (deps.storePending ?? storePendingPlanClaim)(
            deps.planId,
            deps.plan,
            deps.entitlementToken,
            deps.requestFingerprint,
            "export",
          );
        }
        (deps.redirectAuth ?? redirectToAuth)();
        return {
          state: resetGuidebookExportAfterPendingAuth(),
          preparedPdf: null,
          redirect: "auth",
          notice: { type: "info", message: "登录状态已失效，路书已暂存，请重新登录后继续导出。" },
        };
      }
      return {
        state: advanceGuidebookProgress(state, "failed", message),
        preparedPdf: null,
        redirect: null,
        notice: { type: "error", message },
      };
    }
    const blob = (deps.createPdfBlob ?? base64ToPdfBlob)(result.pdfBase64);
    if (blob.size <= 0) {
      const message = "生成的 PDF 为空，请重试。";
      return {
        state: advanceGuidebookProgress(state, "failed", message),
        preparedPdf: null,
        redirect: null,
        notice: { type: "error", message },
      };
    }
    return {
      state: advanceGuidebookProgress(state, "ready"),
      preparedPdf: {
        filename: result.filename || fallbackPdfFilename(deps.plan),
        blob,
        readyAt: (deps.now ?? Date.now)(),
      },
      redirect: null,
    };
  } catch (error) {
    if (isUnauthorizedExportError(error)) {
      if (deps.planId && deps.plan) {
        (deps.storePending ?? storePendingPlanClaim)(
          deps.planId,
          deps.plan,
          deps.entitlementToken,
          deps.requestFingerprint,
          "export",
        );
      }
      (deps.redirectAuth ?? redirectToAuth)();
      return {
        state: resetGuidebookExportAfterPendingAuth(),
        preparedPdf: null,
        redirect: "auth",
        notice: { type: "info", message: "登录状态已失效，路书已暂存，请重新登录后继续导出。" },
      };
    }
    const message = error instanceof Error ? error.message : "路书生成失败，请重试。";
    return {
      state: advanceGuidebookProgress(state, "failed", message),
      preparedPdf: null,
      redirect: null,
      notice: { type: "error", message },
    };
  }
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
  entitlementToken = "",
  requestFingerprint = planId,
): GuidebookExportController {
  const { user, isPending } = useCurrentUserState();
  const exportGuidebookFn = useServerFn(exportGuidebook);
  const ensureExportFn = useServerFn(ensurePlanExportableFn);
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

    const result = await runGuidebookExportAttempt({
      isPending,
      hasUser: Boolean(user),
      plan,
      planId,
      entitlementToken,
      requestFingerprint,
      previewFrame: previewFrameRef?.current ?? null,
      ensureExport: ensureExportFn,
      exportPdf: exportGuidebookFn,
    });
    if (runRef.current !== runId) return;

    setState(result.state);
    setPreparedPdf(result.preparedPdf);
    if (result.notice) {
      if (result.notice.type === "success") toast.success(result.notice.message);
      else if (result.notice.type === "error") toast.error(result.notice.message);
      else toast.info(result.notice.message);
    }
    if (result.preparedPdf) downloadBlob(result.preparedPdf);
  }, [
    downloadBlob,
    ensureExportFn,
    entitlementToken,
    exportGuidebookFn,
    isPending,
    plan,
    planId,
    previewFrameRef,
    requestFingerprint,
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
