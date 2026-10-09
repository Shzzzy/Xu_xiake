import { createHash } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { getSessionUser } from "@/lib/auth/verify.server";
import { getSql } from "@/lib/db";
import { markDeliveryDraftFailed } from "@/lib/delivery-drafts.repository";
import { markDraftPreviewReadyWithSql, resolveDraftPreviewWithSql } from "@/lib/delivery.server";
import {
  readGuestGenerationEntitlementId,
  releaseGenerationAfterFailure,
  resolvePreviewPlan,
} from "@/lib/entitlements.server";
import { encodeGuidebookEvent, streamGuidebookPages } from "@/lib/guidebook-stream.server";
import { resolvePlanShare } from "@/lib/shares.server";
import { tripPlanSchema } from "@/lib/trip-plan-schema";
import type { TripPlan } from "@/lib/travel-plan";
import { z } from "zod";

// 预览请求体的轻量上限：先于 JSON 解析拦截超大体，和 16 天上限共同约束付费调用面。
const GUIDEBOOK_PREVIEW_MAX_BODY_BYTES = 2_000_000;

const previewRequestSchema = z.object({
  planId: z.string().min(1).max(128),
  entitlementToken: z.string().min(16).max(256).optional(),
  requestFingerprint: z.string().min(1).max(256).optional(),
  draftId: z.string().min(1).max(128).optional(),
  shareToken: z.string().min(16).max(256).optional(),
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
 * 草稿优先按 draftId 授权；正式版本、访客旧凭证和分享链接继续兼容。
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

        let plan: TripPlan;
        let resolvedUserId: string | null = null;
        let cookieEntitlementId: string | null = null;
        const shareToken = payload.shareToken;
        try {
          if (shareToken) {
            const shared = await resolvePlanShare(shareToken);
            if (!shared) throw new Error("链接不存在或已失效");
            plan = shared.plan;
          } else {
            const user = await getSessionUser();
            resolvedUserId = user?.id ?? null;
            cookieEntitlementId = await readGuestGenerationEntitlementId();
            if (payload.draftId) {
              const draft = await resolveDraftPreviewWithSql(await getSql(), {
                draftId: payload.draftId,
                userId: resolvedUserId,
                guestSessionHash: cookieEntitlementId,
                entitlementToken: payload.entitlementToken ?? null,
                requestFingerprint: payload.requestFingerprint ?? null,
                plan: payload.plan,
              });
              plan = draft.plan;
            } else {
              plan = await resolvePreviewPlan({
                userId: resolvedUserId,
                planId: payload.planId,
                plan: payload.plan,
                entitlementToken: payload.entitlementToken ?? null,
                requestFingerprint: payload.requestFingerprint ?? null,
                cookieEntitlementId,
              });
            }
          }
        } catch (error) {
          return new Response(
            encodeGuidebookEvent({
              type: "error",
              runId,
              message: error instanceof Error ? error.message : "未授权预览路书。",
            }),
            { status: shareToken ? 404 : resolvedUserId ? 403 : 401, headers: NDJSON_HEADERS },
          );
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const manifestEntries: string[] = [];
            try {
              for await (const event of streamGuidebookPages(plan, {
                signal: request.signal,
                runId,
              })) {
                if (event.type === "page") {
                  manifestEntries.push(`${event.index}:${event.id}:${event.checksum}`);
                }
                controller.enqueue(encoder.encode(encodeGuidebookEvent(event)));
              }

              if (payload.draftId && !request.signal.aborted) {
                const pageManifestHash = createHash("sha256")
                  .update(manifestEntries.join("\n"))
                  .digest("hex");
                await markDraftPreviewReadyWithSql(await getSql(), {
                  draftId: payload.draftId,
                  userId: resolvedUserId,
                  guestSessionHash: cookieEntitlementId,
                  entitlementToken: payload.entitlementToken ?? null,
                  requestFingerprint: payload.requestFingerprint ?? null,
                  plan,
                  pageManifestHash,
                  pageCount: manifestEntries.length,
                });
              }
            } catch (error) {
              // 客户端中止通常来自 React 开发模式重挂载或用户离开页面，不能把草稿判失败。
              if (request.signal.aborted) {
                return;
              }
              if (payload.draftId && payload.entitlementToken && payload.requestFingerprint) {
                await releaseGenerationAfterFailure({
                  entitlementToken: payload.entitlementToken,
                  requestFingerprint: payload.requestFingerprint,
                  userId: resolvedUserId,
                  cookieEntitlementId,
                  reason: "guidebook_preview_failed",
                }).catch(() => undefined);
                await markDeliveryDraftFailed(await getSql(), {
                  id: payload.draftId,
                  reason: error instanceof Error ? error.message : "路书预览生成失败",
                }).catch(() => undefined);
              }
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