import { randomUUID } from "node:crypto";
import type { TripPlan } from "./travel-plan.ts";

export type SaveTravelPlanInput = {
  userId: string;
  plan: TripPlan;
};

type PlanSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

function parseStoredPlan(value: unknown): TripPlan {
  // pg 与 PGlite 对 jsonb 的返回形态可能不同：兼容已解析对象和文本两种结果。
  if (typeof value === "string") return JSON.parse(value) as TripPlan;
  return value as TripPlan;
}

/**
 * 使用调用方提供的 Sql 写入行程，便于上层在一条事务中同时保存行程和领取权益。
 * plan_data 固定使用 jsonb，避免把大型行程对象拆散成多张表。
 */
export async function saveTravelPlanWithSql(
  sql: PlanSql,
  input: SaveTravelPlanInput,
): Promise<{ id: string }> {
  const id = randomUUID();
  await sql.query(
    `insert into travel_plans (
       id, user_id, title, origin, destination, days, status, plan_data
     ) values ($1,$2,$3,$4,$5,$6,'saved',$7::jsonb)`,
    [
      id,
      input.userId,
      input.plan.meta.title,
      input.plan.meta.origin,
      input.plan.meta.destination,
      input.plan.meta.days,
      JSON.stringify(input.plan),
    ],
  );
  return { id };
}

/** 保存一份归属于指定用户的旅行方案。 */
export async function saveTravelPlan(input: SaveTravelPlanInput): Promise<{ id: string }> {
  const { getSql } = await import("./db.ts");
  const sql = await getSql();
  return saveTravelPlanWithSql(sql, input);
}

/** 按用户和行程 ID 读取行程；查询条件同时包含 user_id，天然阻止跨用户读取。 */
export async function getTravelPlanWithSql(
  sql: PlanSql,
  userId: string,
  planId: string,
): Promise<TripPlan | null> {
  const rows = await sql.query<{ plan_data: unknown }>(
    "select plan_data from travel_plans where id = $1 and user_id = $2",
    [planId, userId],
  );
  const row = rows[0];
  return row ? parseStoredPlan(row.plan_data) : null;
}

/** 读取当前用户拥有的旅行方案；不属于该用户时返回 null。 */
export async function getTravelPlan(userId: string, planId: string): Promise<TripPlan | null> {
  const { getSql } = await import("./db.ts");
  const sql = await getSql();
  return getTravelPlanWithSql(sql, userId, planId);
}
