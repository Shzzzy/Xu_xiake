import type { CreditLedgerEntry, CreditReservation } from "./credits/types.ts";
import { createCreditsService } from "./credits.server.ts";
import {
  getTravelPlanWithSql,
  saveTravelPlanWithSql,
  type SaveTravelPlanInput,
} from "./plans.repository.ts";
import type { TripPlan } from "./travel-plan.ts";

type EntitlementSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: EntitlementSql) => Promise<T>): Promise<T>;
};

export type EntitlementsService = {
  saveTravelPlan(input: SaveTravelPlanInput): Promise<{ id: string }>;
  getTravelPlan(userId: string, planId: string): Promise<TripPlan | null>;
  claimFirstFreePlan(userId: string, plan: TripPlan): Promise<{ planId: string }>;
  reservePaidPlan(userId: string, planId: string): Promise<CreditReservation>;
  finishPaidPlan(
    reservationId: string,
    planId: string,
    userId?: string,
  ): Promise<CreditLedgerEntry>;
};

async function reservationOwnerUserId(
  sql: EntitlementSql,
  reservationId: string,
): Promise<string | null> {
  const rows = await sql.query<{ user_id: string }>(
    `select w.user_id
     from credit_reservations r
     join credit_wallets w on w.id = r.wallet_id
     where r.id = $1`,
    [reservationId],
  );
  return rows[0]?.user_id ?? null;
}

/**
 * 使用注入的 Sql 构造行程权益服务。
 * 生产入口注入 getSql()，测试可注入真实 PGlite，保证保存、领取和消费走同一套事务逻辑。
 */
export function createEntitlementsService(sql: EntitlementSql): EntitlementsService {
  async function saveTravelPlan(input: SaveTravelPlanInput): Promise<{ id: string }> {
    return saveTravelPlanWithSql(sql, input);
  }

  async function getTravelPlan(userId: string, planId: string): Promise<TripPlan | null> {
    return getTravelPlanWithSql(sql, userId, planId);
  }

  /**
   * 首次免费领取必须在同一事务中完成：先写入属于当前用户的行程，再领取免费权益。
   * 如果 claim 失败，事务回滚，不会留下孤立行程或错误的免费状态。
   */
  async function claimFirstFreePlan(userId: string, plan: TripPlan): Promise<{ planId: string }> {
    return sql.transaction(async (tx) => {
      const saved = await saveTravelPlanWithSql(tx, { userId, plan });
      const txCredits = createCreditsService(tx);
      await txCredits.ensureWallet(userId);
      await txCredits.claimFreeTrial(userId, saved.id);
      return { planId: saved.id };
    });
  }

  /** 付费预留前先确认行程属于当前用户，避免把点数预留绑定到他人行程。 */
  async function reservePaidPlan(userId: string, planId: string): Promise<CreditReservation> {
    return sql.transaction(async (tx) => {
      const plan = await getTravelPlanWithSql(tx, userId, planId);
      if (!plan) throw new Error("行程不存在或无权访问");
      return createCreditsService(tx).reserveCredit(userId, planId);
    });
  }

  /**
   * 完成付费生成时，既校验预留所属账号，也校验行程属于该账号。
   * 两参数调用兼容既有接口；三参数调用用于 server function 显式传入当前用户。
   */
  async function finishPaidPlan(
    reservationId: string,
    planId: string,
    userId?: string,
  ): Promise<CreditLedgerEntry> {
    return sql.transaction(async (tx) => {
      const ownerUserId = await reservationOwnerUserId(tx, reservationId);
      if (!ownerUserId) throw new Error("点数预留不存在、已消费或已过期");
      if (userId && ownerUserId !== userId) throw new Error("行程不存在或无权访问");

      const plan = await getTravelPlanWithSql(tx, ownerUserId, planId);
      if (!plan) throw new Error("行程不存在或无权访问");

      return createCreditsService(tx).consumeReservation(reservationId, planId);
    });
  }

  return {
    saveTravelPlan,
    getTravelPlan,
    claimFirstFreePlan,
    reservePaidPlan,
    finishPaidPlan,
  };
}

let defaultServicePromise: Promise<EntitlementsService> | null = null;

async function getDefaultService(): Promise<EntitlementsService> {
  defaultServicePromise ??= (async () => {
    const { getSql } = await import("./db.ts");
    return createEntitlementsService(await getSql());
  })().catch((error) => {
    defaultServicePromise = null;
    throw error;
  });
  return defaultServicePromise;
}

/** 保存一份归属于指定用户的旅行方案。 */
export function saveTravelPlan(input: SaveTravelPlanInput): Promise<{ id: string }> {
  return getDefaultService().then((service) => service.saveTravelPlan(input));
}

/** 按用户读取旅行方案；不属于该用户时返回 null。 */
export function getTravelPlan(userId: string, planId: string): Promise<TripPlan | null> {
  return getDefaultService().then((service) => service.getTravelPlan(userId, planId));
}

/** 为当前用户保存行程并领取首次免费权益。 */
export function claimFirstFreePlan(userId: string, plan: TripPlan): Promise<{ planId: string }> {
  return getDefaultService().then((service) => service.claimFirstFreePlan(userId, plan));
}

/** 为当前用户的已有行程预留一点。 */
export function reservePaidPlan(userId: string, planId: string): Promise<CreditReservation> {
  return getDefaultService().then((service) => service.reservePaidPlan(userId, planId));
}

/** 完成当前用户的付费生成消费。 */
export function finishPaidPlan(
  reservationId: string,
  planId: string,
  userId?: string,
): Promise<CreditLedgerEntry> {
  return getDefaultService().then((service) =>
    service.finishPaidPlan(reservationId, planId, userId),
  );
}
