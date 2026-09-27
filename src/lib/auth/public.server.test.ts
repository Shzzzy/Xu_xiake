import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { pgliteDialect } from "./pglite-dialect.ts";
import { createPhoneSignupGuard } from "./phone-signup-guard.ts";
import {
  createPublicAccountRecordWithAuth,
  getPublicAccountWithQuery,
} from "./public.server.ts";

const migrationNames = [
  "0001_public_auth.sql",
  "0002_discovered_places.sql",
  "0003_clear_discovered_route_context.sql",
  "0004_commercial_accounts.sql",
  "0005_username_auth.sql",
] as const;

async function createMigrations() {
  return Promise.all(
    migrationNames.map(async (name) => ({
      name,
      sql: await readFile(
        fileURLToPath(new URL(`../../../migrations/${name}`, import.meta.url)),
        "utf8",
      ),
    })),
  );
}

test("public account record uses normalized phone and stores a hashed password", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of await createMigrations()) {
    await pg.exec(migration.sql);
  }

  try {
    const auth = betterAuth({
      baseURL: "http://localhost:8080",
      secret: "public-account-record-test-secret-0123456789",
      database: { dialect: pgliteDialect(() => pg), type: "postgres" },
      trustedOrigins: ["http://localhost:8080"],
      emailAndPassword: { enabled: true },
      user: {
        additionalFields: {
          phone: { type: "string", required: false, input: true },
          role: { type: "string", required: false, defaultValue: "user", input: false },
          status: { type: "string", required: false, defaultValue: "active", input: false },
        },
      },
      databaseHooks: createPhoneSignupGuard(),
      plugins: [
        username({
          minUsernameLength: 11,
          maxUsernameLength: 11,
          usernameValidator: (value) => /^1[3-9]\d{9}$/.test(value),
        }),
      ],
    });

    const phone = "13" + String(Date.now()).slice(-9);
    const record = await createPublicAccountRecordWithAuth(auth, {
      phone: `+86 ${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`,
      password: "password123",
    });

    assert.equal(record.phone, phone);
    assert.equal(record.role, "user");
    assert.equal(record.status, "active");

    const account = await getPublicAccountWithQuery(
      {
        query: async <T>(text: string, params?: unknown[]) => {
          const result = await pg.query<T>(text, params ?? []);
          return result.rows;
        },
      },
      record.id,
    );
    assert.deepEqual(account, {
      id: record.id,
      phone,
      role: "user",
      status: "active",
    });

    const credentials = await pg.query<{ password: string }>(
      'select "password" from "account" where "userId" = $1',
      [record.id],
    );
    assert.ok(credentials.rows[0]?.password);
    assert.notEqual(credentials.rows[0]?.password, "password123");
  } finally {
    await pg.close();
  }
});
