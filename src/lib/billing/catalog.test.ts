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

test("套餐折扣与单次价格保持整数分关系", () => {
  const singleCents = PACKAGE_CATALOG.single.amountCents;

  assert.equal(
    PACKAGE_CATALOG.ten.amountCents,
    Math.round((singleCents * PACKAGE_CATALOG.ten.points * 95) / 100),
  );
  assert.equal(
    PACKAGE_CATALOG.thirty.amountCents,
    Math.round((singleCents * PACKAGE_CATALOG.thirty.points * 90) / 100),
  );
});
