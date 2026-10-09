import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDeliveryDraft, markDeliveryDraftPreviewReady } from "./delivery-drafts.repository.ts";
import { resolveDraftPreviewWithSql } from "./delivery.server.ts";
import { finalizeDeliveryDraftWithSql } from "./entitlements.server.ts";
import type { EntitlementsService } from "./entitlements.server.ts";
import {
  createDeliveryTestContext,
  createUser,
  fundWallet,
  samplePlan,
  type TestSql,
} from "./test-support/pglite.ts";

async function createGeneratingDraft(sql: TestSql, userId: string) {
  return createDeliveryDraft(sql, {
    id: `draft-${randomUUID()}`,
    ownerUserId: userId,
    guestSessionHash: null,
    planId: `plan-${randomUUID()}`,
    requestFingerprint: `fp-${randomUUID()}`,
    entitlementId: null,
    plan: samplePlan("未完成预览"),
    previewScope: "full",
    expiresAt: new Date(Date.now() + 60_000),
  });
}

async function createReadyPaidDraft(
  sql: TestSql,
  userId: string,
  entitlements: EntitlementsService,
) {
  const planId = `plan-${randomUUID()}`;
  const requestFingerprint = `fp-${randomUUID()}`;
  const reservation = await entitlements.reservePaidPlan(userId, planId);
  const prepared = await entitlements.preparePaidGeneration({
    userId,
    planId,
    requestFingerprint,
    reservationId: reservation.id,
  });
  await entitlements.authorizeGeneration({
    entitlementToken: prepared.token,
    requestFingerprint,
    userId,
    cookieEntitlementId: null,
  });
  const draft = await createDeliveryDraft(sql, {
    id: `draft-${randomUUID()}`,
    ownerUserId: userId,
    guestSessionHash: null,
    planId,
    requestFingerprint,
    entitlementId: prepared.entitlementId,
    plan: samplePlan("付费草稿"),
    previewScope: "full",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const ready = await markDeliveryDraftPreviewReady(sql, {
    id: draft.id,
    pageManifestHash: "manifest-hash",
    pageCount: 13,
  });
  return { ...ready, entitlementToken: prepared.token, requestFingerprint };
}

test("paid draft consumes exactly once after preview is ready", async () => {
  const { pg, sql, credits, entitlements } = await createDeliveryTestContext();
  try {
    const userId = await createUser(sql);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);
    const draft = await createReadyPaidDraft(sql, userId, entitlements);

    const first = await finalizeDeliveryDraftWithSql(sql, {
      draftId: draft.id,
      userId,
      entitlementToken: draft.entitlementToken,
      requestFingerprint: draft.requestFingerprint,
      plan: draft.plan,
    });
    const second = await finalizeDeliveryDraftWithSql(sql, {
      draftId: draft.id,
      userId,
      entitlementToken: draft.entitlementToken,
      requestFingerprint: draft.requestFingerprint,
      plan: draft.plan,
    });

    assert.equal(second.versionId, first.versionId);
    const wallet = await credits.getWalletSummary(userId);
    assert.equal(wallet.wallet.balance, 0);
    assert.equal(wallet.wallet.reserved, 0);
    assert.equal(wallet.ledger.filter((row) => row.reason === "generation").length, 1);
  } finally {
    await pg.close();
  }
});

test("finalize rejects a draft whose preview has not completed", async () => {
  const { pg, sql } = await createDeliveryTestContext();
  try {
    const userId = await createUser(sql);
    const draft = await createGeneratingDraft(sql, userId);

    await assert.rejects(
      () =>
        finalizeDeliveryDraftWithSql(sql, {
          draftId: draft.id,
          userId,
          entitlementToken: "token-1234567890",
          requestFingerprint: draft.requestFingerprint,
          plan: draft.plan,
        }),
      /预览未完成/,
    );
  } finally {
    await pg.close();
  }
});
test("draft preview can be authorized by its bound entitlement token", async () => {
  const { pg, sql, credits, entitlements } = await createDeliveryTestContext();
  try {
    const userId = await createUser(sql);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);
    const draft = await createReadyPaidDraft(sql, userId, entitlements);

    const resolved = await resolveDraftPreviewWithSql(sql, {
      draftId: draft.id,
      userId: null,
      guestSessionHash: null,
      entitlementToken: draft.entitlementToken,
      requestFingerprint: draft.requestFingerprint,
      plan: draft.plan,
    });
    assert.equal(resolved.id, draft.id);
  } finally {
    await pg.close();
  }
});

test("draft preview is readable only by the matching owner or guest session", async () => {
  const { pg, sql } = await createDeliveryTestContext();
  try {
    const ownerId = await createUser(sql);
    const draft = await createGeneratingDraft(sql, ownerId);

    const resolved = await resolveDraftPreviewWithSql(sql, {
      draftId: draft.id,
      userId: ownerId,
      guestSessionHash: null,
      plan: draft.plan,
    });
    assert.equal(resolved.id, draft.id);

    await assert.rejects(
      () =>
        resolveDraftPreviewWithSql(sql, {
          draftId: draft.id,
          userId: randomUUID(),
          guestSessionHash: null,
          plan: draft.plan,
        }),
      /草稿不存在或无权访问/,
    );
  } finally {
    await pg.close();
  }
});