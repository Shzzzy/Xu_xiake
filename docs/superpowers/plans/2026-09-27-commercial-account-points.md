# 商业化账号、点数与支付系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有徐霞客旅行规划中实现手机号账号、钱包点数、首次免费、B 路引点册、支付订单、管理员后台和分享闭环，同时保持现有规划与路书能力可用。

**Architecture:** 先建立数据库与认证底座，再实现点数账本和权益判断，随后接入订单、支付回调、规划扣点、行程持久化和分享，最后实现管理员与端到端验证。所有余额变化必须通过服务端事务和流水完成，客户端永远不能直接改点数。

**Tech Stack:** React 19、TanStack Start/Router、TypeScript、Zod、Better Auth username plugin、Postgres/Supabase、PGlite、Node Test、Playwright、Tailwind CSS 4。

**Spec:** `docs/superpowers/specs/2026-09-27-commercial-account-points-design.md`

## Global Constraints

- 用户登录标识为中国大陆 11 位手机号，标准化正则固定为 `^1[3-9]\d{9}$`。
- 首版不使用短信验证码、微信登录、邮箱登录和订阅制。
- 密码最少 8 位，必须交给 Better Auth 哈希，禁止保存明文密码。
- 首次完整体验每个账号只能使用 1 次。
- 单次套餐固定为 1 点 / 99 分。
- 10 次套餐固定为 10 点 / 941 分。
- 30 次套餐固定为 30 点 / 2673 分。
- 只有成功生成新的旅行方案才消耗 1 点；失败、超时、取消不得扣点。
- PDF、分享和社交文案随已生成行程解锁，不额外扣点。
- 分享访问者无需登录或购买。
- 所有余额修改必须写入 `credit_ledger`，禁止直接更新余额而不写流水。
- 所有金额只使用整数分 `amount_cents`，禁止浮点金额。
- 所有数据库变更必须新增 `migrations/*.sql` 文件，禁止运行时临时建表。
- 管理员只能由普通账号升级，不创建默认管理员密码。
- 管理员调整点数、停用用户、退款都必须写 `admin_audit_logs`。
- 代码注释使用中文。
- 不删除现有文件和功能；需要替换旧逻辑时先保留兼容路径，测试通过后再单独移除。
- 每个 Task 结束后运行对应测试并单独提交。

---

## 文件地图

### 新增文件

- `migrations/0001_public_auth.sql`：将公开账号所需的 Better Auth 基础表放到根迁移目录。
- `migrations/0004_commercial_accounts.sql`：账号扩展、钱包、流水、预留、订单、支付事件、行程、分享和审计表。
- `src/lib/auth/phone.ts`：手机号规范化和脱敏纯函数。
- `src/lib/auth/public.server.ts`：手机号注册、登录和账号初始化服务。
- `src/lib/auth/public.functions.ts`：公开账号 server functions。
- `src/routes/auth.tsx`：登录注册路由。
- `src/components/auth/AuthBookPage.tsx`：B 路引册页风格登录注册组件。
- `src/lib/credits/types.ts`：钱包、流水、预留类型。
- `src/lib/credits.server.ts`：点数事务服务。
- `src/lib/credits.functions.ts`：钱包读取 server functions。
- `src/lib/entitlements.server.ts`：首次免费与新方案权益判断。
- `src/lib/plans.repository.ts`：行程保存和读取。
- `src/lib/shares.server.ts`：分享 Token 和只读读取。
- `src/lib/billing/catalog.ts`：套餐目录与金额校验。
- `src/lib/billing/catalog.test.ts`：套餐测试。
- `src/lib/payments/provider.ts`：支付服务商接口。
- `src/lib/payments/orders.server.ts`：订单创建、查询、状态机。
- `src/lib/payments/test-provider.server.ts`：本地测试支付适配器。
- `src/lib/payments/provider-registry.server.ts`：按环境选择支付服务商。
- `src/lib/payments/webhook.server.ts`：回调验签与幂等处理。
- `src/routes/api/payments/webhook.ts`：支付回调路由。
- `src/routes/pricing.tsx`：B 点册路由。
- `src/components/billing/PricingBook.tsx`：套餐与权益 UI。
- `src/components/billing/CheckoutSheet.tsx`：支付确认抽屉。
- `src/routes/account.tsx`：账号与钱包页。
- `src/routes/share/$token.tsx`：只读分享页。
- `src/lib/admin.server.ts`：管理员授权与审计服务。
- `src/lib/admin.functions.ts`：管理员 server functions。
- `src/routes/admin.tsx`：管理员后台路由。
- `src/components/admin/AdminDashboard.tsx`：管理员界面。

### 修改文件

- `src/lib/auth/email-password.ts`：启用邮箱密码底层能力。
- `src/lib/auth/server.ts`：挂载 username 插件。
- `src/lib/auth/client.ts`：挂载 username 客户端插件。
- `src/lib/auth/use-current-user.ts`：增加手机号、角色和状态字段。
- `src/lib/auth/verify.server.ts`：返回角色和账号状态。
- `src/routes/__root.tsx`：挂载全局账号状态和 Toaster 保持现状。
- `src/components/planner/PlannerPrototype.tsx`：顶部入口、余额、结果页购买入口和 claim 流程。
- `src/components/planner/plan-output/GuidebookPreview.tsx`：导出/分享前权益检查。
- `src/components/planner/plan-output/use-guidebook-export.ts`：导出前账号和点数校验。
- `src/lib/live-planner.functions.ts`：付费生成前预留点数，成功后消费，失败释放。
- `package.json`：增加精确测试脚本。
- `docs/03-deployment-and-operations.md`：补充公开账号、支付和管理员配置。

---

### Task 1: 数据库账号与账本结构

**Files:**
- Create: `migrations/0001_public_auth.sql`
- Create: `migrations/0004_commercial_accounts.sql`
- Create: `src/lib/credits/types.ts`
- Test: `src/lib/credits/schema.integration.test.ts`

**Interfaces:**
- Consumes: 现有 `src/lib/db.ts` 的 `getSql()`。
- Produces: 后续任务使用的数据库表名和 TypeScript 类型：
  - `UserRole = "user" | "admin"`
  - `UserStatus = "active" | "disabled"`
  - `CreditWallet`
  - `CreditLedgerEntry`
  - `CreditReservation`
  - `PaymentOrder`

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { getSql } from "../db.ts";

test("commercial migrations create account and credit tables", async () => {
  const sql = await getSql();
  const tables = await sql.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  const names = tables.map((row) => row.table_name);
  assert.ok(names.includes("credit_wallets"));
  assert.ok(names.includes("credit_ledger"));
  assert.ok(names.includes("credit_reservations"));
  assert.ok(names.includes("payment_orders"));
});

test("user table has phone role and status columns", async () => {
  const sql = await getSql();
  const rows = await sql.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_name = 'user'",
  );
  const names = rows.map((row) => row.column_name);
  assert.ok(names.includes("phone"));
  assert.ok(names.includes("role"));
  assert.ok(names.includes("status"));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/credits/schema.integration.test.ts`

Expected: FAIL，提示 `credit_wallets` 或 `phone` 列不存在。

- [ ] **Step 3: 创建公开认证基础迁移**

从 `migrations/auth/0001_auth.sql` 复制 Better Auth 的 `user`、`session`、`account`、`verification` 表和索引到新的根目录文件 `migrations/0001_public_auth.sql`。不要修改原文件。

文件名必须使用 `0001_public_auth.sql`，因为现有数据库的 `_migrations` 没有这个 basename，下一次构建会补跑。

- [ ] **Step 4: 创建商业化和账号扩展迁移**

```sql
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
```

- [ ] **Step 5: 创建共享类型**

```ts
export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export type CreditWallet = {
  id: string;
  userId: string;
  balance: number;
  reserved: number;
  freeTrialClaimed: boolean;
  version: number;
};

export type CreditLedgerEntry = {
  id: string;
  walletId: string;
  delta: number;
  balanceAfter: number;
  reason:
    | "free_trial"
    | "purchase"
    | "generation"
    | "refund"
    | "admin_adjustment"
    | "expiration"
    | "migration";
  orderId: string | null;
  planId: string | null;
  operatorUserId: string | null;
  note: string | null;
  createdAt: string;
};

export type CreditReservation = {
  id: string;
  walletId: string;
  planId: string | null;
  status: "reserved" | "consumed" | "released" | "expired";
  expiresAt: string;
};

export type PaymentOrder = {
  id: string;
  userId: string;
  walletId: string;
  packageCode: "single" | "ten" | "thirty";
  points: number;
  amountCents: number;
  currency: "CNY";
  provider: string;
  providerOrderId: string | null;
  providerTransactionId: string | null;
  status: "created" | "pending" | "paid" | "failed" | "expired" | "refunded" | "closed";
  paidAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/credits/schema.integration.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add migrations/0001_public_auth.sql migrations/0004_commercial_accounts.sql src/lib/credits/types.ts src/lib/credits/schema.integration.test.ts
git commit -m "feat: add commercial account and credit schema"
```

---

### Task 2: 手机号规范化纯函数

**Files:**
- Create: `src/lib/auth/phone.ts`
- Test: `src/lib/auth/phone.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `normalizePhone(value: string): string`
  - `isValidPhone(value: string): boolean`
  - `phoneToInternalEmail(phone: string): string`
  - `maskPhone(phone: string): string`

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { isValidPhone, maskPhone, normalizePhone, phoneToInternalEmail } from "./phone.ts";

test("normalizes China mobile numbers", () => {
  assert.equal(normalizePhone("+86 138-0013-8000"), "13800138000");
  assert.equal(normalizePhone("138 0013 8000"), "13800138000");
});

test("rejects invalid phone numbers", () => {
  assert.equal(isValidPhone("12345678901"), false);
  assert.equal(isValidPhone("1380013800"), false);
  assert.equal(isValidPhone("13800138000"), true);
});

test("builds internal email and masks display phone", () => {
  assert.equal(phoneToInternalEmail("13800138000"), "13800138000@phone.invalid");
  assert.equal(maskPhone("13800138000"), "138****8000");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/auth/phone.test.ts`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现纯函数**

```ts
const CHINA_MOBILE_PATTERN = /^1[3-9]\d{9}$/;

export function normalizePhone(value: string): string {
  return value.replace(/[^\d]/g, "").replace(/^86(?=1[3-9]\d{9}$)/, "");
}

export function isValidPhone(value: string): boolean {
  return CHINA_MOBILE_PATTERN.test(normalizePhone(value));
}

export function phoneToInternalEmail(phone: string): string {
  return normalizePhone(phone) + "@phone.invalid";
}

export function maskPhone(phone: string): string {
  const normalized = normalizePhone(phone);
  if (!isValidPhone(normalized)) return normalized;
  return normalized.slice(0, 3) + "****" + normalized.slice(7);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/auth/phone.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/auth/phone.ts src/lib/auth/phone.test.ts
git commit -m "feat: add phone normalization helpers"
```

---

### Task 3: Better Auth 手机号用户名插件

**Files:**
- Modify: `src/lib/auth/email-password.ts`
- Modify: `src/lib/auth/server.ts`
- Modify: `src/lib/auth/client.ts`
- Test: `src/lib/auth/public-auth.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `normalizePhone`、`phoneToInternalEmail`。
- Produces:
  - Better Auth username 登录端点。
  - 客户端 `authClient.signIn.username`。
  - 客户端 `authClient.signUp.email`，在注册时携带 `username`。

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("public auth enables username credentials", () => {
  const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
  const flag = readFileSync(new URL("./email-password.ts", import.meta.url), "utf8");
  assert.match(server, /username\(/);
  assert.match(client, /usernameClient\(/);
  assert.match(flag, /emailAndPasswordEnabled = true/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/auth/public-auth.test.ts`

Expected: FAIL。

- [ ] **Step 3: 启用邮箱密码底层能力**

把 `src/lib/auth/email-password.ts` 的导出值改为：

```ts
export const emailAndPasswordEnabled = true;
```

- [ ] **Step 4: 挂载服务端 username 插件**

在 `src/lib/auth/server.ts` 中导入：

```ts
import { username } from "better-auth/plugins";
```

并把 `plugins` 数组改为：

```ts
plugins: [
  gateIdentitySessions(),
  ...(grokOAuthPlugin ? [grokOAuthPlugin] : []),
  username({
    minUsernameLength: 11,
    maxUsernameLength: 11,
    usernameValidator: (value) => /^1[3-9]\d{9}$/.test(value),
  }),
  bearer(),
  tanstackStartCookies(),
],
```

- [ ] **Step 5: 挂载客户端 username 插件**

在 `src/lib/auth/client.ts` 中导入：

```ts
import { usernameClient } from "better-auth/client/plugins";
```

并把 `plugins` 改为：

```ts
plugins: [genericOAuthClient(), usernameClient()],
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/auth/public-auth.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/lib/auth/email-password.ts src/lib/auth/server.ts src/lib/auth/client.ts src/lib/auth/public-auth.test.ts
git commit -m "feat: enable phone username authentication"
```

---

### Task 4: 手机号注册登录服务与页面

**Files:**
- Create: `src/lib/auth/public.server.ts`
- Create: `src/lib/auth/public.functions.ts`
- Create: `src/routes/auth.tsx`
- Create: `src/components/auth/AuthBookPage.tsx`
- Modify: `src/lib/auth/use-current-user.ts`
- Modify: `src/lib/auth/verify.server.ts`
- Test: `src/lib/auth/public.server.test.ts`

**Interfaces:**
- Consumes: Task 1 的账号表与钱包表，Task 2 纯函数，Task 3 Better Auth username 插件。
- Produces:
  - `registerPublicAccount(input: { phone: string; password: string }): Promise<{ userId: string }>`
  - `getPublicAccount(userId: string): Promise<PublicAccount | null>`
  - `PublicAccount = { id: string; phone: string; role: UserRole; status: UserStatus }`
  - Server functions `getMyAccount`、`claimCurrentPlan` 由后续 Task 7 实现。

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "./phone.ts";
import { createPublicAccountRecord } from "./public.server.ts";

test("public account record uses normalized phone and hashes only internally", async () => {
  const record = await createPublicAccountRecord({
    phone: "+86 138-0013-8000",
    password: "password123",
  });
  assert.equal(record.phone, normalizePhone("13800138000"));
  assert.equal(record.role, "user");
  assert.equal(record.status, "active");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/auth/public.server.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现账号服务**

```ts
import { auth } from "./server.ts";
import { isValidPhone, normalizePhone, phoneToInternalEmail } from "./phone.ts";
import type { UserRole, UserStatus } from "../credits/types.ts";

export type PublicAccount = {
  id: string;
  phone: string;
  role: UserRole;
  status: UserStatus;
};

export async function createPublicAccountRecord(input: { phone: string; password: string }) {
  const phone = normalizePhone(input.phone);
  if (!isValidPhone(phone)) throw new Error("手机号格式不正确");
  if (input.password.length < 8) throw new Error("密码至少需要 8 位");
  const result = await auth.api.signUpEmail({
    body: {
      email: phoneToInternalEmail(phone),
      password: input.password,
      name: phone,
      username: phone,
    },
  });
  return { id: result.user.id, phone, role: "user" as const, status: "active" as const };
}

export async function getPublicAccount(userId: string): Promise<PublicAccount | null> {
  const { getSql } = await import("../db.ts");
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    phone: string;
    role: UserRole;
    status: UserStatus;
  }>(
    'select id, phone, role, status from "user" where id = $1',
    [userId],
  );
  const row = rows[0];
  return row ? { id: row.id, phone: row.phone, role: row.role, status: row.status } : null;
}
```

- [ ] **Step 4: 实现 server functions**

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./middleware.ts";
import { createPublicAccountRecord, getPublicAccount } from "./public.server.ts";

const registerInput = z.object({
  phone: z.string().min(1),
  password: z.string().min(8).max(128),
});

export const registerWithPhone = createServerFn({ method: "POST" })
  .validator(registerInput)
  .handler(async ({ data }) => createPublicAccountRecord(data));

export const getMyAccount = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => getPublicAccount(context.userId));
```

- [ ] **Step 5: 实现 `/auth` 页面**

把 `public/prototypes/auth-roadbook-prototype.html` 的结构迁移为 React 组件，保留以下交互：

- 登录/注册 Tab。
- 手机号规范化后再提交。
- 注册成功后调用 `authClient.signIn.username` 或服务端注册后刷新 Session。
- 登录成功后读取 `returnTo` 查询参数并跳转。
- 未验证手机号和无法找回密码提示必须保留。

`src/routes/auth.tsx` 只负责读取路由和渲染 `AuthBookPage`。

- [ ] **Step 6: 扩展当前用户类型**

把 `AppUser` 增加：

```ts
phone: string | null;
role: "user" | "admin";
status: "active" | "disabled";
```

`useCurrentUserState` 从 Better Auth session 的 user 字段读取这些值。

- [ ] **Step 7: 扩展服务端会话返回**

把 `VerifiedUser` 改为：

```ts
export type VerifiedUser = {
  id: string;
  email: string | null;
  phone: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
};
```

`getSessionUser` 查询 `"user"` 表补齐 phone、role、status。`requireUserId` 保持返回 string，增加 `requireActiveUserId` 返回完整用户并要求 `status === "active"`。

- [ ] **Step 8: 运行测试**

Run: `node --experimental-strip-types --test src/lib/auth/phone.test.ts src/lib/auth/public-auth.test.ts src/lib/auth/public.server.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add src/lib/auth/public.server.ts src/lib/auth/public.functions.ts src/routes/auth.tsx src/components/auth/AuthBookPage.tsx src/lib/auth/use-current-user.ts src/lib/auth/verify.server.ts src/lib/auth/public.server.test.ts
git commit -m "feat: add phone registration and login page"
```

---

### Task 5: 钱包、流水和点数预留服务

**Files:**
- Create: `src/lib/credits.server.ts`
- Create: `src/lib/credits.functions.ts`
- Test: `src/lib/credits.server.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `credit_wallets`、`credit_ledger`、`credit_reservations`。
- Produces:
  - `ensureWallet(userId: string): Promise<CreditWallet>`
  - `getWalletSummary(userId: string): Promise<{ wallet: CreditWallet; ledger: CreditLedgerEntry[] }>`
  - `claimFreeTrial(userId: string, planId: string | null): Promise<CreditLedgerEntry>`
  - `reserveCredit(userId: string, planId: string, ttlMinutes?: number): Promise<CreditReservation>`
  - `consumeReservation(reservationId: string, planId: string): Promise<CreditLedgerEntry>`
  - `releaseReservation(reservationId: string): Promise<void>`
  - `expireReservations(now?: Date): Promise<number>`

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getSql } from "./db.ts";
import {
  claimFreeTrial,
  consumeReservation,
  ensureWallet,
  getWalletSummary,
  releaseReservation,
  reserveCredit,
} from "./credits.server.ts";

async function createUser() {
  const sql = await getSql();
  const id = randomUUID();
  const phone = "13" + String(Date.now()).slice(-9);
  await sql.query(
    'insert into "user" (id, name, email, "emailVerified", phone) values ($1,$2,$3,true,$4)',
    [id, phone, phone + "@phone.invalid", phone],
  );
  return id;
}

test("wallet starts empty and free trial can only be claimed once", async () => {
  const userId = await createUser();
  await ensureWallet(userId);
  await claimFreeTrial(userId, "plan-1");
  await assert.rejects(() => claimFreeTrial(userId, "plan-2"), /免费体验/);
  const summary = await getWalletSummary(userId);
  assert.equal(summary.wallet.freeTrialClaimed, true);
  assert.equal(summary.ledger[0]?.reason, "free_trial");
});

test("reservation prevents double spending and release restores availability", async () => {
  const userId = await createUser();
  await ensureWallet(userId);
  const sql = await getSql();
  await sql.query("update credit_wallets set balance = 1 where user_id = $1", [userId]);
  const reservation = await reserveCredit(userId, "plan-a");
  await assert.rejects(() => reserveCredit(userId, "plan-b"), /点数不足/);
  await releaseReservation(reservation.id);
  const reservation2 = await reserveCredit(userId, "plan-b");
  await consumeReservation(reservation2.id, "plan-b");
  const summary = await getWalletSummary(userId);
  assert.equal(summary.wallet.balance, 0);
  assert.equal(summary.wallet.reserved, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/credits.server.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现钱包读取与创建**

```ts
import { randomUUID } from "node:crypto";
import { getSql } from "./db.ts";
import type { CreditLedgerEntry, CreditReservation, CreditWallet } from "./credits/types.ts";

function mapWallet(row: Record<string, unknown>): CreditWallet {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    balance: Number(row.balance),
    reserved: Number(row.reserved),
    freeTrialClaimed: Boolean(row.free_trial_claimed),
    version: Number(row.version),
  };
}

export async function ensureWallet(userId: string): Promise<CreditWallet> {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `insert into credit_wallets (id, user_id)
     values ($1, $2)
     on conflict (user_id) do update set updated_at = credit_wallets.updated_at
     returning *`,
    [randomUUID(), userId],
  );
  return mapWallet(rows[0]!);
}
```

- [ ] **Step 4: 实现免费体验 claim**

```ts
export async function claimFreeTrial(userId: string, planId: string | null): Promise<CreditLedgerEntry> {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `with updated as (
       update credit_wallets
       set free_trial_claimed = true,
           version = version + 1,
           updated_at = now()
       where user_id = $1 and free_trial_claimed = false
       returning id, balance
     ), ledger as (
       insert into credit_ledger (
         id, wallet_id, delta, balance_after, reason, plan_id, note
       )
       select $2, id, 0, balance, 'free_trial', $3, '首次免费体验'
       from updated
       returning *
     )
     select * from ledger`,
    [userId, randomUUID(), planId],
  );
  if (!rows[0]) throw new Error("免费体验已使用或钱包不存在");
  return mapLedger(rows[0]);
}
```

- [ ] **Step 5: 实现预留、消费和释放**

```ts
export async function reserveCredit(
  userId: string,
  planId: string,
  ttlMinutes = 15,
): Promise<CreditReservation> {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `with updated as (
       update credit_wallets
       set reserved = reserved + 1,
           version = version + 1,
           updated_at = now()
       where user_id = $1 and balance - reserved >= 1
       returning id
     ), reservation as (
       insert into credit_reservations (id, wallet_id, plan_id, status, expires_at)
       select $2, id, $3, 'reserved', now() + ($4 * interval '1 minute')
       from updated
       returning *
     )
     select * from reservation`,
    [userId, randomUUID(), planId, ttlMinutes],
  );
  if (!rows[0]) throw new Error("点数不足或钱包不存在");
  return mapReservation(rows[0]);
}

export async function consumeReservation(
  reservationId: string,
  planId: string,
): Promise<CreditLedgerEntry> {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `with consumed as (
       update credit_reservations
       set status = 'consumed', plan_id = $2, updated_at = now()
       where id = $1 and status = 'reserved' and expires_at > now()
       returning wallet_id, plan_id
     ), wallet_update as (
       update credit_wallets w
       set balance = w.balance - 1,
           reserved = w.reserved - 1,
           version = w.version + 1,
           updated_at = now()
       from consumed c
       where w.id = c.wallet_id
       returning w.id, w.balance
     ), ledger as (
       insert into credit_ledger (
         id, wallet_id, delta, balance_after, reason, plan_id, note
       )
       select $3, u.id, -1, u.balance, 'generation', c.plan_id, '生成旅行方案'
       from wallet_update u join consumed c on c.wallet_id = u.id
       returning *
     )
     select * from ledger`,
    [reservationId, planId, randomUUID()],
  );
  if (!rows[0]) throw new Error("点数预留不存在、已消费或已过期");
  return mapLedger(rows[0]);
}

export async function releaseReservation(reservationId: string): Promise<void> {
  const sql = await getSql();
  await sql.query(
    `with released as (
       update credit_reservations
       set status = 'released', updated_at = now()
       where id = $1 and status = 'reserved'
       returning wallet_id
     )
     update credit_wallets w
     set reserved = w.reserved - 1,
         version = w.version + 1,
         updated_at = now()
     from released r
     where w.id = r.wallet_id and w.reserved > 0`,
    [reservationId],
  );
}
```

- [ ] **Step 6: 实现读取和过期清理**

```ts
export async function getWalletSummary(userId: string) {
  const sql = await getSql();
  const wallet = await ensureWallet(userId);
  const ledger = await sql.query<Record<string, unknown>>(
    `select * from credit_ledger where wallet_id = $1 order by created_at desc limit 100`,
    [wallet.id],
  );
  return { wallet, ledger: ledger.map(mapLedger) };
}

export async function expireReservations(now = new Date()): Promise<number> {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(
    `with expired as (
       update credit_reservations
       set status = 'expired', updated_at = now()
       where status = 'reserved' and expires_at <= $1
       returning wallet_id
     ), grouped as (
       select wallet_id, count(*)::int as count from expired group by wallet_id
     )
     update credit_wallets w
     set reserved = w.reserved - g.count,
         version = w.version + 1,
         updated_at = now()
     from grouped g
     where w.id = g.wallet_id
     returning w.id`,
    [now.toISOString()],
  );
  return rows.length;
}
```

- [ ] **Step 7: 实现 server functions**

```ts
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./auth/middleware.ts";
import { getWalletSummary } from "./credits.server.ts";

export const getMyWallet = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => getWalletSummary(context.userId));
```

- [ ] **Step 8: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/credits.server.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add src/lib/credits.server.ts src/lib/credits.functions.ts src/lib/credits.server.test.ts
git commit -m "feat: add credit wallet and reservation service"
```

---

### Task 6: 账号与钱包页

**Files:**
- Create: `src/routes/account.tsx`
- Create: `src/components/account/AccountBookPage.tsx`
- Test: `src/components/account/AccountBookPage.test.tsx`

**Interfaces:**
- Consumes: `getMyWallet`，`useCurrentUserState`。
- Produces: `/account` 页面和“购买点数”入口。

- [ ] **Step 1: 写失败组件测试**

```tsx
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountBookPage } from "./AccountBookPage.tsx";

test("renders masked phone, balance and ledger", () => {
  const html = renderToStaticMarkup(
    <AccountBookPage
      user={{ id: "u1", phone: "13800138000", role: "user", status: "active" }}
      wallet={{ balance: 10, reserved: 0, freeTrialClaimed: true }}
      ledger={[{ id: "l1", delta: 10, reason: "purchase", balanceAfter: 10 }]}
    />,
  );
  assert.match(html, /138/);
  assert.match(html, /10 点/);
  assert.match(html, /购买点数/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `tsx --test src/components/account/AccountBookPage.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现展示组件**

组件必须包含：

- 脱敏手机号。
- 可用点数 `balance - reserved`。
- 首次免费是否已使用。
- 最近 100 条流水。
- “购买点数”按钮跳转 `/pricing?returnTo=/account`。
- 管理员角色时显示 `/admin` 入口。

- [ ] **Step 4: 实现受保护路由**

`src/routes/account.tsx` 使用 `useCurrentUserState`；未登录时跳转 `/auth?returnTo=/account`。

- [ ] **Step 5: 运行测试确认通过**

Run: `tsx --test src/components/account/AccountBookPage.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/routes/account.tsx src/components/account/AccountBookPage.tsx src/components/account/AccountBookPage.test.tsx
git commit -m "feat: add account and wallet page"
```

---

### Task 7: 行程保存与首次免费 claim

**Files:**
- Create: `src/lib/plans.repository.ts`
- Create: `src/lib/entitlements.server.ts`
- Create: `src/lib/entitlements.functions.ts`
- Test: `src/lib/entitlements.server.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `claimFreeTrial`、`reserveCredit`、`consumeReservation`。
- Produces:
  - `saveTravelPlan(input: SaveTravelPlanInput): Promise<{ id: string }>`
  - `claimFirstFreePlan(userId: string, plan: TripPlan): Promise<{ planId: string }>`
  - `reservePaidPlan(userId: string, planId: string): Promise<CreditReservation>`
  - `finishPaidPlan(reservationId: string, planId: string): Promise<CreditLedgerEntry>`

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getSql } from "./db.ts";
import { ensureWallet, getWalletSummary } from "./credits.server.ts";
import { claimFirstFreePlan, finishPaidPlan, reservePaidPlan, saveTravelPlan } from "./entitlements.server.ts";

test("first free claim saves one plan and consumes free trial", async () => {
  const userId = randomUUID();
  const sql = await getSql();
  await sql.query(
    'insert into "user" (id, name, email, "emailVerified", phone) values ($1,$2,$3,true,$4)',
    [userId, "tester", userId + "@phone.invalid", "13800138000"],
  );
  await ensureWallet(userId);
  const result = await claimFirstFreePlan(userId, {
    meta: { title: "北京之旅", destination: "北京", origin: "上海", days: 3 },
  } as never);
  assert.ok(result.planId);
  const summary = await getWalletSummary(userId);
  assert.equal(summary.wallet.freeTrialClaimed, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/entitlements.server.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现行程保存仓储**

```ts
import { randomUUID } from "node:crypto";
import { getSql } from "./db.ts";
import type { TripPlan } from "./travel-plan.ts";

export type SaveTravelPlanInput = {
  userId: string;
  plan: TripPlan;
};

export async function saveTravelPlan(input: SaveTravelPlanInput): Promise<{ id: string }> {
  const sql = await getSql();
  const id = randomUUID();
  await sql.query(
    `insert into travel_plans (
       id, user_id, title, origin, destination, days, status, plan_data
     ) values ($1,$2,$3,$4,$5,$6,'saved',$7::jsonb)`,
    [
      id,
      input.userId,
      input.plan.meta.title,
      input.plan.meta.origin,
      input.plan.meta.destination,
      input.plan.meta.days,
      JSON.stringify(input.plan),
    ],
  );
  return { id };
}
```

- [ ] **Step 4: 实现首次免费 claim**

```ts
import { claimFreeTrial } from "./credits.server.ts";
import { saveTravelPlan } from "./plans.repository.ts";
import type { TripPlan } from "./travel-plan.ts";

export async function claimFirstFreePlan(userId: string, plan: TripPlan) {
  const saved = await saveTravelPlan({ userId, plan });
  await claimFreeTrial(userId, saved.id);
  return { planId: saved.id };
}
```

- [ ] **Step 5: 实现付费预留和完成**

```ts
import { consumeReservation, reserveCredit } from "./credits.server.ts";
import { saveTravelPlan } from "./plans.repository.ts";

export async function reservePaidPlan(userId: string, planId: string) {
  return reserveCredit(userId, planId);
}

export async function finishPaidPlan(reservationId: string, planId: string) {
  return consumeReservation(reservationId, planId);
}
```

- [ ] **Step 6: 实现 server functions**

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./auth/middleware.ts";
import { tripPlanSchema } from "./trip-plan-schema.ts";
import { claimFirstFreePlan } from "./entitlements.server.ts";

export const claimCurrentPlan = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ plan: tripPlanSchema }))
  .handler(async ({ context, data }) => claimFirstFreePlan(context.userId, data.plan));
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/entitlements.server.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/lib/plans.repository.ts src/lib/entitlements.server.ts src/lib/entitlements.functions.ts src/lib/entitlements.server.test.ts
git commit -m "feat: claim first free plan into account"
```

---

### Task 8: 套餐目录与 B 点册页面

**Files:**
- Create: `src/lib/billing/catalog.ts`
- Create: `src/lib/billing/catalog.test.ts`
- Create: `src/routes/pricing.tsx`
- Create: `src/components/billing/PricingBook.tsx`
- Test: `src/components/billing/PricingBook.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `/account` 和 Task 7 的权益状态。
- Produces:
  - `PACKAGE_CATALOG`
  - `resolvePackage(code: PackageCode): PackageDefinition`
  - `/pricing` 页面。

- [ ] **Step 1: 写失败目录测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_CATALOG, resolvePackage } from "./catalog.ts";

test("catalog uses integer cents", () => {
  assert.deepEqual(PACKAGE_CATALOG.single, {
    code: "single",
    points: 1,
    amountCents: 99,
    discountLabel: "无门槛",
  });
  assert.equal(resolvePackage("ten").amountCents, 941);
  assert.equal(resolvePackage("thirty").amountCents, 2673);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/billing/catalog.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现套餐目录**

```ts
export type PackageCode = "single" | "ten" | "thirty";

export type PackageDefinition = {
  code: PackageCode;
  points: number;
  amountCents: number;
  discountLabel: string;
};

export const PACKAGE_CATALOG = {
  single: { code: "single", points: 1, amountCents: 99, discountLabel: "无门槛" },
  ten: { code: "ten", points: 10, amountCents: 941, discountLabel: "9.5 折 · 推荐" },
  thirty: { code: "thirty", points: 30, amountCents: 2673, discountLabel: "9 折" },
} as const satisfies Record<PackageCode, PackageDefinition>;

export function resolvePackage(code: PackageCode): PackageDefinition {
  return PACKAGE_CATALOG[code];
}
```

- [ ] **Step 4: 实现 B 点册 React 组件**

把 `public/prototypes/commercial-payment-directions.html` 中方向 B 的结构迁移到 `PricingBook.tsx`：

- 左侧为权益和信任说明。
- 右侧为套餐价目表。
- 默认选中 10 次。
- 价格统一从 `PACKAGE_CATALOG` 渲染。
- 点击“进入支付”打开 `CheckoutSheet`。
- 登录状态不存在时先跳转 `/auth?returnTo=/pricing`。

- [ ] **Step 5: 实现路由**

`src/routes/pricing.tsx` 读取 `returnTo` 并渲染 `PricingBook`。

- [ ] **Step 6: 写组件测试**

```tsx
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingBook } from "./PricingBook.tsx";

test("pricing book renders all packages", () => {
  const html = renderToStaticMarkup(<PricingBook authenticated={false} onCheckout={() => {}} />);
  assert.match(html, /0.99/);
  assert.match(html, /9.41/);
  assert.match(html, /26.73/);
  assert.match(html, /9.5 折/);
});
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/billing/catalog.test.ts && tsx --test src/components/billing/PricingBook.test.tsx`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/lib/billing/catalog.ts src/lib/billing/catalog.test.ts src/routes/pricing.tsx src/components/billing/PricingBook.tsx src/components/billing/PricingBook.test.tsx
git commit -m "feat: add pricing book and package catalog"
```

---

### Task 9: 支付订单与支付服务商接口

**Files:**
- Create: `src/lib/payments/provider.ts`
- Create: `src/lib/payments/orders.server.ts`
- Create: `src/lib/payments/test-provider.server.ts`
- Create: `src/lib/payments/provider-registry.server.ts`
- Test: `src/lib/payments/orders.server.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `payment_orders`、Task 5 的钱包、Task 8 的套餐目录。
- Produces:
  - `PaymentProvider` 接口。
  - `createPaymentOrder(userId: string, packageCode: PackageCode): Promise<CreatedPayment>`
  - `getPaymentOrder(userId: string, orderId: string): Promise<PaymentOrder>`
  - `markOrderPaid(orderId: string, event: PaymentWebhookEvent): Promise<void>`

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getSql } from "../db.ts";
import { ensureWallet } from "../credits.server.ts";
import { createPaymentOrder } from "./orders.server.ts";

test("creates an order from catalog and ignores client price input", async () => {
  const userId = randomUUID();
  const sql = await getSql();
  await sql.query(
    'insert into "user" (id, name, email, "emailVerified", phone) values ($1,$2,$3,true,$4)',
    [userId, "buyer", userId + "@phone.invalid", "13800138001"],
  );
  await ensureWallet(userId);
  const order = await createPaymentOrder(userId, "ten");
  assert.equal(order.points, 10);
  assert.equal(order.amountCents, 941);
  assert.equal(order.status, "created");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/payments/orders.server.test.ts`

Expected: FAIL。

- [ ] **Step 3: 定义支付接口**

```ts
export type PaymentWebhookEvent = {
  provider: string;
  providerEventId: string;
  providerOrderId: string;
  providerTransactionId: string;
  status: "paid" | "failed" | "refunded";
  amountCents: number;
  currency: string;
  raw: Record<string, unknown>;
};

export type CreatedPayment = {
  provider: string;
  providerOrderId: string;
  redirectUrl: string | null;
  payload: Record<string, unknown>;
};

export interface PaymentProvider {
  id: string;
  createPayment(input: {
    orderId: string;
    amountCents: number;
    description: string;
  }): Promise<CreatedPayment>;
  verifyWebhook(request: Request): Promise<PaymentWebhookEvent>;
}
```

- [ ] **Step 4: 实现订单创建**

```ts
import { randomUUID } from "node:crypto";
import { getSql } from "../db.ts";
import { ensureWallet } from "../credits.server.ts";
import { resolvePackage, type PackageCode } from "../billing/catalog.ts";
import { getPaymentProvider } from "./provider-registry.server.ts";

export async function createPaymentOrder(userId: string, packageCode: PackageCode) {
  const item = resolvePackage(packageCode);
  const wallet = await ensureWallet(userId);
  const provider = getPaymentProvider();
  const orderId = randomUUID();
  const payment = await provider.createPayment({
    orderId,
    amountCents: item.amountCents,
    description: item.points + " 次旅行规划点数",
  });
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `insert into payment_orders (
       id, user_id, wallet_id, package_code, points, amount_cents,
       provider, provider_order_id, status, expires_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,'pending', now() + interval '30 minutes')
     returning *`,
    [
      orderId,
      userId,
      wallet.id,
      item.code,
      item.points,
      item.amountCents,
      payment.provider,
      payment.providerOrderId,
    ],
  );
  return mapPaymentOrder(rows[0]!);
}
```

- [ ] **Step 5: 实现测试支付服务商**

```ts
import type { PaymentProvider } from "./provider.ts";

export function createTestPaymentProvider(): PaymentProvider {
  return {
    id: "test",
    async createPayment(input) {
      return {
        provider: "test",
        providerOrderId: "test-" + input.orderId,
        redirectUrl: "/pricing?testOrder=" + input.orderId,
        payload: { amountCents: input.amountCents },
      };
    },
    async verifyWebhook(request) {
      const body = await request.json();
      return {
        provider: "test",
        providerEventId: String(body.eventId),
        providerOrderId: String(body.providerOrderId),
        providerTransactionId: String(body.transactionId),
        status: "paid",
        amountCents: Number(body.amountCents),
        currency: "CNY",
        raw: body,
      };
    },
  };
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/payments/orders.server.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/lib/payments/provider.ts src/lib/payments/provider-registry.server.ts src/lib/payments/orders.server.ts src/lib/payments/test-provider.server.ts src/lib/payments/orders.server.test.ts
git commit -m "feat: add payment order and provider abstraction"
```

---

### Task 10: 支付回调、幂等加点和点数流水

**Files:**
- Create: `src/lib/payments/webhook.server.ts`
- Create: `src/routes/api/payments/webhook.ts`
- Test: `src/lib/payments/webhook.server.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `PaymentProvider`、`PaymentWebhookEvent`。
- Produces:
  - `processPaymentWebhook(event: PaymentWebhookEvent): Promise<{ processed: boolean }>`
  - `POST /api/payments/webhook`。

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getSql } from "../db.ts";
import { processPaymentWebhook } from "./webhook.server.ts";

test("duplicate webhook does not add credits twice", async () => {
  const sql = await getSql();
  const userId = randomUUID();
  const walletId = randomUUID();
  const orderId = randomUUID();
  await sql.query(
    `insert into "user" (id, name, email, "emailVerified", phone) values ($1,$2,$3,true,$4)`,
    [userId, "buyer", userId + "@phone.invalid", "13800138002"],
  );
  await sql.query("insert into credit_wallets (id, user_id) values ($1,$2)", [walletId, userId]);
  await sql.query(
    `insert into payment_orders (id, user_id, wallet_id, package_code, points, amount_cents, provider, provider_order_id, status, expires_at) values ($1,$2,$3,'ten',10,941,'test','test-order-1','pending', now() + interval '30 minutes')`,
    [orderId, userId, walletId],
  );
  const event = {
    provider: "test",
    providerEventId: "event-1",
    providerOrderId: "test-order-1",
    providerTransactionId: "txn-1",
    status: "paid" as const,
    amountCents: 941,
    currency: "CNY",
    raw: {},
  };
  const first = await processPaymentWebhook(event);
  const second = await processPaymentWebhook(event);
  assert.equal(first.processed, true);
  assert.equal(second.processed, false);
  const wallets = await sql.query<{ balance: number }>(
    "select balance from credit_wallets where id = $1",
    [walletId],
  );
  assert.equal(Number(wallets[0]?.balance), 10);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/payments/webhook.server.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现回调幂等处理**

```ts
import { randomUUID } from "node:crypto";
import { getSql } from "../db.ts";
import type { PaymentWebhookEvent } from "./provider.ts";

export async function processPaymentWebhook(event: PaymentWebhookEvent) {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `with inserted_event as (
       insert into payment_events (
         id, provider, provider_event_id, order_id, payload, status
       ) values ($1,$2,$3,null,$4::jsonb,'received')
       on conflict (provider_event_id) do nothing
       returning id
     ), target_order as (
       select * from payment_orders
       where provider = $2 and provider_order_id = $5
       for update
     ), paid_order as (
       update payment_orders o
       set status = 'paid',
           provider_transaction_id = $6,
           paid_at = now(),
           updated_at = now()
       from target_order t, inserted_event e
       where o.id = t.id
         and o.status = 'pending'
         and o.amount_cents = $7
         and o.currency = $8
       returning o.id, o.wallet_id, o.points
     ), wallet_update as (
       update credit_wallets w
       set balance = w.balance + p.points,
           version = w.version + 1,
           updated_at = now()
       from paid_order p
       where w.id = p.wallet_id
       returning w.id, w.balance
     ), ledger as (
       insert into credit_ledger (
         id, wallet_id, delta, balance_after, reason, order_id, note
       )
       select $9, u.id, p.points, u.balance, 'purchase', p.id, '购买点数'
       from wallet_update u join paid_order p on p.wallet_id = u.id
       returning id
     )
     select (select count(*) from ledger)::int as processed`,
    [
      randomUUID(),
      event.provider,
      event.providerEventId,
      JSON.stringify(event.raw),
      event.providerOrderId,
      event.providerTransactionId,
      event.amountCents,
      event.currency,
      randomUUID(),
    ],
  );
  return { processed: Number(rows[0]?.processed ?? 0) > 0 };
}
```

- [ ] **Step 4: 实现回调路由**

```ts
import { createFileRoute } from "@tanstack/react-router";
import { getPaymentProvider } from "@/lib/payments/provider-registry.server";
import { processPaymentWebhook } from "@/lib/payments/webhook.server";

export const Route = createFileRoute("/api/payments/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provider = getPaymentProvider();
        const event = await provider.verifyWebhook(request);
        const result = await processPaymentWebhook(event);
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/payments/webhook.server.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/lib/payments/webhook.server.ts src/routes/api/payments/webhook.ts src/lib/payments/webhook.server.test.ts
git commit -m "feat: process payment webhooks idempotently"
```

---

### Task 11: 首个生产支付适配器

**Files:**
- Create: `src/lib/payments/wechat-pay.server.ts`
- Modify: `src/lib/payments/provider-registry.server.ts`
- Test: `src/lib/payments/wechat-pay.server.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `PaymentProvider`。
- Produces:
  - `getPaymentProvider(): PaymentProvider`
  - 生产环境 `PAYMENT_PROVIDER=wechat`。

**实施决策：** 首期生产适配器固定为微信支付 API v3。支付宝按钮保留在 UI 中，但未配置第二个适配器时置灰并显示“暂未开放”。

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { assertWechatAmount } from "./wechat-pay.server.ts";

test("wechat amount must match local order cents", () => {
  assert.doesNotThrow(() => assertWechatAmount(941, 941));
  assert.throws(() => assertWechatAmount(941, 1), /金额不匹配/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/payments/wechat-pay.server.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现微信支付适配器骨架**

必须提供以下环境变量：

- `WECHAT_PAY_MCH_ID`
- `WECHAT_PAY_APP_ID`
- `WECHAT_PAY_SERIAL_NO`
- `WECHAT_PAY_PRIVATE_KEY`
- `WECHAT_PAY_API_V3_KEY`
- `WECHAT_PAY_PLATFORM_CERT`
- `WECHAT_PAY_NOTIFY_URL`

适配器职责：

- 生成微信支付预下单请求。
- 使用商户私钥生成签名。
- 返回二维码或 H5 跳转地址。
- 回调使用平台证书验签。
- 解密回调资源并转换为 `PaymentWebhookEvent`。
- 校验 amount、currency、订单号。

- [ ] **Step 4: 实现 provider registry**

```ts
import { createTestPaymentProvider } from "./test-provider.server.ts";
import { createWechatPayProvider } from "./wechat-pay.server.ts";
import type { PaymentProvider } from "./provider.ts";

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  const kind = process.env.PAYMENT_PROVIDER?.trim() || "test";
  if (process.env.NODE_ENV === "production" && kind === "test") {
    throw new Error("生产环境禁止使用测试支付服务商");
  }
  if (kind === "test") cached = createTestPaymentProvider();
  else if (kind === "wechat") cached = createWechatPayProvider();
  else throw new Error("不支持的支付服务商");
  return cached;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/payments/wechat-pay.server.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/lib/payments/wechat-pay.server.ts src/lib/payments/provider-registry.server.ts src/lib/payments/wechat-pay.server.test.ts
git commit -m "feat: add production wechat payment adapter"
```

---

### Task 12: 规划生成接入免费与点数预留

**Files:**
- Modify: `src/lib/entitlements.server.ts`
- Modify: `src/lib/entitlements.functions.ts`
- Modify: `src/components/planner/PlannerPrototype.tsx`
- Modify: `src/components/planner/plan-output/use-guidebook-export.ts`
- Test: `src/lib/planner-entitlement.integration.test.ts`

**Interfaces:**
- Consumes: Task 5、Task 7、Task 8。
- Produces:
  - `preparePlanGeneration(userId: string | null, planId: string): Promise<GenerationPermission | GenerationDecision>`
  - `GenerationDecision`：
    - `{ kind: "guest" }`
    - `{ kind: "free"; userId: string }`
    - `{ kind: "needs_confirmation"; userId: string }`
    - `{ kind: "needs_login" }`
    - `{ kind: "needs_purchase" }`
  - `GenerationPermission`：
    - `{ kind: "guest" }`
    - `{ kind: "free"; userId: string }`
    - `{ kind: "paid"; reservationId: string }`
    - `{ kind: "needs_login" }`
    - `{ kind: "needs_purchase" }`

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { decideGenerationPermission } from "./entitlements.server.ts";

test("returns purchase when free trial used and balance is zero", () => {
  assert.deepEqual(
    decideGenerationPermission({
      userId: "u1",
      wallet: { balance: 0, reserved: 0, freeTrialClaimed: true },
    }),
    { kind: "needs_purchase" },
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/planner-entitlement.integration.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现纯权限判断**

```ts
export type GenerationDecision =
  | { kind: "guest" }
  | { kind: "free"; userId: string }
  | { kind: "needs_confirmation"; userId: string }
  | { kind: "needs_login" }
  | { kind: "needs_purchase" };

export function decideGenerationPermission(input: {
  userId: string | null;
  wallet: { balance: number; reserved: number; freeTrialClaimed: boolean } | null;
}): GenerationDecision {
  if (!input.userId) return { kind: "guest" };
  if (!input.wallet) return { kind: "needs_purchase" };
  if (!input.wallet.freeTrialClaimed) return { kind: "free", userId: input.userId };
  if (input.wallet.balance - input.wallet.reserved >= 1) {
    return { kind: "needs_confirmation", userId: input.userId };
  }
  return { kind: "needs_purchase" };
}
```

- [ ] **Step 4: 实现预留函数**

```ts
export async function reservePaidGeneration(userId: string, planId: string) {
  const reservation = await reserveCredit(userId, planId);
  return { kind: "paid" as const, reservationId: reservation.id };
}

export async function preparePlanGeneration(userId: string | null, planId: string) {
  if (!userId) return claimGuestGenerationAttempt();
  const wallet = await ensureWallet(userId);
  const decision = decideGenerationPermission({
    userId,
    wallet: {
      balance: wallet.balance,
      reserved: wallet.reserved,
      freeTrialClaimed: wallet.freeTrialClaimed,
    },
  });
  return decision;
}
```

- [ ] **Step 5: 在规划前调用权益检查**

在 `PlannerPrototype.tsx` 的规划 effect 中，调用 `livePlannerFn` 之前先调用 `preparePlanGeneration`。

分支规则：

- `guest`：继续生成；服务端设置 `guest_generation_used` Cookie。
- `free`：继续生成；成功后调用 `claimCurrentPlan`。
- `needs_login`：跳转 `/auth?returnTo=/`。
- `needs_purchase`：显示 B 点册入口。
- `needs_confirmation`：弹窗显示“本次将消耗 1 点”；确认后才预留。
- `paid`：成功后调用 `finishPaidPlan`。
- 生成失败：调用 `releaseReservation`，不得扣点。

- [ ] **Step 6: 加访客防滥用**

在 `entitlements.server.ts` 中增加以下实现，Cookie 使用 `HttpOnly`、`SameSite=Lax`、`Secure`，有效期 24 小时：

```ts
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";

const GUEST_GENERATION_COOKIE = "guest_generation_used";

export async function claimGuestGenerationAttempt() {
  if (getCookie(GUEST_GENERATION_COOKIE)) return { kind: "needs_login" as const };
  setCookie(GUEST_GENERATION_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24,
    path: "/",
  });
  return { kind: "guest" as const };
}

export function releaseGuestGenerationAttempt() {
  deleteCookie(GUEST_GENERATION_COOKIE, { path: "/" });
}
```

- [ ] **Step 7: PDF 和分享入口登录检查**

在 `use-guidebook-export.ts`：

- 未登录：跳转 `/auth?returnTo=<当前页>`。
- 登录但行程尚未 claim：先调用 `claimCurrentPlan`。
- claim 成功后继续 PDF。

分享按钮使用同一权益检查。

- [ ] **Step 8: 运行测试**

Run: `node --experimental-strip-types --test src/lib/planner-entitlement.integration.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add src/lib/entitlements.server.ts src/lib/entitlements.functions.ts src/components/planner/PlannerPrototype.tsx src/components/planner/plan-output/use-guidebook-export.ts src/lib/planner-entitlement.integration.test.ts
git commit -m "feat: gate planning and exports with credits"
```

---

### Task 13: 行程分享链接

**Files:**
- Create: `src/lib/shares.server.ts`
- Create: `src/lib/shares.functions.ts`
- Create: `src/routes/share/$token.tsx`
- Create: `src/components/share/SharedGuidebookPage.tsx`
- Test: `src/lib/shares.server.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `travel_plans`、Task 1 的 `plan_shares`。
- Produces:
  - `createPlanShare(userId: string, planId: string): Promise<{ url: string }>`
  - `resolvePlanShare(token: string): Promise<{ plan: TripPlan } | null>`

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { hashShareToken } from "./shares.server.ts";

test("share token is never stored raw", () => {
  const token = "abc123";
  const hash = hashShareToken(token);
  assert.notEqual(hash, token);
  assert.equal(hash.length, 64);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/shares.server.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现分享服务**

```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getSql } from "./db.ts";
import type { TripPlan } from "./travel-plan.ts";

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createPlanShare(userId: string, planId: string) {
  const token = randomBytes(32).toString("base64url");
  const sql = await getSql();
  await sql.query(
    `insert into plan_shares (id, plan_id, owner_user_id, token_hash, status)
     values ($1,$2,$3,$4,'active')`,
    [randomUUID(), planId, userId, hashShareToken(token)],
  );
  return { url: "/share/" + token };
}

export async function resolvePlanShare(token: string): Promise<{ plan: TripPlan } | null> {
  const sql = await getSql();
  const rows = await sql.query<{ plan_data: TripPlan }>(
    `select p.plan_data
     from plan_shares s
     join travel_plans p on p.id = s.plan_id
     where s.token_hash = $1 and s.status = 'active'
       and (s.expires_at is null or s.expires_at > now())`,
    [hashShareToken(token)],
  );
  return rows[0] ? { plan: rows[0].plan_data } : null;
}
```

- [ ] **Step 4: 实现分享 server function**

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./auth/middleware.ts";
import { createPlanShare } from "./shares.server.ts";

export const sharePlan = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ planId: z.string().min(1) }))
  .handler(async ({ context, data }) => createPlanShare(context.userId, data.planId));
```

- [ ] **Step 5: 实现只读分享页**

`src/routes/share/$token.tsx` 加载 `resolvePlanShare`：

- 命中时渲染 `SharedGuidebookPage`。
- 未命中显示“链接不存在或已失效”。
- 页面不显示购买、账号、管理入口。
- 页面只读，不提供重新规划。
- 可以下载 PDF，但 PDF 不显示用户手机号。

- [ ] **Step 6: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/shares.server.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/lib/shares.server.ts src/lib/shares.functions.ts src/routes/share/$token.tsx src/components/share/SharedGuidebookPage.tsx src/lib/shares.server.test.ts
git commit -m "feat: add read-only plan sharing"
```

---

### Task 14: 管理员授权、账号与审计服务

**Files:**
- Create: `src/lib/admin.server.ts`
- Create: `src/lib/admin.functions.ts`
- Test: `src/lib/admin.server.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `admin_audit_logs`、Task 5 的钱包与流水。
- Produces:
  - `requireAdmin(userId: string): Promise<void>`
  - `adjustCredits(input: AdminCreditAdjustment): Promise<CreditLedgerEntry>`
  - `setUserStatus(adminUserId: string, userId: string, status: UserStatus): Promise<void>`
  - `listAdminUsers(): Promise<AdminUserRow[]>`
  - `listAdminOrders(): Promise<PaymentOrder[]>`

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { requireAdmin } from "./admin.server.ts";

test("normal user cannot act as admin", async () => {
  await assert.rejects(() => requireAdmin("normal-user"), /管理员权限/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/admin.server.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现管理员校验**

```ts
import { getSql } from "./db.ts";

export async function requireAdmin(userId: string): Promise<void> {
  const sql = await getSql();
  const rows = await sql.query<{ role: string; status: string }>(
    'select role, status from "user" where id = $1',
    [userId],
  );
  if (rows[0]?.role !== "admin" || rows[0]?.status !== "active") {
    throw new Error("需要管理员权限");
  }
}
```

- [ ] **Step 4: 实现管理员调整点数和审计**

调整点数必须在一个原子 SQL 中完成：

- 更新钱包余额。
- 插入 `credit_ledger`，reason = `admin_adjustment`。
- 插入 `admin_audit_logs`。

```ts
export type AdminCreditAdjustment = {
  adminUserId: string;
  userId: string;
  delta: number;
  note: string;
};

export async function adjustCredits(input: AdminCreditAdjustment) {
  await requireAdmin(input.adminUserId);
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new Error("点数变更必须为非零整数");
  if (input.note.trim().length < 2) throw new Error("必须填写调整原因");
  const sql = await getSql();
  const rows = await sql.query(
    `with target_wallet as (
       select id, balance from credit_wallets where user_id = $1 for update
     ), updated_wallet as (
       update credit_wallets w
       set balance = w.balance + $2,
           version = w.version + 1,
           updated_at = now()
       from target_wallet t
       where w.id = t.id and w.balance + $2 >= 0
       returning w.id, w.balance
     ), ledger as (
       insert into credit_ledger (
         id, wallet_id, delta, balance_after, reason, operator_user_id, note
       )
       select $3, id, $2, balance, 'admin_adjustment', $4, $5
       from updated_wallet
       returning *
     ), audit as (
       insert into admin_audit_logs (
         id, admin_user_id, action, target_user_id, details
       )
       values ($6, $4, 'adjust_credits', $1, jsonb_build_object('delta', $2, 'note', $5))
       returning id
     )
     select * from ledger`,
    [input.userId, input.delta, randomUUID(), input.adminUserId, input.note.trim(), randomUUID()],
  );
  if (!rows[0]) throw new Error("点数调整失败：余额不足或钱包不存在");
  return rows[0];
}
```

- [ ] **Step 5: 实现管理员查询**

- 用户列表必须返回脱敏手机号。
- 订单列表返回金额、套餐、状态和时间。
- 流水列表按创建时间倒序。
- 管理员查看完整手机号时必须写审计事件 `view_full_phone`。

- [ ] **Step 6: 实现 server functions**

所有管理员 server function 必须使用 `authMiddleware`，再在 handler 中调用 `requireAdmin(context.userId)`。

- [ ] **Step 7: 运行测试确认通过**

Run: `node --experimental-strip-types --test src/lib/admin.server.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/lib/admin.server.ts src/lib/admin.functions.ts src/lib/admin.server.test.ts
git commit -m "feat: add admin authorization and audit service"
```

---

### Task 15: 管理员后台页面

**Files:**
- Create: `src/routes/admin.tsx`
- Create: `src/components/admin/AdminDashboard.tsx`
- Test: `src/components/admin/AdminDashboard.test.tsx`

**Interfaces:**
- Consumes: Task 14 的管理员 server functions。
- Produces: `/admin` 路由和管理后台。

- [ ] **Step 1: 写失败组件测试**

```tsx
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminDashboard } from "./AdminDashboard.tsx";

test("admin dashboard shows key metrics and tables", () => {
  const html = renderToStaticMarkup(
    <AdminDashboard
      metrics={{ users: 3, orders: 2, revenueCents: 1882, plans: 5 }}
      users={[]}
      orders={[]}
      ledger={[]}
    />,
  );
  assert.match(html, /用户/);
  assert.match(html, /订单/);
  assert.match(html, /收入/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `tsx --test src/components/admin/AdminDashboard.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现后台页面**

页面必须包含：

- 顶部统计卡：用户数、订单数、收入、生成次数。
- 用户表：脱敏手机号、角色、状态、点数。
- 订单表：套餐、金额、状态、时间。
- 流水表：原因、变化、余额、时间。
- 调整点数表单：用户、正负值、原因。
- 停用/启用用户按钮。
- 所有破坏性操作必须二次确认。

- [ ] **Step 4: 实现路由权限**

`/admin`：

- 未登录：跳转 `/auth?returnTo=/admin`。
- 非管理员：显示 403 页面。
- 管理员：渲染 `AdminDashboard`。
- 不在普通页面导航中展示管理员入口。

- [ ] **Step 5: 运行测试确认通过**

Run: `tsx --test src/components/admin/AdminDashboard.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/routes/admin.tsx src/components/admin/AdminDashboard.tsx src/components/admin/AdminDashboard.test.tsx
git commit -m "feat: add admin dashboard"
```

---

### Task 16: 端到端验收、部署配置和文档

**Files:**
- Create: `scripts/commercial-flow.e2e.test.mjs`
- Modify: `package.json`
- Modify: `src/lib/planner.test.ts` 或新增 `src/lib/commercial-flow.test.ts`
- Modify: `docs/03-deployment-and-operations.md`
- Modify: `docs/superpowers/specs/2026-09-27-commercial-account-points-design.md`
- Test: `scripts/commercial-flow.e2e.test.mjs`

**Interfaces:**
- Consumes: Task 1–15 所有接口。
- Produces: 可上线的端到端商业化闭环。

- [ ] **Step 1: 增加测试脚本**

在 `package.json` 的 `test` 命令中增加：

```json
"test:commercial": "node --test --test-concurrency=1 scripts/commercial-flow.e2e.test.mjs"
```

并把命令接入总 `npm test`。

- [ ] **Step 2: 写端到端测试**

测试流程：

1. 启动 PGlite 测试数据库。
2. 创建访客并生成第一份行程。
3. 注册手机号账号。
4. claim 第一份行程。
5. 检查钱包 `freeTrialClaimed=true`。
6. 尝试生成第二份行程。
7. 检查余额 0 时返回 `needs_purchase`。
8. 创建 10 次订单。
9. 调用测试支付回调。
10. 检查余额为 10。
11. 再次生成并消费 1 点。
12. 检查余额为 9。
13. 重复支付回调。
14. 检查余额仍为 9。
15. 创建分享链接。
16. 未登录读取分享路书。
17. 检查分享页不包含手机号、订单和钱包。

- [ ] **Step 3: 运行端到端测试**

Run: `npm run test:commercial`

Expected: PASS。

- [ ] **Step 4: 运行全量测试**

Run: `npm run typecheck && npm test`

Expected: PASS。

- [ ] **Step 5: 更新部署文档**

在 `docs/03-deployment-and-operations.md` 增加：

- `VITE_AUTH_ENABLED=true`。
- `BETTER_AUTH_SECRET`。
- `PAYMENT_PROVIDER=wechat`。
- 微信支付环境变量。
- 首次管理员升级 SQL。
- 支付回调 URL。
- 上线前必须验证支付回调验签和金额校验。

- [ ] **Step 6: 更新设计文档状态**

把 `docs/superpowers/specs/2026-09-27-commercial-account-points-design.md` 状态改为“已确认并进入实施”。

- [ ] **Step 7: 生产发布前检查**

- [ ] `DATABASE_URL` 指向 Supabase，且迁移成功。
- [ ] `VITE_AUTH_ENABLED=true`。
- [ ] `BETTER_AUTH_SECRET` 已设置。
- [ ] `PAYMENT_PROVIDER=wechat`。
- [ ] 微信支付商户配置完整。
- [ ] 支付回调地址可从公网访问。
- [ ] 测试支付订单不进入生产数据。
- [ ] 生产管理员账号已通过 Supabase `role=admin` 升级。
- [ ] 普通注册不能创建管理员。
- [ ] 分享链接不泄露账号信息。
- [ ] 首页、规划、路书、PDF、登录、购买、分享均通过浏览器验收。

- [ ] **Step 8: 提交**

```bash
git add package.json scripts/commercial-flow.e2e.test.mjs src/lib/commercial-flow.test.ts docs/03-deployment-and-operations.md docs/superpowers/specs/2026-09-27-commercial-account-points-design.md
git commit -m "test: verify commercial account and points flow"
```

---

## Spec Coverage

| 设计章节 | 对应任务 |
| --- | --- |
| 目标用户、收费模式、套餐价格 | Task 8 |
| 首次免费、访客生成、账号 claim | Task 7、Task 12 |
| 页面入口、B 路引册页 | Task 8 |
| 手机号账号、注册登录、密码规则 | Task 2、Task 3、Task 4 |
| 用户角色与管理员 | Task 14、Task 15 |
| 用户扩展、钱包、流水、预留 | Task 1、Task 5 |
| 订单、支付事件、回调幂等 | Task 9、Task 10、Task 11 |
| 点数消费、失败释放、并发保护 | Task 5、Task 12 |
| 行程持久化与分享 | Task 7、Task 13 |
| 管理员审计和安全 | Task 14、Task 15 |
| 测试、部署和验收 | Task 16 |

## Plan Checks

- **Spec coverage:** 设计文档中的账号、钱包、点数、支付、B 点册、首次免费、管理员、分享、安全和测试章节均有对应任务。
- **Placeholder scan:** 本计划不使用 TODO/TBD/待补，所有任务均包含测试、运行命令和实现内容。
- **Type consistency:** 套餐使用 `PackageCode`；权限使用 `GenerationPermission`；钱包使用 `CreditWallet`、`CreditLedgerEntry`、`CreditReservation`；订单使用 `PaymentOrder`。后续任务只引用前序任务定义的接口。
- **执行顺序:** 每个 Task 都产生可单独测试和提交的交付物；Task 1–5 是硬前置，Task 6–13 可在底座稳定后并行拆分，Task 14–16 依赖账号、钱包和订单完成。
