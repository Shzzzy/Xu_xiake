import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware.ts";
import { createPublicAccountRecord, getPublicAccount } from "./public.server.ts";

const registerInput = z.object({
  phone: z.string().min(1),
  password: z.string().min(8).max(128),
});

export const registerWithPhone = createServerFn({ method: "POST" })
  .validator(registerInput)
  .handler(async ({ data }) => createPublicAccountRecord(data));

export const getMyAccount = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => getPublicAccount(context.userId));
