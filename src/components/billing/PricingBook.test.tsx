import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PackageDefinition } from "@/lib/billing/catalog";
import {
  PricingBook,
  buildPricingAuthHref,
  completeCheckout,
  resolveCheckoutAction,
} from "./PricingBook.tsx";

const noopCheckout = (_selection: PackageDefinition) => {};

test("点册渲染三档套餐价格和默认选中的十次点数", () => {
  const html = renderToStaticMarkup(
    <PricingBook authenticated={false} onCheckout={noopCheckout} />,
  );

  assert.match(html, /0\.99/);
  assert.match(html, /9\.41/);
  assert.match(html, /26\.73/);
  assert.match(html, /9\.5 折/);
  assert.match(html, /data-package="ten"[^>]*aria-pressed="true"/);
  assert.match(html, /十次点数/);
});

test("未登录进入支付时跳转登录页并保留 pricing returnTo", () => {
  assert.equal(buildPricingAuthHref(), "/auth?returnTo=/pricing");
  assert.equal(buildPricingAuthHref("/account"), "/auth?returnTo=/pricing?returnTo=%2Faccount");

  const html = renderToStaticMarkup(
    <PricingBook authenticated={false} onCheckout={noopCheckout} returnTo="/account" />,
  );
  assert.match(html, /href="\/auth\?returnTo=\/pricing\?returnTo=%2Faccount"/);
});

test("已登录进入支付时打开结算界面", () => {
  const action = resolveCheckoutAction({
    authenticated: true,
    returnTo: "/account",
    selectedCode: "ten",
  });

  assert.equal(action.status, "checkout");
  if (action.status === "checkout") {
    assert.equal(action.selection.amountCents, 941);
    assert.equal(action.selection.points, 10);
  }
});

test("结算确认回调收到当前选中的套餐", () => {
  const selections: PackageDefinition[] = [];
  const received = completeCheckout({
    selectedCode: "thirty",
    onCheckout: (selection) => selections.push(selection),
  });

  assert.equal(received.code, "thirty");
  assert.equal(selections.length, 1);
  assert.equal(selections[0]?.amountCents, 2673);
});
