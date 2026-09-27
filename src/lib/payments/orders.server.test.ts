import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createPaymentOrdersService } from "./orders.server.ts";
import type { CreatedPayment, PaymentProvider, PaymentWebhookEvent } from "./provider.ts";
import { createTestPaymentProvider } from "./test-provider.server.ts";
import { resolvePaymentProvider } from "./provider-registry.server.ts";

const migrationNames = [
  "0001_public_auth.sql",
  "0002_discovered_places.sql",
  "0003_clear_discovered_route_context.sql",
  "0004_commercial_accounts.sql",
  "0005_username_auth.sql",
  "0006_credit_reservation_idempotency.sql",
  "0007_payment_order_idempotency.sql",
] as const;

type TestSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: TestSql) => Promise<T>): Promise<T>;
};

async function createTestContext() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of migrationNames) {
    const migration = await readFile(
      fileURLToPath(new URL(`../../../migrations/${name}`, import.meta.url)),
      "utf8",
    );
    await pg.exec(migration);
  }

  const query = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  };
  const transaction = async <T>(fn: (tx: TestSql) => Promise<T>): Promise<T> =>
    pg.transaction(async (tx) => {
      const txQuery = async <U = Record<string, unknown>>(
        text: string,
        params: unknown[] = [],
      ): Promise<U[]> => {
        const result = await tx.query<U>(text, params);
        return result.rows;
      };
      let txSql: TestSql;
      txSql = {
        query: txQuery,
        transaction: (inner) => inner(txSql),
      };
      return fn(txSql);
    });

  return { pg, sql: { query, transaction } satisfies TestSql };
}

let phoneSequence = 0;

async function createUser(
  sql: TestSql,
  status: "active" | "disabled" = "active",
): Promise<{ id: string; phone: string }> {
  const id = randomUUID();
  phoneSequence += 1;
  const phone = `13${String(100_000_000 + phoneSequence).padStart(9, "0")}`;
  await sql.query(
    `insert into "user" (id, name, email, "emailVerified", phone, status)
     values ($1, $2, $3, true, $4, $5)`,
    [id, phone, `${phone}@phone.invalid`, phone, status],
  );
  return { id, phone };
}

function createCountingProvider() {
  let createCalls = 0;
  const provider: PaymentProvider = {
    id: "test",
    async createPayment(input): Promise<CreatedPayment> {
      createCalls += 1;
      return {
        provider: "test",
        providerOrderId: `test-${input.orderId}`,
        redirectUrl: `/pricing?testOrder=${input.orderId}`,
        payload: { amountCents: input.amountCents },
      };
    },
    async verifyWebhook(): Promise<PaymentWebhookEvent> {
      throw new Error("本测试不验证支付回调");
    },
  };
  return {
    provider,
    get createCalls() {
      return createCalls;
    },
  };
}

test("createPaymentOrder reads catalog price and persists the order", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const counting = createCountingProvider();
    const orders = createPaymentOrdersService(sql, counting.provider);

    const order = await orders.createPaymentOrder(userId, "ten");

    assert.equal(order.points, 10);
    assert.equal(order.amountCents, 941);
    assert.equal(order.currency, "CNY");
    assert.equal(order.status, "created");
    assert.equal(order.providerOrderId, `test-${order.id}`);
    assert.equal(counting.createCalls, 1);

    const rows = await sql.query<{ count: number }>(
      "select count(*)::int as count from payment_orders",
    );
    assert.equal(rows[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("createPaymentOrder rejects missing and disabled accounts", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const orders = createPaymentOrdersService(sql, createTestPaymentProvider());

    await assert.rejects(() => orders.createPaymentOrder(randomUUID(), "single"), /用户不存在/);

    const { id: disabledUserId } = await createUser(sql, "disabled");
    await assert.rejects(() => orders.createPaymentOrder(disabledUserId, "single"), /账号已停用/);
  } finally {
    await pg.close();
  }
});

test("same clientRequestId is idempotent and cannot change package", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const counting = createCountingProvider();
    const orders = createPaymentOrdersService(sql, counting.provider);

    const first = await orders.createPaymentOrder(userId, "ten", {
      clientRequestId: "checkout-request-1",
    });
    const second = await orders.createPaymentOrder(userId, "ten", {
      requestId: "checkout-request-1",
    });

    assert.equal(second.id, first.id);
    assert.equal(second.providerOrderId, first.providerOrderId);
    assert.equal(second.clientRequestId, "checkout-request-1");
    assert.equal(second.redirectUrl, first.redirectUrl);
    assert.deepEqual(second.paymentPayload, first.paymentPayload);
    assert.equal(counting.createCalls, 1);

    await assert.rejects(
      () =>
        orders.createPaymentOrder(userId, "single", {
          clientRequestId: "checkout-request-1",
        }),
      /幂等请求参数不一致/,
    );

    const rows = await sql.query<{ count: number }>(
      "select count(*)::int as count from payment_orders",
    );
    assert.equal(rows[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("concurrent retries with one clientRequestId create one local order", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const counting = createCountingProvider();
    const orders = createPaymentOrdersService(sql, counting.provider);

    const results = await Promise.all([
      orders.createPaymentOrder(userId, "thirty", { clientRequestId: "parallel-checkout" }),
      orders.createPaymentOrder(userId, "thirty", { clientRequestId: "parallel-checkout" }),
    ]);

    assert.equal(results[0]?.id, results[1]?.id);
    const rows = await sql.query<{ count: number }>(
      "select count(*)::int as count from payment_orders",
    );
    assert.equal(rows[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("getPaymentOrder is scoped to its owner and markOrderPaid updates once", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const { id: otherUserId } = await createUser(sql);
    const orders = createPaymentOrdersService(sql, createTestPaymentProvider());
    const order = await orders.createPaymentOrder(userId, "single");

    assert.equal((await orders.getPaymentOrder(userId, order.id)).id, order.id);
    await assert.rejects(() => orders.getPaymentOrder(otherUserId, order.id), /订单不存在/);

    const event: PaymentWebhookEvent = {
      provider: "test",
      providerEventId: "event-paid-1",
      providerOrderId: order.providerOrderId!,
      providerTransactionId: "transaction-paid-1",
      status: "paid",
      amountCents: order.amountCents,
      currency: "CNY",
      raw: {},
    };

    await orders.markOrderPaid(order.id, event);
    await orders.markOrderPaid(order.id, event);
    const paid = await orders.getPaymentOrder(userId, order.id);
    assert.equal(paid.status, "paid");
    assert.equal(paid.providerTransactionId, event.providerTransactionId);
    assert.ok(paid.paidAt);
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.id],
    );
    assert.equal(ledger[0]?.count, 0);

    await assert.rejects(
      () => orders.markOrderPaid(order.id, { ...event, amountCents: 1 }),
      /金额不匹配/,
    );
  } finally {
    await pg.close();
  }
});

test("provider registry defaults to test outside production and rejects test in production", () => {
  assert.equal(resolvePaymentProvider({ NODE_ENV: "test" } as NodeJS.ProcessEnv).id, "test");
  assert.throws(
    () =>
      resolvePaymentProvider({
        NODE_ENV: "production",
        PAYMENT_PROVIDER: "test",
      } as NodeJS.ProcessEnv),
    /生产环境禁止使用 test/,
  );
});
