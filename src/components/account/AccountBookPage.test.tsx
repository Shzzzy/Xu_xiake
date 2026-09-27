import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ACCOUNT_SIGN_IN_HREF,
  AccountBookPage,
  AccountBookRouteView,
  getWalletLoadErrorAction,
} from "./AccountBookPage.tsx";

const baseUser = {
  id: "u1",
  phone: "13800138000",
  role: "user" as const,
  status: "active" as const,
};

test("renders masked phone, available balance, free trial status and ledger", () => {
  const html = renderToStaticMarkup(
    <AccountBookPage
      user={baseUser}
      wallet={{ balance: 10, reserved: 1, freeTrialClaimed: true }}
      ledger={[
        {
          id: "l1",
          delta: 10,
          reason: "purchase",
          balanceAfter: 10,
          createdAt: "2026-09-27T08:00:00.000Z",
        },
      ]}
    />,
  );

  assert.match(html, /138\*{4}8000/);
  assert.match(html, /9 点/);
  assert.match(html, /首次免费已使用/);
  assert.match(html, /最近流水/);
  assert.match(html, /购买获得/);
  assert.match(html, /href="\/pricing\?returnTo=\/account"/);
});

test("shows admin entry only for admin accounts", () => {
  const userHtml = renderToStaticMarkup(
    <AccountBookPage
      user={baseUser}
      wallet={{ balance: 2, reserved: 0, freeTrialClaimed: false }}
      ledger={[]}
    />,
  );
  const adminHtml = renderToStaticMarkup(
    <AccountBookPage
      user={{ ...baseUser, role: "admin" }}
      wallet={{ balance: 2, reserved: 0, freeTrialClaimed: false }}
      ledger={[]}
    />,
  );

  assert.doesNotMatch(userHtml, /href="\/admin"/);
  assert.match(adminHtml, /href="\/admin"/);
  assert.match(adminHtml, /管理后台/);
});

test("does not render the previous user's wallet while the next user loads", () => {
  const html = renderToStaticMarkup(
    <AccountBookRouteView
      user={{ ...baseUser, id: "u2", phone: "13900139000" }}
      isPending={false}
      summary={{
        userId: "u1",
        wallet: { balance: 10, reserved: 0, freeTrialClaimed: true },
        ledger: [
          {
            id: "l1",
            delta: 10,
            reason: "purchase",
            balanceAfter: 10,
          },
        ],
      }}
      loading={true}
      error={null}
    />,
  );

  assert.doesNotMatch(html, /10 点/);
  assert.doesNotMatch(html, /购买获得/);
  assert.match(html, /正在整理你的行旅点册/);
});

test("maps a 401 wallet failure to the account sign-in redirect", () => {
  assert.equal(getWalletLoadErrorAction({ status: 401 }), "redirect");
  assert.equal(getWalletLoadErrorAction(new Error("Unauthorized")), "redirect");
  assert.equal(getWalletLoadErrorAction(new Error("数据库连接失败")), "message");
  assert.equal(ACCOUNT_SIGN_IN_HREF, "/auth?returnTo=/account");
});

test("shows a friendly message instead of an internal wallet error", () => {
  const html = renderToStaticMarkup(
    <AccountBookRouteView
      user={baseUser}
      isPending={false}
      summary={null}
      loading={false}
      error="数据库连接失败"
    />,
  );

  assert.match(html, /暂时无法加载账号信息，请稍后重试/);
  assert.doesNotMatch(html, /数据库连接失败/);
});
