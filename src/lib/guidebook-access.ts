export type GuidebookExportGate = "wait" | "login" | "ensure_entitlement";

/**
 * PDF 和分享共用的登录闸门。
 * 会话尚未解析时不能误判成未登录；已登录则继续走服务端权益幂等检查。
 */
export function resolveGuidebookExportGate(input: {
  isPending: boolean;
  hasUser: boolean;
}): GuidebookExportGate {
  if (input.isPending) return "wait";
  if (!input.hasUser) return "login";
  return "ensure_entitlement";
}

/** 账号 session 仍在解析时，导出状态必须回到 idle，不能卡在 preparing。 */
export function resetGuidebookExportAfterPendingAuth(): {
  stage: "idle";
  progress: number;
} {
  return { stage: "idle", progress: 0 };
}

/** 输入变化或卸载时，只释放当前尝试且尚未 finalize 的凭证。 */
export function shouldReleaseGenerationOnCleanup(input: {
  attemptPlanId: string | null;
  currentPlanId: string;
  finalizedPlanId: string | null;
  hasToken: boolean;
}): boolean {
  return (
    input.attemptPlanId === input.currentPlanId &&
    input.finalizedPlanId !== input.currentPlanId &&
    input.hasToken
  );
}
