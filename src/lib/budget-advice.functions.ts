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
            distanceKm: z.number().nonnegative().optional(),
            unitCost: z.number().nonnegative().optional(),
            totalCost: z.number().nonnegative().optional(),
            costBasis: z.enum(["per-person", "vehicle"]).optional(),
          })
          .strict(),
      )
      .max(14),
    pace: z.string().trim().min(1),
    interests: z.array(z.string().trim().min(1)),
    costs: z
      .object({
        lodgingPerRoomPerNight: z.number().nonnegative().optional(),
        foodPerPersonPerDay: z.number().nonnegative().optional(),
        adultTicketPrice: z.number().nonnegative().optional(),
        childTicketPrice: z.number().nonnegative().optional(),
        uniformTicketPrice: z.number().nonnegative().optional(),
        uncertainty: z.enum(["low", "medium", "high"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const recommendBudget = createServerFn({ method: "POST" })
  .validator(budgetAdviceInputSchema)
  .handler(async ({ data }) => {
    try {
      return {
        status: "ok" as const,
        // 本地确定性金额始终可用；DeepSeek Key 只影响说明文案是否由模型整理。
        advice: await requestBudgetAdvice(data),
      };
    } catch (error) {
      return {
        status: "failed" as const,
        message: error instanceof Error ? error.message : "预算建议失败",
      };
    }
  });
