import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readFile as readSourceFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { pgliteDialect } from "./pglite-dialect.ts";
import { emailAndPasswordEnabled } from "./email-password.ts";
import { phoneToInternalEmail } from "./phone.ts";

const migrationNames = [
  "0001_public_auth.sql",
  "0002_discovered_places.sql",
  "0003_clear_discovered_route_context.sql",
  "0004_commercial_accounts.sql",
  "0005_username_auth.sql",
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

test("public auth config mounts username credentials", async () => {
  const server = await readSourceFile(new URL("./server.ts", import.meta.url), "utf8");
  const client = await readSourceFile(new URL("./client.ts", import.meta.url), "utf8");
  assert.match(server, /username\(/);
  assert.match(client, /usernameClient\(/);
  assert.equal(emailAndPasswordEnabled, true);
});

test("phone username registration and login work against migrated PGlite", async () => {
  const pg = await createMigratedDatabase();
  try {
    const auth = betterAuth({
      baseURL: "http://localhost:8080",
      secret: "public-auth-test-secret-0123456789",
      database: {
        dialect: pgliteDialect(() => pg),
        type: "postgres",
      },
      trustedOrigins: ["http://localhost:8080"],
      emailAndPassword: { enabled: emailAndPasswordEnabled },
      plugins: [
        username({
          minUsernameLength: 11,
          maxUsernameLength: 11,
          usernameValidator: (value) => /^1[3-9]\d{9}$/.test(value),
        }),
      ],
    });

    const phone = "13800138000";
    const password = "Test-pass-123";
    const signUp = await auth.api.signUpEmail({
      body: {
        name: "测试用户",
        email: phoneToInternalEmail(phone),
        password,
        username: phone,
      },
    });

    assert.equal(signUp.user.username, phone);
    assert.equal(signUp.user.displayUsername, phone);

    const rows = await pg.query<{
      username: string;
      displayUsername: string;
    }>('select "username", "displayUsername" from "user" where "id" = $1', [signUp.user.id]);
    assert.deepEqual(rows.rows, [{ username: phone, displayUsername: phone }]);

    const signIn = await auth.api.signInUsername({
      body: { username: phone, password },
    });
    assert.equal(signIn.user.id, signUp.user.id);
    assert.equal(signIn.user.username, phone);
    assert.equal(signIn.user.displayUsername, phone);
  } finally {
    await pg.close();
  }
});
