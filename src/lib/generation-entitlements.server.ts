import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CreditLedgerEntry } from "./credits/types.ts";
import { createCreditsService } from "./credits.server.ts";
import { getTravelPlanWithSql, hashTripPlan, saveTravelPlanWithSql } from "./plans.repository.ts";
import type { TripPlan } from "./travel-plan.ts";

type EntitlementSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: EntitlementSql) => Promise<T>): Promise<T>;
};

type Row = Record<string, unknown>;

export type GenerationEntitlementKind = "guest" | "free" | "paid";
export type GenerationEntitlementStatus =
  "available" | "used" | "claimed" | "consumed" | "released" | "expired" | "failed";

export type PreparedGenerationEntitlement = {
  kind: GenerationEntitlementKind;
  token: string;
  entitlementId: string;
  planId: string;
  requestFingerprint: string;
  userId: string | null;
  reservationId: string | null;
  expiresAt: string;
};

export type GenerationAuthorization = {
  entitlementId: string;
  kind: GenerationEntitlementKind;
  userId: string | null;
  planId: string;
  requestFingerprint: string;
  reservationId: string | null;
};

export type GenerationCredentials = {
  entitlementToken: string;
  requestFingerprint: string;
  userId: string | null;
  cookieEntitlementId: string | null;
};

export type FinalizeFreeInput = {
  userId: string;
  planId: string;
  plan: TripPlan;
  entitlementToken: string;
  requestFingerprint: string;
  cookieEntitlementId?: string | null;
};

export type FinalizePaidInput = {
  userId: string;
  planId: string;
  plan: TripPlan;
  entitlementToken: string;
  requestFingerprint: string;
  cookieEntitlementId?: string | null;
};

export type PreviewResolutionInput = {
  userId: string | null;
  planId: string;
  plan?: TripPlan;
  entitlementToken?: string | null;
  requestFingerprint?: string | null;
  cookieEntitlementId?: string | null;
};

export type GenerationEntitlementsService = {
  prepareGuestGeneration(input: {
    planId: string;
    requestFingerprint: string;
    guestBucket: string;
    ttlHours?: number;
  }): Promise<PreparedGenerationEntitlement | { kind: "needs_login" }>;
  prepareFreeGeneration(input: {
    userId: string;
    planId: string;
    requestFingerprint: string;
  }): Promise<PreparedGenerationEntitlement>;
  preparePaidGeneration(input: {
    userId: string;
    planId: string;
    requestFingerprint: string;
    reservationId: string;
  }): Promise<PreparedGenerationEntitlement>;
  resolvePaidRetryAttempt(input: {
    userId: string;
    planId: string;
    requestFingerprint: string;
  }): Promise<number>;
  authorizeGeneration(input: GenerationCredentials): Promise<GenerationAuthorization>;
  releaseGeneration(
    input: GenerationCredentials,
  ): Promise<{ released: boolean; kind: GenerationEntitlementKind }>;
  releaseGenerationAfterFailure(
    input: GenerationCredentials & { reason: string },
  ): Promise<{ released: boolean; kind: GenerationEntitlementKind }>;
  finalizeGuestGeneration(input: {
    token: string;
    requestFingerprint: string;
    planId: string;
    plan: TripPlan;
    cookieEntitlementId: string;
  }): Promise<void>;
  claimFreeWithEntitlement(input: FinalizeFreeInput): Promise<{ planId: string }>;
  finishPaidWithEntitlement(input: FinalizePaidInput): Promise<CreditLedgerEntry>;
  resolvePreviewPlan(input: PreviewResolutionInput): Promise<TripPlan>;
  ensurePlanExportable(input: {
    userId: string;
    planId: string;
    plan?: TripPlan;
    entitlementToken?: string | null;
    requestFingerprint?: string | null;
    cookieEntitlementId?: string | null;
  }): Promise<TripPlan>;
};

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function mapPrepared(row: Row, token: string): PreparedGenerationEntitlement {
  return {
    kind: row.kind as GenerationEntitlementKind,
    token,
    entitlementId: String(row.id),
    planId: String(row.plan_id),
    requestFingerprint: String(row.request_fingerprint),
    userId: nullableString(row.user_id),
    reservationId: nullableString(row.reservation_id),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
  };
}

function mapAuthorization(row: Row): GenerationAuthorization {
  return {
    entitlementId: String(row.id),
    kind: row.kind as GenerationEntitlementKind,
    userId: nullableString(row.user_id),
    planId: String(row.plan_id),
    requestFingerprint: String(row.request_fingerprint),
    reservationId: nullableString(row.reservation_id),
  };
}

function assertNotExpired(row: Row): void {
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
    throw new Error("生成凭证已过期");
  }
}

function assertFingerprint(row: Row, input: GenerationCredentials): void {
  assertNotExpired(row);
  if (String(row.request_fingerprint) !== input.requestFingerprint) {
    throw new Error("生成凭证与请求指纹不匹配");
  }
}

function assertCredentials(row: Row, input: GenerationCredentials): void {
  assertFingerprint(row, input);
  const kind = row.kind as GenerationEntitlementKind;
  const rowUserId = nullableString(row.user_id);
  if (kind === "guest") {
    if (input.userId) throw new Error("登录用户无权使用访客生成凭证");
    if (input.cookieEntitlementId !== String(row.id)) {
      throw new Error("访客 Cookie 与生成凭证不匹配");
    }
    return;
  }

  if (!input.userId || rowUserId !== input.userId) {
    throw new Error("用户无权使用该生成凭证");
  }
}

/**
 * 优先使用平台可信来源 IP，不能把可伪造的 UA 当成唯一限流维度。
 * 当前只信任平台明确写入的头部，不回退到可由客户端伪造的通用转发头。
 */
export function trustedClientIp(headers: Headers): string {
  const candidates = [
    headers.get("x-nf-client-connection-ip"),
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
  ];
  return candidates.map((value) => value?.trim()).find(Boolean) || "unknown-ip";
}

async function lockEntitlementByToken(sql: EntitlementSql, token: string): Promise<Row> {
  const rows = await sql.query<Row>(
    "select * from generation_entitlements where token_hash = $1 for update",
    [hashGenerationToken(token)],
  );
  const row = rows[0];
  if (!row) throw new Error("生成凭证无效或不存在");
  return row;
}

async function updateEntitlementToUsed(sql: EntitlementSql, id: string): Promise<Row> {
  const rows = await sql.query<Row>(
    "update generation_entitlements set status = 'used', used_at = coalesce(used_at, now()) where id = $1 and status = 'available' returning *",
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error("生成凭证已使用，不能重放");
  return row;
}

function validatePlanAssignment(row: Row, planId: string, planHash?: string): void {
  const rowPlanId = nullableString(row.plan_id);
  if (rowPlanId && rowPlanId !== planId) throw new Error("生成凭证与行程不匹配");
  const rowPlanHash = nullableString(row.plan_hash);
  if (planHash && rowPlanHash && rowPlanHash !== planHash) {
    throw new Error("行程内容与生成凭证不一致");
  }
}

function prepared(
  kind: GenerationEntitlementKind,
  token: string,
  id: string,
  planId: string,
  requestFingerprint: string,
  userId: string | null,
  reservationId: string | null,
  expiresAt: string,
): PreparedGenerationEntitlement {
  return {
    kind,
    token,
    entitlementId: id,
    planId,
    requestFingerprint,
    userId,
    reservationId,
    expiresAt,
  };
}

export function hashGenerationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function entitlementExpiry(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

const MAX_GENERATION_RETRIES = 2;
const MAX_FAILURE_REASON_LENGTH = 500;

function normalizeFailureReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("缺少失败释放原因");
  return Array.from(trimmed).slice(0, MAX_FAILURE_REASON_LENGTH).join("");
}

/** 同一次逻辑生成失败后最多再签发两次新 token。 */
async function nextGenerationRetryCount(
  sql: EntitlementSql,
  input: {
    kind: GenerationEntitlementKind;
    userId: string | null;
    guestBucket: string | null;
    requestFingerprint: string;
    planId: string;
  },
): Promise<number> {
  const rows =
    input.kind === "guest"
      ? await sql.query<{ retry_count: number | null }>(
          `select max(retry_count)::int as retry_count
             from generation_entitlements
            where kind = 'guest'
              and guest_bucket = $1
              and request_fingerprint = $2
              and plan_id = $3
              and status = 'failed'`,
          [input.guestBucket, input.requestFingerprint, input.planId],
        )
      : await sql.query<{ retry_count: number | null }>(
          `select max(retry_count)::int as retry_count
             from generation_entitlements
            where kind = $1
              and user_id = $2
              and request_fingerprint = $3
              and plan_id = $4
              and status = 'failed'`,
          [input.kind, input.userId, input.requestFingerprint, input.planId],
        );
  const current = rows[0]?.retry_count == null ? -1 : Number(rows[0].retry_count);
  if (current >= MAX_GENERATION_RETRIES) {
    throw new Error("生成失败重试次数已达上限，请调整条件后重新发起规划");
  }
  return current + 1;
}

/** 使用注入的 SQL 构造一次性生成权益服务。 */
export function createGenerationEntitlementsService(
  sql: EntitlementSql,
): GenerationEntitlementsService {
  async function prepareGuestGeneration(input: {
    planId: string;
    requestFingerprint: string;
    guestBucket: string;
    ttlHours?: number;
  }): Promise<PreparedGenerationEntitlement | { kind: "needs_login" }> {
    const token = newToken();
    const id = randomUUID();
    const expiresAt = entitlementExpiry(input.ttlHours ?? 24);
    return sql.transaction(async (tx) => {
      const existingRows = await tx.query<Row>(
        "select * from generation_entitlements where guest_bucket = $1 and kind = 'guest' and status in ('available', 'used', 'claimed') for update",
        [input.guestBucket],
      );
      const existing = existingRows[0];
      const rollingWindowMs = (input.ttlHours ?? 24) * 60 * 60 * 1000;
      if (existing) {
        const createdAt = new Date(String(existing.created_at)).getTime();
        if (Date.now() - createdAt < rollingWindowMs) {
          // 已签发但未使用的 token 不能再次轮换，否则并发请求会拿到两把有效钥匙。
          return { kind: "needs_login" };
        }
        await tx.query("update generation_entitlements set status = 'expired' where id = $1", [
          existing.id,
        ]);
      }

      const retryCount = await nextGenerationRetryCount(tx, {
        kind: "guest",
        userId: null,
        guestBucket: input.guestBucket,
        requestFingerprint: input.requestFingerprint,
        planId: input.planId,
      });
      const rows = await tx.query<Row>(
        `insert into generation_entitlements (
           id, token_hash, user_id, request_fingerprint, kind, guest_bucket,
           plan_id, status, expires_at, retry_count
         ) values ($1,$2,null,$3,'guest',$4,$5,'available',$6,$7)
         on conflict (guest_bucket) where kind = 'guest' and status in ('available', 'used', 'claimed')
         do nothing returning *`,
        [
          id,
          hashGenerationToken(token),
          input.requestFingerprint,
          input.guestBucket,
          input.planId,
          expiresAt,
          retryCount,
        ],
      );
      if (rows[0]) {
        return prepared(
          "guest",
          token,
          id,
          input.planId,
          input.requestFingerprint,
          null,
          null,
          expiresAt,
        );
      }

      const activeRows = await tx.query<Row>(
        "select * from generation_entitlements where guest_bucket = $1 and kind = 'guest' and status in ('available', 'used', 'claimed') for update",
        [input.guestBucket],
      );
      const active = activeRows[0];
      if (active) return { kind: "needs_login" };
      throw new Error("访客生成凭证创建冲突，请稍后重试");
    });
  }

  async function prepareFreeGeneration(input: {
    userId: string;
    planId: string;
    requestFingerprint: string;
  }): Promise<PreparedGenerationEntitlement> {
    return sql.transaction(async (tx) => {
      const existingRows = await tx.query<Row>(
        "select * from generation_entitlements where user_id = $1 and kind = 'free' and status in ('available', 'used', 'claimed') for update",
        [input.userId],
      );
      const existing = existingRows[0];
      const token = newToken();
      const expiresAt = entitlementExpiry(24);
      if (existing) {
        if (
          String(existing.request_fingerprint) !== input.requestFingerprint ||
          String(existing.plan_id) !== input.planId ||
          String(existing.status) !== "available"
        ) {
          throw new Error("免费生成凭证已使用");
        }
        throw new Error("免费生成凭证已签发，请勿重复请求");
      }

      const retryCount = await nextGenerationRetryCount(tx, {
        kind: "free",
        userId: input.userId,
        guestBucket: null,
        requestFingerprint: input.requestFingerprint,
        planId: input.planId,
      });
      const id = randomUUID();
      const rows = await tx.query<Row>(
        `insert into generation_entitlements (
           id, token_hash, user_id, request_fingerprint, kind, plan_id,
           status, expires_at, retry_count
         ) values ($1,$2,$3,$4,'free',$5,'available',$6,$7)
         on conflict (user_id) where kind = 'free' and status in ('available', 'used', 'claimed')
         do nothing returning *`,
        [
          id,
          hashGenerationToken(token),
          input.userId,
          input.requestFingerprint,
          input.planId,
          expiresAt,
          retryCount,
        ],
      );
      if (rows[0]) {
        return prepared(
          "free",
          token,
          id,
          input.planId,
          input.requestFingerprint,
          input.userId,
          null,
          expiresAt,
        );
      }

      const activeRows = await tx.query<Row>(
        "select * from generation_entitlements where user_id = $1 and kind = 'free' and status in ('available', 'used', 'claimed') for update",
        [input.userId],
      );
      const active = activeRows[0];
      if (active) throw new Error("免费生成凭证已签发，请勿重复请求");
      throw new Error("免费生成凭证正在创建，请稍后重试");
    });
  }

  async function preparePaidGeneration(input: {
    userId: string;
    planId: string;
    requestFingerprint: string;
    reservationId: string;
  }): Promise<PreparedGenerationEntitlement> {
    return sql.transaction(async (tx) => {
      const existingRows = await tx.query<Row>(
        "select * from generation_entitlements where reservation_id = $1 and kind = 'paid' and status in ('available', 'used', 'claimed') for update",
        [input.reservationId],
      );
      const existing = existingRows[0];
      const token = newToken();
      const expiresAt = entitlementExpiry(1);
      if (existing) {
        if (
          String(existing.request_fingerprint) !== input.requestFingerprint ||
          String(existing.plan_id) !== input.planId ||
          String(existing.status) !== "available"
        ) {
          throw new Error("付费生成凭证已使用");
        }
        throw new Error("付费生成凭证已签发，请勿重复请求");
      }

      const retryCount = await nextGenerationRetryCount(tx, {
        kind: "paid",
        userId: input.userId,
        guestBucket: null,
        requestFingerprint: input.requestFingerprint,
        planId: input.planId,
      });
      const id = randomUUID();
      const rows = await tx.query<Row>(
        `insert into generation_entitlements (
           id, token_hash, user_id, request_fingerprint, kind, plan_id,
           reservation_id, status, expires_at, retry_count
         ) values ($1,$2,$3,$4,'paid',$5,$6,'available',$7,$8)
         on conflict (reservation_id) where kind = 'paid' and status in ('available', 'used', 'claimed')
         do nothing returning *`,
        [
          id,
          hashGenerationToken(token),
          input.userId,
          input.requestFingerprint,
          input.planId,
          input.reservationId,
          expiresAt,
          retryCount,
        ],
      );
      if (rows[0]) {
        return prepared(
          "paid",
          token,
          id,
          input.planId,
          input.requestFingerprint,
          input.userId,
          input.reservationId,
          expiresAt,
        );
      }

      const activeRows = await tx.query<Row>(
        "select * from generation_entitlements where reservation_id = $1 and kind = 'paid' and status = 'available' for update",
        [input.reservationId],
      );
      const active = activeRows[0];
      if (active) throw new Error("付费生成凭证已签发，请勿重复请求");
      throw new Error("付费生成凭证正在创建，请稍后重试");
    });
  }

  async function resolvePaidRetryAttempt(input: {
    userId: string;
    planId: string;
    requestFingerprint: string;
  }): Promise<number> {
    return sql.transaction(async (tx) => {
      const existingRows = await tx.query<Row>(
        `select *
           from generation_entitlements
          where user_id = $1
            and kind = 'paid'
            and request_fingerprint = $2
            and plan_id = $3
            and status in ('available', 'used', 'claimed', 'consumed')
          order by created_at desc
          limit 1
          for update`,
        [input.userId, input.requestFingerprint, input.planId],
      );
      const existing = existingRows[0];
      if (existing) {
        if (String(existing.status) === "consumed") {
          throw new Error("本次生成已完成，不能重复预留点数");
        }
        throw new Error("付费生成凭证已签发，请勿重复确认点数");
      }
      return nextGenerationRetryCount(tx, {
        kind: "paid",
        userId: input.userId,
        guestBucket: null,
        requestFingerprint: input.requestFingerprint,
        planId: input.planId,
      });
    });
  }

  async function authorizeGeneration(
    input: GenerationCredentials,
  ): Promise<GenerationAuthorization> {
    return sql.transaction(async (tx) => {
      const row = await lockEntitlementByToken(tx, input.entitlementToken);
      assertCredentials(row, input);
      if (String(row.status) !== "available") {
        throw new Error("生成凭证已失效，不能重放");
      }
      const used = await updateEntitlementToUsed(tx, String(row.id));
      return mapAuthorization(used);
    });
  }

  async function releaseGeneration(
    input: GenerationCredentials,
  ): Promise<{ released: boolean; kind: GenerationEntitlementKind }> {
    return sql.transaction(async (tx) => {
      const row = await lockEntitlementByToken(tx, input.entitlementToken);
      assertCredentials(row, input);
      const kind = row.kind as GenerationEntitlementKind;
      const status = String(row.status);
      if (status !== "available") {
        throw new Error("只有尚未开始使用的生成凭证可以由客户端释放");
      }
      await tx.query(
        "update generation_entitlements set status = 'released', failure_reason = 'client_cancelled' where id = $1 and status = 'available'",
        [row.id],
      );
      return { released: true, kind };
    });
  }

  /** 仅供服务端生成异常调用；失败是终态，旧 token 永久不能被重放。 */
  async function releaseGenerationAfterFailure(
    input: GenerationCredentials & { reason: string },
  ): Promise<{ released: boolean; kind: GenerationEntitlementKind }> {
    const failureReason = normalizeFailureReason(input.reason);
    return sql.transaction(async (tx) => {
      const row = await lockEntitlementByToken(tx, input.entitlementToken);
      assertCredentials(row, input);
      const kind = row.kind as GenerationEntitlementKind;
      const status = String(row.status);
      if (status !== "available" && status !== "used") return { released: false, kind };

      if (kind === "paid") {
        const reservationId = nullableString(row.reservation_id);
        if (reservationId) await createCreditsService(tx).releaseReservation(reservationId);
      }
      const updated = await tx.query<Row>(
        `update generation_entitlements
            set status = 'failed', failure_reason = $2
          where id = $1 and status in ('available', 'used')
          returning id`,
        [row.id, failureReason],
      );
      return { released: updated.length === 1, kind };
    });
  }

  async function finalizeGuestGeneration(input: {
    token: string;
    requestFingerprint: string;
    planId: string;
    plan: TripPlan;
    cookieEntitlementId: string;
  }): Promise<void> {
    await sql.transaction(async (tx) => {
      const row = await lockEntitlementByToken(tx, input.token);
      assertCredentials(row, {
        entitlementToken: input.token,
        requestFingerprint: input.requestFingerprint,
        userId: null,
        cookieEntitlementId: input.cookieEntitlementId,
      });
      if (String(row.kind) !== "guest") throw new Error("生成凭证类型不匹配");
      validatePlanAssignment(row, input.planId, hashTripPlan(input.plan));
      const status = String(row.status);
      if (status !== "used" && status !== "claimed") throw new Error("生成凭证尚未使用或已失效");
      await tx.query(
        "update generation_entitlements set plan_id = $2, plan_hash = $3, status = 'claimed' where id = $1 and status in ('used', 'claimed')",
        [row.id, input.planId, hashTripPlan(input.plan)],
      );
    });
  }

  async function claimFreeWithEntitlement(input: FinalizeFreeInput): Promise<{ planId: string }> {
    return sql.transaction(async (tx) => {
      const row = await lockEntitlementByToken(tx, input.entitlementToken);
      assertFingerprint(row, {
        entitlementToken: input.entitlementToken,
        requestFingerprint: input.requestFingerprint,
        userId: input.userId,
        cookieEntitlementId: input.cookieEntitlementId ?? null,
      });
      const kind = String(row.kind);
      const rowUserId = nullableString(row.user_id);
      if (kind !== "free" && kind !== "guest") throw new Error("生成凭证类型不匹配");
      if (kind === "free" && rowUserId !== input.userId) throw new Error("用户无权使用该生成凭证");
      if (kind === "guest") {
        if (rowUserId && rowUserId !== input.userId) {
          throw new Error("访客生成凭证已绑定其他用户");
        }
        if (input.cookieEntitlementId !== String(row.id)) {
          throw new Error("访客 Cookie 与生成凭证不匹配");
        }
      }
      validatePlanAssignment(row, input.planId, hashTripPlan(input.plan));

      const status = String(row.status);
      if (status !== "used" && status !== "claimed") throw new Error("生成凭证尚未使用或已失效");

      const existingPlan = await getTravelPlanWithSql(tx, input.userId, input.planId);
      if (!existingPlan) {
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
            "select l.id from credit_ledger l join credit_wallets w on w.id = l.wallet_id where w.user_id = $1 and l.reason = 'free_trial' and l.plan_id = $2 limit 1",
            [input.userId, input.planId],
          );
          if (!existingClaim[0]) throw new Error("免费体验已使用");
        } else {
          await txCredits.claimFreeTrial(input.userId, input.planId);
        }
      }

      await tx.query(
        "update generation_entitlements set user_id = $2, plan_id = $3, plan_hash = $4, status = 'claimed' where id = $1 and status in ('used', 'claimed')",
        [row.id, input.userId, input.planId, hashTripPlan(input.plan)],
      );
      return { planId: input.planId };
    });
  }

  async function finishPaidWithEntitlement(input: FinalizePaidInput): Promise<CreditLedgerEntry> {
    return sql.transaction(async (tx) => {
      const row = await lockEntitlementByToken(tx, input.entitlementToken);
      assertCredentials(row, {
        entitlementToken: input.entitlementToken,
        requestFingerprint: input.requestFingerprint,
        userId: input.userId,
        cookieEntitlementId: input.cookieEntitlementId ?? null,
      });
      if (String(row.kind) !== "paid") throw new Error("生成凭证类型不匹配");
      validatePlanAssignment(row, input.planId, hashTripPlan(input.plan));
      const status = String(row.status);
      if (status !== "used" && status !== "consumed") throw new Error("生成凭证尚未使用或已失效");
      const reservationId = nullableString(row.reservation_id);
      if (!reservationId) throw new Error("付费生成凭证缺少预留");

      await saveTravelPlanWithSql(tx, {
        userId: input.userId,
        planId: input.planId,
        plan: input.plan,
      });
      const txCredits = createCreditsService(tx);
      await txCredits.associateReservationPlan(input.userId, reservationId, input.planId);
      const entry = await txCredits.consumeReservation(reservationId, input.planId);
      await tx.query(
        "update generation_entitlements set plan_id = $2, plan_hash = $3, status = 'consumed' where id = $1 and status in ('used', 'consumed')",
        [row.id, input.planId, hashTripPlan(input.plan)],
      );
      return entry;
    });
  }

  async function resolvePreviewPlan(input: PreviewResolutionInput): Promise<TripPlan> {
    if (input.userId) {
      const saved = await getTravelPlanWithSql(sql, input.userId, input.planId);
      if (saved) return saved;
    }

    if (!input.entitlementToken || !input.requestFingerprint || !input.plan) {
      throw new Error("未授权预览路书");
    }

    const row = await sql.transaction(async (tx) =>
      lockEntitlementByToken(tx, input.entitlementToken!),
    );
    assertCredentials(row, {
      entitlementToken: input.entitlementToken,
      requestFingerprint: input.requestFingerprint,
      userId: input.userId,
      cookieEntitlementId: input.cookieEntitlementId ?? null,
    });
    if (String(row.kind) !== "guest") throw new Error("生成凭证类型不匹配");
    if (!nullableString(row.plan_hash)) throw new Error("访客生成的 plan hash 尚未绑定");
    validatePlanAssignment(row, input.planId, hashTripPlan(input.plan));
    const status = String(row.status);
    if (status !== "claimed" && status !== "used") throw new Error("生成凭证尚未完成预览授权");
    return input.plan;
  }

  async function ensurePlanExportable(input: {
    userId: string;
    planId: string;
    plan?: TripPlan;
    entitlementToken?: string | null;
    requestFingerprint?: string | null;
    cookieEntitlementId?: string | null;
  }): Promise<TripPlan> {
    const existing = await getTravelPlanWithSql(sql, input.userId, input.planId);
    if (existing) return existing;

    if (!input.entitlementToken || !input.requestFingerprint || !input.plan) {
      throw new Error("路书尚未保存或生成凭证不完整");
    }

    const row = await sql.transaction(async (tx) =>
      lockEntitlementByToken(tx, input.entitlementToken!),
    );
    const kind = String(row.kind);
    if (kind === "guest" || kind === "free") {
      await claimFreeWithEntitlement({
        userId: input.userId,
        planId: input.planId,
        plan: input.plan,
        entitlementToken: input.entitlementToken,
        requestFingerprint: input.requestFingerprint,
        cookieEntitlementId: input.cookieEntitlementId ?? null,
      });
      return input.plan;
    }
    await finishPaidWithEntitlement({
      userId: input.userId,
      planId: input.planId,
      plan: input.plan,
      entitlementToken: input.entitlementToken,
      requestFingerprint: input.requestFingerprint,
      cookieEntitlementId: input.cookieEntitlementId ?? null,
    });
    return input.plan;
  }

  return {
    prepareGuestGeneration,
    prepareFreeGeneration,
    preparePaidGeneration,
    resolvePaidRetryAttempt,
    authorizeGeneration,
    releaseGeneration,
    releaseGenerationAfterFailure,
    finalizeGuestGeneration,
    claimFreeWithEntitlement,
    finishPaidWithEntitlement,
    resolvePreviewPlan,
    ensurePlanExportable,
  };
}
