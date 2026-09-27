import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./auth/middleware.ts";
import {
  adjustCredits,
  getAdminDashboard,
  requireAdmin,
  revealFullPhone,
  setUserStatus,
} from "./admin.server.ts";

const statusSchema = z.enum(["active", "disabled"]);

/** 管理员仪表盘数据；所有查询前先做服务端角色校验。 */
export const getAdminDashboardData = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    return getAdminDashboard();
  });

/** 管理员手动调整点数，必须填写原因并写入审计日志。 */
export const adjustCreditsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      userId: z.string().min(1).max(128),
      delta: z
        .number()
        .int()
        .refine((value) => value !== 0, "点数变更不能为 0"),
      note: z.string().trim().min(2).max(500),
    }),
  )
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    return adjustCredits({
      adminUserId: context.userId,
      userId: data.userId,
      delta: data.delta,
      note: data.note,
    });
  });

/** 管理员停用或启用普通账号。 */
export const setUserStatusFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      userId: z.string().min(1).max(128),
      status: statusSchema,
    }),
  )
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    await setUserStatus(context.userId, data.userId, data.status);
    return { ok: true as const };
  });

/** 查看完整手机号会单独写入 view_full_phone 审计事件。 */
export const revealFullPhoneFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ userId: z.string().min(1).max(128) }))
  .handler(async ({ context, data }) => {
    await requireAdmin(context.userId);
    return { phone: await revealFullPhone(context.userId, data.userId) };
  });
