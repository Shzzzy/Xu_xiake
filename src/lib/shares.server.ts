import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TripPlan } from "./travel-plan.ts";

type ShareSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

function parseStoredPlan(value: unknown): TripPlan {
  // pg 与 PGlite 对 jsonb 的返回形态可能不同：兼容已解析对象和文本两种结果。
  if (typeof value === "string") return JSON.parse(value) as TripPlan;
  return value as TripPlan;
}

/** 分享令牌只存 SHA-256，数据库泄露时不能直接还原可访问链接。 */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type CreatePlanShareResult = { url: string };
export type ResolvedPlanShare = { plan: TripPlan };

export type SharesService = {
  createPlanShare(userId: string, planId: string): Promise<CreatePlanShareResult>;
  resolvePlanShare(token: string): Promise<ResolvedPlanShare | null>;
};

function assertPlanOwnerExistsInput(userId: string, planId: string): void {
  if (!userId || !planId) throw new Error("缺少用户身份或行程标识");
}

/** 使用注入的 SQL 构造分享服务，便于真实 PGlite 集成测试。 */
export function createSharesService(sql: ShareSql): SharesService {
  async function createPlanShare(userId: string, planId: string): Promise<CreatePlanShareResult> {
    assertPlanOwnerExistsInput(userId, planId);
    const owned = await sql.query<{ id: string }>(
      "select id from travel_plans where id = $1 and user_id = $2 limit 1",
      [planId, userId],
    );
    if (!owned[0]) throw new Error("行程不存在或无权分享");

    const token = randomBytes(32).toString("base64url");
    await sql.query(
      `insert into plan_shares (id, plan_id, owner_user_id, token_hash, status)
       values ($1, $2, $3, $4, 'active')`,
      [randomUUID(), planId, userId, hashShareToken(token)],
    );
    return { url: `/share/${token}` };
  }

  async function resolvePlanShare(token: string): Promise<ResolvedPlanShare | null> {
    if (!token.trim()) return null;
    const rows = await sql.query<{ plan_data: unknown }>(
      `select p.plan_data
         from plan_shares s
         join travel_plans p
           on p.id = s.plan_id and p.user_id = s.owner_user_id
        where s.token_hash = $1
          and s.status = 'active'
          and (s.expires_at is null or s.expires_at > now())
        limit 1`,
      [hashShareToken(token.trim())],
    );
    const row = rows[0];
    return row ? { plan: parseStoredPlan(row.plan_data) } : null;
  }

  return { createPlanShare, resolvePlanShare };
}

let defaultServicePromise: Promise<SharesService> | null = null;

async function getDefaultService(): Promise<SharesService> {
  defaultServicePromise ??= (async () => {
    const { getSql } = await import("./db.ts");
    return createSharesService(await getSql());
  })().catch((error) => {
    defaultServicePromise = null;
    throw error;
  });
  return defaultServicePromise;
}

/** 为当前用户创建一条只读分享链接。 */
export async function createPlanShare(
  userId: string,
  planId: string,
): Promise<CreatePlanShareResult> {
  return (await getDefaultService()).createPlanShare(userId, planId);
}

/** 解析有效分享令牌；不存在、已撤销或已过期时返回 null。 */
export async function resolvePlanShare(token: string): Promise<ResolvedPlanShare | null> {
  return (await getDefaultService()).resolvePlanShare(token);
}
