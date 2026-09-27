-- 商业化账号扩展：账号状态、点数钱包、流水、预占、订单、行程、分享和管理员审计。
alter table "user" add column if not exists "phone" text;
alter table "user" add column if not exists "phoneVerified" boolean not null default false;
alter table "user" add column if not exists "role" text not null default 'user';
alter table "user" add column if not exists "status" text not null default 'active';

create unique index if not exists "user_phone_unique_idx"
  on "user" ("phone") where "phone" is not null;

alter table "user" drop constraint if exists "user_role_check";
alter table "user" add constraint "user_role_check" check ("role" in ('user', 'admin'));
alter table "user" drop constraint if exists "user_status_check";
alter table "user" add constraint "user_status_check" check ("status" in ('active', 'disabled'));

create table if not exists credit_wallets (
  id text primary key,
  user_id text not null unique references "user" ("id") on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  reserved integer not null default 0 check (reserved >= 0 and reserved <= balance),
  free_trial_claimed boolean not null default false,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists credit_ledger (
  id text primary key,
  wallet_id text not null references credit_wallets (id) on delete cascade,
  delta integer not null,
  balance_after integer not null check (balance_after >= 0),
  reason text not null,
  order_id text,
  plan_id text,
  operator_user_id text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists credit_ledger_wallet_created_idx
  on credit_ledger (wallet_id, created_at desc);

create table if not exists credit_reservations (
  id text primary key,
  wallet_id text not null references credit_wallets (id) on delete cascade,
  plan_id text,
  status text not null check (status in ('reserved', 'consumed', 'released', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists credit_reservations_wallet_status_idx
  on credit_reservations (wallet_id, status, expires_at);

create table if not exists payment_orders (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  wallet_id text not null references credit_wallets (id) on delete cascade,
  package_code text not null,
  points integer not null check (points > 0),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'CNY',
  provider text not null,
  provider_order_id text,
  provider_transaction_id text,
  status text not null check (status in ('created', 'pending', 'paid', 'failed', 'expired', 'refunded', 'closed')),
  paid_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_orders_user_created_idx
  on payment_orders (user_id, created_at desc);

create table if not exists payment_events (
  id text primary key,
  provider text not null,
  provider_event_id text not null unique,
  order_id text,
  payload jsonb not null,
  status text not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists travel_plans (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  title text not null,
  origin text not null,
  destination text not null,
  days integer not null check (days > 0),
  status text not null,
  plan_data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists travel_plans_user_created_idx
  on travel_plans (user_id, created_at desc);

create table if not exists plan_shares (
  id text primary key,
  plan_id text not null references travel_plans (id) on delete cascade,
  owner_user_id text not null references "user" ("id") on delete cascade,
  token_hash text not null unique,
  status text not null check (status in ('active', 'revoked', 'expired')),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists admin_audit_logs (
  id text primary key,
  admin_user_id text not null references "user" ("id") on delete restrict,
  action text not null,
  target_user_id text,
  target_order_id text,
  target_plan_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
