import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./auth/middleware.ts";
import { getTravelPlan } from "./entitlements.server.ts";
import {
  GUIDEBOOK_EXPORT_TOTAL_TIMEOUT_MS,
  exportGuidebookWithTimeout,
  renderGuidebookPdf,
  type GuidebookExportResult,
} from "./guidebook-pdf.server.ts";

/** PDF 只允许导出当前账号已经保存的路书，客户端不能直接提交任意 plan。 */
export const exportGuidebook = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ planId: z.string().min(1).max(128) }))
  .handler(async ({ context, data }): Promise<GuidebookExportResult> => {
    const plan = await getTravelPlan(context.userId, data.planId);
    if (!plan) throw new Error("行程不存在或无权访问");
    return exportGuidebookWithTimeout(plan, {
      renderPdf: renderGuidebookPdf,
      timeoutMs: GUIDEBOOK_EXPORT_TOTAL_TIMEOUT_MS,
    });
  });
