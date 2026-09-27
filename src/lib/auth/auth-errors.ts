export type AuthErrorMode = "login" | "register";

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}

export function readableAuthError(error: unknown, mode: AuthErrorMode): string {
  const message = errorText(error);
  if (/already|已存在|unique|duplicate|USERNAME_IS_ALREADY_TAKEN/i.test(message)) {
    return "该手机号已经注册，请直接登录。";
  }
  if (/too many|rate.?limit|频繁|429/i.test(message)) {
    return "注册请求过于频繁，请稍后再试。";
  }
  if (/password|credential|密码/i.test(message)) {
    return mode === "login" ? "手机号或密码不正确。" : "密码不符合要求。";
  }
  if (/手机号|phone|username|邮箱|email/i.test(message)) {
    return "账号信息有误，请检查手机号和邮箱格式。";
  }
  return mode === "login" ? "登录失败，请稍后再试。" : "注册失败，请稍后再试。";
}
