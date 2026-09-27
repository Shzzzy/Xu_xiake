import type { CreditLedgerEntry, CreditReservation } from "./credits/types.ts";
import { createCreditsService, ensureWallet } from "./credits.server.ts";
import {
  createGenerationEntitlementsService,
  hashGenerationToken,
  trustedClientIp,
  type FinalizeFreeInput,
  type FinalizePaidInput,
  type GenerationAuthorization,
  type GenerationCredentials,
  type GenerationEntitlementsService,
  type PreparedGenerationEntitlement,
  type PreviewResolutionInput,
} from "./generation-entitlements.server.ts";

export { hashGenerationToken };
export type { PreparedGenerationEntitlement };
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

export type GenerationPreparedKind = "guest" | "free" | "paid";
export type GenerationPreparation =
  | PreparedGenerationEntitlement
  | {
      kind: "needs_confirmation";
      userId: string;
      planId: string;
      requestFingerprint: string;
    }
  | { kind: "needs_login" }
  | { kind: "needs_purchase" };

/** 兼容旧 UI 命名；实际 paid 入口使用 GenerationPreparation。 */
export type GenerationPermission = GenerationPreparation;

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
  entitlementToken?: string;
  requestFingerprint?: string;
  cookieEntitlementId?: string | null;
};

export type FinishPaidPlanInput = {
  userId: string;
  reservationId?: string;
  planId: string;
  plan: TripPlan;
  entitlementToken?: string;
  requestFingerprint?: string;
  cookieEntitlementId?: string | null;
};

export type EntitlementsService = GenerationEntitlementsService & {
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
  const generation = createGenerationEntitlementsService(sql);
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

    if (input.entitlementToken && input.requestFingerprint) {
      return generation.claimFreeWithEntitlement({
        userId: input.userId,
        planId: input.planId,
        plan: input.plan,
        entitlementToken: input.entitlementToken,
        requestFingerprint: input.requestFingerprint,
        cookieEntitlementId: input.cookieEntitlementId ?? null,
      });
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
    if (!input.planId || !input.plan) {
      throw new Error("缺少行程标识或最终计划");
    }

    if (input.entitlementToken && input.requestFingerprint) {
      return generation.finishPaidWithEntitlement({
        userId: input.userId,
        planId: input.planId,
        plan: input.plan,
        entitlementToken: input.entitlementToken,
        requestFingerprint: input.requestFingerprint,
        cookieEntitlementId: input.cookieEntitlementId ?? null,
      });
    }

    const reservationId = input.reservationId;
    if (!reservationId) throw new Error("缺少预留标识");

    return sql.transaction(async (tx) => {
      const ownerUserId = await reservationOwnerUserId(tx, reservationId);
      if (!ownerUserId) throw new Error("点数预留不存在、已消费或已过期");
      if (ownerUserId !== input.userId) throw new Error("行程不存在或无权访问");

      await saveTravelPlanWithSql(tx, {
        userId: input.userId,
        planId: input.planId,
        plan: input.plan,
      });
      const txCredits = createCreditsService(tx);
      await txCredits.associateReservationPlan(input.userId, reservationId, input.planId);
      return txCredits.consumeReservation(reservationId, input.planId);
    });
  }

  return {
    ...generation,
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

const GUEST_GENERATION_COOKIE = "guest_generation_entitlement";
const GUEST_GENERATION_TTL_MS = 24 * 60 * 60 * 1000;

/** 读取当前请求绑定的访客凭证 id；没有 Cookie 时返回 null。 */
export async function readGuestGenerationEntitlementId(): Promise<string | null> {
  const { getCookie } = await import("@tanstack/react-start/server");
  return getCookie(GUEST_GENERATION_COOKIE) ?? null;
}

/** 只在服务端设置访客凭证 Cookie，客户端 JavaScript 无法读取。 */
async function setGuestGenerationEntitlementCookie(entitlementId: string): Promise<void> {
  const { setCookie } = await import("@tanstack/react-start/server");
  setCookie(GUEST_GENERATION_COOKIE, entitlementId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: GUEST_GENERATION_TTL_MS / 1000,
    path: "/",
  });
}

/** 只清理与本次 attempt 相同的 Cookie，避免失败请求清掉新请求。 */
export async function clearGuestGenerationEntitlementCookie(
  entitlementId?: string | null,
): Promise<void> {
  const { deleteCookie, getCookie } = await import("@tanstack/react-start/server");
  const current = getCookie(GUEST_GENERATION_COOKIE);
  if (!current) return;
  if (entitlementId && current !== entitlementId) return;
  deleteCookie(GUEST_GENERATION_COOKIE, { path: "/" });
}

/** IP + UA + 24 小时窗口组成 guest bucket，防止清 Cookie 后无限试用。 */
export async function createGuestRequestBucket(): Promise<string> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const request = getRequest();
  const ip = request ? trustedClientIp(request.headers) : "unknown-ip";
  // 滚动 24 小时由 entitlement.created_at 判断，bucket 本身只绑定可信 IP，UA 变化不能绕开。
  return hashGenerationToken(ip);
}

/** 生成前只做权益判断并签发一次性凭证。 */
export async function preparePlanGeneration(
  userId: string | null,
  planId: string,
  requestFingerprint = planId,
  guestBucket?: string,
): Promise<GenerationPreparation> {
  if (!planId || !requestFingerprint) throw new Error("缺少生成标识或请求指纹");
  const service = await getDefaultService();
  if (!userId) {
    const bucket = guestBucket ?? (await createGuestRequestBucket());
    const guest = await service.prepareGuestGeneration({
      planId,
      requestFingerprint,
      guestBucket: bucket,
    });
    if (guest.kind === "needs_login") return guest;
    await setGuestGenerationEntitlementCookie(guest.entitlementId);
    return guest;
  }

  const wallet = await ensureWallet(userId);
  const decision = decideGenerationPermission({
    userId,
    wallet: {
      balance: wallet.balance,
      reserved: wallet.reserved,
      freeTrialClaimed: wallet.freeTrialClaimed,
    },
  });
  if (decision.kind === "free") {
    return service.prepareFreeGeneration({ userId, planId, requestFingerprint });
  }
  if (decision.kind === "needs_confirmation") {
    return { ...decision, planId, requestFingerprint };
  }
  return { kind: "needs_purchase" };
}

/** 用户确认后预留点数并签发 paid 凭证。 */
export async function reservePaidGeneration(
  userId: string,
  planId: string,
  requestFingerprint = planId,
): Promise<PreparedGenerationEntitlement> {
  const reservation = await reservePaidPlan(userId, planId);
  try {
    return await (
      await getDefaultService()
    ).preparePaidGeneration({
      userId,
      planId,
      requestFingerprint,
      reservationId: reservation.id,
    });
  } catch (error) {
    await releasePaidPlan(userId, reservation.id).catch(() => undefined);
    throw error;
  }
}

/** 生成接口在执行前必须调用；token 会原子标记 used，重复调用会失败。 */
export async function authorizeGenerationEntitlement(
  input: GenerationCredentials,
): Promise<GenerationAuthorization> {
  return (await getDefaultService()).authorizeGeneration(input);
}

/** 公开释放只允许 available 凭证，used 必须由服务端失败路径释放。 */
export async function releaseGenerationEntitlement(
  input: GenerationCredentials,
): Promise<{ released: boolean; kind: GenerationPreparedKind }> {
  return (await getDefaultService()).releaseGeneration(input);
}

/** 服务端生成异常内部调用，允许释放 used 并记录原因。 */
export async function releaseGenerationAfterFailure(
  input: GenerationCredentials & { reason: string },
): Promise<{ released: boolean; kind: GenerationPreparedKind }> {
  return (await getDefaultService()).releaseGenerationAfterFailure(input);
}

/** 访客生成成功后把最终 plan 绑定到凭证，等待登录后 claim。 */
export async function finalizeGuestGeneration(input: {
  token: string;
  requestFingerprint: string;
  planId: string;
  plan: TripPlan;
  cookieEntitlementId: string;
}): Promise<void> {
  await (await getDefaultService()).finalizeGuestGeneration(input);
}

/** 预览接口的统一入口：登录读取已保存 plan，访客验证一次性凭证与 plan hash。 */
export async function resolvePreviewPlan(input: PreviewResolutionInput): Promise<TripPlan> {
  return (await getDefaultService()).resolvePreviewPlan(input);
}

/** 导出前的统一服务端入口：已保存直接通过，否则按 entitlement kind 绑定/claim/consume。 */
export async function ensurePlanExportable(input: {
  userId: string;
  planId: string;
  plan?: TripPlan;
  entitlementToken?: string | null;
  requestFingerprint?: string | null;
  cookieEntitlementId?: string | null;
}): Promise<TripPlan> {
  return (await getDefaultService()).ensurePlanExportable(input);
}

/** 访客首次生成时写入旧版本兼容 Cookie；新链路使用 preparePlanGeneration。 */
export async function claimGuestGenerationAttempt(): Promise<GenerationDecision> {
  const { getCookie } = await import("@tanstack/react-start/server");
  const decision = resolveGuestGenerationDecision(Boolean(getCookie(GUEST_GENERATION_COOKIE)));
  if (decision.kind !== "guest") return decision;
  await clearGuestGenerationEntitlementCookie();
  return decision;
}

/** 兼容旧调用；新链路使用 releaseGenerationEntitlement。 */
export async function releaseGuestGenerationAttempt(): Promise<void> {
  await clearGuestGenerationEntitlementCookie();
}
