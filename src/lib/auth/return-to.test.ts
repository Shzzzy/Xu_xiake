import test from "node:test";
import assert from "node:assert/strict";
import { buildSignInRedirect, normalizeReturnTo } from "./return-to.ts";

const origin = "https://travel.example";

test("returnTo rejects normalized protocol-relative and backslash payloads", () => {
  assert.equal(normalizeReturnTo("/%2e%2e//evil.com", origin), "/");
  assert.equal(normalizeReturnTo("/%2e%2e/%5cevil.com", origin), "/");
  assert.equal(normalizeReturnTo("/%2e%2e//", origin), "/");
  assert.equal(normalizeReturnTo("//evil.com/path", origin), "/");
  assert.equal(normalizeReturnTo("/\\evil.com/path", origin), "/");
  assert.equal(normalizeReturnTo("/%5Cevil.com/path", origin), "/");
  assert.equal(normalizeReturnTo("https://evil.com/path", origin), "/");
});

test("returnTo keeps same-origin pathname, query and hash", () => {
  assert.equal(
    normalizeReturnTo("/plan/beijing?day=2#map", origin),
    "/plan/beijing?day=2#map",
  );
  assert.equal(normalizeReturnTo("https://travel.example/plan/1?x=1#p2", origin), "/plan/1?x=1#p2");
  assert.equal(normalizeReturnTo("/pricing?x=1#a", origin), "/pricing?x=1#a");
});

test("sign-in redirect targets /auth and carries the triggering page", () => {
  const redirect = buildSignInRedirect("/plan/beijing?day=2#map", origin);
  assert.equal(redirect.to, "/auth");
  assert.equal(redirect.search.returnTo, "/plan/beijing?day=2#map");
  assert.equal(normalizeReturnTo(redirect.search.returnTo, origin), "/plan/beijing?day=2#map");
});
