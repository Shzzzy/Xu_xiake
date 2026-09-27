import { randomUUID } from "node:crypto";
import type { PaymentWebhookEvent } from "./provider.ts";

type Row = Record<string, unknown>;

export type PaymentCreditSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export type ApplyPaidOrderCreditsResult = {
  applied: boolean;
  alreadyApplied: boolean;
};

/**
 * 为已锁定订单补齐支付入账。
 * 调用方必须先锁定 payment_orders 行；purchase 流水是最终幂等依据。
 */
export async function applyPaidOrderCredits(
  tx: PaymentCreditSql,
  order: Row,
  event: PaymentWebhookEvent,
): Promise<ApplyPaidOrderCreditsResult> {
  const orderId = String(order.id);
  const walletId = String(order.wallet_id);
  const points = Number(order.points);

  if (!Number.isInteger(points) || points <= 0) {
    throw new Error("支付订单点数异常");
  }

  const purchaseRows = await tx.query<{ id: string }>(
    `select id from credit_ledger
     where order_id = $1 and reason = 'purchase'
     for update`,
    [orderId],
  );

  if (purchaseRows[0]) {
    // 流水已经存在时只补订单元数据，绝不能再次增加钱包余额。
    await tx.query(
      `update payment_orders
       set status = 'paid',
           provider_transaction_id = coalesce(provider_transaction_id, $2),
           paid_at = coalesce(paid_at, now()),
           credits_applied_at = coalesce(credits_applied_at, now()),
           updated_at = now()
       where id = $1`,
      [orderId, event.providerTransactionId],
    );
    return { applied: false, alreadyApplied: true };
  }

  // 固定顺序：调用方已锁订单，这里再锁钱包，确保余额和流水来自同一快照。
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

  await tx.query(
    `update payment_orders
     set status = 'paid',
         provider_transaction_id = $2,
         paid_at = coalesce(paid_at, now()),
         credits_applied_at = now(),
         updated_at = now()
     where id = $1`,
    [orderId, event.providerTransactionId],
  );

  return { applied: true, alreadyApplied: false };
}
