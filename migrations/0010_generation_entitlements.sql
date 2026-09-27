-- 一次性生成权益凭证：原始 token 只返回客户端，数据库只保存哈希。
create table if not exists generation_entitlements (
  id text primary key,
  token_hash text not null unique,
  user_id text references "user" ("id") on delete cascade,
  request_fingerprint text not null,
  kind text not null check (kind in ('guest', 'free', 'paid')),
  guest_bucket text,
  plan_id text,
  reservation_id text references credit_reservations (id) on delete set null,
  plan_hash text,
  status text not null check (
    status in ('available', 'used', 'claimed', 'consumed', 'released', 'expired')
  ),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists generation_entitlements_status_expiry_idx
  on generation_entitlements (status, expires_at);

create index if not exists generation_entitlements_user_created_idx
  on generation_entitlements (user_id, created_at desc);

-- 同一 24 小时 guest bucket 最多保留一条未释放凭证，避免并发首次生成或清 Cookie 刷取。
create unique index if not exists generation_entitlements_guest_bucket_active_idx
  on generation_entitlements (guest_bucket)
  where kind = 'guest' and status in ('available', 'used', 'claimed');

-- 同一请求指纹在 guest bucket 内也只能有一条活动记录。
create unique index if not exists generation_entitlements_guest_fingerprint_active_idx
  on generation_entitlements (guest_bucket, request_fingerprint)
  where kind = 'guest' and status in ('available', 'used', 'claimed');

-- 免费权益一次只允许一条活动凭证，释放后才可重新申请。
create unique index if not exists generation_entitlements_free_user_active_idx
  on generation_entitlements (user_id)
  where kind = 'free' and status in ('available', 'used', 'claimed');

-- 同一付费预留只允许一条活动凭证，防止同一笔预留被多次生成使用。
create unique index if not exists generation_entitlements_paid_reservation_active_idx
  on generation_entitlements (reservation_id)
  where kind = 'paid' and status in ('available', 'used', 'claimed');
