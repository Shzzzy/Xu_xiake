import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requestBudgetAdvice } from "./budget-advice.server";

const budgetAdviceInputSchema = z
  .object({
    origin: z.string().trim().min(1),
    destination: z.string().trim().min(1),
    region: z.string().trim().min(1),
    days: z.number().int().positive(),
    travelers: z
      .object({
        adults: z.number().int().positive(),
        children: z.number().int().nonnegative(),
      })
      .strict(),
    transportPreference: z.string().trim().min(1),
    roundTrip: z.boolean(),
    returnMode: z.enum(["scenic", "fast"]).nullable(),
    routeLegs: z
      .array(
        z
          .object({
            from: z.string().trim().min(1),
            to: z.string().trim().min(1),
            transport: z.string().trim().min(1),
            kind: z.enum(["outbound", "return"]),
            style: z.enum(["direct", "wander"]),
          })
          .strict(),
      )
      .max(14),
    pace: z.string().trim().min(1),
    interests: z.array(z.string().trim().min(1)),
  })
  .strict();

export const recommendBudget = createServerFn({ method: "POST" })
  .validator(budgetAdviceInputSchema)
  .handler(async ({ data }) => {
    const key = process.env.DEEPSEEK_API_KEY?.trim();
    if (!key) {
      return { status: "needs_configuration" as const, message: "缺少 DEEPSEEK_API_KEY" };
    }

    try {
      return {
        status: "ok" as const,
        advice: await requestBudgetAdvice(data, { apiKey: key }),
      };
    } catch (error) {
      return {
        status: "failed" as const,
        message: error instanceof Error ? error.message : "预算建议失败",
      };
    }
  });
