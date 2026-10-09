import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createAdminService } from "./admin.server.ts";

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
  "0013_generation_entitlement_retry.sql",
  "0014_delivery_drafts.sql",
] as const;

type TestSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: TestSql) => Promise<T>): Promise<T>;
};

async function createTestContext() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of migrationNames) {
    const migration = await readFile(
      fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
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
  return { pg, sql: { query, transaction } satisfies TestSql };
}

let sequence = 0;

async function createUser(
  sql: TestSql,
  role: "user" | "admin" = "user",
  status: "active" | "disabled" = "active",
): Promise<{ id: string; phone: string }> {
  sequence += 1;
  const id = randomUUID();
  const phone = `13${String(100_000_000 + sequence).padStart(9, "0")}`;
  await sql.query(
    `insert into "user" (id, name, email, "emailVerified", phone, role, status)
     values ($1, $2, $3, true, $4, $5, $6)`,
    [id, phone, `${phone}@phone.invalid`, phone, role, status],
  );
  return { id, phone };
}

async function fundWallet(sql: TestSql, userId: string, balance: number): Promise<void> {
  await sql.query(
    "insert into credit_wallets (id, user_id, balance, reserved) values ($1, $2, $3, 0)",
    [randomUUID(), userId, balance],
  );
}

test("普通用户不能执行管理员操作", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const normal = await createUser(sql);
    const service = createAdminService(sql);
    await assert.rejects(() => service.requireAdmin(normal.id), /管理员权限/);
    await assert.rejects(
      () =>
        service.adjustCredits({
          adminUserId: normal.id,
          userId: normal.id,
          delta: 1,
          note: "测试调整",
        }),
      /管理员权限/,
    );
  } finally {
    await pg.close();
  }
});

test("管理员调整点数同时写流水和审计，且禁止透支", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const admin = await createUser(sql, "admin");
    const target = await createUser(sql);
    await fundWallet(sql, target.id, 2);
    const service = createAdminService(sql);

    const entry = await service.adjustCredits({
      adminUserId: admin.id,
      userId: target.id,
      delta: 5,
      note: "活动补偿",
    });
    assert.equal(entry.delta, 5);
    assert.equal(entry.balanceAfter, 7);

    const wallets = await sql.query<{ balance: number }>(
      "select balance from credit_wallets where user_id = $1",
      [target.id],
    );
    assert.equal(wallets[0]?.balance, 7);
    const audits = await sql.query<{ action: string }>(
      "select action from admin_audit_logs where admin_user_id = $1 and target_user_id = $2",
      [admin.id, target.id],
    );
    assert.deepEqual(
      audits.map((row) => row.action),
      ["adjust_credits"],
    );

    await assert.rejects(
      () =>
        service.adjustCredits({
          adminUserId: admin.id,
          userId: target.id,
          delta: -20,
          note: "不应成功",
        }),
      /余额不能为负数/,
    );
    const ledgerCount = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where wallet_id = (select id from credit_wallets where user_id = $1)",
      [target.id],
    );
    assert.equal(ledgerCount[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("管理员用户列表脱敏，状态变更和查看手机号都写审计", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const admin = await createUser(sql, "admin");
    const target = await createUser(sql);
    await fundWallet(sql, target.id, 3);
    const service = createAdminService(sql);

    const users = await service.listAdminUsers();
    const targetRow = users.find((user) => user.id === target.id);
    assert.equal(targetRow?.phoneMasked, `${target.phone.slice(0, 3)}****${target.phone.slice(7)}`);

    await service.setUserStatus(admin.id, target.id, "disabled");
    const disabled = await sql.query<{ status: string }>(
      'select status from "user" where id = $1',
      [target.id],
    );
    assert.equal(disabled[0]?.status, "disabled");

    const phone = await service.revealFullPhone(admin.id, target.id);
    assert.equal(phone, target.phone);
    const audits = await sql.query<{ action: string }>(
      "select action from admin_audit_logs order by created_at asc, id asc",
    );
    assert.deepEqual(
      audits.map((row) => row.action),
      ["set_user_status", "view_full_phone"],
    );
  } finally {
    await pg.close();
  }
});
