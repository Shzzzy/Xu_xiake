import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RegistrationRateLimiter } from "./registration-rate-limit.ts";

test("registration rate limiter allows, limits, then resets after the window", () => {
  let now = 1_000;
  const limiter = new RegistrationRateLimiter({
    maxAttempts: 2,
    windowMs: 1_000,
    now: () => now,
  });

  limiter.check("203.0.113.10", "13800138000");
  limiter.check("203.0.113.10", "13800138000");
  assert.throws(
    () => limiter.check("203.0.113.10", "13800138000"),
    /注册请求过于频繁/,
  );

  limiter.check("203.0.113.11", "13800138000");
  limiter.check("203.0.113.10", "13800139000");

  now += 1_001;
  limiter.check("203.0.113.10", "13800138000");
});

test("public registration server function enforces the limiter before account creation", async () => {
  const source = await readFile(
    fileURLToPath(new URL("./public.functions.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /enforceRegistrationRateLimit\(requestIp\(\), data\.phone\)/);
});
