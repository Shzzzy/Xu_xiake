import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountBookPage } from "./AccountBookPage.tsx";

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
