import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { pgliteDialect } from "./pglite-dialect.ts";
import { createPhoneSignupGuard } from "./phone-signup-guard.ts";

const migrationNames = [
  "0001_public_auth.sql",
  "0002_discovered_places.sql",
  "0003_clear_discovered_route_context.sql",
  "0004_commercial_accounts.sql",
  "0005_username_auth.sql",
] as const;

async function createTestAuth(pg: PGlite) {
  return betterAuth({
    baseURL: "http://localhost:8080",
    secret: "phone-signup-guard-test-secret-0123456789",
    database: {
      dialect: pgliteDialect(() => pg),
      type: "postgres",
    },
    trustedOrigins: ["http://localhost:8080"],
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        phone: { type: "string", required: false, input: false },
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
}

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

test("production auth config mounts the phone signup guard", async () => {
  const source = await readFile(
    fileURLToPath(new URL("./server.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /databaseHooks:\s*createPhoneSignupGuard\(\)/);
});

test("phone signup guard rejects external email registration", async () => {
  const pg = await createMigratedDatabase();
  try {
    const auth = await createTestAuth(pg);
    await assert.rejects(
      () =>
        auth.api.signUpEmail({
          body: {
            name: "外部邮箱用户",
            email: "person@example.com",
            password: "password123",
          },
        }),
      /手机号/,
    );
  } finally {
    await pg.close();
  }
});

test("phone signup guard rejects mismatched internal email", async () => {
  const pg = await createMigratedDatabase();
  try {
    const auth = await createTestAuth(pg);
    await assert.rejects(
      () =>
        auth.api.signUpEmail({
          body: {
            name: "手机号用户",
            email: "13800138000@phone.invalid",
            password: "password123",
            username: "13900139000",
          },
        }),
      /邮箱必须与手机号一致/,
    );
  } finally {
    await pg.close();
  }
});

test("phone signup guard accepts a normalized phone account", async () => {
  const pg = await createMigratedDatabase();
  try {
    const auth = await createTestAuth(pg);
    const phone = "13800138000";
    const signUp = await auth.api.signUpEmail({
      body: {
        name: phone,
        email: `${phone}@phone.invalid`,
        password: "password123",
        username: phone,
      },
    });

    assert.equal(signUp.user.username, phone);
    assert.equal(signUp.user.displayUsername, phone);
    assert.equal(signUp.user.phone, phone);

    const signIn = await auth.api.signInUsername({
      body: { username: phone, password: "password123" },
    });
    assert.equal(signIn.user.id, signUp.user.id);
    assert.equal((signIn.user as { phone?: string }).phone, phone);
  } finally {
    await pg.close();
  }
});

test("phone identity fields cannot be changed through public update-user", async () => {
  const guard = createPhoneSignupGuard();
  const before = guard.user?.update?.before;
  assert.ok(before);

  const context = {
    path: "/update-user",
    body: { name: "新名字", phone: "13900139000", username: "13900139000" },
    context: { session: null },
  } as never;

  await assert.rejects(
    () => before({ phone: "13900139000" } as never, context),
    /不能通过公开更新接口修改/,
  );
  await assert.rejects(
    () => before({ username: "13900139000" } as never, context),
    /不能通过公开更新接口修改/,
  );
});

test("phone guard does not block OAuth user creation paths", async () => {
  const guard = createPhoneSignupGuard();
  const before = guard.user?.create?.before;
  assert.ok(before);
  const result = await before(
    {
      id: "oauth-user",
      name: "OAuth 用户",
      email: "oauth@example.com",
      emailVerified: true,
    } as never,
    {
      path: "/sign-in/social",
      body: { provider: "google" },
      context: { session: null },
    } as never,
  );
  assert.equal(result, undefined);
});
