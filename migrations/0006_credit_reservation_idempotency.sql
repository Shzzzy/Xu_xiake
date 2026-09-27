-- 同一钱包下的同一行程只能保留一条预留记录，
-- 防止客户端重试或并发请求重复预留和重复扣点。
create unique index if not exists credit_reservations_wallet_plan_unique_idx
  on credit_reservations (wallet_id, plan_id)
  where plan_id is not null;