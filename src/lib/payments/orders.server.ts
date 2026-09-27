import { createHash, randomUUID } from "node:crypto";
import { PACKAGE_CATALOG, resolvePackage, type PackageCode } from "../billing/catalog.ts";
import { createCreditsService } from "../credits.server.ts";
import type { PaymentOrder } from "../credits/types.ts";
import type { PaymentProvider, PaymentWebhookEvent } from "./provider.ts";

type Row = Record<string, unknown>;

export type PaymentSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: PaymentSql) => Promise<T>): Promise<T>;
};

export type PaymentOrdersService = {
  createPaymentOrder(
    userId: string,
    packageCode: PackageCode,
    clientRequestId: string,
  ): Promise<PaymentOrder>;
  getPaymentOrder(userId: string, orderId: string): Promise<PaymentOrder>;
  markOrderPaid(orderId: string, event: PaymentWebhookEvent): Promise<void>;
};

export class PaymentUserNotFoundError extends Error {
  readonly status = 404;
  readonly code = "PAYMENT_USER_NOT_FOUND";

  constructor() {
    super("用户不存在，无法创建支付订单");
    this.name = "PaymentUserNotFoundError";
  }
}

export class PaymentAccountDisabledError extends Error {
  readonly status = 403;
  readonly code = "PAYMENT_ACCOUNT_DISABLED";

  constructor() {
    super("账号已停用，无法创建支付订单");
    this.name = "PaymentAccountDisabledError";
  }
}

export class PaymentOrderNotFoundError extends Error {
  readonly status = 404;
  readonly code = "PAYMENT_ORDER_NOT_FOUND";

  constructor() {
    super("支付订单不存在");
    this.name = "PaymentOrderNotFoundError";
  }
}

export class PaymentIdempotencyConflictError extends Error {
  readonly status = 409;
  readonly code = "PAYMENT_IDEMPOTENCY_CONFLICT";

  constructor(message = "幂等请求参数不一致") {
    super(message);
    this.name = "PaymentIdempotencyConflictError";
  }
}

export class PaymentProviderConflictError extends Error {
  readonly status = 409;
  readonly code = "PAYMENT_PROVIDER_CONFLICT";

  constructor(message = "支付服务商返回结果冲突") {
    super(message);
    this.name = "PaymentProviderConflictError";
  }
}

/** provider 创建租约时长：并发请求在这个窗口内只能有一个调用外部支付服务商。 */
export const PROVIDER_CREATION_LEASE_MS = 30_000;

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
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

function mapPaymentOrder(row: Row): PaymentOrder {
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
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    clientRequestId: nullableString(row.client_request_id),
    redirectUrl: nullableString(row.provider_redirect_url),
    paymentPayload: parseJsonObject(row.provider_payload),
  };
}

function assertPackageCode(value: string): asserts value is PackageCode {
  if (!Object.prototype.hasOwnProperty.call(PACKAGE_CATALOG, value)) {
    throw new Error(`无效点数套餐：${value}`);
  }
}

function normalizeClientRequestId(clientRequestId: string): string {
  if (typeof clientRequestId !== "string") {
    throw new PaymentIdempotencyConflictError("缺少 clientRequestId");
  }
  const value = clientRequestId.trim();
  if (!value) throw new PaymentIdempotencyConflictError("缺少 clientRequestId");
  if (value.length > 128) {
    throw new PaymentIdempotencyConflictError("clientRequestId 不能超过 128 个字符");
  }
  return value;
}

/** 将用户与客户端幂等键派生为稳定订单号，重复请求不会生成第二个本地订单。 */
function buildStableOrderId(userId: string, clientRequestId: string): string {
  const digest = createHash("sha256")
    .update(`payment-order\0${userId}\0${clientRequestId}`)
    .digest("hex")
    .slice(0, 32);
  return `payment_${digest}`;
}

function isCreationLeaseActive(row: Row, nowMs: number): boolean {
  const token = row.provider_creation_token;
  const startedAt = row.provider_creation_started_at;
  if (token == null || startedAt == null) return false;
  const startedMs = new Date(String(startedAt)).getTime();
  if (!Number.isFinite(startedMs)) return true;
  return startedMs + PROVIDER_CREATION_LEASE_MS > nowMs;
}

function assertOrderMatches(
  row: Row,
  userId: string,
  packageCode: PackageCode,
  item: ReturnType<typeof resolvePackage>,
): void {
  if (
    String(row.user_id) !== userId ||
    String(row.package_code) !== packageCode ||
    Number(row.points) !== item.points ||
    Number(row.amount_cents) !== item.amountCents
  ) {
    throw new PaymentIdempotencyConflictError();
  }
}

export function createPaymentOrdersService(
  sql: PaymentSql,
  provider: PaymentProvider,
  now: () => Date = () => new Date(),
): PaymentOrdersService {
  const credits = createCreditsService(sql);

  async function selectOrderForUpdate(tx: PaymentSql, orderId: string): Promise<Row | null> {
    const rows = await tx.query<Row>("select * from payment_orders where id = $1 for update", [
      orderId,
    ]);
    return rows[0] ?? null;
  }

  async function clearCreationLease(orderId: string, token: string): Promise<void> {
    await sql.query(
      `update payment_orders
       set provider_creation_token = null,
           provider_creation_started_at = null,
           updated_at = now()
       where id = $1 and provider_creation_token = $2`,
      [orderId, token],
    );
  }

  async function createPaymentOrder(
    userId: string,
    packageCode: PackageCode,
    clientRequestId: string,
  ): Promise<PaymentOrder> {
    assertPackageCode(packageCode);
    const item = resolvePackage(packageCode);
    const normalizedRequestId = normalizeClientRequestId(clientRequestId);
    const orderId = buildStableOrderId(userId, normalizedRequestId);
    const nowMs = now().getTime();
    const leaseStartedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + 30 * 60_000).toISOString();

    const prepared = await sql.transaction(async (tx) => {
      const users = await tx.query<{ id: string; status: string }>(
        'select id, status from "user" where id = $1 for update',
        [userId],
      );
      const user = users[0];
      if (!user) throw new PaymentUserNotFoundError();
      if (user.status !== "active") throw new PaymentAccountDisabledError();

      let order = await selectOrderForUpdate(tx, orderId);
      if (!order) {
        const wallet = await createCreditsService(tx).ensureWallet(userId);
        const creationToken = randomUUID();
        const inserted = await tx.query<Row>(
          `insert into payment_orders (
             id, user_id, wallet_id, package_code, points, amount_cents, currency,
             provider, provider_order_id, status, expires_at, client_request_id,
             provider_creation_token, provider_creation_started_at
           ) values ($1,$2,$3,$4,$5,$6,'CNY',$7,null,'created',$8,$9,$10,$11)
           on conflict (id) do nothing
           returning *`,
          [
            orderId,
            userId,
            wallet.id,
            item.code,
            item.points,
            item.amountCents,
            provider.id,
            expiresAt,
            normalizedRequestId,
            creationToken,
            leaseStartedAt,
          ],
        );
        if (inserted[0]) return { row: inserted[0], creationToken };
        order = await selectOrderForUpdate(tx, orderId);
      }

      if (!order) throw new Error("支付订单创建失败");
      assertOrderMatches(order, userId, packageCode, item);

      if (order.provider_order_id != null) {
        return { row: order, creationToken: null };
      }
      if (isCreationLeaseActive(order, nowMs)) {
        return { row: order, creationToken: null };
      }

      const creationToken = randomUUID();
      const updated = await tx.query<Row>(
        `update payment_orders
         set provider_creation_token = $2,
             provider_creation_started_at = $3,
             updated_at = now()
         where id = $1
         returning *`,
        [orderId, creationToken, leaseStartedAt],
      );
      if (!updated[0]) throw new Error("支付服务商创建租约获取失败");
      return { row: updated[0], creationToken };
    });

    if (!prepared.creationToken) return mapPaymentOrder(prepared.row);

    const creationToken = prepared.creationToken;
    try {
      const payment = await provider.createPayment({
        orderId,
        amountCents: item.amountCents,
        description: `${item.points} 次旅行规划点数`,
      });
      if (payment.provider !== provider.id) {
        throw new PaymentProviderConflictError("支付服务商返回的 provider 标识不一致");
      }
      if (!payment.providerOrderId.trim()) {
        throw new PaymentProviderConflictError("支付服务商未返回支付单号");
      }

      const updated = await sql.transaction(async (tx) => {
        const rows = await tx.query<Row>(
          `update payment_orders
           set provider_order_id = $2,
               provider_redirect_url = $3,
               provider_payload = $4::jsonb,
               provider_creation_token = null,
               provider_creation_started_at = null,
               updated_at = now()
           where id = $1
             and user_id = $5
             and provider_creation_token = $6
           returning *`,
          [
            orderId,
            payment.providerOrderId,
            payment.redirectUrl,
            JSON.stringify(payment.payload),
            userId,
            creationToken,
          ],
        );
        if (rows[0]) return rows[0];

        const current = await selectOrderForUpdate(tx, orderId);
        if (!current) throw new PaymentOrderNotFoundError();
        assertOrderMatches(current, userId, packageCode, item);
        if (String(current.provider_order_id) === payment.providerOrderId) return current;
        throw new PaymentProviderConflictError("支付服务商创建租约已失效");
      });

      return mapPaymentOrder(updated);
    } catch (error) {
      await clearCreationLease(orderId, creationToken).catch(() => undefined);
      throw error;
    }
  }

  async function getPaymentOrder(userId: string, orderId: string): Promise<PaymentOrder> {
    const rows = await sql.query<Row>(
      "select * from payment_orders where id = $1 and user_id = $2",
      [orderId, userId],
    );
    const row = rows[0];
    if (!row) throw new PaymentOrderNotFoundError();
    return mapPaymentOrder(row);
  }

  async function markOrderPaid(orderId: string, event: PaymentWebhookEvent): Promise<void> {
    if (event.status !== "paid") throw new Error("支付事件状态不是 paid");

    await sql.transaction(async (tx) => {
      const rows = await tx.query<Row>("select * from payment_orders where id = $1 for update", [
        orderId,
      ]);
      const order = rows[0];
      if (!order) throw new PaymentOrderNotFoundError();
      if (String(order.provider) !== event.provider) {
        throw new PaymentProviderConflictError("支付服务商不匹配");
      }
      if (
        Number(order.amount_cents) !== event.amountCents ||
        String(order.currency) !== event.currency
      ) {
        throw new PaymentProviderConflictError("支付金额不匹配");
      }
      if (String(order.provider_order_id) !== event.providerOrderId) {
        throw new PaymentProviderConflictError("支付服务商订单号不匹配");
      }

      if (String(order.status) === "paid") {
        if (String(order.provider_transaction_id) !== event.providerTransactionId) {
          throw new PaymentProviderConflictError("支付流水号冲突");
        }
        return;
      }
      if (!["created", "pending"].includes(String(order.status))) {
        throw new PaymentProviderConflictError("当前订单状态不能标记为已支付");
      }

      await tx.query(
        `update payment_orders
         set status = 'paid',
             provider_transaction_id = $2,
             paid_at = now(),
             updated_at = now()
         where id = $1`,
        [orderId, event.providerTransactionId],
      );
    });
  }

  return { createPaymentOrder, getPaymentOrder, markOrderPaid };
}

let defaultServicePromise: Promise<PaymentOrdersService> | null = null;

async function getDefaultService(): Promise<PaymentOrdersService> {
  defaultServicePromise ??= (async () => {
    const [{ getSql }, { getPaymentProvider }] = await Promise.all([
      import("../db.ts"),
      import("./provider-registry.server.ts"),
    ]);
    return createPaymentOrdersService(await getSql(), getPaymentProvider());
  })().catch((error) => {
    defaultServicePromise = null;
    throw error;
  });
  return defaultServicePromise;
}

export async function createPaymentOrder(
  userId: string,
  packageCode: PackageCode,
  clientRequestId: string,
): Promise<PaymentOrder> {
  return (await getDefaultService()).createPaymentOrder(userId, packageCode, clientRequestId);
}

export async function getPaymentOrder(userId: string, orderId: string): Promise<PaymentOrder> {
  return (await getDefaultService()).getPaymentOrder(userId, orderId);
}

export async function markOrderPaid(orderId: string, event: PaymentWebhookEvent): Promise<void> {
  await (await getDefaultService()).markOrderPaid(orderId, event);
}
