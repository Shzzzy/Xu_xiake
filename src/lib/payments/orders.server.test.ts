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
  "0008_provider_creation_lease.sql",
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

type CountingProviderOptions = {
  failFirst?: boolean;
  delayMs?: number;
  providerId?: string;
  providerOrderId?: (orderId: string) => string;
};

function createCountingProvider(options: CountingProviderOptions = {}) {
  let createCalls = 0;
  let remainingFailures = options.failFirst ? 1 : 0;
  const provider: PaymentProvider = {
    id: "test",
    async createPayment(input): Promise<CreatedPayment> {
      createCalls += 1;
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("provider 暂时失败");
      }
      return {
        provider: options.providerId ?? "test",
        providerOrderId: options.providerOrderId?.(input.orderId) ?? `test-${input.orderId}`,
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

async function readOrderLease(sql: TestSql, orderId: string) {
  const rows = await sql.query<{
    provider_creation_token: string | null;
    provider_creation_started_at: string | null;
    provider_order_id: string | null;
  }>(
    `select provider_creation_token, provider_creation_started_at, provider_order_id
       from payment_orders
      where id = $1`,
    [orderId],
  );
  return rows[0];
}

test("createPaymentOrder reads catalog price and persists the order", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const counting = createCountingProvider();
    const orders = createPaymentOrdersService(sql, counting.provider);

    const order = await orders.createPaymentOrder(userId, "ten", "catalog-request");

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

test("createPaymentOrder requires a non-empty clientRequestId", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const orders = createPaymentOrdersService(sql, createTestPaymentProvider());

    await assert.rejects(() => orders.createPaymentOrder(userId, "single", ""), /clientRequestId/);

    const callWithoutRequestId = orders.createPaymentOrder as unknown as (
      userId: string,
      packageCode: "single",
    ) => Promise<unknown>;
    await assert.rejects(() => callWithoutRequestId(userId, "single"), /clientRequestId/);
  } finally {
    await pg.close();
  }
});

test("createPaymentOrder rejects missing and disabled accounts", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const orders = createPaymentOrdersService(sql, createTestPaymentProvider());

    await assert.rejects(
      () => orders.createPaymentOrder(randomUUID(), "single", "missing-account"),
      /用户不存在/,
    );

    const { id: disabledUserId } = await createUser(sql, "disabled");
    await assert.rejects(
      () => orders.createPaymentOrder(disabledUserId, "single", "disabled-account"),
      /账号已停用/,
    );
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

    const first = await orders.createPaymentOrder(userId, "ten", "checkout-request-1");
    const second = await orders.createPaymentOrder(userId, "ten", "checkout-request-1");

    assert.equal(second.id, first.id);
    assert.equal(second.providerOrderId, first.providerOrderId);
    assert.equal(second.clientRequestId, "checkout-request-1");
    assert.equal(second.redirectUrl, first.redirectUrl);
    assert.deepEqual(second.paymentPayload, first.paymentPayload);
    assert.equal(counting.createCalls, 1);

    await assert.rejects(
      () => orders.createPaymentOrder(userId, "single", "checkout-request-1"),
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

test("concurrent retries with one clientRequestId call provider at most once", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const counting = createCountingProvider({ delayMs: 30 });
    const orders = createPaymentOrdersService(sql, counting.provider);

    const results = await Promise.all([
      orders.createPaymentOrder(userId, "thirty", "parallel-checkout"),
      orders.createPaymentOrder(userId, "thirty", "parallel-checkout"),
    ]);

    assert.equal(results[0]?.id, results[1]?.id);
    assert.equal(counting.createCalls, 1, "同一幂等请求并发时 provider 只能调用一次");
    const rows = await sql.query<{ count: number }>(
      "select count(*)::int as count from payment_orders",
    );
    assert.equal(rows[0]?.count, 1);
    const finalOrder = await orders.getPaymentOrder(userId, results[0]!.id);
    assert.equal(finalOrder.providerOrderId, `test-${finalOrder.id}`);
  } finally {
    await pg.close();
  }
});

test("provider failure clears the lease and allows a retry", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const counting = createCountingProvider({ failFirst: true });
    const orders = createPaymentOrdersService(sql, counting.provider);

    await assert.rejects(
      () => orders.createPaymentOrder(userId, "single", "retry-request"),
      /provider 暂时失败/,
    );

    const orderRows = await sql.query<{ id: string }>("select id from payment_orders");
    const failedOrderId = orderRows[0]!.id;
    const failedLease = await readOrderLease(sql, failedOrderId);
    assert.equal(failedLease?.provider_creation_token, null);
    assert.equal(failedLease?.provider_creation_started_at, null);
    assert.equal(failedLease?.provider_order_id, null);

    const retried = await orders.createPaymentOrder(userId, "single", "retry-request");
    assert.equal(retried.id, failedOrderId);
    assert.equal(retried.providerOrderId, `test-${retried.id}`);
    assert.equal(counting.createCalls, 2);
    assert.equal((await readOrderLease(sql, retried.id))?.provider_creation_token, null);
  } finally {
    await pg.close();
  }
});

test("invalid provider output clears the lease without writing a provider order id", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const counting = createCountingProvider({ providerId: "other-provider" });
    const orders = createPaymentOrdersService(sql, counting.provider);

    await assert.rejects(
      () => orders.createPaymentOrder(userId, "single", "invalid-provider-output"),
      /provider 标识不一致/,
    );

    const rows = await sql.query<{ id: string }>("select id from payment_orders");
    const order = await readOrderLease(sql, rows[0]!.id);
    assert.equal(order?.provider_creation_token, null);
    assert.equal(order?.provider_order_id, null);
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
    const order = await orders.createPaymentOrder(userId, "single", "paid-request");

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
    await assert.rejects(
      () => orders.markOrderPaid(order.id, { ...event, providerOrderId: "wrong-provider-order" }),
      /订单号不匹配/,
    );
  } finally {
    await pg.close();
  }
});

test("markOrderPaid rejects duplicate provider transaction ids", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const { id: userId } = await createUser(sql);
    const orders = createPaymentOrdersService(sql, createTestPaymentProvider());
    const first = await orders.createPaymentOrder(userId, "single", "duplicate-transaction-1");
    const second = await orders.createPaymentOrder(userId, "single", "duplicate-transaction-2");
    const transactionId = "duplicate-transaction-id";

    await orders.markOrderPaid(first.id, {
      provider: "test",
      providerEventId: "event-duplicate-1",
      providerOrderId: first.providerOrderId!,
      providerTransactionId: transactionId,
      status: "paid",
      amountCents: first.amountCents,
      currency: "CNY",
      raw: {},
    });

    await assert.rejects(
      () =>
        orders.markOrderPaid(second.id, {
          provider: "test",
          providerEventId: "event-duplicate-2",
          providerOrderId: second.providerOrderId!,
          providerTransactionId: transactionId,
          status: "paid",
          amountCents: second.amountCents,
          currency: "CNY",
          raw: {},
        }),
      /duplicate|unique constraint/i,
    );
    assert.equal((await orders.getPaymentOrder(userId, second.id)).status, "created");
  } finally {
    await pg.close();
  }
});

test("provider registry fails closed unless NODE_ENV is test or development", () => {
  assert.equal(resolvePaymentProvider({ NODE_ENV: "test" } as NodeJS.ProcessEnv).id, "test");
  assert.equal(resolvePaymentProvider({ NODE_ENV: "development" } as NodeJS.ProcessEnv).id, "test");
  assert.throws(() => resolvePaymentProvider({} as NodeJS.ProcessEnv), /NODE_ENV/);
  assert.throws(
    () => resolvePaymentProvider({ NODE_ENV: "staging" } as NodeJS.ProcessEnv),
    /NODE_ENV/,
  );
  assert.throws(
    () => resolvePaymentProvider({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    /PAYMENT_PROVIDER/,
  );
  assert.throws(
    () =>
      resolvePaymentProvider({
        NODE_ENV: "production",
        PAYMENT_PROVIDER: "test",
      } as NodeJS.ProcessEnv),
    /生产环境禁止使用 test/,
  );
});
