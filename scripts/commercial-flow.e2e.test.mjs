import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createCreditsService } from "../src/lib/credits.server.ts";
import { createEntitlementsService } from "../src/lib/entitlements.server.ts";
import { createPaymentOrdersService } from "../src/lib/payments/orders.server.ts";
import { createPaymentWebhookService } from "../src/lib/payments/webhook.server.ts";
import { createTestPaymentProvider } from "../src/lib/payments/test-provider.server.ts";
import { createSharesService } from "../src/lib/shares.server.ts";

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
  "0012_generation_entitlement_failure_reason.sql",
  "0013_generation_entitlement_retry.sql",
  "0014_delivery_drafts.sql",
];

function createPlan(title, destination) {
  return {
    meta: {
      title,
      origin: "北京",
      destination,
      days: 2,
      travelers: { adults: 1, children: 0 },
    },
    route: { segments: [] },
    budget: { totalBudget: 5000, estimatedTotal: 4000 },
    days: [],
  };
}

async function createTestSql() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of migrationNames) {
    const migration = await readFile(
      fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
      "utf8",
    );
    await pg.exec(migration);
  }
  const query = async (text, params = []) => (await pg.query(text, params)).rows;
  const transaction = async (fn) =>
    pg.transaction(async (tx) => {
      const txSql = {
        query: async (text, params = []) => (await tx.query(text, params)).rows,
        transaction: (inner) => inner(txSql),
      };
      return fn(txSql);
    });
  return { pg, sql: { query, transaction } };
}

test("商业闭环：首次免费 -> 购买入账 -> 点数消费 -> 分享只读", async () => {
  const { pg, sql } = await createTestSql();
  try {
    const userId = randomUUID();
    const phone = "13800138000";
    await sql.query(
      `insert into "user" (id, name, email, "emailVerified", phone, role, status)
       values ($1, $2, $3, true, $4, 'user', 'active')`,
      [userId, phone, `${phone}@phone.invalid`, phone],
    );

    const entitlements = createEntitlementsService(sql);
    const credits = createCreditsService(sql);
    const freePlanId = "plan-free-1";
    const freePlan = createPlan("第一次旅行", "上海");
    const guest = await entitlements.prepareGuestGeneration({
      planId: freePlanId,
      requestFingerprint: "free-request-1",
      guestBucket: "guest-ip-1",
    });
    assert.equal(guest.kind, "guest");
    if (guest.kind !== "guest") throw new Error("guest entitlement missing");

    await entitlements.authorizeGeneration({
      entitlementToken: guest.token,
      requestFingerprint: "free-request-1",
      userId: null,
      cookieEntitlementId: guest.entitlementId,
    });
    await entitlements.finalizeGuestGeneration({
      token: guest.token,
      requestFingerprint: "free-request-1",
      planId: freePlanId,
      plan: freePlan,
      cookieEntitlementId: guest.entitlementId,
    });
    await entitlements.claimFirstFreePlan({
      userId,
      planId: freePlanId,
      plan: freePlan,
      entitlementToken: guest.token,
      requestFingerprint: "free-request-1",
      cookieEntitlementId: guest.entitlementId,
    });

    const claimedWallet = await credits.getWalletSummary(userId);
    assert.equal(claimedWallet.wallet.freeTrialClaimed, true);
    assert.equal(claimedWallet.wallet.balance, 0);
    assert.ok(await entitlements.getTravelPlan(userId, freePlanId));

    const orders = createPaymentOrdersService(sql, createTestPaymentProvider());
    const order = await orders.createPaymentOrder(userId, "ten", "commercial-e2e-order-1");
    assert.equal(order.points, 10);
    assert.equal(order.amountCents, 941);

    const providerOrderId = order.providerOrderId;
    if (!providerOrderId) throw new Error("test provider order id missing");
    const event = {
      provider: "test",
      providerEventId: "event-commercial-e2e-1",
      providerOrderId,
      providerTransactionId: "transaction-commercial-e2e-1",
      status: "paid",
      amountCents: order.amountCents,
      currency: "CNY",
      raw: { source: "commercial-e2e" },
    };
    const webhook = createPaymentWebhookService(sql);
    await webhook.processPaymentWebhook(event);
    const afterPayment = await credits.getWalletSummary(userId);
    assert.equal(afterPayment.wallet.balance, 10);

    const paidPlanId = "plan-paid-1";
    const paidPlan = createPlan("第二次旅行", "成都");
    await entitlements.saveTravelPlan({ userId, planId: paidPlanId, plan: paidPlan });
    const reservation = await credits.reserveCreditForGeneration(userId, paidPlanId, 30, 0);
    await credits.associateReservationPlan(userId, reservation.id, paidPlanId);
    await credits.consumeReservation(reservation.id, paidPlanId);
    const afterGeneration = await credits.getWalletSummary(userId);
    assert.equal(afterGeneration.wallet.balance, 9);

    await webhook.processPaymentWebhook(event);
    const afterDuplicateCallback = await credits.getWalletSummary(userId);
    assert.equal(afterDuplicateCallback.wallet.balance, 9);

    const shares = createSharesService(sql);
    const share = await shares.createPlanShare(userId, paidPlanId);
    const token = share.url.split("/").pop();
    assert.ok(token);
    const resolved = await shares.resolvePlanShare(token);
    assert.equal(resolved?.plan.meta.title, "第二次旅行");
    assert.equal(JSON.stringify(resolved).includes(phone), false);
  } finally {
    await pg.close();
  }
});
