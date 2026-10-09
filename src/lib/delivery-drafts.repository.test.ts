import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeliveryDraft,
  getDeliveryDraft,
  markDeliveryDraftFinalized,
  markDeliveryDraftPreviewReady,
} from "./delivery-drafts.repository.ts";
import { createDeliveryTestContext, createUser, samplePlan } from "./test-support/pglite.ts";

test("draft moves from generating to preview-ready to finalized", async () => {
  const { pg, sql } = await createDeliveryTestContext();
  try {
    const userId = await createUser(sql);
    const plan = samplePlan("草稿状态");
    await sql.query(
      `insert into travel_plans (
         id, user_id, title, origin, destination, days, status, plan_data
       ) values ($1,$2,$3,$4,$5,$6,'saved',$7::jsonb)`,
      [ "version-1", userId, plan.meta.title, plan.meta.origin, plan.meta.destination, plan.meta.days, JSON.stringify(plan) ],
    );
    const draft = await createDeliveryDraft(sql, {
      id: "draft-1",
      ownerUserId: userId,
      guestSessionHash: null,
      planId: "plan-1",
      requestFingerprint: "fp-1",
      entitlementId: null,
      plan,
      previewScope: "full",
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(draft.status, "generating");

    const ready = await markDeliveryDraftPreviewReady(sql, {
      id: draft.id,
      pageManifestHash: "pages-hash",
      pageCount: 13,
    });
    assert.equal(ready.status, "preview_ready");
    assert.equal(ready.pageCount, 13);

    const finalized = await markDeliveryDraftFinalized(sql, {
      id: draft.id,
      versionId: "version-1",
    });
    assert.equal(finalized.status, "finalized");
    assert.equal(finalized.versionId, "version-1");

    assert.equal((await getDeliveryDraft(sql, draft.id))?.status, "finalized");
  } finally {
    await pg.close();
  }
});

test("draft cannot skip preview before finalize", async () => {
  const { pg, sql } = await createDeliveryTestContext();
  try {
    const draft = await createDeliveryDraft(sql, {
      id: "draft-2",
      ownerUserId: null,
      guestSessionHash: "guest-hash",
      planId: "plan-2",
      requestFingerprint: "fp-2",
      entitlementId: null,
      plan: samplePlan("不可跳过预览"),
      previewScope: "full",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await assert.rejects(
      () => markDeliveryDraftFinalized(sql, { id: draft.id, versionId: "version-2" }),
      /状态不允许/,
    );
  } finally {
    await pg.close();
  }
});