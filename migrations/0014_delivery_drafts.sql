create table if not exists trip_drafts (
  id text primary key,
  owner_user_id text references "user" ("id") on delete cascade,
  guest_session_hash text,
  plan_id text not null,
  request_fingerprint text not null,
  entitlement_id text references generation_entitlements (id) on delete set null,
  plan_hash text not null,
  plan_data jsonb not null,
  preview_scope text not null default 'full'
    check (preview_scope in ('full', 'limited')),
  page_manifest_hash text,
  page_count integer not null default 0 check (page_count >= 0),
  status text not null default 'generating'
    check (status in ('generating', 'preview_ready', 'awaiting_finalize', 'finalized', 'failed', 'expired')),
  version_id text references travel_plans (id) on delete set null,
  failure_reason text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_drafts_owner_or_guest_check
    check (owner_user_id is not null or guest_session_hash is not null)
);

create index if not exists trip_drafts_owner_status_idx
  on trip_drafts (owner_user_id, status, expires_at);

create index if not exists trip_drafts_guest_status_idx
  on trip_drafts (guest_session_hash, status, expires_at);

create unique index if not exists trip_drafts_owner_plan_active_idx
  on trip_drafts (owner_user_id, plan_id)
  where owner_user_id is not null
    and status in ('generating', 'preview_ready', 'awaiting_finalize');