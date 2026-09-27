import { randomUUID } from "node:crypto";
import type { PaymentProvider, PaymentWebhookEvent } from "./provider.ts";

type Row = Record<string, unknown>;

export type PaymentWebhookSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: PaymentWebhookSql) => Promise<T>): Promise<T>;
};

export type PaymentWebhookReason =
  | "duplicate_event"
  | "unknown_order"
  | "amount_or_currency_mismatch"
  | "already_paid"
  | "order_status_conflict"
  | "duplicate_transaction"
  | "unsupported_status";

export type PaymentWebhookResult = {
  processed: boolean;
  reason?: PaymentWebhookReason;
  rejected?: true;
};

export type PaymentWebhookService = {
  processPaymentWebhook(event: PaymentWebhookEvent): Promise<PaymentWebhookResult>;
};

export type PaymentWebhookHandlerDependencies = {
  provider: Pick<PaymentProvider, "verifyWebhook">;
  processEvent?: (event: PaymentWebhookEvent) => Promise<PaymentWebhookResult>;
};

async function updateEventStatus(
  tx: PaymentWebhookSql,
  eventId: string,
  status: string,
  orderId?: string | null,
): Promise<void> {
  if (orderId === undefined) {
    await tx.query(
      `update payment_events
       set status = $2, processed_at = now()
       where id = $1`,
      [eventId, status],
    );
    return;
  }

  await tx.query(
    `update payment_events
     set order_id = $3, status = $2, processed_at = now()
     where id = $1`,
    [eventId, status, orderId],
  );
}

/**
 * 使用注入的 Sql.query()/transaction() 构造支付回调服务。
 * 生产入口注入 getSql()，测试注入真实 PGlite，二者执行同一套事务逻辑。
 */
export function createPaymentWebhookService(sql: PaymentWebhookSql): PaymentWebhookService {
  async function processPaymentWebhook(event: PaymentWebhookEvent): Promise<PaymentWebhookResult> {
    return sql.transaction(async (tx) => {
      const eventId = randomUUID();
      const insertedEvents = await tx.query<{ id: string }>(
        `insert into payment_events (id, provider, provider_event_id, order_id, payload, status)
         values ($1, $2, $3, null, $4::jsonb, 'received')
         on conflict (provider, provider_event_id) do nothing
         returning id`,
        [eventId, event.provider, event.providerEventId, JSON.stringify(event.raw)],
      );
      const insertedEventId = insertedEvents[0]?.id;
      if (!insertedEventId) return { processed: false, reason: "duplicate_event" };

      // failed/refunded 已超出本任务范围：保留事件并明确拒绝，不触碰订单和钱包。
      if (event.status !== "paid") {
        const relatedOrders = await tx.query<{ id: string }>(
          `select id from payment_orders
           where provider = $1 and provider_order_id = $2
           limit 1`,
          [event.provider, event.providerOrderId],
        );
        await updateEventStatus(tx, insertedEventId, "unsupported", relatedOrders[0]?.id ?? null);
        return { processed: false, reason: "unsupported_status", rejected: true };
      }

      const orderRows = await tx.query<Row>(
        `select * from payment_orders
         where provider = $1 and provider_order_id = $2
         for update`,
        [event.provider, event.providerOrderId],
      );
      const order = orderRows[0];
      if (!order) {
        await updateEventStatus(tx, insertedEventId, "rejected_unknown_order");
        return { processed: false, reason: "unknown_order" };
      }

      const orderId = String(order.id);
      await tx.query("update payment_events set order_id = $2 where id = $1", [
        insertedEventId,
        orderId,
      ]);

      if (
        String(order.provider) !== event.provider ||
        String(order.provider_order_id) !== event.providerOrderId
      ) {
        await updateEventStatus(tx, insertedEventId, "rejected_order", orderId);
        return { processed: false, reason: "unknown_order" };
      }

      if (
        Number(order.amount_cents) !== event.amountCents ||
        String(order.currency) !== event.currency
      ) {
        await updateEventStatus(tx, insertedEventId, "rejected_mismatch", orderId);
        return { processed: false, reason: "amount_or_currency_mismatch" };
      }

      const orderStatus = String(order.status);
      if (orderStatus === "paid") {
        const sameTransaction =
          order.provider_transaction_id != null &&
          String(order.provider_transaction_id) === event.providerTransactionId;
        await updateEventStatus(
          tx,
          insertedEventId,
          sameTransaction ? "duplicate_paid" : "rejected_paid_conflict",
          orderId,
        );
        return { processed: false, reason: "already_paid" };
      }

      if (!["created", "pending"].includes(orderStatus)) {
        await updateEventStatus(tx, insertedEventId, "rejected_order_status", orderId);
        return { processed: false, reason: "order_status_conflict" };
      }

      const transactionConflict = await tx.query<{ id: string }>(
        `select id from payment_orders
         where provider = $1
           and provider_transaction_id = $2
           and id <> $3
         limit 1`,
        [event.provider, event.providerTransactionId, orderId],
      );
      if (transactionConflict[0]) {
        await updateEventStatus(tx, insertedEventId, "rejected_duplicate_transaction", orderId);
        return { processed: false, reason: "duplicate_transaction" };
      }

      const walletId = String(order.wallet_id);
      const points = Number(order.points);
      if (!Number.isInteger(points) || points <= 0) {
        throw new Error("支付订单点数异常");
      }

      // 固定顺序：先锁订单，再锁钱包；加点与流水必须依赖同一个钱包余额快照。
      const wallets = await tx.query<Row>("select * from credit_wallets where id = $1 for update", [
        walletId,
      ]);
      if (!wallets[0]) throw new Error("支付订单关联钱包不存在");

      const walletUpdates = await tx.query<{ balance: number }>(
        `update credit_wallets
         set balance = balance + $2,
             version = version + 1,
             updated_at = now()
         where id = $1
         returning balance`,
        [walletId, points],
      );
      const balanceAfter = Number(walletUpdates[0]?.balance);
      if (!Number.isFinite(balanceAfter)) throw new Error("钱包加点失败");

      await tx.query(
        `insert into credit_ledger (
           id, wallet_id, delta, balance_after, reason, order_id, note
         ) values ($1, $2, $3, $4, 'purchase', $5, '购买点数')`,
        [randomUUID(), walletId, points, balanceAfter, orderId],
      );

      const orderUpdates = await tx.query<{ id: string }>(
        `update payment_orders
         set status = 'paid',
             provider_transaction_id = $2,
             paid_at = now(),
             updated_at = now()
         where id = $1 and status in ('created', 'pending')
         returning id`,
        [orderId, event.providerTransactionId],
      );
      if (!orderUpdates[0]) throw new Error("支付订单状态更新失败");

      await updateEventStatus(tx, insertedEventId, "processed", orderId);
      return { processed: true };
    });
  }

  return { processPaymentWebhook };
}

let defaultServicePromise: Promise<PaymentWebhookService> | null = null;

async function getDefaultService(): Promise<PaymentWebhookService> {
  defaultServicePromise ??= (async () => {
    const { getSql } = await import("../db.ts");
    return createPaymentWebhookService(await getSql());
  })().catch((error) => {
    defaultServicePromise = null;
    throw error;
  });
  return defaultServicePromise;
}

/** 生产入口：使用共享 SQL 客户端处理回调。 */
export async function processPaymentWebhook(
  event: PaymentWebhookEvent,
): Promise<PaymentWebhookResult> {
  return (await getDefaultService()).processPaymentWebhook(event);
}

/**
 * 构造 webhook 路由处理函数。
 * 验签失败必须在任何数据库写入前返回非 2xx。
 */
export function createPaymentWebhookHandler({
  provider,
  processEvent = processPaymentWebhook,
}: PaymentWebhookHandlerDependencies): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let event: PaymentWebhookEvent;
    try {
      event = await provider.verifyWebhook(request);
    } catch (error) {
      console.error(
        "[payments] webhook verification failed:",
        error instanceof Error ? error.message : error,
      );
      return Response.json({ ok: false, error: "invalid_webhook" }, { status: 401 });
    }

    try {
      const result = await processEvent(event);
      if (result.reason === "unsupported_status") {
        return Response.json({ ok: false, ...result }, { status: 422 });
      }
      return Response.json({ ok: true, ...result });
    } catch (error) {
      console.error(
        "[payments] webhook processing failed:",
        error instanceof Error ? error.message : error,
      );
      return Response.json({ ok: false, error: "webhook_processing_failed" }, { status: 500 });
    }
  };
}
