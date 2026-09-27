-- 支付订单幂等与支付跳转数据：支持客户端稳定 requestId 重试，并保存支付服务商返回内容。
alter table payment_orders add column if not exists client_request_id text;
alter table payment_orders add column if not exists provider_redirect_url text;
alter table payment_orders add column if not exists provider_payload jsonb not null default '{}'::jsonb;

create unique index if not exists payment_orders_user_client_request_unique_idx
  on payment_orders (user_id, client_request_id)
  where client_request_id is not null;
