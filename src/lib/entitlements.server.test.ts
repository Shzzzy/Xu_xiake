import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createCreditsService, type CreditsService } from "./credits.server.ts";
import { createEntitlementsService, type EntitlementsService } from "./entitlements.server.ts";
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
  const phone = `13${String(100_000_000 + phoneSequence).padStart(9, "0")}`;
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

test("saved plans can only be read by their owner", async () => {
  const { pg, sql, entitlements } = await createTestContext();
  try {
    const ownerUserId = await createUser(sql);
    const otherUserId = await createUser(sql);
    const plan = samplePlan("所有者行程");

    const saved = await entitlements.saveTravelPlan({
      userId: ownerUserId,
      planId: randomUUID(),
      plan,
    });
    const ownerPlan = await entitlements.getTravelPlan(ownerUserId, saved.id);
    const otherPlan = await entitlements.getTravelPlan(otherUserId, saved.id);

    assert.equal(ownerPlan?.meta.title, "所有者行程");
    assert.equal(otherPlan, null);
  } finally {
    await pg.close();
  }
});

test("first free claim saves one plan and consumes free trial", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = randomUUID();
    const result = await entitlements.claimFirstFreePlan({
      userId,
      planId,
      plan: samplePlan("北京之旅"),
    });

    const saved = await entitlements.getTravelPlan(userId, result.planId);
    assert.equal(saved?.meta.title, "北京之旅");

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.freeTrialClaimed, true);
    assert.equal(summary.ledger.filter((item) => item.reason === "free_trial").length, 1);
    assert.equal(
      summary.ledger.find((item) => item.reason === "free_trial")?.planId,
      result.planId,
    );
  } finally {
    await pg.close();
  }
});

test("claim failure rolls back the saved plan", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    await credits.ensureWallet(userId);
    await credits.claimFreeTrial(userId, null);

    const before = await sql.query<{ count: number }>(
      "select count(*)::int as count from travel_plans where user_id = $1",
      [userId],
    );

    const planId = randomUUID();
    await assert.rejects(
      () =>
        entitlements.claimFirstFreePlan({
          userId,
          planId,
          plan: samplePlan("不应留下的行程"),
        }),
      /免费体验/,
    );

    const after = await sql.query<{ count: number }>(
      "select count(*)::int as count from travel_plans where user_id = $1",
      [userId],
    );
    assert.equal(before[0]?.count, 0);
    assert.equal(after[0]?.count, 0);
  } finally {
    await pg.close();
  }
});

test("reserve paid plan can precede plan persistence without creating a plan", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = randomUUID();
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);

    const reservation = await entitlements.reservePaidPlan(userId, planId);

    const plans = await sql.query<{ count: number }>(
      "select count(*)::int as count from travel_plans where id = $1",
      [planId],
    );
    const reservations = await sql.query<{ count: number; plan_id: string | null }>(
      "select count(*)::int as count, min(plan_id) as plan_id from credit_reservations where id = $1",
      [reservation.id],
    );
    assert.equal(plans[0]?.count, 0);
    assert.equal(reservations[0]?.count, 1);
    assert.equal(reservations[0]?.plan_id, null);
    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 1);
    assert.equal(summary.wallet.reserved, 1);
  } finally {
    await pg.close();
  }
});

test("finish paid plan rejects a mismatched owner and consumes the matching plan", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const ownerUserId = await createUser(sql);
    const otherUserId = await createUser(sql);
    const ownPlanId = randomUUID();
    const otherPlan = await entitlements.saveTravelPlan({
      userId: otherUserId,
      planId: randomUUID(),
      plan: samplePlan("他人行程"),
    });
    await credits.ensureWallet(ownerUserId);
    await fundWallet(sql, ownerUserId, 1);
    const reservation = await entitlements.reservePaidPlan(ownerUserId, ownPlanId);

    await assert.rejects(
      () =>
        entitlements.finishPaidPlan({
          reservationId: reservation.id,
          planId: ownPlanId,
          plan: samplePlan("本人行程"),
        } as never),
      /缺少用户身份/,
    );
    await assert.rejects(
      () =>
        entitlements.finishPaidPlan({
          userId: otherUserId,
          reservationId: reservation.id,
          planId: ownPlanId,
          plan: samplePlan("本人行程"),
        }),
      /行程不存在或无权访问/,
    );
    await assert.rejects(
      () =>
        entitlements.finishPaidPlan({
          userId: ownerUserId,
          reservationId: reservation.id,
          planId: otherPlan.id,
          plan: samplePlan("冒用他人行程"),
        }),
      /行程不存在或无权访问/,
    );

    const afterRejected = await credits.getWalletSummary(ownerUserId);
    assert.equal(afterRejected.wallet.balance, 1);
    assert.equal(afterRejected.wallet.reserved, 1);

    const entry = await entitlements.finishPaidPlan({
      userId: ownerUserId,
      reservationId: reservation.id,
      planId: ownPlanId,
      plan: samplePlan("本人行程"),
    });
    assert.equal(entry.reason, "generation");
    const summary = await credits.getWalletSummary(ownerUserId);
    assert.equal(summary.wallet.balance, 0);
    assert.equal(summary.wallet.reserved, 0);
  } finally {
    await pg.close();
  }
});

test("repeated first free claim with the same planId is idempotent", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = randomUUID();
    const plan = samplePlan("幂等行程");

    const first = await entitlements.claimFirstFreePlan({ userId, planId, plan });
    const second = await entitlements.claimFirstFreePlan({ userId, planId, plan });

    assert.equal(first.planId, planId);
    assert.equal(second.planId, planId);

    const plans = await sql.query<{ count: number }>(
      "select count(*)::int as count from travel_plans where id = $1",
      [planId],
    );
    const summary = await credits.getWalletSummary(userId);
    assert.equal(plans[0]?.count, 1);
    assert.equal(summary.ledger.filter((item) => item.reason === "free_trial").length, 1);
    assert.equal(summary.ledger.find((item) => item.reason === "free_trial")?.planId, planId);
  } finally {
    await pg.close();
  }
});

test("concurrent claims with the same planId create one plan and one free trial ledger", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = randomUUID();
    const plan = samplePlan("并发幂等行程");

    const [first, second] = await Promise.all([
      entitlements.claimFirstFreePlan({ userId, planId, plan }),
      entitlements.claimFirstFreePlan({ userId, planId, plan }),
    ]);

    assert.equal(first.planId, planId);
    assert.equal(second.planId, planId);

    const plans = await sql.query<{ count: number }>(
      "select count(*)::int as count from travel_plans where id = $1",
      [planId],
    );
    const summary = await credits.getWalletSummary(userId);
    assert.equal(plans[0]?.count, 1);
    assert.equal(summary.ledger.filter((item) => item.reason === "free_trial").length, 1);
  } finally {
    await pg.close();
  }
});

test("another user's planId cannot be claimed", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const ownerUserId = await createUser(sql);
    const otherUserId = await createUser(sql);
    const planId = randomUUID();

    await entitlements.saveTravelPlan({
      userId: ownerUserId,
      planId,
      plan: samplePlan("原所有权行程"),
    });

    await assert.rejects(
      () =>
        entitlements.claimFirstFreePlan({
          userId: otherUserId,
          planId,
          plan: samplePlan("冒充行程"),
        }),
      /行程不存在或无权访问/,
    );

    const rows = await sql.query<{ user_id: string }>(
      "select user_id from travel_plans where id = $1",
      [planId],
    );
    assert.equal(rows[0]?.user_id, ownerUserId);
    const summary = await credits.getWalletSummary(otherUserId);
    assert.equal(summary.wallet.freeTrialClaimed, false);
  } finally {
    await pg.close();
  }
});

test("nested plan data survives a jsonb round trip", async () => {
  const { pg, sql, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = randomUUID();
    const plan = {
      meta: {
        title: "嵌套内容行程",
        origin: "上海",
        waypoints: ["杭州"],
        destination: "北京",
        startDate: "2026-10-01",
        days: 3,
        travelers: { adults: 2, children: 1 },
        perPersonBudget: 3000,
        transportPreference: "balanced",
        pace: "balanced",
        interests: ["历史", "美食"],
      },
      extension: {
        nested: {
          tags: ["a", "b"],
          stops: [
            { name: "外滩", location: { longitude: 121.49, latitude: 31.24 } },
            { name: "故宫", location: { longitude: 116.397, latitude: 39.918 } },
          ],
        },
      },
    } as unknown as TripPlan;

    await entitlements.saveTravelPlan({ userId, planId, plan });
    const loaded = await entitlements.getTravelPlan(userId, planId);
    assert.deepEqual(loaded, plan);
  } finally {
    await pg.close();
  }
});
