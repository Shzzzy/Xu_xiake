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
