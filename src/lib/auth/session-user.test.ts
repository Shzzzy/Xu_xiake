import test from "node:test";
import assert from "node:assert/strict";
import { mapSessionUser } from "./session-user.ts";

test("server session user mapping hides the internal phone email", () => {
  assert.deepEqual(
    mapSessionUser({
      id: "user-1",
      email: "13800138000@phone.invalid",
      phone: "13800138000",
      role: "user",
      status: "active",
    }),
    {
      id: "user-1",
      email: null,
      phone: "13800138000",
      role: "user",
      status: "active",
    },
  );
});
