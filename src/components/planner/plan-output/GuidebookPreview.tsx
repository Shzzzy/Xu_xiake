import { useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import type { TripPlan } from "@/lib/travel-plan";
import { ExportGuidebookButton } from "./ExportGuidebookButton";

/** 预览纸张宽度：与 A4 的 210mm 等宽，保证屏幕预览和 PDF 排版一致。 */
const PAPER_WIDTH_PX = 900;

type StreamEvent =
  | { type: "meta"; total: number; title: string; head: string }
  | { type: "page"; index: number; id: string; label: string; html: string }
  | { type: "error"; message: string };

/**
 * 路书逐页预览。
 *
 * 服务端按页推送 NDJSON，每收到一页就追加进同源 iframe，因此用户能一页页看到
 * 路书成形；全部页面到齐后才允许导出 PDF。
 */
export function GuidebookPreview({ plan }: { plan: TripPlan }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [total, setTotal] = useState(0);
  const [received, setReceived] = useState(0);
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const planKey = JSON.stringify(plan);

  useEffect(() => {
    const frame = frameRef.current;
    const shell = shellRef.current;
    if (!frame || !shell) return;

    let cancelled = false;
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
      const height = Math.max(
        doc.documentElement?.scrollHeight ?? 0,
        doc.body?.scrollHeight ?? 0,
      );
      if (height <= 0) return;
      frame.dataset.contentHeight = String(height);
      applyScale();
    };

    const applyScale = () => {
      const width = shell.clientWidth;
      const contentHeight = Number(frame.dataset.contentHeight ?? "0");
      const nextScale = width > 0 ? Math.min(1, width / PAPER_WIDTH_PX) : 1;
      frame.style.width = `${PAPER_WIDTH_PX}px`;
      frame.style.transformOrigin = "top left";
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

    const handleEvent = (event: StreamEvent) => {
      if (event.type === "meta") {
        setTotal(event.total);
        mountShell(event.head);
        measure();
        return;
      }
      if (event.type === "page") {
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify(plan),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error("路书预览服务暂时不可用");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            handleEvent(JSON.parse(line) as StreamEvent);
          }
          if (cancelled) return;
        }
        if (buffer.trim()) handleEvent(JSON.parse(buffer) as StreamEvent);
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
  }, [planKey]);

  const ready = total > 0 && received >= total && !error;
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
        <ExportGuidebookButton
          plan={plan}
          disabled={!ready}
          disabledHint={
            error ? "路书生成失败，请先处理上方问题" : "路书全部页面生成完成后即可导出"
          }
        />
      </div>

      <div ref={shellRef} className="relative w-full overflow-y-auto" style={{ height: "min(78vh, 900px)", overflowAnchor: "none" }}>
        <iframe
          ref={frameRef}
          title="路书预览"
          sandbox="allow-same-origin"
          className="border-0 bg-transparent shadow-none"
          style={{ width: PAPER_WIDTH_PX, height: 0 }}
        />
      </div>
    </section>
  );
}
