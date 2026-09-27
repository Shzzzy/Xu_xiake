import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./auth/middleware.ts";
import { createPlanShare, resolvePlanShare } from "./shares.server.ts";

const tokenSchema = z.object({
  token: z.string().min(16).max(256),
});

const planSchema = z.object({
  planId: z.string().min(1).max(128),
});

/** 登录用户为自己的行程创建只读分享链接。 */
export const sharePlan = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(planSchema)
  .handler(async ({ context, data }) => createPlanShare(context.userId, data.planId));

/** 公开解析分享链接；调用方只能得到路书内容，不会得到账号、钱包或订单信息。 */
export const getSharedPlan = createServerFn({ method: "GET" })
  .validator(tokenSchema)
  .handler(async ({ data }) => {
    const result = await resolvePlanShare(data.token);
    if (!result) throw new Error("链接不存在或已失效");
    return result;
  });
