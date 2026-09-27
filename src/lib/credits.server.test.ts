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
  "0006_credit_reservation_idempotency.sql",
  "0007_payment_order_idempotency.sql",
  "0008_provider_creation_lease.sql",
  "0009_payment_credits_applied.sql",
  "0010_generation_entitlements.sql",
  "0011_travel_plan_hash.sql",
  "0012_generation_entitlement_failure_reason.sql",
] as const;

type TestSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: TestSql) => Promise<T>): Promise<T>;
};

type WalletInvariantRow = {
  balance: number;
  reserved: number;
  ledger_sum: number;
  reserved_count: number;
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

async function assertWalletInvariants(sql: TestSql, userId: string): Promise<void> {
  const rows = await sql.query<WalletInvariantRow>(
    `select w.balance,
            w.reserved,
            coalesce(sum(l.delta), 0)::int as ledger_sum,
            (
              select count(*)::int
              from credit_reservations r
              where r.wallet_id = w.id and r.status = 'reserved'
            ) as reserved_count
       from credit_wallets w
       left join credit_ledger l on l.wallet_id = w.id
      where w.user_id = $1
      group by w.id`,
    [userId],
  );
  const row = rows[0];
  assert.ok(row, "钱包不存在");
  assert.equal(row.balance, row.ledger_sum, "钱包余额必须等于流水总和");
  assert.equal(row.reserved, row.reserved_count, "钱包预占必须等于预留记录数");
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
    await assertWalletInvariants(sql, userId);
  } finally {
    await pg.close();
  }
});

test("same plan is idempotent across reserve, consume and repeated reserve", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = await createPlan(sql, userId);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);

    const first = await credits.reserveCredit(userId, planId);
    const second = await credits.reserveCredit(userId, planId);
    assert.equal(second.id, first.id);

    const reservations = await sql.query<{ id: string }>(
      "select id from credit_reservations where wallet_id = (select id from credit_wallets where user_id = $1) and plan_id = $2",
      [userId, planId],
    );
    assert.equal(reservations.length, 1);

    const consumed = await credits.consumeReservation(first.id, planId);
    const consumedAgain = await credits.consumeReservation(second.id, planId);
    assert.equal(consumedAgain.id, consumed.id);
    await credits.releaseReservation(first.id);

    const reserveAfterConsume = await credits.reserveCredit(userId, planId);
    assert.equal(reserveAfterConsume.id, first.id);
    assert.equal(reserveAfterConsume.status, "consumed");

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 0);
    assert.equal(summary.wallet.reserved, 0);
    assert.equal(summary.ledger.filter((item) => item.reason === "generation").length, 1);
    await assertWalletInvariants(sql, userId);
  } finally {
    await pg.close();
  }
});

test("release restores the reservation and repeated release is a no-op", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = await createPlan(sql, userId);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);

    const reservation = await credits.reserveCredit(userId, planId);
    await credits.releaseReservation(reservation.id);
    await credits.releaseReservation(reservation.id);

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 1);
    assert.equal(summary.wallet.reserved, 0);
    await assertWalletInvariants(sql, userId);
  } finally {
    await pg.close();
  }
});

test("concurrent reservations for different plans cannot exceed available balance", async () => {
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
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 1);
    assert.equal(summary.wallet.reserved, 1);
    await assertWalletInvariants(sql, userId);
  } finally {
    await pg.close();
  }
});

test("concurrent reservations for the same plan return one reservation and consume one point", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = await createPlan(sql, userId);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);

    const [first, second] = await Promise.all([
      credits.reserveCredit(userId, planId),
      credits.reserveCredit(userId, planId),
    ]);
    assert.equal(first.id, second.id);

    const reservations = await sql.query<{ id: string }>(
      "select id from credit_reservations where wallet_id = (select id from credit_wallets where user_id = $1) and plan_id = $2",
      [userId, planId],
    );
    assert.equal(reservations.length, 1);

    const consumed = await credits.consumeReservation(first.id, planId);
    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 0);
    assert.equal(summary.wallet.reserved, 0);
    assert.equal(summary.ledger.filter((item) => item.reason === "generation").length, 1);
    assert.equal(consumed.balanceAfter, 0);
    await assertWalletInvariants(sql, userId);
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
    await assertWalletInvariants(sql, userId);
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
    await assertWalletInvariants(sql, userId);
  } finally {
    await pg.close();
  }
});

test("concurrent consumption of one reservation returns one ledger entry", async () => {
  const { pg, sql, credits } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = await createPlan(sql, userId);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);
    const reservation = await credits.reserveCredit(userId, planId);

    const [first, second] = await Promise.all([
      credits.consumeReservation(reservation.id, planId),
      credits.consumeReservation(reservation.id, planId),
    ]);
    assert.equal(first.id, second.id);

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.wallet.balance, 0);
    assert.equal(summary.wallet.reserved, 0);
    assert.equal(summary.ledger.filter((item) => item.reason === "generation").length, 1);
    await assertWalletInvariants(sql, userId);
  } finally {
    await pg.close();
  }
});
