import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./auth/middleware.ts";
import { getWalletSummary } from "./credits.server.ts";

/** 获取当前登录用户的钱包和最近流水。 */
export const getMyWallet = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => getWalletSummary(context.userId));
