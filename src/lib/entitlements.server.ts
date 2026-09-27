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

export type ClaimFirstFreePlanInput = {
  userId: string;
  planId: string;
  plan: TripPlan;
};

export type FinishPaidPlanInput = {
  userId: string;
  reservationId: string;
  planId: string;
};

export type EntitlementsService = {
  saveTravelPlan(input: SaveTravelPlanInput): Promise<{ id: string }>;
  getTravelPlan(userId: string, planId: string): Promise<TripPlan | null>;
  claimFirstFreePlan(input: ClaimFirstFreePlanInput): Promise<{ planId: string }>;
  reservePaidPlan(userId: string, planId: string): Promise<CreditReservation>;
  finishPaidPlan(input: FinishPaidPlanInput): Promise<CreditLedgerEntry>;
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
  async function claimFirstFreePlan(input: ClaimFirstFreePlanInput): Promise<{ planId: string }> {
    if (!input?.userId || !input.planId || !input.plan) {
      throw new Error("缺少用户身份或行程标识");
    }

    return sql.transaction(async (tx) => {
      await saveTravelPlanWithSql(tx, {
        userId: input.userId,
        planId: input.planId,
        plan: input.plan,
      });
      const txCredits = createCreditsService(tx);
      await txCredits.ensureWallet(input.userId);

      const wallets = await tx.query<{ free_trial_claimed: boolean }>(
        "select free_trial_claimed from credit_wallets where user_id = $1 for update",
        [input.userId],
      );
      const wallet = wallets[0];
      if (!wallet) throw new Error("钱包不存在");

      if (Boolean(wallet.free_trial_claimed)) {
        const existingClaim = await tx.query<{ id: string }>(
          `select l.id
           from credit_ledger l
           join credit_wallets w on w.id = l.wallet_id
           where w.user_id = $1 and l.reason = 'free_trial' and l.plan_id = $2
           limit 1`,
          [input.userId, input.planId],
        );
        if (existingClaim[0]) return { planId: input.planId };
        throw new Error("免费体验已使用");
      }

      await txCredits.claimFreeTrial(input.userId, input.planId);
      return { planId: input.planId };
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
   * 完成付费生成时必须显式传入当前用户，并同时校验预留账号和行程归属。
   */
  async function finishPaidPlan(input: FinishPaidPlanInput): Promise<CreditLedgerEntry> {
    if (!input?.userId) throw new Error("缺少用户身份");
    if (!input.reservationId || !input.planId) throw new Error("缺少预留或行程标识");

    return sql.transaction(async (tx) => {
      const ownerUserId = await reservationOwnerUserId(tx, input.reservationId);
      if (!ownerUserId) throw new Error("点数预留不存在、已消费或已过期");
      if (ownerUserId !== input.userId) throw new Error("行程不存在或无权访问");

      const plan = await getTravelPlanWithSql(tx, input.userId, input.planId);
      if (!plan) throw new Error("行程不存在或无权访问");

      return createCreditsService(tx).consumeReservation(input.reservationId, input.planId);
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
export function claimFirstFreePlan(input: ClaimFirstFreePlanInput): Promise<{ planId: string }> {
  return getDefaultService().then((service) => service.claimFirstFreePlan(input));
}

/** 为当前用户的已有行程预留一点。 */
export function reservePaidPlan(userId: string, planId: string): Promise<CreditReservation> {
  return getDefaultService().then((service) => service.reservePaidPlan(userId, planId));
}

/** 完成当前用户的付费生成消费。 */
export function finishPaidPlan(input: FinishPaidPlanInput): Promise<CreditLedgerEntry> {
  return getDefaultService().then((service) => service.finishPaidPlan(input));
}
