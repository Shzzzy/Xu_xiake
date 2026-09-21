import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  GUIDEBOOK_EXPORT_TOTAL_TIMEOUT_MS,
  exportGuidebookWithTimeout,
  renderGuidebookPdf,
  type GuidebookExportResult,
} from "./guidebook-pdf.server.ts";
import { tripPlanSchema } from "./trip-plan-schema.ts";

export const exportGuidebook = createServerFn({ method: "POST" })
  .validator(z.object({ plan: tripPlanSchema }))
  .handler(async ({ data }): Promise<GuidebookExportResult> =>
    exportGuidebookWithTimeout(data.plan, {
      renderPdf: renderGuidebookPdf,
      timeoutMs: GUIDEBOOK_EXPORT_TOTAL_TIMEOUT_MS,
    }),
  );