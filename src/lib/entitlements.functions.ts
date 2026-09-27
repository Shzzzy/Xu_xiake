import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./auth/middleware.ts";
import { claimFirstFreePlan } from "./entitlements.server.ts";
import { tripPlanSchema } from "./trip-plan-schema.ts";

const claimPlanInput = z.object({
  plan: tripPlanSchema,
});

/** 登录后把当前行程保存到账号，并消耗该账号唯一一次首次免费权益。 */
export const claimCurrentPlan = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(claimPlanInput)
  .handler(async ({ context, data }) => claimFirstFreePlan(context.userId, data.plan));
