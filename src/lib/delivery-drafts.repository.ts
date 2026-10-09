import { hashTripPlan } from "./plans.repository.ts";
import type { TripPlan } from "./travel-plan.ts";

type DraftSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

type DraftRow = Record<string, unknown> & {
  id: string;
  owner_user_id: string | null;
  guest_session_hash: string | null;
  plan_id: string;
  request_fingerprint: string;
  entitlement_id: string | null;
  plan_hash: string;
  plan_data: unknown;
  preview_scope: "full" | "limited";
  page_manifest_hash: string | null;
  page_count: number;
  status: DeliveryDraftStatus;
  version_id: string | null;
  failure_reason: string | null;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type DeliveryDraftStatus =
  | "generating"
  | "preview_ready"
  | "awaiting_finalize"
  | "finalized"
  | "failed"
  | "expired";

export type DeliveryDraftRecord = {
  id: string;
  ownerUserId: string | null;
  guestSessionHash: string | null;
  planId: string;
  requestFingerprint: string;
  entitlementId: string | null;
  planHash: string;
  plan: TripPlan;
  previewScope: "full" | "limited";
  pageManifestHash: string | null;
  pageCount: number;
  status: DeliveryDraftStatus;
  versionId: string | null;
  failureReason: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateDeliveryDraftInput = {
  id: string;
  ownerUserId: string | null;
  guestSessionHash: string | null;
  planId: string;
  requestFingerprint: string;
  entitlementId: string | null;
  plan: TripPlan;
  previewScope: "full" | "limited";
  expiresAt: Date;
};

export type ClaimDeliveryDraftForUserInput = {
  draftId: string;
  userId: string;
  guestSessionHash: string | null;
};

export type PreviewReadyInput = {
  id: string;
  pageManifestHash: string;
  pageCount: number;
};

export type FinalizedInput = {
  id: string;
  versionId: string;
};

export type FailedInput = {
  id: string;
  reason: string;
};

function parseStoredPlan(value: unknown): TripPlan {
  if (typeof value === "string") return JSON.parse(value) as TripPlan;
  return value as TripPlan;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapDraftRow(row: DraftRow): DeliveryDraftRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    guestSessionHash: row.guest_session_hash,
    planId: row.plan_id,
    requestFingerprint: row.request_fingerprint,
    entitlementId: row.entitlement_id,
    planHash: row.plan_hash,
    plan: parseStoredPlan(row.plan_data),
    previewScope: row.preview_scope,
    pageManifestHash: row.page_manifest_hash,
    pageCount: Number(row.page_count),
    status: row.status,
    versionId: row.version_id,
    failureReason: row.failure_reason,
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export async function createDeliveryDraft(
  sql: DraftSql,
  input: CreateDeliveryDraftInput,
): Promise<DeliveryDraftRecord> {
  const rows = await sql.query<DraftRow>(
    `insert into trip_drafts (
       id, owner_user_id, guest_session_hash, plan_id, request_fingerprint,
       entitlement_id, plan_hash, plan_data, preview_scope, expires_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     returning *`,
    [
      input.id,
      input.ownerUserId,
      input.guestSessionHash,
      input.planId,
      input.requestFingerprint,
      input.entitlementId,
      hashTripPlan(input.plan),
      JSON.stringify(input.plan),
      input.previewScope,
      input.expiresAt,
    ],
  );
  return mapDraftRow(rows[0]!);
}

export async function getDeliveryDraft(
  sql: DraftSql,
  id: string,
): Promise<DeliveryDraftRecord | null> {
  const rows = await sql.query<DraftRow>("select * from trip_drafts where id = $1", [id]);
  return rows[0] ? mapDraftRow(rows[0]) : null;
}

export async function claimDeliveryDraftForUser(
  sql: DraftSql,
  input: ClaimDeliveryDraftForUserInput,
): Promise<DeliveryDraftRecord> {
  const existing = await getDeliveryDraft(sql, input.draftId);
  if (!existing) throw new Error("草稿不存在或已过期");
  if (existing.ownerUserId === input.userId) return existing;
  if (existing.ownerUserId) throw new Error("草稿不存在或无权访问");
  if (!input.guestSessionHash || existing.guestSessionHash !== input.guestSessionHash) {
    throw new Error("草稿不存在或无权访问");
  }

  const rows = await sql.query<DraftRow>(
    `update trip_drafts
        set owner_user_id = $2,
            guest_session_hash = null,
            updated_at = now()
      where id = $1
        and owner_user_id is null
        and guest_session_hash = $3
        and status in ('generating', 'preview_ready', 'awaiting_finalize')
      returning *`,
    [input.draftId, input.userId, input.guestSessionHash],
  );
  if (!rows[0]) throw new Error("草稿状态不允许绑定账号");
  return mapDraftRow(rows[0]);
}

export async function markDeliveryDraftPreviewReady(
  sql: DraftSql,
  input: PreviewReadyInput,
): Promise<DeliveryDraftRecord> {
  const rows = await sql.query<DraftRow>(
    `update trip_drafts
        set status = 'preview_ready',
            page_manifest_hash = $2,
            page_count = $3,
            updated_at = now()
      where id = $1
        and status in ('generating', 'preview_ready')
      returning *`,
    [input.id, input.pageManifestHash, input.pageCount],
  );
  if (rows[0]) return mapDraftRow(rows[0]);

  const existing = await getDeliveryDraft(sql, input.id);
  if (!existing) throw new Error("草稿不存在或已过期");
  throw new Error(`草稿状态不允许标记预览完成：${existing.status}`);
}

export async function markDeliveryDraftFinalized(
  sql: DraftSql,
  input: FinalizedInput,
): Promise<DeliveryDraftRecord> {
  const rows = await sql.query<DraftRow>(
    `update trip_drafts
        set status = 'finalized',
            version_id = $2,
            updated_at = now()
      where id = $1
        and status in ('preview_ready', 'awaiting_finalize')
      returning *`,
    [input.id, input.versionId],
  );
  if (rows[0]) return mapDraftRow(rows[0]);

  const existing = await getDeliveryDraft(sql, input.id);
  if (!existing) throw new Error("草稿不存在或已过期");
  throw new Error(`草稿状态不允许正式结算：${existing.status}`);
}

export async function markDeliveryDraftFailed(
  sql: DraftSql,
  input: FailedInput,
): Promise<DeliveryDraftRecord> {
  const rows = await sql.query<DraftRow>(
    `update trip_drafts
        set status = 'failed',
            failure_reason = $2,
            updated_at = now()
      where id = $1
        and status in ('generating', 'preview_ready', 'awaiting_finalize')
      returning *`,
    [input.id, input.reason],
  );
  if (rows[0]) return mapDraftRow(rows[0]);

  const existing = await getDeliveryDraft(sql, input.id);
  if (!existing) throw new Error("草稿不存在或已过期");
  if (existing.status === "failed") return existing;
  throw new Error(`草稿状态不允许标记失败：${existing.status}`);
}