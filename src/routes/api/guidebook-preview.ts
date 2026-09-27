import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "@/lib/auth/verify.server";
import { readGuestGenerationEntitlementId, resolvePreviewPlan } from "@/lib/entitlements.server";
import { encodeGuidebookEvent, streamGuidebookPages } from "@/lib/guidebook-stream.server";
import { tripPlanSchema } from "@/lib/trip-plan-schema";
import { z } from "zod";

// 预览请求体的轻量上限：先于 JSON 解析拦截超大体，和 16 天上限共同约束付费调用面。
const GUIDEBOOK_PREVIEW_MAX_BODY_BYTES = 2_000_000;

const previewRequestSchema = z.object({
  planId: z.string().min(1).max(128),
  entitlementToken: z.string().min(16).max(256).optional(),
  requestFingerprint: z.string().min(1).max(256).optional(),
  plan: tripPlanSchema,
});

const NDJSON_HEADERS = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  // 反向代理下也必须逐块下发，否则逐页进度会变成一次性到达。
  "x-accel-buffering": "no",
};

/**
 * 路书逐页流式预览接口。
 *
 * 登录用户只读取自己已保存的 plan；访客必须提交与数据库凭证一致的 token、
 * fingerprint 和 plan hash，不能只信任请求体 plan。
 */
export const Route = createFileRoute("/api/guidebook-preview")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runId = request.headers.get("x-guidebook-run-id")?.trim() || "legacy";
        const contentLength = Number(request.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > GUIDEBOOK_PREVIEW_MAX_BODY_BYTES) {
          return new Response(
            encodeGuidebookEvent({ type: "error", runId, message: "行程数据过大，无法预览路书。" }),
            { status: 413, headers: NDJSON_HEADERS },
          );
        }

        let payload: z.infer<typeof previewRequestSchema>;
        try {
          payload = previewRequestSchema.parse(await request.json());
        } catch {
          return new Response(
            encodeGuidebookEvent({
              type: "error",
              runId,
              message: "行程数据不合法，无法预览路书。",
            }),
            { status: 400, headers: NDJSON_HEADERS },
          );
        }

        let plan;
        let resolvedUserId: string | null = null;
        try {
          const user = await getSessionUser();
          resolvedUserId = user?.id ?? null;
          const cookieEntitlementId = await readGuestGenerationEntitlementId();
          plan = await resolvePreviewPlan({
            userId: resolvedUserId,
            planId: payload.planId,
            plan: payload.plan,
            entitlementToken: payload.entitlementToken ?? null,
            requestFingerprint: payload.requestFingerprint ?? null,
            cookieEntitlementId,
          });
        } catch (error) {
          return new Response(
            encodeGuidebookEvent({
              type: "error",
              runId,
              message: error instanceof Error ? error.message : "未授权预览路书。",
            }),
            { status: resolvedUserId ? 403 : 401, headers: NDJSON_HEADERS },
          );
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const event of streamGuidebookPages(plan, {
                signal: request.signal,
                runId,
              })) {
                controller.enqueue(encoder.encode(encodeGuidebookEvent(event)));
              }
            } catch (error) {
              controller.enqueue(
                encoder.encode(
                  encodeGuidebookEvent({
                    type: "error",
                    runId,
                    message: error instanceof Error ? error.message : "路书预览生成失败。",
                  }),
                ),
              );
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, { headers: NDJSON_HEADERS });
      },
    },
  },
});
