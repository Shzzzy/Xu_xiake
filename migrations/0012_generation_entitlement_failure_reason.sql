-- 记录生成失败释放原因，公开客户端不能把 used 凭证直接改回 released。
alter table generation_entitlements
  add column if not exists failure_reason text;
