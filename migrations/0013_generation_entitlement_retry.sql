-- 生成权益失败后不再复用旧 token，而是保留失败记录并允许有限次数的安全重试。
alter table generation_entitlements
  add column if not exists retry_count integer not null default 0;

alter table generation_entitlements
  add column if not exists failure_reason text;

alter table generation_entitlements
  drop constraint if exists generation_entitlements_status_check;
alter table generation_entitlements
  add constraint generation_entitlements_status_check
  check (status in ('available', 'used', 'claimed', 'consumed', 'released', 'expired', 'failed'));

alter table generation_entitlements
  drop constraint if exists generation_entitlements_retry_count_check;
alter table generation_entitlements
  add constraint generation_entitlements_retry_count_check
  check (retry_count between 0 and 2);

alter table generation_entitlements
  drop constraint if exists generation_entitlements_failure_reason_length_check;
alter table generation_entitlements
  add constraint generation_entitlements_failure_reason_length_check
  check (failure_reason is null or char_length(failure_reason) <= 500);

create index if not exists generation_entitlements_retry_lookup_idx
  on generation_entitlements (kind, user_id, guest_bucket, request_fingerprint, plan_id, retry_count)
  where status = 'failed';
