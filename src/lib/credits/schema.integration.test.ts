import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

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

const commercialTables = [
  "credit_wallets",
  "credit_ledger",
  "credit_reservations",
  "payment_orders",
  "payment_events",
  "travel_plans",
  "plan_shares",
  "admin_audit_logs",
  "generation_entitlements",
] as const;

const requiredConstraints = [
  "credit_wallets_balance_check",
  "credit_wallets_reserved_check",
  "credit_wallets_id_user_id_key",
  "credit_ledger_reason_check",
  "credit_ledger_order_id_fkey",
  "credit_ledger_plan_id_fkey",
  "credit_ledger_operator_user_id_fkey",
  "credit_reservations_plan_id_fkey",
  "payment_orders_wallet_owner_fkey",
  "payment_events_order_id_fkey",
  "payment_events_provider_event_id_key",
  "travel_plans_id_user_id_key",
  "plan_shares_plan_owner_fkey",
  "admin_audit_logs_target_user_id_fkey",
  "admin_audit_logs_target_order_id_fkey",
  "admin_audit_logs_target_plan_id_fkey",
] as const;

const requiredIndexes = [
  "payment_orders_provider_order_id_unique_idx",
  "payment_orders_provider_transaction_id_unique_idx",
  "credit_ledger_purchase_order_unique_idx",
  "user_username_unique_idx",
  "credit_reservations_wallet_plan_unique_idx",
  "payment_orders_user_client_request_unique_idx",
  "generation_entitlements_guest_bucket_active_idx",
  "generation_entitlements_guest_fingerprint_active_idx",
  "generation_entitlements_free_user_active_idx",
  "generation_entitlements_paid_reservation_active_idx",
  "travel_plans_plan_hash_idx",
] as const;

async function createMigratedDatabase() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of migrationNames) {
    const migration = await readFile(
      fileURLToPath(new URL(`../../../migrations/${name}`, import.meta.url)),
      "utf8",
    );
    await pg.exec(migration);
  }
  return pg;
}

async function seedCommercialFixtures(pg: PGlite) {
  await pg.exec(`
    insert into "user" ("id", "name", "email", "emailVerified") values
      ('user-a', '用户甲', 'user-a@example.com', true),
      ('user-b', '用户乙', 'user-b@example.com', true),
      ('user-c', '用户丙', 'user-c@example.com', true),
      ('user-d', '用户丁', 'user-d@example.com', true);

    insert into credit_wallets (id, user_id, balance) values
      ('wallet-a', 'user-a', 10),
      ('wallet-b', 'user-b', 10);

    insert into travel_plans (
      id, user_id, title, origin, destination, days, status, plan_data
    ) values (
      'plan-a', 'user-a', '测试行程', '北京', '上海', 3, 'ready', '{}'::jsonb
    );
  `);
}

async function expectFailure(pg: PGlite, statement: string, pattern: RegExp) {
  await assert.rejects(() => pg.exec(statement), pattern);
}

test("commercial migrations create all commercial tables", async () => {
  const pg = await createMigratedDatabase();
  try {
    const result = await pg.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = result.rows.map((row) => row.table_name);
    for (const table of commercialTables) {
      assert.ok(names.includes(table), `缺少商业表：${table}`);
    }
  } finally {
    await pg.close();
  }
});

test("username migration creates Better Auth user columns and enforces uniqueness", async () => {
  const pg = await createMigratedDatabase();
  try {
    const columns = await pg.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'user'
          and column_name in ('username', 'displayUsername')
        order by column_name`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ["displayUsername", "username"],
    );

    const indexes = await pg.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = 'public'
          and indexname = 'user_username_unique_idx'`,
    );
    assert.equal(indexes.rows.length, 1, "缺少用户名部分唯一索引");
    assert.match(indexes.rows[0].indexdef, /unique/i);
    assert.match(indexes.rows[0].indexdef, /username/i);
    assert.match(indexes.rows[0].indexdef, /where .*username.*is not null/i);

    await pg.exec(`
      insert into "user" (
        "id", "name", "email", "emailVerified", "username", "displayUsername"
      ) values (
        'user-username-1', '用户甲', 'username-a@example.com', true,
        '13800138000', '13800138000'
      );
    `);

    await expectFailure(
      pg,
      `insert into "user" (
         "id", "name", "email", "emailVerified", "username", "displayUsername"
       ) values (
         'user-username-2', '用户乙', 'username-b@example.com', true,
         '13800138000', '13800138000'
       )`,
      /user_username_unique_idx|duplicate key|unique constraint/i,
    );
  } finally {
    await pg.close();
  }
});

test("payment orders include provider creation lease and credit application columns", async () => {
  const pg = await createMigratedDatabase();
  try {
    const columns = await pg.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'payment_orders'
          and column_name in ('credits_applied_at', 'provider_creation_token', 'provider_creation_started_at')
        order by column_name`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ["credits_applied_at", "provider_creation_started_at", "provider_creation_token"],
    );
  } finally {
    await pg.close();
  }
});

test("commercial migrations declare required constraints and indexes", async () => {
  const pg = await createMigratedDatabase();
  try {
    const constraints = await pg.query<{ constraint_name: string }>(
      "select constraint_name from information_schema.table_constraints where table_schema = 'public'",
    );
    const constraintNames = constraints.rows.map((row) => row.constraint_name);
    for (const constraint of requiredConstraints) {
      assert.ok(constraintNames.includes(constraint), `缺少约束：${constraint}`);
    }

    const indexes = await pg.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public'",
    );
    const indexNames = indexes.rows.map((row) => row.indexname);
    for (const index of requiredIndexes) {
      assert.ok(indexNames.includes(index), `缺少索引：${index}`);
    }
  } finally {
    await pg.close();
  }
});

test("user, balance, and ledger checks reject invalid writes", async () => {
  const pg = await createMigratedDatabase();
  try {
    await seedCommercialFixtures(pg);

    await expectFailure(
      pg,
      `insert into "user" ("id", "name", "email", "emailVerified", "role")
       values ('invalid-role', '无效角色', 'invalid-role@example.com', true, 'owner')`,
      /user_role_check|check constraint/i,
    );

    await expectFailure(
      pg,
      `insert into credit_wallets (id, user_id, balance)
       values ('negative-wallet', 'user-c', -1)`,
      /credit_wallets_balance_check|check constraint/i,
    );

    await expectFailure(
      pg,
      `insert into credit_ledger (id, wallet_id, delta, balance_after, reason)
       values ('invalid-reason', 'wallet-a', 0, 10, 'invalid_reason')`,
      /credit_ledger_reason_check|check constraint/i,
    );
  } finally {
    await pg.close();
  }
});

test("payment orders bind wallet ownership and provider identifiers", async () => {
  const pg = await createMigratedDatabase();
  try {
    await seedCommercialFixtures(pg);

    await expectFailure(
      pg,
      `insert into payment_orders (
         id, user_id, wallet_id, package_code, points, amount_cents, provider,
         provider_order_id, provider_transaction_id, status, expires_at
       ) values (
         'order-cross-user', 'user-a', 'wallet-b', 'single', 1, 99, 'wechat',
         'provider-cross-user', 'transaction-cross-user', 'created', now() + interval '1 day'
       )`,
      /payment_orders_wallet_owner_fkey|foreign key constraint/i,
    );

    await pg.exec(`
      insert into payment_orders (
        id, user_id, wallet_id, package_code, points, amount_cents, provider,
        provider_order_id, provider_transaction_id, status, expires_at
      ) values (
        'order-valid', 'user-a', 'wallet-a', 'single', 1, 99, 'wechat',
        'provider-order-1', 'transaction-1', 'created', now() + interval '1 day'
      );
    `);

    await expectFailure(
      pg,
      `insert into payment_orders (
         id, user_id, wallet_id, package_code, points, amount_cents, provider,
         provider_order_id, provider_transaction_id, status, expires_at
       ) values (
         'order-duplicate-provider', 'user-a', 'wallet-a', 'single', 1, 99, 'wechat',
         'provider-order-1', 'transaction-2', 'created', now() + interval '1 day'
       )`,
      /payment_orders_provider_order_id_unique_idx|duplicate key|unique constraint/i,
    );

    await expectFailure(
      pg,
      `insert into payment_orders (
         id, user_id, wallet_id, package_code, points, amount_cents, provider,
         provider_order_id, provider_transaction_id, status, expires_at
       ) values (
         'order-duplicate-transaction', 'user-a', 'wallet-a', 'single', 1, 99, 'wechat',
         'provider-order-2', 'transaction-1', 'created', now() + interval '1 day'
       )`,
      /payment_orders_provider_transaction_id_unique_idx|duplicate key|unique constraint/i,
    );

    await pg.exec(`
      insert into payment_orders (
        id, user_id, wallet_id, package_code, points, amount_cents, provider,
        provider_order_id, provider_transaction_id, status, expires_at
      ) values (
        'order-other-provider', 'user-a', 'wallet-a', 'single', 1, 99, 'alipay',
        'provider-order-1', 'transaction-3', 'created', now() + interval '1 day'
      );
    `);

    await pg.exec(`
      insert into payment_orders (
        id, user_id, wallet_id, package_code, points, amount_cents, provider,
        status, expires_at, client_request_id
      ) values (
        'order-client-request-1', 'user-a', 'wallet-a', 'single', 1, 99, 'wechat',
        'created', now() + interval '1 day', 'checkout-request-1'
      );
    `);

    await expectFailure(
      pg,
      `insert into payment_orders (
         id, user_id, wallet_id, package_code, points, amount_cents, provider,
         status, expires_at, client_request_id
       ) values (
         'order-client-request-2', 'user-a', 'wallet-a', 'single', 1, 99, 'wechat',
         'created', now() + interval '1 day', 'checkout-request-1'
       )`,
      /payment_orders_user_client_request_unique_idx|duplicate key|unique constraint/i,
    );

    await pg.exec(`
      insert into payment_events (id, provider, provider_event_id, order_id, payload, status)
      values ('event-wechat-1', 'wechat', 'event-1', 'order-valid', '{}'::jsonb, 'received');
    `);

    await expectFailure(
      pg,
      `insert into payment_events (id, provider, provider_event_id, order_id, payload, status)
       values ('event-wechat-1-duplicate', 'wechat', 'event-1', 'order-valid', '{}'::jsonb, 'received')`,
      /payment_events_provider_event_id_key|duplicate key|unique constraint/i,
    );

    await pg.exec(`
      insert into payment_events (id, provider, provider_event_id, order_id, payload, status)
      values ('event-alipay-1', 'alipay', 'event-1', 'order-valid', '{}'::jsonb, 'received');
    `);

    await expectFailure(
      pg,
      `insert into payment_events (id, provider, provider_event_id, order_id, payload, status)
       values ('event-invalid-order', 'wechat', 'event-2', 'missing-order', '{}'::jsonb, 'received')`,
      /payment_events_order_id_fkey|foreign key constraint/i,
    );
  } finally {
    await pg.close();
  }
});

test("plan shares require the share owner to match the plan owner", async () => {
  const pg = await createMigratedDatabase();
  try {
    await seedCommercialFixtures(pg);

    await expectFailure(
      pg,
      `insert into plan_shares (id, plan_id, owner_user_id, token_hash, status)
       values ('share-mismatch', 'plan-a', 'user-b', 'token-mismatch', 'active')`,
      /plan_shares_plan_owner_fkey|foreign key constraint/i,
    );

    await pg.exec(`
      insert into plan_shares (id, plan_id, owner_user_id, token_hash, status)
      values ('share-valid', 'plan-a', 'user-a', 'token-valid', 'active');
    `);
  } finally {
    await pg.close();
  }
});

test("purchase ledger is unique per payment order", async () => {
  const pg = await createMigratedDatabase();
  try {
    await seedCommercialFixtures(pg);
    await pg.exec(`
      insert into payment_orders (
        id, user_id, wallet_id, package_code, points, amount_cents, provider,
        provider_order_id, status, expires_at
      ) values (
        'order-purchase-unique', 'user-a', 'wallet-a', 'single', 1, 99, 'wechat',
        'provider-purchase-unique', 'paid', now() + interval '1 day'
      );

      insert into credit_ledger (
        id, wallet_id, delta, balance_after, reason, order_id
      ) values (
        'ledger-purchase-unique-1', 'wallet-a', 1, 11, 'purchase', 'order-purchase-unique'
      );
    `);

    await expectFailure(
      pg,
      `insert into credit_ledger (
         id, wallet_id, delta, balance_after, reason, order_id
       ) values (
         'ledger-purchase-unique-2', 'wallet-a', 1, 12, 'purchase', 'order-purchase-unique'
       )`,
      /credit_ledger_purchase_order_unique_idx|duplicate key|unique constraint/i,
    );
  } finally {
    await pg.close();
  }
});
