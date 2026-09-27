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
  "available" | "used" | "claimed" | "consumed" | "released" | "expired";

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
 * Netlify 头优先于 Cloudflare/代理头，最后才回落 X-Forwarded-For。
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
    "update generation_entitlements set status = 'used', used_at = coalesce(used_at, now()) where id = $1 and status in ('available', 'released') returning *",
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
        if (Date.now() - createdAt < rollingWindowMs) return { kind: "needs_login" };
        await tx.query("update generation_entitlements set status = 'expired' where id = $1", [
          existing.id,
        ]);
      }

      const rows = await tx.query<Row>(
        "insert into generation_entitlements (id, token_hash, user_id, request_fingerprint, kind, guest_bucket, plan_id, status, expires_at) values ($1,$2,null,$3,'guest',$4,$5,'available',$6) on conflict (guest_bucket) where kind = 'guest' and status in ('available', 'used', 'claimed') do nothing returning *",
        [
          id,
          hashGenerationToken(token),
          input.requestFingerprint,
          input.guestBucket,
          input.planId,
          expiresAt,
        ],
      );
      if (!rows[0]) return { kind: "needs_login" };
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
        if (String(existing.status) !== "available") throw new Error("免费生成凭证已使用");
        const rows = await tx.query<Row>(
          "update generation_entitlements set token_hash = $2, request_fingerprint = $3, plan_id = $4, expires_at = $5 where id = $1 and status = 'available' returning *",
          [
            existing.id,
            hashGenerationToken(token),
            input.requestFingerprint,
            input.planId,
            expiresAt,
          ],
        );
        if (!rows[0]) throw new Error("免费生成凭证已使用");
        return prepared(
          "free",
          token,
          String(rows[0].id),
          input.planId,
          input.requestFingerprint,
          input.userId,
          null,
          expiresAt,
        );
      }

      const id = randomUUID();
      const rows = await tx.query<Row>(
        "insert into generation_entitlements (id, token_hash, user_id, request_fingerprint, kind, plan_id, status, expires_at) values ($1,$2,$3,$4,'free',$5,'available',$6) returning *",
        [
          id,
          hashGenerationToken(token),
          input.userId,
          input.requestFingerprint,
          input.planId,
          expiresAt,
        ],
      );
      if (!rows[0]) throw new Error("免费生成凭证创建失败");
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
        if (String(existing.status) !== "available") throw new Error("付费生成凭证已使用");
        const rows = await tx.query<Row>(
          "update generation_entitlements set token_hash = $2, request_fingerprint = $3, plan_id = $4, expires_at = $5 where id = $1 and status = 'available' returning *",
          [
            existing.id,
            hashGenerationToken(token),
            input.requestFingerprint,
            input.planId,
            expiresAt,
          ],
        );
        if (!rows[0]) throw new Error("付费生成凭证已使用");
        return prepared(
          "paid",
          token,
          String(rows[0].id),
          input.planId,
          input.requestFingerprint,
          input.userId,
          input.reservationId,
          expiresAt,
        );
      }

      const id = randomUUID();
      const rows = await tx.query<Row>(
        "insert into generation_entitlements (id, token_hash, user_id, request_fingerprint, kind, plan_id, reservation_id, status, expires_at) values ($1,$2,$3,$4,'paid',$5,$6,'available',$7) returning *",
        [
          id,
          hashGenerationToken(token),
          input.userId,
          input.requestFingerprint,
          input.planId,
          input.reservationId,
          expiresAt,
        ],
      );
      if (!rows[0]) throw new Error("付费生成凭证创建失败");
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
    });
  }

  async function authorizeGeneration(
    input: GenerationCredentials,
  ): Promise<GenerationAuthorization> {
    return sql.transaction(async (tx) => {
      const row = await lockEntitlementByToken(tx, input.entitlementToken);
      assertCredentials(row, input);
      if (String(row.kind) === "paid" && String(row.status) === "released") {
        throw new Error("付费生成凭证已释放，请重新确认点数");
      }
      if (String(row.status) !== "available" && String(row.status) !== "released") {
        throw new Error("生成凭证已使用，不能重放");
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

  /** 仅供服务端生成异常调用，允许释放已经标记 used 的本次 attempt。 */
  async function releaseGenerationAfterFailure(
    input: GenerationCredentials & { reason: string },
  ): Promise<{ released: boolean; kind: GenerationEntitlementKind }> {
    if (!input.reason.trim()) throw new Error("缺少失败释放原因");
    return sql.transaction(async (tx) => {
      const row = await lockEntitlementByToken(tx, input.entitlementToken);
      assertCredentials(row, input);
      const kind = row.kind as GenerationEntitlementKind;
      const status = String(row.status);
      if (status === "released") return { released: false, kind };
      if (status !== "available" && status !== "used") return { released: false, kind };

      if (kind === "paid") {
        const reservationId = nullableString(row.reservation_id);
        if (reservationId) await createCreditsService(tx).releaseReservation(reservationId);
      }
      await tx.query(
        "update generation_entitlements set status = 'released', failure_reason = $2 where id = $1 and status in ('available', 'used')",
        [row.id, input.reason],
      );
      return { released: true, kind };
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
