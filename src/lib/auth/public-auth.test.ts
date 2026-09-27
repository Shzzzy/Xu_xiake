import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("public auth enables username credentials", () => {
  const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
  const flag = readFileSync(new URL("./email-password.ts", import.meta.url), "utf8");
  assert.match(server, /username\(/);
  assert.match(client, /usernameClient\(/);
  assert.match(flag, /emailAndPasswordEnabled = true/);
});
