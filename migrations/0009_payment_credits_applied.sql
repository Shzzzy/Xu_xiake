-- 支付入账标记：订单更新为 paid 后，只有写入 purchase 流水才代表点数已经发放。
alter table payment_orders add column if not exists credits_applied_at timestamptz;

-- 同一订单最多一条 purchase 流水，数据库层阻止重复入账。
create unique index if not exists credit_ledger_purchase_order_unique_idx
  on credit_ledger (order_id)
  where reason = 'purchase' and order_id is not null;
