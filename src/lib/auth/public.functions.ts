import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { authMiddleware } from "./middleware.ts";
import { createPublicAccountRecord, getPublicAccount } from "./public.server.ts";
import { enforceRegistrationRateLimit } from "./registration-rate-limit.ts";

const registerInput = z.object({
  phone: z.string().min(1),
  password: z.string().min(8).max(128),
});

function requestIp(): string {
  try {
    const request = getRequest();
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export const registerWithPhone = createServerFn({ method: "POST" })
  .validator(registerInput)
  .handler(async ({ data }) => {
    enforceRegistrationRateLimit(requestIp(), data.phone);
    return createPublicAccountRecord(data);
  });

export const getMyAccount = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => getPublicAccount(context.userId));
