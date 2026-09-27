const CHINA_MOBILE_PATTERN = /^1[3-9]\d{9}$/;

export function normalizePhone(value: string): string {
  // 先移除空格、连字符等展示字符，再兼容国内常见的 +86 前缀。
  return value.replace(/[^\d]/g, "").replace(/^86(?=1[3-9]\d{9}$)/, "");
}

export function isValidPhone(value: string): boolean {
  return CHINA_MOBILE_PATTERN.test(normalizePhone(value));
}

export function phoneToInternalEmail(phone: string): string {
  return normalizePhone(phone) + "@phone.invalid";
}

export function maskPhone(phone: string): string {
  const normalized = normalizePhone(phone);
  // 无效号码不伪装成已脱敏号码，直接返回规范化结果便于排查。
  if (!isValidPhone(normalized)) return normalized;
  return normalized.slice(0, 3) + "****" + normalized.slice(7);
}
