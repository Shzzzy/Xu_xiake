import test from "node:test";
import assert from "node:assert/strict";
import { readableAuthError } from "./auth-errors.ts";

test("readableAuthError distinguishes duplicate, rate limit, password and invalid input", () => {
  assert.match(readableAuthError(new Error("USERNAME_IS_ALREADY_TAKEN"), "register"), /已经注册/);
  assert.match(readableAuthError(new Error("429 too many requests"), "register"), /过于频繁/);
  assert.match(readableAuthError(new Error("invalid password"), "login"), /手机号或密码/);
  const invalidUsername = readableAuthError(new Error("invalid username"), "login");
  assert.doesNotMatch(invalidUsername, /密码不正确/);
  assert.match(invalidUsername, /账号信息有误/);
});
