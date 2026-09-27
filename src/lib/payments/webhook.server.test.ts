import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createPaymentWebhookHandler, createPaymentWebhookService } from "./webhook.server.ts";
import type { PaymentProvider, PaymentWebhookEvent } from "./provider.ts";

const migrationNames = [
  "0001_public_auth.sql",
  "0002_discovered_places.sql",
  "0003_clear_discovered_route_context.sql",
  "0004_commercial_accounts.sql",
  "0005_username_auth.sql",
  "0006_credit_reservation_idempotency.sql",
  "0007_payment_order_idempotency.sql",
  "0008_provider_creation_lease.sql",
  "0009_payment_credits_applied.sql",
  "0010_generation_entitlements.sql",
  "0011_travel_plan_hash.sql",
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

let phoneSequence = 500;
let providerOrderSequence = 0;

async function createPendingOrder(
  sql: TestSql,
  overrides: {
    points?: number;
    amountCents?: number;
    currency?: string;
    provider?: string;
    providerOrderId?: string;
  } = {},
) {
  const userId = randomUUID();
  const walletId = randomUUID();
  const orderId = randomUUID();
  phoneSequence += 1;
  providerOrderSequence += 1;
  const phone = `139${String(20_000_000 + phoneSequence).padStart(8, "0")}`;
  const provider = overrides.provider ?? "test";
  const providerOrderId = overrides.providerOrderId ?? `provider-order-${providerOrderSequence}`;

  await sql.query(
    `insert into "user" (id, name, email, "emailVerified", phone, status)
     values ($1, $2, $3, true, $4, 'active')`,
    [userId, phone, `${phone}@phone.invalid`, phone],
  );
  await sql.query("insert into credit_wallets (id, user_id) values ($1, $2)", [walletId, userId]);
  await sql.query(
    `insert into payment_orders (
       id, user_id, wallet_id, package_code, points, amount_cents, currency,
       provider, provider_order_id, status, expires_at
     ) values ($1, $2, $3, 'ten', $4, $5, $6, $7, $8, 'pending', now() + interval '30 minutes')`,
    [
      orderId,
      userId,
      walletId,
      overrides.points ?? 10,
      overrides.amountCents ?? 941,
      overrides.currency ?? "CNY",
      provider,
      providerOrderId,
    ],
  );

  return { userId, walletId, orderId, provider, providerOrderId };
}

function eventFor(
  order: { provider: string; providerOrderId: string; amountCents?: number },
  overrides: Partial<PaymentWebhookEvent> = {},
): PaymentWebhookEvent {
  return {
    provider: order.provider,
    providerEventId: `event-${randomUUID()}`,
    providerOrderId: order.providerOrderId,
    providerTransactionId: `transaction-${randomUUID()}`,
    status: "paid",
    amountCents: order.amountCents ?? 941,
    currency: "CNY",
    raw: {},
    ...overrides,
  };
}

async function walletBalance(sql: TestSql, walletId: string): Promise<number> {
  const rows = await sql.query<{ balance: number }>(
    "select balance from credit_wallets where id = $1",
    [walletId],
  );
  return Number(rows[0]?.balance ?? -1);
}

test("paid webhook updates order, wallet and purchase ledger atomically", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    const event = eventFor(order);

    const result = await createPaymentWebhookService(sql).processPaymentWebhook(event);

    assert.deepEqual(result, { processed: true });
    assert.equal(await walletBalance(sql, order.walletId), 10);

    const orders = await sql.query<{
      status: string;
      provider_transaction_id: string;
      paid_at: string | null;
    }>(
      `select status, provider_transaction_id, paid_at
         from payment_orders
        where id = $1`,
      [order.orderId],
    );
    assert.equal(orders[0]?.status, "paid");
    assert.equal(orders[0]?.provider_transaction_id, event.providerTransactionId);
    assert.ok(orders[0]?.paid_at);

    const ledger = await sql.query<{
      delta: number;
      balance_after: number;
      reason: string;
      order_id: string;
    }>(
      `select delta, balance_after, reason, order_id
         from credit_ledger
        where order_id = $1`,
      [order.orderId],
    );
    assert.equal(ledger.length, 1);
    assert.equal(Number(ledger[0]?.delta), 10);
    assert.equal(Number(ledger[0]?.balance_after), 10);
    assert.equal(ledger[0]?.reason, "purchase");
    assert.equal(ledger[0]?.order_id, order.orderId);

    const events = await sql.query<{ status: string; processed_at: string | null }>(
      `select status, processed_at
         from payment_events
        where provider = $1 and provider_event_id = $2`,
      [event.provider, event.providerEventId],
    );
    assert.equal(events[0]?.status, "processed");
    assert.ok(events[0]?.processed_at);
  } finally {
    await pg.close();
  }
});

test("duplicate webhook event does not add credits twice", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    const event = eventFor(order);
    const service = createPaymentWebhookService(sql);

    const first = await service.processPaymentWebhook(event);
    const second = await service.processPaymentWebhook(event);

    assert.equal(first.processed, true);
    assert.deepEqual(second, { processed: false, reason: "duplicate_event" });
    assert.equal(await walletBalance(sql, order.walletId), 10);
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(ledger[0]?.count, 1);
    const events = await sql.query<{ count: number }>(
      `select count(*)::int as count
         from payment_events
        where provider = $1 and provider_event_id = $2`,
      [event.provider, event.providerEventId],
    );
    assert.equal(events[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("amount and currency mismatches are rejected without credits", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    const service = createPaymentWebhookService(sql);

    const wrongAmount = eventFor(order, {
      amountCents: 1,
      providerEventId: "wrong-amount-event",
    });
    const wrongCurrency = eventFor(order, {
      currency: "USD",
      providerEventId: "wrong-currency-event",
    });

    assert.deepEqual(await service.processPaymentWebhook(wrongAmount), {
      processed: false,
      reason: "amount_or_currency_mismatch",
      rejected: true,
    });
    assert.deepEqual(await service.processPaymentWebhook(wrongCurrency), {
      processed: false,
      reason: "amount_or_currency_mismatch",
      rejected: true,
    });

    assert.equal(await walletBalance(sql, order.walletId), 0);
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(ledger[0]?.count, 0);
    const orders = await sql.query<{ status: string }>(
      "select status from payment_orders where id = $1",
      [order.orderId],
    );
    assert.equal(orders[0]?.status, "pending");
    const events = await sql.query<{ status: string }>(
      `select status from payment_events
        where provider_event_id in ($1, $2)
        order by provider_event_id`,
      [wrongAmount.providerEventId, wrongCurrency.providerEventId],
    );
    assert.deepEqual(
      events.map((row) => row.status),
      ["rejected_mismatch", "rejected_mismatch"],
    );
  } finally {
    await pg.close();
  }
});

test("unknown provider order is recorded as retryable without credits", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const event: PaymentWebhookEvent = {
      provider: "test",
      providerEventId: "unknown-order-event",
      providerOrderId: "missing-provider-order",
      providerTransactionId: "txn-unknown",
      status: "paid",
      amountCents: 99,
      currency: "CNY",
      raw: {},
    };

    const result = await createPaymentWebhookService(sql).processPaymentWebhook(event);

    assert.deepEqual(result, { processed: false, reason: "unknown_order", retryable: true });
    const events = await sql.query<{ order_id: string | null; status: string }>(
      `select order_id, status from payment_events
        where provider = $1 and provider_event_id = $2`,
      [event.provider, event.providerEventId],
    );
    assert.equal(events[0]?.order_id, null);
    assert.equal(events[0]?.status, "retryable_unknown_order");
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger",
    );
    assert.equal(ledger[0]?.count, 0);
  } finally {
    await pg.close();
  }
});

test("a new webhook for an already paid order does not add credits again", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    const firstEvent = eventFor(order, {
      providerEventId: "already-paid-first",
      providerTransactionId: "already-paid-transaction",
    });
    const secondEvent = eventFor(order, {
      providerEventId: "already-paid-second",
      providerTransactionId: "already-paid-transaction",
    });
    const service = createPaymentWebhookService(sql);

    assert.equal((await service.processPaymentWebhook(firstEvent)).processed, true);
    assert.deepEqual(await service.processPaymentWebhook(secondEvent), {
      processed: false,
      reason: "already_paid",
    });

    assert.equal(await walletBalance(sql, order.walletId), 10);
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(ledger[0]?.count, 1);
    const events = await sql.query<{ status: string }>(
      "select status from payment_events where provider_event_id = $1",
      [secondEvent.providerEventId],
    );
    assert.equal(events[0]?.status, "duplicate_paid");
  } finally {
    await pg.close();
  }
});

test("concurrent duplicate webhook events produce one credit and one ledger entry", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    const event = eventFor(order, { providerEventId: "concurrent-event" });
    const service = createPaymentWebhookService(sql);

    const results = await Promise.all([
      service.processPaymentWebhook(event),
      service.processPaymentWebhook(event),
    ]);

    assert.deepEqual(results.map((result) => result.processed).sort(), [false, true]);
    assert.equal(await walletBalance(sql, order.walletId), 10);
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(ledger[0]?.count, 1);
    const events = await sql.query<{ count: number }>(
      `select count(*)::int as count from payment_events
        where provider = $1 and provider_event_id = $2`,
      [event.provider, event.providerEventId],
    );
    assert.equal(events[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("failed and refunded events are preserved but explicitly not processed", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    const service = createPaymentWebhookService(sql);

    for (const status of ["failed", "refunded"] as const) {
      const event = eventFor(order, {
        status,
        providerEventId: `${status}-event`,
      });
      const result = await service.processPaymentWebhook(event);
      assert.deepEqual(result, {
        processed: false,
        reason: "unsupported_status",
        rejected: true,
      });
    }

    assert.equal(await walletBalance(sql, order.walletId), 0);
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(ledger[0]?.count, 0);
    const events = await sql.query<{ status: string }>(
      `select status from payment_events
        where provider_event_id in ('failed-event', 'refunded-event')
        order by provider_event_id`,
    );
    assert.deepEqual(
      events.map((row) => row.status),
      ["unsupported_failed", "unsupported_refunded"],
    );
  } finally {
    await pg.close();
  }
});

test("webhook handler rejects verification failures before processing", async () => {
  let verifyCalls = 0;
  let processCalls = 0;
  const provider: PaymentProvider = {
    id: "test",
    async createPayment() {
      throw new Error("unused");
    },
    async verifyWebhook() {
      verifyCalls += 1;
      throw new Error("invalid signature");
    },
  };
  const handler = createPaymentWebhookHandler({
    provider,
    processEvent: async () => {
      processCalls += 1;
      return { processed: true };
    },
  });

  const response = await handler(
    new Request("https://example.com/api/payments/webhook", {
      method: "POST",
      body: "{}",
    }),
  );

  assert.equal(response.status, 401);
  assert.equal(verifyCalls, 1);
  assert.equal(processCalls, 0);
  assert.deepEqual(await response.json(), { ok: false, error: "invalid_webhook" });
});

test("webhook handler verifies then processes a valid event", async () => {
  const event: PaymentWebhookEvent = {
    provider: "test",
    providerEventId: "route-valid-event",
    providerOrderId: "route-provider-order",
    providerTransactionId: "route-transaction",
    status: "paid",
    amountCents: 99,
    currency: "CNY",
    raw: {},
  };
  let seenEvent: PaymentWebhookEvent | null = null;
  const provider: PaymentProvider = {
    id: "test",
    async createPayment() {
      throw new Error("unused");
    },
    async verifyWebhook() {
      return event;
    },
  };
  const handler = createPaymentWebhookHandler({
    provider,
    processEvent: async (input) => {
      seenEvent = input;
      return { processed: true };
    },
  });

  const response = await handler(
    new Request("https://example.com/api/payments/webhook", {
      method: "POST",
      body: "{}",
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(seenEvent, event);
  assert.deepEqual(await response.json(), { ok: true, processed: true });
});

test("provider mismatch is recorded as retryable without credits", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    const event = eventFor(order, {
      provider: "other",
      providerEventId: "provider-mismatch-event",
    });

    const result = await createPaymentWebhookService(sql).processPaymentWebhook(event);

    assert.deepEqual(result, { processed: false, reason: "unknown_order", retryable: true });
    assert.equal(await walletBalance(sql, order.walletId), 0);
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(ledger[0]?.count, 0);
    const events = await sql.query<{ order_id: string | null; status: string }>(
      `select order_id, status from payment_events
        where provider = $1 and provider_event_id = $2`,
      [event.provider, event.providerEventId],
    );
    assert.equal(events[0]?.order_id, null);
    assert.equal(events[0]?.status, "retryable_unknown_order");
  } finally {
    await pg.close();
  }
});

test("webhook handler returns 422 for unsupported payment event statuses", async () => {
  const event: PaymentWebhookEvent = {
    provider: "test",
    providerEventId: "route-unsupported-event",
    providerOrderId: "route-provider-order",
    providerTransactionId: "route-transaction",
    status: "refunded",
    amountCents: 99,
    currency: "CNY",
    raw: {},
  };
  const provider: PaymentProvider = {
    id: "test",
    async createPayment() {
      throw new Error("unused");
    },
    async verifyWebhook() {
      return event;
    },
  };
  const handler = createPaymentWebhookHandler({
    provider,
    processEvent: async () => ({
      processed: false,
      reason: "unsupported_status",
      rejected: true,
    }),
  });

  const response = await handler(
    new Request("https://example.com/api/payments/webhook", {
      method: "POST",
      body: "{}",
    }),
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false,
    processed: false,
    reason: "unsupported_status",
    rejected: true,
  });
});

test("paid order without credits is repaired exactly once by webhook", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    await sql.query(
      `update payment_orders
       set status = 'paid',
           provider_transaction_id = $2,
           paid_at = now(),
           credits_applied_at = null
       where id = $1`,
      [order.orderId, "legacy-paid-transaction"],
    );

    const event = eventFor(order, {
      providerEventId: "repair-missing-credits",
      providerTransactionId: "legacy-paid-transaction",
    });
    const service = createPaymentWebhookService(sql);

    assert.deepEqual(await service.processPaymentWebhook(event), { processed: true });
    assert.equal(await walletBalance(sql, order.walletId), 10);

    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(ledger[0]?.count, 1);

    const orders = await sql.query<{ credits_applied_at: string | null }>(
      "select credits_applied_at from payment_orders where id = $1",
      [order.orderId],
    );
    assert.ok(orders[0]?.credits_applied_at);

    assert.deepEqual(await service.processPaymentWebhook(event), {
      processed: false,
      reason: "duplicate_event",
    });
    assert.equal(await walletBalance(sql, order.walletId), 10);
    const repeatedLedger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(repeatedLedger[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("unknown order event is retried and processed after the order appears", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const event: PaymentWebhookEvent = {
      provider: "test",
      providerEventId: "late-order-event",
      providerOrderId: "late-order-provider-id",
      providerTransactionId: "late-order-transaction",
      status: "paid",
      amountCents: 941,
      currency: "CNY",
      raw: {},
    };
    const service = createPaymentWebhookService(sql);

    assert.deepEqual(await service.processPaymentWebhook(event), {
      processed: false,
      reason: "unknown_order",
      retryable: true,
    });

    const firstEvents = await sql.query<{ status: string; processed_at: string | null }>(
      `select status, processed_at from payment_events
        where provider = $1 and provider_event_id = $2`,
      [event.provider, event.providerEventId],
    );
    assert.equal(firstEvents[0]?.status, "retryable_unknown_order");
    assert.equal(firstEvents[0]?.processed_at, null);

    const order = await createPendingOrder(sql, { providerOrderId: event.providerOrderId });
    assert.deepEqual(await service.processPaymentWebhook(event), { processed: true });
    assert.equal(await walletBalance(sql, order.walletId), 10);

    const finalEvents = await sql.query<{ status: string; order_id: string | null }>(
      `select status, order_id from payment_events
        where provider = $1 and provider_event_id = $2`,
      [event.provider, event.providerEventId],
    );
    assert.equal(finalEvents[0]?.status, "processed");
    assert.equal(finalEvents[0]?.order_id, order.orderId);
  } finally {
    await pg.close();
  }
});

test("two different concurrent events for one order credit only once", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    const firstEvent = eventFor(order, {
      providerEventId: "same-order-event-1",
      providerTransactionId: "same-order-transaction",
    });
    const secondEvent = eventFor(order, {
      providerEventId: "same-order-event-2",
      providerTransactionId: "same-order-transaction",
    });
    const service = createPaymentWebhookService(sql);

    const results = await Promise.all([
      service.processPaymentWebhook(firstEvent),
      service.processPaymentWebhook(secondEvent),
    ]);

    assert.equal(results.filter((result) => result.processed).length, 1);
    assert.equal(await walletBalance(sql, order.walletId), 10);
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(ledger[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("refunded event arriving before paid prevents later credit application", async () => {
  const { pg, sql } = await createTestContext();
  try {
    const order = await createPendingOrder(sql);
    const refunded = eventFor(order, {
      status: "refunded",
      providerEventId: "refund-first",
    });
    const paid = eventFor(order, {
      providerEventId: "paid-after-refund",
      providerTransactionId: "paid-after-refund-transaction",
    });
    const service = createPaymentWebhookService(sql);

    assert.deepEqual(await service.processPaymentWebhook(refunded), {
      processed: false,
      reason: "unsupported_status",
      rejected: true,
    });
    assert.deepEqual(await service.processPaymentWebhook(paid), {
      processed: false,
      reason: "refunded_before_paid",
      rejected: true,
    });

    assert.equal(await walletBalance(sql, order.walletId), 0);
    const ledger = await sql.query<{ count: number }>(
      "select count(*)::int as count from credit_ledger where order_id = $1",
      [order.orderId],
    );
    assert.equal(ledger[0]?.count, 0);
    const events = await sql.query<{ status: string }>(
      "select status from payment_events where provider_event_id = $1",
      [paid.providerEventId],
    );
    assert.equal(events[0]?.status, "rejected_refunded_before_paid");
  } finally {
    await pg.close();
  }
});

test("webhook handler rejects provider id mismatches before processing", async () => {
  let processCalls = 0;
  const event: PaymentWebhookEvent = {
    provider: "other",
    providerEventId: "provider-id-mismatch",
    providerOrderId: "provider-id-mismatch-order",
    providerTransactionId: "provider-id-mismatch-transaction",
    status: "paid",
    amountCents: 99,
    currency: "CNY",
    raw: {},
  };
  const provider: PaymentProvider = {
    id: "test",
    async createPayment() {
      throw new Error("unused");
    },
    async verifyWebhook() {
      return event;
    },
  };
  const handler = createPaymentWebhookHandler({
    provider,
    processEvent: async () => {
      processCalls += 1;
      return { processed: true };
    },
  });

  const response = await handler(
    new Request("https://example.com/api/payments/webhook", {
      method: "POST",
      body: "{}",
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(processCalls, 0);
  assert.deepEqual(await response.json(), { ok: false, error: "provider_mismatch" });
});

test("webhook handler returns 503 for retryable unknown orders", async () => {
  const event: PaymentWebhookEvent = {
    provider: "test",
    providerEventId: "route-unknown-order",
    providerOrderId: "route-unknown-order-provider",
    providerTransactionId: "route-unknown-order-transaction",
    status: "paid",
    amountCents: 99,
    currency: "CNY",
    raw: {},
  };
  const provider: PaymentProvider = {
    id: "test",
    async createPayment() {
      throw new Error("unused");
    },
    async verifyWebhook() {
      return event;
    },
  };
  const handler = createPaymentWebhookHandler({
    provider,
    processEvent: async () => ({
      processed: false,
      reason: "unknown_order",
      retryable: true,
    }),
  });

  const response = await handler(
    new Request("https://example.com/api/payments/webhook", {
      method: "POST",
      body: "{}",
    }),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    processed: false,
    reason: "unknown_order",
    retryable: true,
  });
});

test("webhook handler returns 409 for amount mismatches", async () => {
  const event: PaymentWebhookEvent = {
    provider: "test",
    providerEventId: "route-amount-mismatch",
    providerOrderId: "route-amount-mismatch-provider",
    providerTransactionId: "route-amount-mismatch-transaction",
    status: "paid",
    amountCents: 98,
    currency: "CNY",
    raw: {},
  };
  const provider: PaymentProvider = {
    id: "test",
    async createPayment() {
      throw new Error("unused");
    },
    async verifyWebhook() {
      return event;
    },
  };
  const handler = createPaymentWebhookHandler({
    provider,
    processEvent: async () => ({
      processed: false,
      reason: "amount_or_currency_mismatch",
      rejected: true,
    }),
  });

  const response = await handler(
    new Request("https://example.com/api/payments/webhook", {
      method: "POST",
      body: "{}",
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    processed: false,
    reason: "amount_or_currency_mismatch",
    rejected: true,
  });
});
