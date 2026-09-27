import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createCreditsService, type CreditsService } from "./credits.server.ts";
import {
  createEntitlementsService,
  decideGenerationPermission,
  resolveGuestGenerationDecision,
  type EntitlementsService,
} from "./entitlements.server.ts";
import { resolveGuidebookExportGate } from "./guidebook-access.ts";
import type { TripPlan } from "./travel-plan.ts";

const migrationNames = [
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
] as const;

type TestSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: TestSql) => Promise<T>): Promise<T>;
};

async function createTestContext(): Promise<{
  pg: PGlite;
  sql: TestSql;
  credits: CreditsService;
  entitlements: EntitlementsService;
}> {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of migrationNames) {
    const migration = await readFile(
      fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
      "utf8",
    );
    await pg.exec(migration);
  }

  const query = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  };
  const transaction = async <T>(fn: (tx: TestSql) => Promise<T>): Promise<T> =>
    pg.transaction(async (tx) => {
      const txQuery = async <U = Record<string, unknown>>(
        text: string,
        params: unknown[] = [],
      ): Promise<U[]> => {
        const result = await tx.query<U>(text, params);
        return result.rows;
      };
      let txSql: TestSql;
      txSql = {
        query: txQuery,
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

let phoneSequence = 0;

async function createUser(sql: TestSql): Promise<string> {
  const id = randomUUID();
  phoneSequence += 1;
  const phone = `13${String(200_000_000 + phoneSequence).padStart(9, "0")}`;
  await sql.query(
    'insert into "user" (id, name, email, "emailVerified", phone) values ($1,$2,$3,true,$4)',
    [id, phone, `${phone}@phone.invalid`, phone],
  );
  return id;
}

function samplePlan(title: string): TripPlan {
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

async function fundWallet(sql: TestSql, userId: string, points: number): Promise<void> {
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
      `insert into credit_ledger (
         id, wallet_id, delta, balance_after, reason, note
       ) values ($1, $2, $3, $4, 'purchase', '测试充值')`,
      [randomUUID(), wallet.id, points, wallet.balance],
    );
  });
}

test("decideGenerationPermission distinguishes guest, free, paid confirmation and purchase", () => {
  assert.deepEqual(decideGenerationPermission({ userId: null, wallet: null }), { kind: "guest" });
  assert.deepEqual(
    decideGenerationPermission({
      userId: "u1",
      wallet: { balance: 0, reserved: 0, freeTrialClaimed: false },
    }),
    { kind: "free", userId: "u1" },
  );
  assert.deepEqual(
    decideGenerationPermission({
      userId: "u1",
      wallet: { balance: 1, reserved: 0, freeTrialClaimed: true },
    }),
    { kind: "needs_confirmation", userId: "u1" },
  );
  assert.deepEqual(
    decideGenerationPermission({
      userId: "u1",
      wallet: { balance: 1, reserved: 1, freeTrialClaimed: true },
    }),
    { kind: "needs_purchase" },
  );
});

test("guest generation attempt is allowed once and then requires login", () => {
  assert.deepEqual(resolveGuestGenerationDecision(false), { kind: "guest" });
  assert.deepEqual(resolveGuestGenerationDecision(true), { kind: "needs_login" });
});

test("guidebook export requires login before claiming or exporting", () => {
  assert.equal(resolveGuidebookExportGate({ isPending: true, hasUser: false }), "wait");
  assert.equal(resolveGuidebookExportGate({ isPending: false, hasUser: false }), "login");
  assert.equal(
    resolveGuidebookExportGate({ isPending: false, hasUser: true }),
    "ensure_entitlement",
  );
});

test("paid generation reserves before a travel plan exists and saves on finish", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);
    const planId = `generation-${randomUUID()}`;

    const before = await sql.query<{ count: number }>(
      "select count(*)::int as count from travel_plans where id = $1",
      [planId],
    );
    assert.equal(before[0]?.count, 0);

    const reservation = await entitlements.reservePaidPlan(userId, planId);
    const reservedSummary = await credits.getWalletSummary(userId);
    assert.equal(reservedSummary.wallet.balance, 1);
    assert.equal(reservedSummary.wallet.reserved, 1);

    const entry = await entitlements.finishPaidPlan({
      userId,
      reservationId: reservation.id,
      planId,
      plan: samplePlan("先预留后保存"),
    });
    assert.equal(entry.reason, "generation");
    assert.equal((await entitlements.getTravelPlan(userId, planId))?.meta.title, "先预留后保存");

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 0);
    assert.equal(summary.wallet.reserved, 0);
    assert.equal(summary.ledger.filter((item) => item.reason === "generation").length, 1);
  } finally {
    await pg.close();
  }
});

test("repeated finish is idempotent and does not charge twice", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 2);
    const planId = `generation-${randomUUID()}`;
    const reservation = await entitlements.reservePaidPlan(userId, planId);
    const input = {
      userId,
      reservationId: reservation.id,
      planId,
      plan: samplePlan("重复 finalize"),
    };

    const first = await entitlements.finishPaidPlan(input);
    const second = await entitlements.finishPaidPlan(input);

    assert.equal(second.id, first.id);
    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 1);
    assert.equal(summary.wallet.reserved, 0);
    assert.equal(summary.ledger.filter((item) => item.reason === "generation").length, 1);
  } finally {
    await pg.close();
  }
});

test("generation failure can release a paid reservation before finalize", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);
    const planId = `generation-${randomUUID()}`;
    const first = await entitlements.reservePaidPlan(userId, planId);

    await entitlements.releasePaidPlan(userId, first.id);
    const released = await credits.getWalletSummary(userId);
    assert.equal(released.wallet.balance, 1);
    assert.equal(released.wallet.reserved, 0);

    const second = await entitlements.reservePaidPlan(userId, planId);
    const reservedAgain = await credits.getWalletSummary(userId);
    assert.equal(second.id, first.id);
    assert.equal(reservedAgain.wallet.reserved, 1);
  } finally {
    await pg.close();
  }
});

test("free generation claim saves the final plan and stays idempotent", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = `generation-${randomUUID()}`;
    const plan = samplePlan("首次免费最终计划");

    const first = await entitlements.claimFirstFreePlan({ userId, planId, plan });
    const second = await entitlements.claimFirstFreePlan({ userId, planId, plan });
    assert.equal(first.planId, planId);
    assert.equal(second.planId, planId);
    assert.equal(
      (await entitlements.getTravelPlan(userId, planId))?.meta.title,
      "首次免费最终计划",
    );

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.freeTrialClaimed, true);
    assert.equal(summary.ledger.filter((item) => item.reason === "free_trial").length, 1);
  } finally {
    await pg.close();
  }
});
