import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, optionalAuthMiddleware } from "./auth/middleware.ts";
import { claimDeliveryDraftForUser, createDeliveryDraft } from "./delivery-drafts.repository.ts";
import { hashGenerationToken, readGuestGenerationEntitlementId } from "./entitlements.server.ts";
import { tripPlanSchema } from "./trip-plan-schema.ts";

const createDraftInput = z.object({
  planId: z.string().min(1).max(128),
  requestFingerprint: z.string().min(1).max(256),
  entitlementToken: z.string().min(16).max(256),
  plan: tripPlanSchema,
  previewScope: z.enum(["full", "limited"]).default("full"),
  ttlHours: z.number().int().min(1).max(72).default(24),
});

const draftActorInput = z.object({
  draftId: z.string().min(1).max(128),
});

async function getSql() {
  const { getSql: loadSql } = await import("./db.ts");
  return loadSql();
}

export const createDeliveryDraftFn = createServerFn({ method: "POST" })
  .middleware([optionalAuthMiddleware])
  .validator(createDraftInput)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const guestEntitlementId = context.userId
      ? null
      : await readGuestGenerationEntitlementId();
    const rows = await sql.query<{
      id: string;
      user_id: string | null;
      request_fingerprint: string;
      status: string;
    }>(
      `select id, user_id, request_fingerprint, status
         from generation_entitlements
        where token_hash = $1`,
      [hashGenerationToken(data.entitlementToken)],
    );
    const entitlement = rows[0];
    if (!entitlement) throw new Error("生成凭证无效或不存在");
    if (entitlement.request_fingerprint !== data.requestFingerprint) {
      throw new Error("生成凭证与请求指纹不匹配");
    }
    if (context.userId) {
      if (entitlement.user_id !== context.userId) throw new Error("生成凭证不属于当前用户");
    } else if (guestEntitlementId !== entitlement.id) {
      throw new Error("访客 Cookie 与生成凭证不匹配");
    }

    return createDeliveryDraft(sql, {
      id: crypto.randomUUID(),
      ownerUserId: context.userId,
      guestSessionHash: context.userId ? null : guestEntitlementId,
      planId: data.planId,
      requestFingerprint: data.requestFingerprint,
      entitlementId: entitlement.id,
      plan: data.plan,
      previewScope: data.previewScope,
      expiresAt: new Date(Date.now() + data.ttlHours * 60 * 60 * 1000),
    });
  });

export const claimDeliveryDraftForUserFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(draftActorInput)
  .handler(async ({ context, data }) =>
    claimDeliveryDraftForUser(await getSql(), {
      draftId: data.draftId,
      userId: context.userId,
      guestSessionHash: await readGuestGenerationEntitlementId(),
    }),
  );
