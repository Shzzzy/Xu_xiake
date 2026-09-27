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
  balance integer not null default 0,
  reserved integer not null default 0,
  free_trial_claimed boolean not null default false,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credit_wallets_balance_check check (balance >= 0),
  constraint credit_wallets_reserved_check check (reserved >= 0 and reserved <= balance)
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
  created_at timestamptz not null default now(),
  constraint credit_ledger_reason_check check (
    reason in (
      'free_trial',
      'purchase',
      'generation',
      'refund',
      'admin_adjustment',
      'expiration',
      'migration'
    )
  )
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
  wallet_id text not null,
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
  provider_event_id text not null,
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
  plan_id text not null,
  owner_user_id text not null,
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

-- 所有商业表建完后，再补充跨表唯一约束和外键，避免前向依赖。
alter table credit_wallets
  add constraint credit_wallets_id_user_id_key unique (id, user_id);

alter table travel_plans
  add constraint travel_plans_id_user_id_key unique (id, user_id);

alter table payment_events
  drop constraint if exists payment_events_provider_event_id_key;
alter table payment_events
  add constraint payment_events_provider_event_id_key unique (provider, provider_event_id);

alter table payment_orders
  drop constraint if exists payment_orders_wallet_id_fkey;
alter table payment_orders
  add constraint payment_orders_wallet_owner_fkey
  foreign key (wallet_id, user_id) references credit_wallets (id, user_id)
  on delete cascade;

alter table credit_ledger
  add constraint credit_ledger_order_id_fkey
  foreign key (order_id) references payment_orders (id) on delete set null;
alter table credit_ledger
  add constraint credit_ledger_plan_id_fkey
  foreign key (plan_id) references travel_plans (id) on delete set null;
alter table credit_ledger
  add constraint credit_ledger_operator_user_id_fkey
  foreign key (operator_user_id) references "user" ("id") on delete set null;

alter table credit_reservations
  add constraint credit_reservations_plan_id_fkey
  foreign key (plan_id) references travel_plans (id) on delete set null;

alter table payment_events
  add constraint payment_events_order_id_fkey
  foreign key (order_id) references payment_orders (id) on delete set null;

alter table plan_shares
  drop constraint if exists plan_shares_plan_id_fkey;
alter table plan_shares
  drop constraint if exists plan_shares_owner_user_id_fkey;
alter table plan_shares
  add constraint plan_shares_plan_owner_fkey
  foreign key (plan_id, owner_user_id) references travel_plans (id, user_id)
  on delete cascade;

alter table admin_audit_logs
  add constraint admin_audit_logs_target_user_id_fkey
  foreign key (target_user_id) references "user" ("id") on delete set null;
alter table admin_audit_logs
  add constraint admin_audit_logs_target_order_id_fkey
  foreign key (target_order_id) references payment_orders (id) on delete set null;
alter table admin_audit_logs
  add constraint admin_audit_logs_target_plan_id_fkey
  foreign key (target_plan_id) references travel_plans (id) on delete set null;

create unique index if not exists payment_orders_provider_order_id_unique_idx
  on payment_orders (provider, provider_order_id)
  where provider_order_id is not null;

create unique index if not exists payment_orders_provider_transaction_id_unique_idx
  on payment_orders (provider, provider_transaction_id)
  where provider_transaction_id is not null;
