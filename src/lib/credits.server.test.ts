import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createCreditsService, type CreditsService } from "./credits.server.ts";

const migrationNames = [
  "0001_public_auth.sql",
  "0002_discovered_places.sql",
  "0003_clear_discovered_route_context.sql",
  "0004_commercial_accounts.sql",
  "0005_username_auth.sql",
] as const;

type TestSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

async function createTestContext(): Promise<{
  pg: PGlite;
  sql: TestSql;
  credits: CreditsService;
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
  const sql: TestSql = {
    query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
  return { pg, sql, credits: createCreditsService(sql) };
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

async function createPlan(sql: TestSql, userId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `insert into travel_plans (id, user_id, title, origin, destination, days, status, plan_data)
     values ($1, $2, '测试行程', '北京', '上海', 3, 'ready', '{}'::jsonb)`,
    [id, userId],
  );
  return id;
}

async function fundWallet(sql: TestSql, userId: string, balance: number): Promise<void> {
  await sql.query("update credit_wallets set balance = $2 where user_id = $1", [userId, balance]);
}

test("wallet starts empty and free trial can only be claimed once", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const wallet = await credits.ensureWallet(userId);
    assert.equal(wallet.balance, 0);
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.freeTrialClaimed, false);

    const sameWallet = await credits.ensureWallet(userId);
    assert.equal(sameWallet.id, wallet.id);

    const entry = await credits.claimFreeTrial(userId, null);
    assert.equal(entry.reason, "free_trial");
    assert.equal(entry.delta, 0);
    await assert.rejects(() => credits.claimFreeTrial(userId, null), /免费体验/);

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.freeTrialClaimed, true);
    assert.equal(summary.ledger.filter((item) => item.reason === "free_trial").length, 1);
  } finally {
    await pg.close();
  }
});

test("reservation prevents double spending, release restores it, and consume writes a ledger entry", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planA = await createPlan(sql, userId);
    const planB = await createPlan(sql, userId);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);

    const reservation = await credits.reserveCredit(userId, planA);
    assert.equal(reservation.status, "reserved");
    await assert.rejects(() => credits.reserveCredit(userId, planB), /点数不足/);

    await credits.releaseReservation(reservation.id);
    await credits.releaseReservation(reservation.id);
    const afterRelease = await credits.getWalletSummary(userId);
    assert.equal(afterRelease.wallet.balance, 1);
    assert.equal(afterRelease.wallet.reserved, 0);

    const reservation2 = await credits.reserveCredit(userId, planB);
    const consumed = await credits.consumeReservation(reservation2.id, planB);
    assert.equal(consumed.reason, "generation");
    assert.equal(consumed.delta, -1);
    assert.equal(consumed.balanceAfter, 0);

    await assert.rejects(
      () => credits.consumeReservation(reservation2.id, planB),
      /预留不存在、已消费或已过期/,
    );
    await credits.releaseReservation(reservation2.id);

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 0);
    assert.equal(summary.wallet.reserved, 0);
    assert.equal(summary.ledger.filter((item) => item.reason === "generation").length, 1);
  } finally {
    await pg.close();
  }
});

test("concurrent reservations cannot exceed available balance", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planA = await createPlan(sql, userId);
    const planB = await createPlan(sql, userId);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);

    const results = await Promise.allSettled([
      credits.reserveCredit(userId, planA),
      credits.reserveCredit(userId, planB),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 1);
    assert.equal(summary.wallet.reserved, 1);

    if (fulfilled[0]?.status === "fulfilled") {
      await credits.releaseReservation(fulfilled[0].value.id);
    }
  } finally {
    await pg.close();
  }
});

test("reservations expire atomically and return the number of expired rows", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planA = await createPlan(sql, userId);
    const planB = await createPlan(sql, userId);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 2);

    const first = await credits.reserveCredit(userId, planA);
    const second = await credits.reserveCredit(userId, planB);
    const expired = await credits.expireReservations(new Date(Date.now() + 16 * 60 * 1000));
    assert.equal(expired, 2);

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 2);
    assert.equal(summary.wallet.reserved, 0);
    await assert.rejects(
      () => credits.consumeReservation(first.id, planA),
      /预留不存在、已消费或已过期/,
    );
    await assert.rejects(
      () => credits.consumeReservation(second.id, planB),
      /预留不存在、已消费或已过期/,
    );
    assert.equal(await credits.expireReservations(new Date(Date.now() + 20 * 60 * 1000)), 0);
  } finally {
    await pg.close();
  }
});
test("concurrent free trial claims produce exactly one claim", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    await credits.ensureWallet(userId);

    const results = await Promise.allSettled([
      credits.claimFreeTrial(userId, null),
      credits.claimFreeTrial(userId, null),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.freeTrialClaimed, true);
    assert.equal(summary.ledger.filter((item) => item.reason === "free_trial").length, 1);
  } finally {
    await pg.close();
  }
});

test("concurrent consumption of one reservation writes exactly one ledger entry", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = await createPlan(sql, userId);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);
    const reservation = await credits.reserveCredit(userId, planId);

    const results = await Promise.allSettled([
      credits.consumeReservation(reservation.id, planId),
      credits.consumeReservation(reservation.id, planId),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 0);
    assert.equal(summary.wallet.reserved, 0);
    assert.equal(summary.ledger.filter((item) => item.reason === "generation").length, 1);
  } finally {
    await pg.close();
  }
});
