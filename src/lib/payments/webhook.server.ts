import { randomUUID } from "node:crypto";
import { applyPaidOrderCredits } from "./credit-application.server.ts";
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
  | "paid_transaction_conflict"
  | "order_status_conflict"
  | "duplicate_transaction"
  | "refunded_before_paid"
  | "unsupported_status";

export type PaymentWebhookResult = {
  processed: boolean;
  reason?: PaymentWebhookReason;
  retryable?: true;
  rejected?: true;
};

export type PaymentWebhookService = {
  processPaymentWebhook(event: PaymentWebhookEvent): Promise<PaymentWebhookResult>;
};

export type PaymentWebhookHandlerDependencies = {
  provider: Pick<PaymentProvider, "id" | "verifyWebhook">;
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

async function markEventRetryable(
  tx: PaymentWebhookSql,
  eventId: string,
  orderId: string | null = null,
): Promise<void> {
  await tx.query(
    `update payment_events
     set order_id = $3, status = $2, processed_at = null
     where id = $1`,
    [eventId, "retryable_unknown_order", orderId],
  );
}

/** 已有事件状态决定重试是继续处理，还是返回稳定的终态结果。 */
function resultForExistingEvent(status: string): PaymentWebhookResult | null {
  if (
    status === "received" ||
    status === "retryable_unknown_order" ||
    status === "rejected_unknown_order" ||
    status === "rejected_order"
  ) {
    return null;
  }

  if (status === "processed") return { processed: false, reason: "duplicate_event" };
  if (status === "duplicate_paid") return { processed: false, reason: "already_paid" };
  if (status === "rejected_mismatch") {
    return { processed: false, reason: "amount_or_currency_mismatch", rejected: true };
  }
  if (status === "rejected_duplicate_transaction") {
    return { processed: false, reason: "duplicate_transaction", rejected: true };
  }
  if (status === "rejected_order_status") {
    return { processed: false, reason: "order_status_conflict", rejected: true };
  }
  if (status === "rejected_paid_conflict") {
    return { processed: false, reason: "paid_transaction_conflict", rejected: true };
  }
  if (status === "rejected_refunded_before_paid") {
    return { processed: false, reason: "refunded_before_paid", rejected: true };
  }
  if (
    status === "unsupported" ||
    status === "unsupported_failed" ||
    status === "unsupported_refunded"
  ) {
    return { processed: false, reason: "unsupported_status", rejected: true };
  }

  return { processed: false, reason: "duplicate_event" };
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

      let eventRowId = insertedEvents[0]?.id;
      if (!eventRowId) {
        // 同一事件重试时，只有可重试状态才允许继续处理。
        const existingRows = await tx.query<{ id: string; status: string }>(
          `select id, status from payment_events
           where provider = $1 and provider_event_id = $2
           for update`,
          [event.provider, event.providerEventId],
        );
        const existing = existingRows[0];
        if (!existing) throw new Error("支付事件幂等记录不存在");
        const existingResult = resultForExistingEvent(String(existing.status));
        if (existingResult) return existingResult;
        eventRowId = existing.id;
      }

      const orderRows = await tx.query<Row>(
        `select * from payment_orders
         where provider = $1 and provider_order_id = $2
         for update`,
        [event.provider, event.providerOrderId],
      );
      const order = orderRows[0];

      // failed/refunded 已超出本任务范围：保留事件并明确拒绝，不发放点数。
      if (event.status !== "paid") {
        const status = event.status === "refunded" ? "unsupported_refunded" : "unsupported_failed";
        await updateEventStatus(tx, eventRowId, status, order ? String(order.id) : null);
        return { processed: false, reason: "unsupported_status", rejected: true };
      }

      if (!order) {
        // 未知订单不能在首次事件记录后永久吞掉；保留可重试审计状态。
        await markEventRetryable(tx, eventRowId);
        return { processed: false, reason: "unknown_order", retryable: true };
      }

      const orderId = String(order.id);
      await tx.query("update payment_events set order_id = $2 where id = $1", [
        eventRowId,
        orderId,
      ]);

      if (
        String(order.provider) !== event.provider ||
        String(order.provider_order_id) !== event.providerOrderId
      ) {
        await markEventRetryable(tx, eventRowId);
        return { processed: false, reason: "unknown_order", retryable: true };
      }

      if (
        Number(order.amount_cents) !== event.amountCents ||
        String(order.currency) !== event.currency
      ) {
        await updateEventStatus(tx, eventRowId, "rejected_mismatch", orderId);
        return { processed: false, reason: "amount_or_currency_mismatch", rejected: true };
      }

      const orderStatus = String(order.status);
      if (orderStatus === "paid") {
        const sameTransaction =
          order.provider_transaction_id == null ||
          String(order.provider_transaction_id) === event.providerTransactionId;
        if (!sameTransaction) {
          await updateEventStatus(tx, eventRowId, "rejected_paid_conflict", orderId);
          return { processed: false, reason: "paid_transaction_conflict", rejected: true };
        }
      } else if (!["created", "pending"].includes(orderStatus)) {
        await updateEventStatus(tx, eventRowId, "rejected_order_status", orderId);
        return { processed: false, reason: "order_status_conflict", rejected: true };
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
        await updateEventStatus(tx, eventRowId, "rejected_duplicate_transaction", orderId);
        return { processed: false, reason: "duplicate_transaction", rejected: true };
      }

      const requiresRepair = order.credits_applied_at == null;
      const creditResult = await applyPaidOrderCredits(tx, order, event);
      if (creditResult.blockedByRefund) {
        await updateEventStatus(tx, eventRowId, "rejected_refunded_before_paid", orderId);
        return { processed: false, reason: "refunded_before_paid", rejected: true };
      }
      if (creditResult.applied || requiresRepair) {
        await updateEventStatus(tx, eventRowId, "processed", orderId);
        return { processed: creditResult.applied };
      }

      await updateEventStatus(tx, eventRowId, "duplicate_paid", orderId);
      return { processed: false, reason: "already_paid" };
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

    if (event.provider !== provider.id) {
      return Response.json({ ok: false, error: "provider_mismatch" }, { status: 400 });
    }

    try {
      const result = await processEvent(event);
      if (result.retryable) {
        return Response.json({ ok: false, ...result }, { status: 503 });
      }
      if (result.rejected) {
        const status = result.reason === "unsupported_status" ? 422 : 409;
        return Response.json({ ok: false, ...result }, { status });
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
