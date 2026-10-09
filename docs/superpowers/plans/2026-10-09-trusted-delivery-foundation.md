# 可信交付基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让行程先进入可恢复草稿，完整路书通过校验后再由用户确认正式结算，并让同一正式版本可安全重复导出和分享。

**Architecture:** 新增 `trip_drafts` 作为草稿事实来源；预览从草稿读取，不再要求计划提前保存为正式版本；`FinalizeService` 在预览完成后以单个幂等事务保存正式版本并领取或消费权益；客户端用一个交付状态机替换当前自动保存逻辑。

**Tech Stack:** React 19、TypeScript、TanStack Start、Zod、Kysely、Postgres/Supabase、PGlite、Node Test、tsx、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-09-trusted-delivery-loop-design.md`

## Global Constraints

- 所有代码注释使用中文。
- 数据库变更必须新增 `migrations/0014_*.sql`。
- 本地测试使用 PGlite，生产通过 `DATABASE_URL` 使用 Supabase Postgres。
- 权益和正式版本操作必须在服务端校验。
- 预览完成前不得消费首次免费资格或付费点数。
- `finalize` 必须幂等：同一 `draftId + content_hash` 重复调用返回同一正式版本。
- 同一正式版本的重复打印、导出和分享不再收费。
- 不记录或输出真实密钥、支付凭证或敏感身份数据。

## File Structure

**Create**

- `migrations/0014_delivery_drafts.sql`：草稿、页面清单和结算引用。
- `src/lib/delivery-state.ts`：交付状态和合法迁移。
- `src/lib/delivery-drafts.repository.ts`：草稿 SQL 仓储。
- `src/lib/delivery-drafts.repository.test.ts`：PGlite 仓储测试。
- `src/lib/delivery.functions.ts`：草稿、预览提交和正式结算 server functions。
- `src/lib/delivery-lifecycle.integration.test.ts`：预览后结算与幂等测试。
- src/lib/test-support/pglite.ts：共享 PGlite 测试上下文和 migration 列表。
- `scripts/task-14-delivery-flow.e2e.test.mjs`：端到端回归。

**Modify**

- `src/lib/generation-entitlements.server.ts`：finalize 事务同步草稿状态。
- `src/lib/entitlements.server.ts`：draft-aware finalize 服务。
- `src/lib/entitlements.functions.ts`：新增 draft-aware server function。
- `src/routes/api/guidebook-preview.ts`：支持 `draftId`。
- `src/components/planner/plan-output/GuidebookPreview.tsx`：接入预览完成/失败回调。
- `src/components/planner/PlannerPrototype.tsx`：用户确认后才结算。
- `src/lib/pending-plan-restore.ts`：恢复草稿引用。

---

### Task 1: 草稿数据模型与仓储

**Files:**
- Create: `migrations/0014_delivery_drafts.sql`
- Create: `src/lib/delivery-drafts.repository.ts`
- Create: `src/lib/delivery-drafts.repository.test.ts`
- Modify: `src/lib/generation-entitlements.integration.test.ts`、`src/lib/credits/schema.integration.test.ts`、`src/lib/shares.server.test.ts` 的 `migrationNames`

**Interfaces:**
- Produces: `DeliveryDraftRecord`、`DeliveryDraftStatus`、`createDeliveryDraft`、`getDeliveryDraft`、`claimDeliveryDraftForUser`、`markDeliveryDraftPreviewReady`、`markDeliveryDraftFinalized`、`markDeliveryDraftFailed`。

- [ ] **Step 0: Create the shared PGlite test helper**

Create `src/lib/test-support/pglite.ts`:

```ts
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createCreditsService } from "../credits.server.ts";
import { createEntitlementsService } from "../entitlements.server.ts";
import type { TripPlan } from "../travel-plan.ts";

export const deliveryMigrationNames = [
  "0001_public_auth.sql",
  "0002_discovered_places.sql",
  "0003_clear_discovered_route_context.sql",
  "0004_commercial_accounts.sql",
  "0005_username_auth.sql",
  "0006_credit_reservation_idempotency.sql",
  "0007_payment_order_idempotency.sql",
  "0008_provider_creation_lease.sql",
  "0009_payment_credits_applied.sql",
  "0010_generation_entitlements.sql",
  "0011_travel_plan_hash.sql",
  "0012_generation_entitlement_failure_reason.sql",
  "0013_generation_entitlement_retry.sql",
  "0014_delivery_drafts.sql",
] as const;

export type TestSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: TestSql) => Promise<T>): Promise<T>;
};

export async function createDeliveryTestContext() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of deliveryMigrationNames) {
    const migration = await readFile(
      fileURLToPath(new URL(`../../../migrations/${name}`, import.meta.url)),
      "utf8",
    );
    await pg.exec(migration);
  }
  const query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  };
  const transaction = async <T>(fn: (tx: TestSql) => Promise<T>): Promise<T> =>
    pg.transaction(async (tx) => {
      const txSql: TestSql = {
        query: async <U = Record<string, unknown>>(text: string, params: unknown[] = []) => {
          const result = await tx.query<U>(text, params);
          return result.rows;
        },
        transaction: (inner) => inner(txSql),
      };
      return fn(txSql);
    });
  const sql: TestSql = { query, transaction };
  return {
    pg,
    sql,
    credits: createCreditsService(sql),
    entitlements: createEntitlementsService(sql),
  };
}

export function samplePlan(title = "凭证行程"): TripPlan {
  return {
    meta: {
      title,
      origin: "上海",
      waypoints: [],
      destination: "北京",
      startDate: "2026-10-01",
      days: 3,
      travelers: { adults: 1, children: 0 },
      perPersonBudget: 3000,
      transportPreference: "balanced",
      pace: "balanced",
      interests: ["历史"],
    },
  } as unknown as TripPlan;
}

export async function createUser(sql: TestSql): Promise<string> {
  const id = randomUUID();
  const phone = `13${String(Date.now()).slice(-9)}`;
  await sql.query(
    'insert into "user" (id, name, email, "emailVerified", phone) values ($1,$2,$3,true,$4)',
    [id, phone, `${phone}@phone.invalid`, phone],
  );
  return id;
}

export async function fundWallet(sql: TestSql, userId: string, points: number): Promise<void> {
  await sql.transaction(async (tx) => {
    const wallets = await tx.query<{ id: string; balance: number }>(
      `update credit_wallets
       set balance = balance + $2,
           version = version + 1,
           updated_at = now()
       where user_id = $1
       returning id, balance`,
      [userId, points],
    );
    const wallet = wallets[0];
    if (!wallet) throw new Error("测试充值失败：钱包不存在");
    await tx.query(
      `insert into credit_ledger (id, wallet_id, delta, balance_after, reason, note)
       values ($1, $2, $3, $4, 'purchase', '测试充值')`,
      [randomUUID(), wallet.id, points, wallet.balance],
    );
  });
}
```
- [ ] **Step 1: Write the failing repository test**

```ts
test("draft moves from generating to preview-ready to finalized", async () => {
  const { pg, sql } = await createDeliveryTestContext();
  try {
    const draft = await createDeliveryDraft(sql, {
      id: "draft-1",
      ownerUserId: null,
      guestSessionHash: "guest-hash",
      planId: "plan-1",
      requestFingerprint: "fp-1",
      entitlementId: null,
      plan: samplePlan("草稿状态"),
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

    const finalized = await markDeliveryDraftFinalized(sql, {
      id: draft.id,
      versionId: "version-1",
    });
    assert.equal(finalized.status, "finalized");
    assert.equal(finalized.versionId, "version-1");
  } finally {
    await pg.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/delivery-drafts.repository.test.ts`

Expected: FAIL because the migration and repository do not exist.

- [ ] **Step 3: Add the migration**

```sql
create table if not exists trip_drafts (
  id text primary key,
  owner_user_id text references "user" ("id") on delete cascade,
  guest_session_hash text,
  plan_id text not null,
  request_fingerprint text not null,
  entitlement_id text references generation_entitlements (id) on delete set null,
  plan_hash text not null,
  plan_data jsonb not null,
  preview_scope text not null default 'full'
    check (preview_scope in ('full', 'limited')),
  page_manifest_hash text,
  page_count integer not null default 0 check (page_count >= 0),
  status text not null default 'generating'
    check (status in ('generating', 'preview_ready', 'awaiting_finalize', 'finalized', 'failed', 'expired')),
  version_id text references travel_plans (id) on delete set null,
  failure_reason text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_drafts_owner_or_guest_check
    check (owner_user_id is not null or guest_session_hash is not null)
);

create index if not exists trip_drafts_owner_status_idx
  on trip_drafts (owner_user_id, status, expires_at);

create index if not exists trip_drafts_guest_status_idx
  on trip_drafts (guest_session_hash, status, expires_at);
```

- [ ] **Step 4: Implement the repository**

Define these exact exports:

```ts
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

export async function createDeliveryDraft(sql: PlanSql, input: CreateDeliveryDraftInput): Promise<DeliveryDraftRecord>;
export async function getDeliveryDraft(sql: PlanSql, id: string): Promise<DeliveryDraftRecord | null>;
export async function markDeliveryDraftPreviewReady(sql: PlanSql, input: PreviewReadyInput): Promise<DeliveryDraftRecord>;
export async function markDeliveryDraftFinalized(sql: PlanSql, input: FinalizedInput): Promise<DeliveryDraftRecord>;
export async function markDeliveryDraftFailed(sql: PlanSql, input: FailedInput): Promise<DeliveryDraftRecord>;
```

Use parameterized SQL, `hashTripPlan(plan)` from `plans.repository.ts`, and reject invalid transitions with `Error("草稿状态不允许...")`.

- [ ] **Step 5: Run the focused test**

Run: `npx tsx --test src/lib/delivery-drafts.repository.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add migrations/0014_delivery_drafts.sql src/lib/delivery-drafts.repository.ts src/lib/delivery-drafts.repository.test.ts src/lib/generation-entitlements.integration.test.ts src/lib/credits/schema.integration.test.ts src/lib/shares.server.test.ts
git commit -m "feat: add delivery draft repository"
```

---

### Task 2: 交付状态机

**Files:**
- Create: `src/lib/delivery-state.ts`
- Create: `src/lib/delivery-state.test.ts`
- Modify: `src/components/planner/plan-output/GuidebookStage.tsx`

**Interfaces:**
- Produces: `DeliveryState`、`DeliveryEvent`、`advanceDeliveryState`、`isPreviewReady`、`canFinalize`。

- [ ] **Step 1: Write the failing state test**

```ts
test("delivery cannot finalize before preview is ready", () => {
  const ready = advanceDeliveryState(
    { key: "preview_generating", draftId: "draft-1" },
    { type: "preview_completed", pageCount: 13, manifestHash: "abc" },
  );
  assert.equal(ready.key, "awaiting_finalize");
  assert.equal(canFinalize(ready), true);
  assert.equal(canFinalize({ key: "preview_generating", draftId: "draft-1" }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/delivery-state.test.ts`

Expected: FAIL because `delivery-state.ts` does not exist.

- [ ] **Step 3: Implement the state machine**

```ts
export type DeliveryState =
  | { key: "brief" }
  | { key: "preflight" }
  | { key: "entitlement_reserved" }
  | { key: "draft_generating"; draftId: string }
  | { key: "draft_ready"; draftId: string }
  | { key: "preview_generating"; draftId: string }
  | { key: "awaiting_finalize"; draftId: string; pageCount: number; manifestHash: string }
  | { key: "finalizing"; draftId: string }
  | { key: "finalized"; draftId: string; versionId: string }
  | { key: "failed"; step: string; message: string; released: boolean };

export type DeliveryEvent =
  | { type: "preflight_passed" }
  | { type: "entitlement_reserved" }
  | { type: "draft_created"; draftId: string }
  | { type: "draft_generated"; draftId: string }
  | { type: "preview_started"; draftId: string }
  | { type: "preview_completed"; pageCount: number; manifestHash: string }
  | { type: "preview_failed"; step: string; message: string; released: boolean }
  | { type: "finalize_started" }
  | { type: "finalize_succeeded"; versionId: string }
  | { type: "reset" };

export function advanceDeliveryState(state: DeliveryState, event: DeliveryEvent): DeliveryState;
export function isPreviewReady(state: DeliveryState): boolean;
export function canFinalize(state: DeliveryState): boolean;
```

- [ ] **Step 4: Run the focused test**

Run: `npx tsx --test src/lib/delivery-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/delivery-state.ts src/lib/delivery-state.test.ts src/components/planner/plan-output/GuidebookStage.tsx
git commit -m "feat: add unified delivery state machine"
```
---

### Task 3: Draft-aware 权益结算

**Files:**
- Modify: `src/lib/generation-entitlements.server.ts`
- Modify: `src/lib/entitlements.server.ts`
- Modify: `src/lib/entitlements.functions.ts`
- Create: `src/lib/delivery-lifecycle.integration.test.ts`

**Interfaces:**
- Consumes: `DeliveryDraftRecord`、`getDeliveryDraft`。
- Produces: `finalizeDraftWithEntitlement`、`finalizeDeliveryDraft`、`finalizeDeliveryDraftFn`。

- [ ] **Step 0: Add the delivery test fixtures**

Add these local helpers to `src/lib/delivery-lifecycle.integration.test.ts`:

```ts
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
```
- [ ] **Step 1: Write the failing integration tests**

```ts
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
      () => finalizeDeliveryDraftWithSql(sql, {
        draftId: draft.id,
        userId,
        entitlementToken: "token",
        requestFingerprint: "fp",
        plan: draft.plan,
      }),
      /预览未完成/,
    );
  } finally {
    await pg.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/delivery-lifecycle.integration.test.ts`

Expected: FAIL because `finalizeDeliveryDraft` does not exist.

- [ ] **Step 3: Extend finalize inputs and transaction updates**

Add `draftId?: string` to `FinalizeFreeInput` and `FinalizePaidInput` in `src/lib/generation-entitlements.server.ts`. In both finalize transactions, after saving the plan and claiming or consuming the entitlement, update the draft:

```ts
if (input.draftId) {
  await tx.query(
    `update trip_drafts
        set status = 'finalized', version_id = $2, updated_at = now()
      where id = $1
        and status in ('preview_ready', 'awaiting_finalize')`,
    [input.draftId, input.planId],
  );
}
```

- [ ] **Step 4: Add the draft-aware finalizer**

In `src/lib/entitlements.server.ts`, add:

```ts
export async function finalizeDeliveryDraft(input: {
  draftId: string;
  userId: string;
  entitlementToken: string;
  requestFingerprint: string;
  plan: TripPlan;
}): Promise<{ versionId: string }> {
  const draft = await getDeliveryDraft(await getSql(), input.draftId);
  if (!draft || draft.ownerUserId !== input.userId) {
    throw new Error("草稿不存在或无权访问");
  }
  if (draft.status !== "preview_ready" && draft.status !== "awaiting_finalize") {
    throw new Error("预览未完成，不能生成正式版本");
  }
  const service = await getDefaultService();
  const entitlement = await service.getEntitlementForFinalize({
    entitlementToken: input.entitlementToken,
    requestFingerprint: input.requestFingerprint,
    userId: input.userId,
  });
  const finalizeInput = { ...input, planId: draft.planId, draftId: draft.id };
  if (entitlement.kind === "paid") {
    await service.finishPaidWithEntitlement(finalizeInput);
  } else {
    await service.claimFreeWithEntitlement(finalizeInput);
  }
  return { versionId: draft.planId };
}
```

Export `finalizeDeliveryDraftWithSql(sql: EntitlementSql, input: FinalizeDraftInput)` for tests, and have the production `finalizeDeliveryDraft(input)` delegate to it with `await getSql()`. Expose `getEntitlementForFinalize(input: GenerationCredentials): Promise<{ kind: "guest" | "free" | "paid"; row: Row }>` from `generation-entitlements.server.ts` so the finalizer never duplicates token validation SQL.

- [ ] **Step 5: Add the server function**

In `src/lib/entitlements.functions.ts`, add:

```ts
export const finalizeDeliveryDraftFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      draftId: z.string().min(1).max(128),
      entitlementToken: z.string().min(16).max(256),
      requestFingerprint: z.string().min(1).max(256),
      plan: tripPlanSchema,
    }),
  )
  .handler(async ({ context, data }) =>
    finalizeDeliveryDraft({ userId: context.userId, ...data }),
  );
```

- [ ] **Step 6: Run tests**

Run: `npx tsx --test src/lib/delivery-lifecycle.integration.test.ts src/lib/generation-entitlements.integration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/generation-entitlements.server.ts src/lib/entitlements.server.ts src/lib/entitlements.functions.ts src/lib/delivery-lifecycle.integration.test.ts
git commit -m "feat: finalize delivery drafts atomically"
```
---

### Task 4: 草稿预览接口与恢复

**Files:**
- Create: `src/lib/delivery.functions.ts`
- Modify: `src/routes/api/guidebook-preview.ts`
- Modify: `src/lib/pending-plan-restore.ts`
- Modify: `src/lib/pending-plan-restore.test.ts`
- Test: `src/lib/guidebook-stream.server.test.ts`

**Interfaces:**
- Consumes: `createDeliveryDraft`、`getDeliveryDraft`、`markDeliveryDraftPreviewReady`。
- Produces: `createDeliveryDraftFn`、`claimDeliveryDraftForUserFn`、`markPreviewReadyFn`、`resolveDraftPreview`。

- [ ] **Step 1: Write the failing authorization test**

```ts
const resolved = await resolveDraftPreview({
  draftId: draft.id,
  userId,
  guestSessionHash: null,
  plan: draft.plan,
});
assert.equal(resolved?.id, draft.id);

await assert.rejects(
  () => resolveDraftPreview({
    draftId: draft.id,
    userId: "other-user",
    guestSessionHash: null,
    plan: draft.plan,
  }),
  /草稿不存在或无权访问/,
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/guidebook-stream.server.test.ts`

Expected: FAIL because `resolveDraftPreview` does not exist.

- [ ] **Step 3: Implement draft server functions**

```ts
export const createDeliveryDraftFn = createServerFn({ method: "POST" })
  .middleware([optionalAuthMiddleware])
  .validator(createDraftInput)
  .handler(async ({ context, data }) =>
    createDeliveryDraft(await getSql(), {
      ...data,
      ownerUserId: context.userId,
      guestSessionHash: context.userId ? null : await readGuestGenerationEntitlementId(),
    }),
  );

export const claimDeliveryDraftForUserFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ draftId: z.string().min(1).max(128) }))
  .handler(async ({ context, data }) =>
    claimDeliveryDraftForUser(await getSql(), {
      draftId: data.draftId,
      userId: context.userId,
      guestSessionHash: await readGuestGenerationEntitlementId(),
    }),
  );
export const markPreviewReadyFn = createServerFn({ method: "POST" })
  .middleware([optionalAuthMiddleware])
  .validator(previewReadyInput)
  .handler(async ({ context, data }) => {
    const draft = await getDeliveryDraft(await getSql(), data.draftId);
    if (!draft) throw new Error("草稿不存在或已过期");
    if (draft.ownerUserId && draft.ownerUserId !== context.userId) {
      throw new Error("草稿不存在或无权访问");
    }
    if (!draft.ownerUserId && draft.guestSessionHash !== (await readGuestGenerationEntitlementId())) {
      throw new Error("草稿不存在或无权访问");
    }
    return markDeliveryDraftPreviewReady(await getSql(), data);
  });
```

- [ ] **Step 4: Update the preview route**

Add `draftId` to `previewRequestSchema`. Resolve in this order:

```ts
if (shareToken) {
  // 分享链接只读取正式版本。
} else if (payload.draftId) {
  const draft = await resolveDraftPreview({
    draftId: payload.draftId,
    userId: resolvedUserId,
    guestSessionHash,
    plan: payload.plan,
  });
  plan = draft.plan;
} else {
  plan = await resolvePreviewPlan({ /* 旧路径兼容 */ });
}
```

The route must not mark preview ready until all page events have been successfully produced. The page stream completion callback writes `markDeliveryDraftPreviewReady` once.

- [ ] **Step 5: Update pending restore**

Change `PendingPlanClaim` to reference `draftId`, `planId`, `action`, and optional `entitlementToken`. Keep reading the old `plan` field for one release, but new code writes `draftId`. After login succeeds, call `claimDeliveryDraftForUserFn` before finalize so a guest draft transitions from `guest_session_hash` ownership to the authenticated user.

- [ ] **Step 6: Run tests**

Run: `npx tsx --test src/lib/pending-plan-restore.test.ts src/lib/guidebook-stream.server.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/delivery.functions.ts src/routes/api/guidebook-preview.ts src/lib/pending-plan-restore.ts src/lib/pending-plan-restore.test.ts src/lib/guidebook-stream.server.test.ts
git commit -m "feat: preview delivery drafts before finalization"
```
---

### Task 5: 客户端交付流程接入

**Files:**
- Modify: `src/components/planner/plan-output/GuidebookPreview.tsx`
- Modify: `src/components/planner/PlannerPrototype.tsx`
- Modify: `src/components/planner/plan-output/plan-output.test.tsx`

**Interfaces:**
- Consumes: `DeliveryState`、`createDeliveryDraftFn`、`markPreviewReadyFn`、`finalizeDeliveryDraftFn`。
- Produces: 预览完成回调、用户确认入口和结算前状态。

- [ ] **Step 1: Write the failing component test**

```tsx
test("calls onReady only after every page is accepted", async () => {
  const onReady = mock(() => undefined);
  render(<GuidebookPreview {...fixtureProps} onReady={onReady} />);
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/planner/plan-output/plan-output.test.tsx`

Expected: FAIL because `onReady` does not exist.

- [ ] **Step 3: Add preview callbacks**

Extend `GuidebookPreview` props with:

```ts
onReady?: (info: { pageCount: number; manifestHash: string }) => void;
onError?: (message: string) => void;
```

Call `onReady` from an effect that watches `ready`, `total`, `received`, and `error`. Call `onError` from stream errors and page checksum errors.

- [ ] **Step 4: Replace auto-finalize in PlannerPrototype**

Remove the effect that finalizes when `plannerState === "saving"`. After a plan is assembled:

1. 调用 `createDeliveryDraftFn` 创建草稿；
2. 保存 `draftId`；
3. 使用 `draftId` 挂载 `GuidebookPreview`；
4. 只在 `onReady` 后进入 `awaiting_finalize`；
5. 显示“确认生成正式版本”；
6. 只有按钮点击后调用 `finalizeDeliveryDraftFn`。

- [ ] **Step 5: Handle restored and old pending plans**

When a restored plan or old pending claim exists without `draftId`, create a new draft first. Do not call the old finalize endpoints directly from the result page.

- [ ] **Step 6: Run tests**

Run:

```powershell
npm run typecheck
npx tsx --test src/components/planner/plan-output/plan-output.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/components/planner/plan-output/GuidebookPreview.tsx src/components/planner/PlannerPrototype.tsx src/components/planner/plan-output/plan-output.test.tsx
git commit -m "feat: require preview before settlement"
```

---

### Task 6: 端到端交付回归

**Files:**
- Create: `scripts/task-14-delivery-flow.e2e.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1-5 的完整交付链路。
- Produces: 可重复执行的交付顺序回归证据。

- [ ] **Step 1: Add the failing E2E cases**

The test must cover:

```text
访客生成草稿 -> 查看完整预览 -> 登录 -> finalize 后领取首次免费
付费用户预留 -> 查看预览 -> finalize 后只扣 1 点
预览失败 -> 预留释放 -> 不产生流水
重复 finalize -> 返回同一 versionId
正式版本重复导出 -> 不产生新流水
```

Use PGlite for state assertions and mocked page streams for deterministic output. Add the script to `package.json` after the file exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test scripts/task-14-delivery-flow.e2e.test.mjs`

Expected: FAIL until Tasks 1-5 are complete.

- [ ] **Step 3: Implement integration glue**

Reuse the production services from Tasks 1-5. Do not mock the finalize transaction or credit ledger. Assert database rows after every operation.

- [ ] **Step 4: Run the affected test set**

Run:

```powershell
npm run typecheck
npm run test:commercial
npx tsx --test src/lib/delivery-state.test.ts src/lib/delivery-drafts.repository.test.ts src/lib/delivery-lifecycle.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add scripts/task-14-delivery-flow.e2e.test.mjs package.json
git commit -m "test: cover trusted delivery sequence"
```

---

## Self-Review

**Spec coverage:** This plan covers draft persistence, preview authorization, preview-before-settlement, idempotent finalization, release-on-preview-failure, formal version reuse, and end-to-end regression. Limited preview rendering, purchase continuation, admin bypass, budget unification, and final PDF/print contract remain in separate follow-up plans.

**Placeholder scan:** No `TODO`, `TBD`, “fill in later”, or unspecified edge-case steps are intentionally present.

**Type consistency:** `DeliveryDraftRecord`, `DeliveryDraftStatus`, `createDeliveryDraft`, `markDeliveryDraftPreviewReady`, `markDeliveryDraftFinalized`, and `finalizeDeliveryDraft` are defined in early tasks and reused with the same names in later tasks.