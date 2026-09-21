import { createServerFn } from "@tanstack/react-start";
import { renderGuidebookHtml } from "./guidebook-html.server.ts";
import { z } from "zod";
import {
  exportGuidebookForTest,
  renderGuidebookPdf,
  type GuidebookExportResult,
} from "./guidebook-pdf.server.ts";
import { tripPlanSchema } from "./trip-plan-schema.ts";
import { enrichTripPlanNarrative } from "./guidebook-narrative.server.ts";

const GUIDEBOOK_PDF_TOTAL_TIMEOUT_MS = 25_000;

export const exportGuidebook = createServerFn({ method: "POST" })
  .validator(z.object({ plan: tripPlanSchema }))
  .handler(async ({ data }): Promise<GuidebookExportResult> => {
    const controller = new AbortController();
    let timeoutResolve: ((result: GuidebookExportResult) => void) | undefined;
    const timeoutPromise = new Promise<GuidebookExportResult>((resolve) => {
      timeoutResolve = resolve;
    });
    const timer = setTimeout(() => {
      controller.abort(new Error("PDF 导出超过总预算"));
      timeoutResolve?.({
        status: "html",
        html: renderGuidebookHtml(data.plan),
        message: "PDF 导出超时，已改为可打印 HTML。",
      });
    }, GUIDEBOOK_PDF_TOTAL_TIMEOUT_MS);

    try {
      const exportPromise = (async () => {
        // 与逐页预览共用同一份每日文案；butler 计划会直接跳过 legacy enrichment。
        const plan = await enrichTripPlanNarrative(data.plan);
        return exportGuidebookForTest(plan, {
          renderPdf: renderGuidebookPdf,
          signal: controller.signal,
          timeoutMs: GUIDEBOOK_PDF_TOTAL_TIMEOUT_MS,
        });
      })();
      return await Promise.race([exportPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  });
