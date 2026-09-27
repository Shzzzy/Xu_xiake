/**
 * 认证接口基路径。
 *
 * 生产构建改用 /auth-gateway，避免部分浏览器扩展或内置浏览器直接拦截 /api/auth/*；
 * 本地开发与 live preview 继续沿用 /api/auth，保持既有 OAuth 回调地址不变。
 */
const viteEnv = (import.meta as ImportMeta & { env?: { PROD?: boolean } }).env;
export const AUTH_BASE_PATH = viteEnv?.PROD === true ? "/auth-gateway" : "/api/auth";
