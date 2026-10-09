import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createSharesService, hashShareToken } from "./shares.server.ts";

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

async function createUser(sql: TestSql): Promise<string> {
  sequence += 1;
  const id = randomUUID();
  const phone = `13${String(100_000_000 + sequence).padStart(9, "0")}`;
  await sql.query(
    `insert into "user" (id, name, email, "emailVerified", phone, role, status)
     values ($1, $2, $3, true, $4, 'user', 'active')`,
    [id, phone, `${phone}@phone.invalid`, phone],
  );
  return id;
}

async function createPlan(sql: TestSql, userId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `insert into travel_plans (id, user_id, title, origin, destination, days, status, plan_data)
     values ($1, $2, '测试路书', '北京', '上海', 2, 'saved', $3::jsonb)`,
    [id, userId, JSON.stringify({ meta: { title: "测试路书" } })],
  );
  return id;
}

test("分享令牌只存哈希且不保存原文", async () => {
  assert.notEqual(hashShareToken("abc123"), "abc123");
  assert.equal(hashShareToken("abc123").length, 64);
});

test("只有行程所有者可以创建分享，且有效令牌可解析", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const owner = await createUser(sql);
    const other = await createUser(sql);
    const planId = await createPlan(sql, owner);
    const shares = createSharesService(sql);

    await assert.rejects(() => shares.createPlanShare(other, planId), /无权分享/);
    const created = await shares.createPlanShare(owner, planId);
    const token = created.url.split("/").pop();
    assert.ok(token);

    const stored = await sql.query<{ token_hash: string }>(
      "select token_hash from plan_shares where token_hash = $1",
      [hashShareToken(token!)],
    );
    assert.equal(stored[0]?.token_hash, hashShareToken(token!));

    const resolved = await shares.resolvePlanShare(token!);
    assert.equal((resolved?.plan as { meta?: { title?: string } })?.meta?.title, "测试路书");
  } finally {
    await pg.close();
  }
});

test("撤销或过期分享不可解析", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const owner = await createUser(sql);
    const planId = await createPlan(sql, owner);
    const shares = createSharesService(sql);
    const created = await shares.createPlanShare(owner, planId);
    const token = created.url.split("/").pop()!;

    await sql.query("update plan_shares set status = 'revoked' where token_hash = $1", [
      hashShareToken(token),
    ]);
    assert.equal(await shares.resolvePlanShare(token), null);
  } finally {
    await pg.close();
  }
});
