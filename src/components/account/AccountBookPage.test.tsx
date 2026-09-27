import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountBookPage,
  AccountBookRouteView,
  loadAccountSummary,
  type AccountBookSummary,
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

test("loads a wallet summary bound to the current user", async () => {
  const written = { summary: null as AccountBookSummary | null };

  await loadAccountSummary({
    userId: "u2",
    fetchWallet: async () => ({
      wallet: { balance: 7, reserved: 1, freeTrialClaimed: false },
      ledger: [],
    }),
    onSuccess: (summary) => {
      written.summary = summary;
    },
    onAuthRequired: () => {
      throw new Error("不应要求重新登录");
    },
    onError: () => {
      throw new Error("不应报告普通错误");
    },
  });

  assert.equal(written.summary?.userId, "u2");
  assert.equal(written.summary?.wallet.balance, 7);
});

test("401 only calls onAuthRequired and leaves the summary null", async () => {
  let summary: Awaited<ReturnType<typeof loadAccountSummary>> = null;
  let authRequiredCount = 0;
  let errorCount = 0;

  await loadAccountSummary({
    userId: "u2",
    fetchWallet: async () => {
      throw { status: 401 };
    },
    onSuccess: (nextSummary) => {
      summary = nextSummary;
    },
    onAuthRequired: () => {
      authRequiredCount += 1;
    },
    onError: () => {
      errorCount += 1;
    },
  });

  assert.equal(summary, null);
  assert.equal(authRequiredCount, 1);
  assert.equal(errorCount, 0);
});

test("non-401 errors call onError with a friendly message", async () => {
  let authRequiredCount = 0;
  let errorMessage = "";
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    await loadAccountSummary({
      userId: "u2",
      fetchWallet: async () => {
        throw new Error("数据库连接失败");
      },
      onSuccess: () => {
        throw new Error("不应写入摘要");
      },
      onAuthRequired: () => {
        authRequiredCount += 1;
      },
      onError: (message) => {
        errorMessage = message;
      },
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(authRequiredCount, 0);
  assert.equal(errorMessage, "暂时无法加载账号信息，请稍后重试。");
  assert.doesNotMatch(errorMessage, /数据库连接失败/);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]?.[0]), /钱包加载失败/);
  assert.match(String(logged[0]?.[1]), /数据库连接失败/);
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
