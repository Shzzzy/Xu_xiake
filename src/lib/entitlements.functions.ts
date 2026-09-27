import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./auth/middleware.ts";
import {
  claimFirstFreePlan,
  finishPaidPlan,
  preparePlanGeneration as preparePlanGenerationServer,
  releaseGuestGenerationAttempt,
  releasePaidPlan,
  reservePaidGeneration,
  type GenerationDecision,
  type GenerationPermission,
} from "./entitlements.server.ts";
import { tripPlanSchema } from "./trip-plan-schema.ts";

/** 规划准备同时支持访客与登录用户；用户身份只从服务端会话读取。 */
const optionalAuthMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const { getBearerToken } = await import("./auth/client.ts");
    return next({ sendContext: { bearerToken: getBearerToken() ?? undefined } });
  })
  .server(async ({ next, context }) => {
    const { assertSameSiteRequest } = await import("./auth/isolation.server.ts");
    const { getSessionUser } = await import("./auth/verify.server.ts");
    assertSameSiteRequest();
    const user = await getSessionUser(context.bearerToken);
    return next({ context: { userId: user?.id ?? null } });
  });

const planIdInput = z.object({
  planId: z.string().min(1).max(128),
});

const claimPlanInput = z.object({
  planId: z.string().min(1).max(128),
  plan: tripPlanSchema,
});

/** 登录后把当前行程保存到账号，并消耗该账号唯一一次首次免费权益。 */
export const claimCurrentPlan = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(claimPlanInput)
  .handler(async ({ context, data }) =>
    claimFirstFreePlan({
      userId: context.userId,
      planId: data.planId,
      plan: data.plan,
    }),
  );

/** 生成前判断访客、免费、付费确认、登录或购买。 */
export const preparePlanGeneration = createServerFn({ method: "POST" })
  .middleware([optionalAuthMiddleware])
  .validator(planIdInput)
  .handler(async ({ context, data }): Promise<GenerationDecision> =>
    preparePlanGenerationServer(context.userId, data.planId),
  );

/** 用户确认消耗一点后，按当前会话预留。 */
export const reservePlanGeneration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(planIdInput)
  .handler(async ({ context, data }): Promise<GenerationPermission> =>
    reservePaidGeneration(context.userId, data.planId),
  );

/** 生成失败时释放预占，不能按客户端 userId 操作。 */
export const releasePlanGeneration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ reservationId: z.string().min(1).max(128) }))
  .handler(async ({ context, data }) => releasePaidPlan(context.userId, data.reservationId));

/** 访客规划失败时清理一次性 Cookie。 */
export const releaseGuestGeneration = createServerFn({ method: "POST" }).handler(async () =>
  releaseGuestGenerationAttempt(),
);

/** 付费计划最终可用后，在同一服务端事务中保存并消费预留。 */
export const finishPaidGeneration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    planIdInput.extend({
      reservationId: z.string().min(1).max(128),
      plan: tripPlanSchema,
    }),
  )
  .handler(async ({ context, data }) =>
    finishPaidPlan({
      userId: context.userId,
      reservationId: data.reservationId,
      planId: data.planId,
      plan: data.plan,
    }),
  );
