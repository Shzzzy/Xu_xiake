-- 保存 plan 内容哈希，重复 planId finalize 时拒绝不同内容，保证幂等结果不可被替换。
alter table travel_plans add column if not exists plan_hash text;

create index if not exists travel_plans_plan_hash_idx
  on travel_plans (plan_hash);
