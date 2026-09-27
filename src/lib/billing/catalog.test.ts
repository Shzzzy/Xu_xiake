import assert from "node:assert/strict";
import test from "node:test";
import { PACKAGE_CATALOG, resolvePackage } from "./catalog.ts";

test("套餐目录金额统一使用整数分", () => {
  assert.deepEqual(PACKAGE_CATALOG.single, {
    code: "single",
    points: 1,
    amountCents: 99,
    discountLabel: "无门槛",
  });
  assert.equal(resolvePackage("ten").amountCents, 941);
  assert.equal(resolvePackage("thirty").amountCents, 2673);
});
