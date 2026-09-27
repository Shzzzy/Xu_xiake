import { normalizePhone } from "./phone.ts";

export type RegistrationRateLimitOptions = {
  maxAttempts?: number;
  windowMs?: number;
  now?: () => number;
};

export class RegistrationRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("注册请求过于频繁，请稍后再试");
    this.name = "RegistrationRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class RegistrationRateLimiter {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, number[]>();

  constructor(options: RegistrationRateLimitOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  check(ip: string, phone: string): void {
    const now = this.now();
    const key = `${ip}:${normalizePhone(phone)}`;
    const cutoff = now - this.windowMs;
    const attempts = (this.buckets.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

    if (attempts.length >= this.maxAttempts) {
      const retryAfterMs = Math.max(0, attempts[0]! + this.windowMs - now);
      throw new RegistrationRateLimitError(retryAfterMs);
    }

    attempts.push(now);
    this.buckets.set(key, attempts);
  }

  reset(): void {
    this.buckets.clear();
  }
}

export const registrationRateLimiter = new RegistrationRateLimiter();

export function enforceRegistrationRateLimit(ip: string, phone: string): void {
  registrationRateLimiter.check(ip, phone);
}
