import { useEffect, useRef, useState, type RefObject } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertCircle, LoaderCircle } from "lucide-react";
import {
  acceptGuidebookPage,
  createGuidebookPageAcceptanceState,
  type GuidebookPageAcceptanceState,
  verifyGuidebookPageChecksum,
} from "@/lib/guidebook-page-protocol";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { sharePlan } from "@/lib/shares.functions";
import type { TripPlan } from "@/lib/travel-plan";
import { ExportGuidebookButton } from "./ExportGuidebookButton";
import { printPreviewDocument } from "./use-guidebook-export";

export const GUIDEBOOK_PREVIEW_SHELL_CLASS =
  "guidebook-preview-scroll guidebook-preview-shell relative w-full overflow-y-auto overflow-x-hidden";
export const GUIDEBOOK_PREVIEW_FRAME_CLASS =
  "guidebook-preview-frame overflow-hidden border-0 bg-transparent shadow-none";
export const GUIDEBOOK_PREVIEW_SCROLLING = "no";
/** 预览纸张宽度：与 A4 的 210mm 等宽，保证屏幕预览和 PDF 排版一致。 */
const PAPER_WIDTH_PX = 900;

type StreamEvent =
  | { type: "meta"; runId: string; total: number; title: string; head: string }
  | {
      type: "page";
      runId: string;
      index: number;
      id: string;
      label: string;
      checksum: string;
      html: string;
    }
  | { type: "error"; runId: string; message: string };

export async function assertGuidebookPageChecksum(html: string, checksum: string): Promise<void> {
  if (!(await verifyGuidebookPageChecksum(html, checksum))) {
    throw new Error("路书页面 checksum 校验失败，已停止预览。");
  }
}

export function shouldHandleStreamEvent(input: {
  eventRunId: string;
  latestRunId: string;
  cancelled: boolean;
}): boolean {
  return !input.cancelled && input.eventRunId === input.latestRunId;
}

export function shouldAcceptPage(input: {
  runId: string;
  latestRunId: string;
  index: number;
  checksum: string;
  state: GuidebookPageAcceptanceState;
}): boolean {
  if (input.runId !== input.latestRunId) return false;
  return acceptGuidebookPage(input.state, {
    runId: input.runId,
    index: input.index,
    checksum: input.checksum,
  });
}

/**
 * 路书逐页预览。
 *
 * 服务端按页推送 NDJSON，每收到一页就追加进同源 iframe，因此用户能一页页看到
 * 路书成形；全部页面到齐后才允许导出 PDF。
 */
export function GuidebookPreview({
  plan,
  planId,
  entitlementToken = "",
  requestFingerprint = planId,
  draftId,
  runId,
  shareToken = "",
  readOnly = false,
  onReady,
  onError,
}: {
  plan: TripPlan;
  planId: string;
  entitlementToken?: string;
  requestFingerprint?: string;
  draftId?: string;
  runId?: string;
  shareToken?: string;
  readOnly?: boolean;
  onReady?: (info: { pageCount: number }) => void;
  onError?: (message: string) => void;
}) {
  const { user } = useCurrentUserState();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const latestRunIdRef = useRef("");
  const pageStateRef = useRef<GuidebookPageAcceptanceState>(createGuidebookPageAcceptanceState(""));
  const [total, setTotal] = useState(0);
  const [received, setReceived] = useState(0);
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const planKey = JSON.stringify(plan);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useEffect(() => {
    const frame = frameRef.current;
    const stage = stageRef.current;
    const shell = shellRef.current;
    if (!frame || !stage || !shell) return;

    let cancelled = false;
    const requestRunId =
      runId?.trim() ||
      globalThis.crypto?.randomUUID?.() ||
      `guidebook-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    latestRunIdRef.current = requestRunId;
    pageStateRef.current = createGuidebookPageAcceptanceState(requestRunId);
    const controller = new AbortController();
    let bodyObserver: ResizeObserver | null = null;
    let shellObserver: ResizeObserver | null = null;

    setTotal(0);
    setReceived(0);
    setLabel(null);
    setError(null);
    frame.dataset.contentHeight = "";

    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const height = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
      if (height <= 0) return;
      frame.dataset.contentHeight = String(height);
      applyScale();
    };

    const applyScale = () => {
      const width = shell.clientWidth;
      const contentHeight = Number(frame.dataset.contentHeight ?? "0");
      const nextScale = width > 0 ? Math.min(1, width / PAPER_WIDTH_PX) : 1;
      // 缩放只改视觉，因此外层容器必须同步改成缩放后的高度，
      // 否则预览尾部会多出一段空白，横向占位也会多出 900px 的滚动条。
      const scaledWidth = PAPER_WIDTH_PX * nextScale;
      stage.style.height = contentHeight > 0 ? `${contentHeight * nextScale}px` : "0px";
      stage.style.overflow = "hidden";
      frame.style.position = "absolute";
      frame.style.top = "0";
      frame.style.left = `${Math.max(0, (width - scaledWidth) / 2)}px`;
      frame.style.width = `${PAPER_WIDTH_PX}px`;
      frame.style.transformOrigin = "top left";
      frame.style.marginLeft = "0";
      frame.style.overflow = "hidden";
      frame.style.transform = `scale(${nextScale})`;
      if (contentHeight > 0) {
        frame.style.height = `${contentHeight}px`;
        shell.style.overflowAnchor = "none";
      }
    };

    const mountShell = (head: string) => {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc.open();
      doc.write(`<!doctype html><html lang="zh-CN"><head>${head}</head><body></body></html>`);
      doc.close();
      if (doc.body) {
        bodyObserver?.disconnect();
        bodyObserver = new ResizeObserver(() => measure());
        bodyObserver.observe(doc.body);
      }
    };

    const appendPage = (html: string) => {
      const body = frame.contentDocument?.body;
      if (!body) return;
      body.insertAdjacentHTML("beforeend", html);
      measure();
      // 字体与内联图片落位后高度还会变一次，稍后再量一次。
      window.setTimeout(() => measure(), 260);
    };

    const handleEvent = async (event: StreamEvent) => {
      if (
        !shouldHandleStreamEvent({
          eventRunId: event.runId,
          latestRunId: latestRunIdRef.current,
          cancelled,
        })
      ) {
        return;
      }

      if (event.type === "meta") {
        setTotal(event.total);
        mountShell(event.head);
        measure();
        return;
      }
      if (event.type === "page") {
        await assertGuidebookPageChecksum(event.html, event.checksum);
        const accepted = shouldAcceptPage({
          runId: event.runId,
          latestRunId: latestRunIdRef.current,
          index: event.index,
          checksum: event.checksum,
          state: pageStateRef.current,
        });
        if (!accepted) return;
        appendPage(event.html);
        setLabel(event.label);
        setReceived((value) => value + 1);
        return;
      }
      setError(event.message);
    };

    mountShell("");
    applyScale();
    shellObserver = new ResizeObserver(() => applyScale());
    shellObserver.observe(shell);

    void (async () => {
      try {
        const response = await fetch("/api/guidebook-preview", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-guidebook-run-id": requestRunId,
          },
          body: JSON.stringify({
            planId,
            draftId,
            entitlementToken,
            requestFingerprint,
            plan,
            shareToken: shareToken || undefined,
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error("路书预览服务暂时不可用");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          if (cancelled) return;
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (cancelled) return;
            if (!line.trim()) continue;
            await handleEvent(JSON.parse(line) as StreamEvent);
          }
        }
        if (!cancelled && buffer.trim()) await handleEvent(JSON.parse(buffer) as StreamEvent);
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "路书预览生成失败");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      bodyObserver?.disconnect();
      shellObserver?.disconnect();
    };
  }, [draftId, entitlementToken, planKey, requestFingerprint, runId, shareToken]);

  const ready = total > 0 && received >= total && !error;

  useEffect(() => {
    if (ready) onReadyRef.current?.({ pageCount: total });
  }, [ready, total]);

  useEffect(() => {
    if (error) onErrorRef.current?.(error);
  }, [error]);
  const progress = total > 0 ? Math.round((received / total) * 100) : 0;
  const statusText = error
    ? error
    : total === 0
      ? "正在准备路书页面…"
      : ready
        ? `路书已就绪 · 共 ${total} 页`
        : `正在生成第 ${received + 1} / 共 ${total} 页${label ? ` · ${label}` : ""}`;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-[16rem] flex-1">
          <p className="text-xs tracking-[0.22em] text-[var(--v-accent)]">GUIDEBOOK / 路书</p>
          <h2 className="mt-1 font-serif text-2xl text-[var(--v-ink)]">逐页生成你的路书</h2>
          <p className="mt-2 flex items-center gap-2 text-sm text-[var(--v-muted)]">
            {error ? (
              <AlertCircle className="size-4 shrink-0 text-[var(--v-accent)]" />
            ) : ready ? null : (
              <LoaderCircle className="size-4 shrink-0 animate-spin" />
            )}
            <span>{statusText}</span>
          </p>
          <div
            className="mt-3 h-1.5 w-full max-w-xl overflow-hidden rounded-full bg-[var(--v-line)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total || 100}
            aria-valuenow={received}
            aria-label="路书页面生成进度"
          >
            <div
              className="h-full bg-[var(--v-accent)] transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        {readOnly ? (
          <ShareGuidebookPrintButton previewFrameRef={frameRef} disabled={!ready} />
        ) : (
          <div className="flex flex-wrap items-start justify-end gap-2">
            {user ? <SharePlanButton planId={planId} title={plan.meta.title} /> : null}
            <ExportGuidebookButton
              plan={plan}
              planId={planId}
              entitlementToken={entitlementToken}
              requestFingerprint={requestFingerprint}
              previewFrameRef={frameRef}
              disabled={!ready}
              disabledHint={
                error ? "路书生成失败，请先处理上方问题" : "路书全部页面生成完成后即可导出"
              }
            />
          </div>
        )}
      </div>

      <div
        ref={shellRef}
        className={GUIDEBOOK_PREVIEW_SHELL_CLASS}
        style={{ height: "clamp(420px, 78vh, 900px)", overflowAnchor: "none" }}
      >
        <div ref={stageRef} className="relative w-full" style={{ height: 0, overflow: "hidden" }}>
          <iframe
            ref={frameRef}
            title="路书预览"
            sandbox="allow-same-origin"
            scrolling={GUIDEBOOK_PREVIEW_SCROLLING}
            className={GUIDEBOOK_PREVIEW_FRAME_CLASS}
            style={{ width: PAPER_WIDTH_PX, height: 0 }}
          />
        </div>
      </div>
    </section>
  );
}

function ShareGuidebookPrintButton({
  previewFrameRef,
  disabled,
}: {
  previewFrameRef: RefObject<HTMLIFrameElement | null>;
  disabled: boolean;
}) {
  const [message, setMessage] = useState("可打印或另存为 PDF");

  function handleClick() {
    if (disabled) return;
    const result = printPreviewDocument(previewFrameRef.current);
    if (result === "printed") setMessage("已打开打印窗口，请选择另存为 PDF");
    else if (result === "blocked") setMessage("打印窗口被拦截，请允许弹窗后重试");
    else setMessage("路书页面尚未准备好");
  }

  return (
    <div className="flex min-w-[220px] flex-col items-stretch gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={handleClick}
        className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--v-accent)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        打印 / 另存为 PDF
      </button>
      <p className="text-center text-[11px] leading-5 text-[var(--v-muted)]">{message}</p>
    </div>
  );
}

function SharePlanButton({ planId, title }: { planId: string; title: string }) {
  const share = useServerFn(sharePlan);
  const [busy, setBusy] = useState(false);

  async function handleShare() {
    setBusy(true);
    try {
      const result = await share({ data: { planId } });
      const url = new URL(result.url, window.location.origin).toString();
      if (navigator.share) {
        await navigator.share({ title, url });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        toast.success("分享链接已复制");
      } else {
        window.prompt("复制分享链接", url);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error(error instanceof Error ? error.message : "分享路书失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void handleShare()}
      className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--v-line)] px-4 text-sm font-medium text-[var(--v-ink)] transition hover:border-[var(--v-accent)] disabled:opacity-50"
    >
      {busy ? "正在生成链接…" : "分享路书"}
    </button>
  );
}
