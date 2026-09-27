export const DEFAULT_APP_ORIGIN = "http://localhost";
export const SIGN_IN_PATH = "/auth" as const;

/**
 * 只接受同源站内路径，并使用解析后的 pathname/search/hash 防止反斜杠和绝对 URL 绕过。
 */
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

    const decodedPathname = decodeURIComponent(url.pathname);
    if (decodedPathname.includes("\\")) return fallback;

    const result = `${url.pathname}${url.search}${url.hash}`;
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
