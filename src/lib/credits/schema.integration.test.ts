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

test("commercial migrations create account and credit tables", async () => {
  const pg = await createMigratedDatabase();
  try {
    const result = await pg.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = result.rows.map((row) => row.table_name);
    assert.ok(names.includes("credit_wallets"));
    assert.ok(names.includes("credit_ledger"));
    assert.ok(names.includes("credit_reservations"));
    assert.ok(names.includes("payment_orders"));
  } finally {
    await pg.close();
  }
});

test("user table has phone role and status columns", async () => {
  const pg = await createMigratedDatabase();
  try {
    const result = await pg.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'user'",
    );
    const names = result.rows.map((row) => row.column_name);
    assert.ok(names.includes("phone"));
    assert.ok(names.includes("role"));
    assert.ok(names.includes("status"));
  } finally {
    await pg.close();
  }
});
