import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PACKAGE_CATALOG, type PackageDefinition } from "@/lib/billing/catalog";
import {
  PricingBook,
  buildPricingAuthHref,
  completeCheckout,
  loadPricingEntitlement,
  resolveCheckoutAction,
} from "./PricingBook.tsx";

const { JSDOM } = await import("jsdom");
const interactionDom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/pricing",
});
Object.defineProperties(globalThis, {
  window: { value: interactionDom.window, configurable: true },
  document: { value: interactionDom.window.document, configurable: true },
  navigator: { value: interactionDom.window.navigator, configurable: true },
  HTMLElement: { value: interactionDom.window.HTMLElement, configurable: true },
  Element: { value: interactionDom.window.Element, configurable: true },
  Node: { value: interactionDom.window.Node, configurable: true },
  Event: { value: interactionDom.window.Event, configurable: true },
  KeyboardEvent: { value: interactionDom.window.KeyboardEvent, configurable: true },
  MouseEvent: { value: interactionDom.window.MouseEvent, configurable: true },
  getComputedStyle: {
    value: interactionDom.window.getComputedStyle.bind(interactionDom.window),
    configurable: true,
  },
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");

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

test("免费体验文案依据真实钱包状态显示", () => {
  const availableHtml = renderToStaticMarkup(
    <PricingBook
      authenticated
      entitlement={{ freeTrialClaimed: false }}
      onCheckout={noopCheckout}
    />,
  );
  const claimedHtml = renderToStaticMarkup(
    <PricingBook
      authenticated
      entitlement={{ freeTrialClaimed: true }}
      onCheckout={noopCheckout}
    />,
  );

  assert.match(availableHtml, /新用户首次完整体验免费/);
  assert.match(claimedHtml, /本次购买将获得 10 点/);
  assert.doesNotMatch(claimedHtml, /首次完整体验免费/);
});

test("套餐标题和点数展示与目录 points 保持一致", () => {
  const html = renderToStaticMarkup(
    <PricingBook authenticated={false} onCheckout={noopCheckout} />,
  );
  const expectedTitles = new Map([
    [1, "单次购买"],
    [10, "十次点数"],
    [30, "三十次点数"],
  ]);

  for (const selection of Object.values(PACKAGE_CATALOG)) {
    assert.match(html, new RegExp(expectedTitles.get(selection.points) ?? ""));
  }
});

test("结算抽屉支持选择套餐、支付方式、确认回调与焦点圈", () => {
  cleanup();
  const selections: PackageDefinition[] = [];

  render(
    <PricingBook
      authenticated
      entitlement={{ freeTrialClaimed: false }}
      onCheckout={(selection) => selections.push(selection)}
    />,
  );

  const trigger = screen.getByRole("button", { name: "进入支付" });
  fireEvent.click(screen.getByRole("radio", { name: /三十次点数/ }));
  trigger.focus();
  fireEvent.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "确认购买点数" });
  const closeButton = screen.getByRole("button", { name: "关闭支付面板" });
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(document.activeElement, closeButton);

  const alipay = screen.getByRole("button", { name: /支付宝/ });
  fireEvent.click(alipay);
  assert.equal(alipay.getAttribute("aria-pressed"), "true");

  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement, screen.getByRole("button", { name: /确认支付/ }));
  fireEvent.keyDown(document, { key: "Tab" });
  assert.equal(document.activeElement, closeButton);

  fireEvent.click(screen.getByRole("button", { name: /确认支付/ }));
  assert.equal(selections.length, 1);
  assert.equal(selections[0]?.code, "thirty");
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger);
});

test("Escape 关闭结算抽屉并恢复触发按钮焦点", () => {
  cleanup();

  render(
    <PricingBook
      authenticated
      entitlement={{ freeTrialClaimed: true }}
      onCheckout={noopCheckout}
    />,
  );

  const trigger = screen.getByRole("button", { name: "进入支付" });
  trigger.focus();
  fireEvent.click(trigger);
  assert.ok(screen.getByRole("dialog", { name: "确认购买点数" }));

  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger);
});

test("未登录时不请求钱包状态", async () => {
  let walletRequests = 0;
  let received: unknown = "未回调";

  const entitlement = await loadPricingEntitlement({
    userId: undefined,
    fetchWallet: async () => {
      walletRequests += 1;
      return { wallet: { freeTrialClaimed: false } };
    },
    onEntitlement: (nextEntitlement) => {
      received = nextEntitlement;
    },
  });

  assert.equal(walletRequests, 0);
  assert.equal(entitlement, null);
  assert.equal(received, null);
});
