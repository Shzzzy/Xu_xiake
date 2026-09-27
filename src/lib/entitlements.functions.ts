import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, optionalAuthMiddleware } from "./auth/middleware.ts";
import {
  claimFirstFreePlan,
  finalizeGuestGeneration as finalizeGuestGenerationServer,
  finishPaidPlan,
  preparePlanGeneration as preparePlanGenerationServer,
  readGuestGenerationEntitlementId,
  releaseGenerationEntitlement,
  reservePaidGeneration,
  type GenerationPreparation,
  type PreparedGenerationEntitlement,
} from "./entitlements.server.ts";
import { tripPlanSchema } from "./trip-plan-schema.ts";

const planIdInput = z.object({
  planId: z.string().min(1).max(128),
  requestFingerprint: z.string().min(1).max(256),
});

const entitlementInput = z.object({
  entitlementToken: z.string().min(16).max(256),
  requestFingerprint: z.string().min(1).max(256),
});

const claimPlanInput = planIdInput.extend({
  plan: tripPlanSchema,
  entitlementToken: z.string().min(16).max(256),
});

const guestFinalizeInput = planIdInput.extend({
  entitlementToken: z.string().min(16).max(256),
  plan: tripPlanSchema,
});

/** 登录后把当前行程保存到账号，并消费 free/guest 一次性凭证。 */
export const claimCurrentPlan = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(claimPlanInput)
  .handler(async ({ context, data }) => {
    const cookieEntitlementId = await readGuestGenerationEntitlementId();
    return claimFirstFreePlan({
      userId: context.userId,
      planId: data.planId,
      plan: data.plan,
      entitlementToken: data.entitlementToken,
      requestFingerprint: data.requestFingerprint,
      cookieEntitlementId,
    });
  });

/** 生成前判断访客、免费、付费确认、登录或购买，并签发一次性凭证。 */
export const preparePlanGeneration = createServerFn({ method: "POST" })
  .middleware([optionalAuthMiddleware])
  .validator(planIdInput)
  .handler(async ({ context, data }): Promise<GenerationPreparation> =>
    preparePlanGenerationServer(context.userId, data.planId, data.requestFingerprint),
  );

/** 用户确认消耗一点后，按当前会话预留并签发 paid 凭证。 */
export const reservePlanGeneration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(planIdInput)
  .handler(async ({ context, data }): Promise<PreparedGenerationEntitlement> =>
    reservePaidGeneration(context.userId, data.planId, data.requestFingerprint),
  );

/** 生成失败时按 token + fingerprint 释放预占，不能按 reservationId 操作。 */
export const releasePlanGeneration = createServerFn({ method: "POST" })
  .middleware([optionalAuthMiddleware])
  .validator(entitlementInput)
  .handler(async ({ context, data }) => {
    const cookieEntitlementId = await readGuestGenerationEntitlementId();
    return releaseGenerationEntitlement({
      entitlementToken: data.entitlementToken,
      requestFingerprint: data.requestFingerprint,
      userId: context.userId,
      cookieEntitlementId,
    });
  });

/** 访客生成成功后，把 plan hash 绑定到一次性凭证。 */
export const finalizeGuestGeneration = createServerFn({ method: "POST" })
  .validator(guestFinalizeInput)
  .handler(async ({ data }) => {
    const cookieEntitlementId = await readGuestGenerationEntitlementId();
    if (!cookieEntitlementId) throw new Error("访客 Cookie 已失效，请重新生成");
    return finalizeGuestGenerationServer({
      token: data.entitlementToken,
      requestFingerprint: data.requestFingerprint,
      planId: data.planId,
      plan: data.plan,
      cookieEntitlementId,
    });
  });

/** 付费计划最终可用后，在同一服务端事务中保存 plan、消费预留并标记凭证。 */
export const finishPaidGeneration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    planIdInput.extend({
      entitlementToken: z.string().min(16).max(256),
      plan: tripPlanSchema,
    }),
  )
  .handler(async ({ context, data }) =>
    finishPaidPlan({
      userId: context.userId,
      planId: data.planId,
      plan: data.plan,
      entitlementToken: data.entitlementToken,
      requestFingerprint: data.requestFingerprint,
    }),
  );
