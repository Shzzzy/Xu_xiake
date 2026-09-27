import { randomUUID } from "node:crypto";
import { maskPhone } from "./auth/phone.ts";
import type { CreditLedgerEntry, PaymentOrder, UserStatus } from "./credits/types.ts";

type Row = Record<string, unknown>;

type AdminSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: AdminSql) => Promise<T>): Promise<T>;
};

export type AdminUserRow = {
  id: string;
  phoneMasked: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
  balance: number;
  reserved: number;
  freeTrialClaimed: boolean;
  createdAt: string;
};

export type AdminOrderRow = Pick<
  PaymentOrder,
  | "id"
  | "userId"
  | "packageCode"
  | "points"
  | "amountCents"
  | "currency"
  | "provider"
  | "status"
  | "paidAt"
  | "createdAt"
>;

export type AdminLedgerRow = CreditLedgerEntry & {
  userPhoneMasked: string | null;
};

export type AdminMetrics = {
  users: number;
  orders: number;
  revenueCents: number;
  plans: number;
};

export type AdminDashboardData = {
  metrics: AdminMetrics;
  users: AdminUserRow[];
  orders: AdminOrderRow[];
  ledger: AdminLedgerRow[];
};

export type AdminCreditAdjustment = {
  adminUserId: string;
  userId: string;
  delta: number;
  note: string;
};

export class AdminPermissionError extends Error {
  readonly status = 403;
  readonly code = "ADMIN_PERMISSION_REQUIRED";

  constructor() {
    super("需要管理员权限");
    this.name = "AdminPermissionError";
  }
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function mapLedger(row: Row): CreditLedgerEntry {
  return {
    id: String(row.id),
    walletId: String(row.wallet_id),
    delta: Number(row.delta),
    balanceAfter: Number(row.balance_after),
    reason: String(row.reason) as CreditLedgerEntry["reason"],
    orderId: nullableString(row.order_id),
    planId: nullableString(row.plan_id),
    operatorUserId: nullableString(row.operator_user_id),
    note: nullableString(row.note),
    createdAt: toIsoString(row.created_at),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapOrder(row: Row): PaymentOrder {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    walletId: String(row.wallet_id),
    packageCode: String(row.package_code) as PaymentOrder["packageCode"],
    points: Number(row.points),
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    provider: String(row.provider),
    providerOrderId: nullableString(row.provider_order_id),
    providerTransactionId: nullableString(row.provider_transaction_id),
    status: String(row.status) as PaymentOrder["status"],
    paidAt: row.paid_at == null ? null : toIsoString(row.paid_at),
    creditsAppliedAt: row.credits_applied_at == null ? null : toIsoString(row.credits_applied_at),
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    clientRequestId: nullableString(row.client_request_id),
    redirectUrl: nullableString(row.provider_redirect_url),
    paymentPayload: parseJsonObject(row.provider_payload),
  };
}

async function requireAdminWithSql(sql: AdminSql, userId: string): Promise<void> {
  if (!userId) throw new AdminPermissionError();
  const rows = await sql.query<{ role: string; status: string }>(
    'select role, status from "user" where id = $1 limit 1',
    [userId],
  );
  if (rows[0]?.role !== "admin" || rows[0]?.status !== "active") {
    throw new AdminPermissionError();
  }
}

export type AdminService = {
  requireAdmin(userId: string): Promise<void>;
  adjustCredits(input: AdminCreditAdjustment): Promise<CreditLedgerEntry>;
  setUserStatus(adminUserId: string, userId: string, status: UserStatus): Promise<void>;
  listAdminUsers(): Promise<AdminUserRow[]>;
  listAdminOrders(): Promise<PaymentOrder[]>;
  listAdminLedger(limit?: number): Promise<AdminLedgerRow[]>;
  getAdminMetrics(): Promise<AdminMetrics>;
  getDashboard(): Promise<AdminDashboardData>;
  revealFullPhone(adminUserId: string, userId: string): Promise<string | null>;
};

/** 使用注入 SQL 构造管理员服务，所有权限判断都在服务端执行。 */
export function createAdminService(sql: AdminSql): AdminService {
  async function listAdminUsers(): Promise<AdminUserRow[]> {
    const rows = await sql.query<Row>(
      `select u.id, u.phone, u.role, u.status, u."createdAt" as created_at,
              coalesce(w.balance, 0)::int as balance,
              coalesce(w.reserved, 0)::int as reserved,
              coalesce(w.free_trial_claimed, false) as free_trial_claimed
         from "user" u
         left join credit_wallets w on w.user_id = u.id
        order by u."createdAt" desc, u.id desc`,
    );
    return rows.map((row) => ({
      id: String(row.id),
      phoneMasked: row.phone == null ? null : maskPhone(String(row.phone)),
      role: String(row.role) === "admin" ? "admin" : "user",
      status: String(row.status) === "disabled" ? "disabled" : "active",
      balance: Number(row.balance),
      reserved: Number(row.reserved),
      freeTrialClaimed: Boolean(row.free_trial_claimed),
      createdAt: toIsoString(row.created_at),
    }));
  }

  async function listAdminOrders(): Promise<PaymentOrder[]> {
    const rows = await sql.query<Row>(
      "select * from payment_orders order by created_at desc, id desc limit 500",
    );
    return rows.map(mapOrder);
  }

  async function listAdminLedger(limit = 200): Promise<AdminLedgerRow[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const rows = await sql.query<Row>(
      `select l.*, u.phone as user_phone
         from credit_ledger l
         join credit_wallets w on w.id = l.wallet_id
         join "user" u on u.id = w.user_id
        order by l.created_at desc, l.id desc
        limit $1`,
      [safeLimit],
    );
    return rows.map((row) => ({
      ...mapLedger(row),
      userPhoneMasked: row.user_phone == null ? null : maskPhone(String(row.user_phone)),
    }));
  }

  async function getAdminMetrics(): Promise<AdminMetrics> {
    const [users, orders, revenue, plans] = await Promise.all([
      sql.query<{ count: number }>('select count(*)::int as count from "user"'),
      sql.query<{ count: number }>("select count(*)::int as count from payment_orders"),
      sql.query<{ total: number | null }>(
        "select coalesce(sum(amount_cents), 0)::int as total from payment_orders where status = 'paid'",
      ),
      sql.query<{ count: number }>("select count(*)::int as count from travel_plans"),
    ]);
    return {
      users: Number(users[0]?.count ?? 0),
      orders: Number(orders[0]?.count ?? 0),
      revenueCents: Number(revenue[0]?.total ?? 0),
      plans: Number(plans[0]?.count ?? 0),
    };
  }

  async function getDashboard(): Promise<AdminDashboardData> {
    const [metrics, users, orders, ledger] = await Promise.all([
      getAdminMetrics(),
      listAdminUsers(),
      listAdminOrders(),
      listAdminLedger(),
    ]);
    return {
      metrics,
      users,
      orders: orders.map((order) => ({
        id: order.id,
        userId: order.userId,
        packageCode: order.packageCode,
        points: order.points,
        amountCents: order.amountCents,
        currency: order.currency,
        provider: order.provider,
        status: order.status,
        paidAt: order.paidAt,
        createdAt: order.createdAt,
      })),
      ledger,
    };
  }

  async function adjustCredits(input: AdminCreditAdjustment): Promise<CreditLedgerEntry> {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new Error("点数变更必须为非零整数");
    }
    const note = input.note.trim();
    if (note.length < 2) throw new Error("必须填写调整原因");

    return sql.transaction(async (tx) => {
      await requireAdminWithSql(tx, input.adminUserId);
      const wallets = await tx.query<{ id: string; balance: number }>(
        "select id, balance from credit_wallets where user_id = $1 for update",
        [input.userId],
      );
      const wallet = wallets[0];
      if (!wallet) throw new Error("点数调整失败：钱包不存在");
      const nextBalance = Number(wallet.balance) + input.delta;
      if (nextBalance < 0) throw new Error("点数调整失败：余额不能为负数");

      await tx.query(
        `update credit_wallets
            set balance = $1, version = version + 1, updated_at = now()
          where id = $2`,
        [nextBalance, wallet.id],
      );
      const ledgerRows = await tx.query<Row>(
        `insert into credit_ledger (
           id, wallet_id, delta, balance_after, reason, operator_user_id, note
         ) values ($1, $2, $3, $4, 'admin_adjustment', $5, $6)
         returning *`,
        [randomUUID(), wallet.id, input.delta, nextBalance, input.adminUserId, note],
      );
      const entry = ledgerRows[0];
      if (!entry) throw new Error("点数调整失败：流水写入失败");

      await tx.query(
        `insert into admin_audit_logs (id, admin_user_id, action, target_user_id, details)
         values ($1, $2, 'adjust_credits', $3, $4::jsonb)`,
        [
          randomUUID(),
          input.adminUserId,
          input.userId,
          JSON.stringify({ delta: input.delta, note }),
        ],
      );
      return mapLedger(entry);
    });
  }

  async function setUserStatus(
    adminUserId: string,
    userId: string,
    status: UserStatus,
  ): Promise<void> {
    if (status !== "active" && status !== "disabled") throw new Error("无效的账号状态");
    if (adminUserId === userId && status === "disabled") {
      throw new Error("不能停用当前管理员账号");
    }

    await sql.transaction(async (tx) => {
      await requireAdminWithSql(tx, adminUserId);
      const users = await tx.query<{ id: string }>(
        'select id from "user" where id = $1 for update',
        [userId],
      );
      if (!users[0]) throw new Error("目标账号不存在");
      await tx.query('update "user" set status = $2 where id = $1', [userId, status]);
      await tx.query(
        `insert into admin_audit_logs (id, admin_user_id, action, target_user_id, details)
         values ($1, $2, 'set_user_status', $3, $4::jsonb)`,
        [randomUUID(), adminUserId, userId, JSON.stringify({ status })],
      );
    });
  }

  async function revealFullPhone(adminUserId: string, userId: string): Promise<string | null> {
    await requireAdminWithSql(sql, adminUserId);
    const rows = await sql.query<{ phone: string | null }>(
      'select phone from "user" where id = $1',
      [userId],
    );
    if (!rows[0]) throw new Error("目标账号不存在");
    await sql.query(
      `insert into admin_audit_logs (id, admin_user_id, action, target_user_id, details)
       values ($1, $2, 'view_full_phone', $3, '{}'::jsonb)`,
      [randomUUID(), adminUserId, userId],
    );
    return rows[0].phone ?? null;
  }

  return {
    requireAdmin: (userId) => requireAdminWithSql(sql, userId),
    adjustCredits,
    setUserStatus,
    listAdminUsers,
    listAdminOrders,
    listAdminLedger,
    getAdminMetrics,
    getDashboard,
    revealFullPhone,
  };
}

let defaultServicePromise: Promise<AdminService> | null = null;

async function getDefaultService(): Promise<AdminService> {
  defaultServicePromise ??= (async () => {
    const { getSql } = await import("./db.ts");
    return createAdminService(await getSql());
  })().catch((error) => {
    defaultServicePromise = null;
    throw error;
  });
  return defaultServicePromise;
}

export async function requireAdmin(userId: string): Promise<void> {
  return (await getDefaultService()).requireAdmin(userId);
}

export async function adjustCredits(input: AdminCreditAdjustment): Promise<CreditLedgerEntry> {
  return (await getDefaultService()).adjustCredits(input);
}

export async function setUserStatus(
  adminUserId: string,
  userId: string,
  status: UserStatus,
): Promise<void> {
  return (await getDefaultService()).setUserStatus(adminUserId, userId, status);
}

export async function listAdminUsers(): Promise<AdminUserRow[]> {
  return (await getDefaultService()).listAdminUsers();
}

export async function listAdminOrders(): Promise<PaymentOrder[]> {
  return (await getDefaultService()).listAdminOrders();
}

export async function listAdminLedger(limit = 200): Promise<AdminLedgerRow[]> {
  return (await getDefaultService()).listAdminLedger(limit);
}

export async function getAdminMetrics(): Promise<AdminMetrics> {
  return (await getDefaultService()).getAdminMetrics();
}

export async function getAdminDashboard(): Promise<AdminDashboardData> {
  return (await getDefaultService()).getDashboard();
}

export async function revealFullPhone(adminUserId: string, userId: string): Promise<string | null> {
  return (await getDefaultService()).revealFullPhone(adminUserId, userId);
}
