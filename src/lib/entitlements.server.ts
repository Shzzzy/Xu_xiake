import type { CreditLedgerEntry, CreditReservation } from "./credits/types.ts";
import { createCreditsService, ensureWallet } from "./credits.server.ts";
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

export type GenerationDecision =
  | { kind: "guest" }
  | { kind: "free"; userId: string }
  | { kind: "needs_confirmation"; userId: string }
  | { kind: "needs_login" }
  | { kind: "needs_purchase" };

export type GenerationPermission =
  | { kind: "guest" }
  | { kind: "free"; userId: string }
  | { kind: "paid"; reservationId: string }
  | { kind: "needs_login" }
  | { kind: "needs_purchase" };

/** 根据钱包状态决定本次生成先走免费、确认扣点还是购买。 */
export function decideGenerationPermission(input: {
  userId: string | null;
  wallet: { balance: number; reserved: number; freeTrialClaimed: boolean } | null;
}): GenerationDecision {
  if (!input.userId) return { kind: "guest" };
  if (!input.wallet) return { kind: "needs_purchase" };
  if (!input.wallet.freeTrialClaimed) return { kind: "free", userId: input.userId };
  if (input.wallet.balance - input.wallet.reserved >= 1) {
    return { kind: "needs_confirmation", userId: input.userId };
  }
  return { kind: "needs_purchase" };
}

/** 访客权益只按 Cookie 是否用过判断，便于单测覆盖真实分支。 */
export function resolveGuestGenerationDecision(hasUsedCookie: boolean): GenerationDecision {
  return hasUsedCookie ? { kind: "needs_login" } : { kind: "guest" };
}

export type ClaimFirstFreePlanInput = {
  userId: string;
  planId: string;
  plan: TripPlan;
};

export type FinishPaidPlanInput = {
  userId: string;
  reservationId: string;
  planId: string;
  plan: TripPlan;
};

export type EntitlementsService = {
  saveTravelPlan(input: SaveTravelPlanInput): Promise<{ id: string }>;
  getTravelPlan(userId: string, planId: string): Promise<TripPlan | null>;
  claimFirstFreePlan(input: ClaimFirstFreePlanInput): Promise<{ planId: string }>;
  reservePaidPlan(userId: string, planId: string): Promise<CreditReservation>;
  releasePaidPlan(userId: string, reservationId: string): Promise<void>;
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
      // 已经保存过的行程说明权益已处理，重复调用直接返回，保证 PDF/分享入口可安全重试。
      const existingPlan = await getTravelPlanWithSql(tx, input.userId, input.planId);
      if (existingPlan) return { planId: input.planId };

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

  /**
   * 付费生成在 plan 尚未存在时先预占点数。
   * 预留的 plan_id 先为空，finish 成功保存 plan 后再关联，避免创建半成品行程。
   */
  async function reservePaidPlan(userId: string, planId: string): Promise<CreditReservation> {
    return sql.transaction(async (tx) => {
      const txCredits = createCreditsService(tx);
      await txCredits.ensureWallet(userId);
      return txCredits.reserveCreditForGeneration(userId, planId);
    });
  }

  /** 生成失败时释放预占；只允许预留所属账号执行。 */
  async function releasePaidPlan(userId: string, reservationId: string): Promise<void> {
    if (!userId || !reservationId) throw new Error("缺少用户身份或预留标识");
    await sql.transaction(async (tx) => {
      const ownerUserId = await reservationOwnerUserId(tx, reservationId);
      if (!ownerUserId) throw new Error("点数预留不存在或已消费");
      if (ownerUserId !== userId) throw new Error("点数预留无权访问");
      await createCreditsService(tx).releaseReservation(reservationId);
    });
  }

  /**
   * 完成付费生成时先保存最终 plan，再在同一事务内关联并消费预留。
   * 任一步失败都会整体回滚，重复调用返回原 generation 流水。
   */
  async function finishPaidPlan(input: FinishPaidPlanInput): Promise<CreditLedgerEntry> {
    if (!input?.userId) throw new Error("缺少用户身份");
    if (!input.reservationId || !input.planId || !input.plan) {
      throw new Error("缺少预留、行程标识或最终计划");
    }

    return sql.transaction(async (tx) => {
      const ownerUserId = await reservationOwnerUserId(tx, input.reservationId);
      if (!ownerUserId) throw new Error("点数预留不存在、已消费或已过期");
      if (ownerUserId !== input.userId) throw new Error("行程不存在或无权访问");

      await saveTravelPlanWithSql(tx, {
        userId: input.userId,
        planId: input.planId,
        plan: input.plan,
      });
      const txCredits = createCreditsService(tx);
      await txCredits.associateReservationPlan(input.userId, input.reservationId, input.planId);
      return txCredits.consumeReservation(input.reservationId, input.planId);
    });
  }

  return {
    saveTravelPlan,
    getTravelPlan,
    claimFirstFreePlan,
    reservePaidPlan,
    releasePaidPlan,
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

/** 为当前用户的待保存行程预留一点。 */
export function reservePaidPlan(userId: string, planId: string): Promise<CreditReservation> {
  return getDefaultService().then((service) => service.reservePaidPlan(userId, planId));
}

/** 生成失败时释放当前用户拥有的预留。 */
export function releasePaidPlan(userId: string, reservationId: string): Promise<void> {
  return getDefaultService().then((service) => service.releasePaidPlan(userId, reservationId));
}

/** 完成当前用户的付费生成消费。 */
export function finishPaidPlan(input: FinishPaidPlanInput): Promise<CreditLedgerEntry> {
  return getDefaultService().then((service) => service.finishPaidPlan(input));
}

const GUEST_GENERATION_COOKIE = "guest_generation_used";

/** 访客首次生成时写入 HttpOnly Cookie；第二次生成要求登录。 */
export async function claimGuestGenerationAttempt(): Promise<GenerationDecision> {
  const { getCookie, setCookie } = await import("@tanstack/react-start/server");
  const decision = resolveGuestGenerationDecision(Boolean(getCookie(GUEST_GENERATION_COOKIE)));
  if (decision.kind !== "guest") return decision;
  setCookie(GUEST_GENERATION_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24,
    path: "/",
  });
  return decision;
}

/** 访客生成失败时回滚 Cookie，避免一次失败就锁死免费体验。 */
export async function releaseGuestGenerationAttempt(): Promise<void> {
  const { deleteCookie } = await import("@tanstack/react-start/server");
  deleteCookie(GUEST_GENERATION_COOKIE, { path: "/" });
}

/** 生成前只做权益判断；付费用户必须先经过前端确认再单独预留。 */
export async function preparePlanGeneration(
  userId: string | null,
  planId: string,
): Promise<GenerationDecision> {
  if (!planId) throw new Error("缺少生成标识");
  if (!userId) return claimGuestGenerationAttempt();
  const wallet = await ensureWallet(userId);
  return decideGenerationPermission({
    userId,
    wallet: {
      balance: wallet.balance,
      reserved: wallet.reserved,
      freeTrialClaimed: wallet.freeTrialClaimed,
    },
  });
}

/** 已确认扣点后执行预留。 */
export async function reservePaidGeneration(
  userId: string,
  planId: string,
): Promise<GenerationPermission> {
  const reservation = await reservePaidPlan(userId, planId);
  return { kind: "paid", reservationId: reservation.id };
}
