import {
  getDeliveryDraft,
  markDeliveryDraftPreviewReady,
  type DeliveryDraftRecord,
  type PreviewReadyInput,
} from "./delivery-drafts.repository.ts";
import { hashGenerationToken } from "./entitlements.server.ts";
import { hashTripPlan } from "./plans.repository.ts";
import type { TripPlan } from "./travel-plan.ts";

type DeliverySql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: DeliverySql) => Promise<T>): Promise<T>;
};

export type ResolveDraftPreviewInput = {
  draftId: string;
  userId: string | null;
  guestSessionHash: string | null;
  entitlementToken?: string | null;
  requestFingerprint?: string | null;
  plan: TripPlan;
};

async function assertDraftActor(
  sql: DeliverySql,
  draft: DeliveryDraftRecord,
  input: ResolveDraftPreviewInput,
): Promise<void> {
  if (draft.ownerUserId && draft.ownerUserId === input.userId) return;
  if (!draft.ownerUserId && input.guestSessionHash && draft.guestSessionHash === input.guestSessionHash) {
    return;
  }
  if (draft.entitlementId && input.entitlementToken && input.requestFingerprint) {
    const rows = await sql.query<{ id: string }>(
      `select id
         from generation_entitlements
        where id = $1
          and token_hash = $2
          and request_fingerprint = $3
          and status in ('available', 'used', 'claimed')
        limit 1`,
      [draft.entitlementId, hashGenerationToken(input.entitlementToken), input.requestFingerprint],
    );
    if (rows[0]) return;
  }
  throw new Error("草稿不存在或无权访问");
}

export async function resolveDraftPreviewWithSql(
  sql: DeliverySql,
  input: ResolveDraftPreviewInput,
): Promise<DeliveryDraftRecord> {
  const draft = await getDeliveryDraft(sql, input.draftId);
  if (!draft) throw new Error("草稿不存在或已过期");
  if (draft.expiresAt.getTime() <= Date.now()) throw new Error("草稿已过期");
  await assertDraftActor(sql, draft, input);
  if (draft.planHash !== hashTripPlan(input.plan)) {
    throw new Error("草稿内容与请求计划不一致");
  }
  if (draft.status === "failed" || draft.status === "expired") {
    throw new Error("草稿已失效");
  }
  return draft;
}

export async function markDraftPreviewReadyWithSql(
  sql: DeliverySql,
  input: ResolveDraftPreviewInput & Omit<PreviewReadyInput, "id">,
): Promise<DeliveryDraftRecord> {
  await resolveDraftPreviewWithSql(sql, input);
  return markDeliveryDraftPreviewReady(sql, {
    id: input.draftId,
    pageManifestHash: input.pageManifestHash,
    pageCount: input.pageCount,
  });
}