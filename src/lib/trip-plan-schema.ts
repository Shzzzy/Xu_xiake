import { z } from "zod";

/**
 * 行程数据的校验 schema：服务端函数与路书流式接口共用同一份定义。
 */
const coordinateSchema = z.tuple([z.number(), z.number()]);
const budgetRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
});
const budgetCategorySchema = budgetRangeSchema.extend({
  amount: z.number(),
  ratio: z.number(),
});
const roadTripBudgetSchema = z.object({
  energy: budgetRangeSchema,
  toll: budgetRangeSchema,
  holidayFreeAdjustment: budgetRangeSchema,
  parking: budgetRangeSchema,
});
const routeSegmentSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: z.enum(["economy", "balanced", "speed", "train", "flight", "drive", "bus", "ship"]),
  distanceKm: z.number(),
  durationMinutes: z.number(),
  navigation: z.string(),
});
const timelineNodeSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  timeLabel: z.string(),
  type: z.enum(["transport", "transfer", "attraction", "meal", "rest", "hotel", "night-activity"]),
  name: z.string(),
  location: z.string().optional(),
  coordinates: coordinateSchema.optional(),
  transportMode: z
    .enum(["economy", "balanced", "speed", "train", "flight", "drive", "bus", "ship"])
    .optional(),
  transportMinutes: z.number().optional(),
  stayMinutes: z.number().optional(),
  estimatedCost: z.number(),
  tips: z.string().optional(),
  navigation: z.string().nullable(),
});
const historyNoteSchema = z.object({
  title: z.string(),
  background: z.string(),
  source: z.string(),
});
const tripDaySchema = z.object({
  date: z.string(),
  theme: z.string(),
  weather: z.string().optional(),
  mapUrl: z.string().optional(),
  navigationUrl: z.string().optional(),
  qrCodeUrl: z.string().optional(),
  nodes: z.array(timelineNodeSchema),
  estimatedCost: z.number(),
  radar: z.object({
    physical: z.number(),
    childFit: z.number(),
    weatherSensitivity: z.number(),
    timeCost: z.number(),
    crowding: z.number(),
  }),
  purpose: z.string(),
  highlights: z.array(z.string()),
  cautions: z.array(z.string()),
  history: z.array(historyNoteSchema).optional(),
  // 管家文案失败日的留痕必须穿透 JSON 边界，保证「本页分析未能生成」可见。
  analysisFailed: z.boolean().optional(),
});

export const tripPlanSchema = z.object({
  meta: z.object({
    title: z.string().min(1),
    origin: z.string(),
    waypoints: z.array(z.string()),
    destination: z.string(),
    startDate: z.string(),
    days: z.number().int().positive(),
    travelers: z.object({
      adults: z.number().int().nonnegative(),
      children: z.number().int().nonnegative(),
    }),
    perPersonBudget: z.number(),
    transportPreference: z.enum(["economy", "balanced", "speed"]),
    pace: z.enum(["relaxed", "balanced", "deep"]),
    interests: z.array(z.string()),
    // 候选景点随计划进入预览/PDF，旧数据缺失时仍可解析。
    allowedAttractions: z.array(z.string()).optional(),
    // 管家 dayCopy 的权威来源标记；preview/PDF 两侧据此跳过 legacy enrichment。
    narrativeSource: z.enum(["butler", "legacy"]).optional(),
  }),
  budget: z.object({
    totalBudget: z.number(),
    estimatedTotal: z.number(),
    totalMin: z.number(),
    totalMax: z.number(),
    remaining: z.number(),
    overBudget: z.number(),
    perPersonBudget: z.number(),
    perPersonEstimated: z.number(),
    rooms: z.number(),
    transport: budgetCategorySchema,
    lodging: budgetCategorySchema,
    food: budgetCategorySchema,
    tickets: budgetCategorySchema,
    other: budgetCategorySchema,
    roadTrip: roadTripBudgetSchema.optional(),
  }),
  route: z.object({
    staticMapUrl: z.string().optional(),
    outbound: z.array(coordinateSchema),
    returnPath: z.array(coordinateSchema),
    outboundSegments: z.array(routeSegmentSchema),
    returnSegments: z.array(routeSegmentSchema),
    distanceKm: z.number(),
    durationMinutes: z.number(),
    returnMode: z.enum(["fast", "scenic"]).nullable(),
  }),
  // 与产品详细路书能力一致：preview 与 exportGuidebook 共用 16 天上限，避免付费调用被无限放大。
  days: z.array(tripDaySchema).max(16),
  // 骨架校验违规需穿透到路书预览/PDF，保证结果页提示条与路书执行提醒同源。
  violations: z
    .array(
      z.object({
        code: z.enum([
          "TIME_WINDOW",
          "DAY_COVERAGE",
          "MISSING_SLOT",
          "OVER_BUDGET",
          "OVER_CAPACITY",
          "PACE_EXCEEDED",
          "UNKNOWN_PLACE",
          "TRANSPORT_CONFLICT",
          "SUMMARY_MISMATCH",
        ]),
        day: z.number().int().positive().optional(),
        nodeIndex: z.number().int().nonnegative().optional(),
        message: z.string(),
        detail: z.object({ expected: z.string(), actual: z.string() }),
      }),
    )
    .optional(),
  closing: z.object({
    quote: z.string().nullable(),
    source: z.string().nullable(),
    message: z.string(),
  }),
});
