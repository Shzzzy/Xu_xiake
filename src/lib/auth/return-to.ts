export const DEFAULT_APP_ORIGIN = "http://localhost";
export const SIGN_IN_PATH = "/auth" as const;

/**
 * 只接受同源站内路径，并使用解析后的 pathname/search/hash 防止反斜杠和绝对 URL 绕过。
 */
/** 最终校验：锁定单个斜杠开头的站内路径，并拒绝反斜杠、协议相对值和控制字符。 */
function isSafeReturnTo(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return false;
  }
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;

  try {
    const decoded = decodeURIComponent(value);
    return !(
      decoded.startsWith("//") ||
      decoded.startsWith("/\\") ||
      decoded.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(decoded)
    );
  } catch {
    return false;
  }
}

export function normalizeReturnTo(
  value: string | undefined,
  origin = DEFAULT_APP_ORIGIN,
): string {
  const fallback = "/";
  if (typeof value !== "string" || !value.trim()) return fallback;

  try {
    const baseOrigin = new URL(origin).origin;
    const url = new URL(value, baseOrigin);
    if (url.origin !== baseOrigin) return fallback;

    const result = `${url.pathname}${url.search}${url.hash}`;
    if (!isSafeReturnTo(result)) return fallback;
    if (result === "/auth" || result.startsWith("/auth?")) return fallback;
    return result || fallback;
  } catch {
    return fallback;
  }
}

export function buildSignInRedirect(
  currentHref: string,
  origin = DEFAULT_APP_ORIGIN,
): { to: typeof SIGN_IN_PATH; search: { returnTo: string } } {
  return {
    to: SIGN_IN_PATH,
    search: { returnTo: normalizeReturnTo(currentHref, origin) },
  };
}
