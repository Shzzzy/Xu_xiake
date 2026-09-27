import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminDashboard } from "./AdminDashboard.tsx";

test("管理后台展示核心指标、脱敏用户和管理操作", () => {
  const html = renderToStaticMarkup(
    <AdminDashboard
      metrics={{ users: 3, orders: 2, revenueCents: 1882, plans: 5 }}
      users={[
        {
          id: "u1",
          phoneMasked: "138****8000",
          role: "user",
          status: "active",
          balance: 10,
          reserved: 1,
          freeTrialClaimed: true,
          createdAt: "2026-09-27T00:00:00.000Z",
        },
      ]}
      orders={[]}
      ledger={[]}
    />,
  );

  assert.match(html, /用户数/);
  assert.match(html, /订单数/);
  assert.match(html, /收入/);
  assert.match(html, /生成次数/);
  assert.match(html, /138\*\*\*\*8000/);
  assert.doesNotMatch(html, /13800138000/);
  assert.match(html, /调整点数/);
  assert.match(html, /查看完整手机号/);
});
