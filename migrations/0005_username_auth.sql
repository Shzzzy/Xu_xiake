-- Better Auth username 插件所需的用户名与展示用户名字段。
-- 使用独立迁移，避免已执行过的 0004 无法原地追加新列。
alter table "user" add column if not exists "username" text;
alter table "user" add column if not exists "displayUsername" text;

-- username 可迁移到已有用户且允许为空；非空值必须唯一。
create unique index if not exists "user_username_unique_idx"
  on "user" ("username")
  where "username" is not null;
