-- 支付服务商创建租约：确保同一订单的并发重试只有一个请求调用外部 provider。
alter table payment_orders add column if not exists provider_creation_token text;
alter table payment_orders add column if not exists provider_creation_started_at timestamptz;
