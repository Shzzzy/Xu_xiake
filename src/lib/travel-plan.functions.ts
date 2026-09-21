import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  exportGuidebookForTest,
  renderGuidebookPdf,
  type GuidebookExportResult,
} from "./guidebook-pdf.server.ts";
import { tripPlanSchema } from "./trip-plan-schema.ts";
import { enrichTripPlanNarrative } from "./guidebook-narrative.server.ts";

export const exportGuidebook = createServerFn({ method: "POST" })
  .validator(z.object({ plan: tripPlanSchema }))
  .handler(async ({ data }): Promise<GuidebookExportResult> => {
    // 与逐页预览共用同一份每日文案；butler 计划会直接跳过 legacy enrichment。
    const plan = await enrichTripPlanNarrative(data.plan);
    return exportGuidebookForTest(plan, { renderPdf: renderGuidebookPdf });
  });
