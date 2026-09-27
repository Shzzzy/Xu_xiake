import { randomUUID } from "node:crypto";
import type { Sql } from "./db.ts";
import type { CreditLedgerEntry, CreditReservation, CreditWallet } from "./credits/types.ts";

type Row = Record<string, unknown>;
type CreditSql = Pick<Sql, "query">;

export type CreditsService = {
  ensureWallet(userId: string): Promise<CreditWallet>;
  getWalletSummary(userId: string): Promise<{ wallet: CreditWallet; ledger: CreditLedgerEntry[] }>;
  claimFreeTrial(userId: string, planId: string | null): Promise<CreditLedgerEntry>;
  reserveCredit(userId: string, planId: string, ttlMinutes?: number): Promise<CreditReservation>;
  consumeReservation(reservationId: string, planId: string): Promise<CreditLedgerEntry>;
  releaseReservation(reservationId: string): Promise<void>;
  expireReservations(now?: Date): Promise<number>;
};

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function mapWallet(row: Row): CreditWallet {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    balance: Number(row.balance),
    reserved: Number(row.reserved),
    freeTrialClaimed: Boolean(row.free_trial_claimed),
    version: Number(row.version),
  };
}

function mapLedger(row: Row): CreditLedgerEntry {
  return {
    id: String(row.id),
    walletId: String(row.wallet_id),
    delta: Number(row.delta),
    balanceAfter: Number(row.balance_after),
    reason: row.reason as CreditLedgerEntry["reason"],
    orderId: nullableString(row.order_id),
    planId: nullableString(row.plan_id),
    operatorUserId: nullableString(row.operator_user_id),
    note: nullableString(row.note),
    createdAt: toIsoString(row.created_at),
  };
}

function mapReservation(row: Row): CreditReservation {
  return {
    id: String(row.id),
    walletId: String(row.wallet_id),
    planId: nullableString(row.plan_id),
    status: row.status as CreditReservation["status"],
    expiresAt: toIsoString(row.expires_at),
  };
}

/**
 * 使用注入的 Sql.query() 构造钱包服务。
 * 生产入口注入 getSql()，测试可注入真实 PGlite，两者执行同一套原子 SQL。
 */
export function createCreditsService(sql: CreditSql): CreditsService {
  /** 读取钱包；不存在时原子创建，重复调用始终返回同一钱包。 */
  async function ensureWallet(userId: string): Promise<CreditWallet> {
    const rows = await sql.query<Row>(
      `insert into credit_wallets (id, user_id)
       values ($1, $2)
       on conflict (user_id) do update set updated_at = credit_wallets.updated_at
       returning *`,
      [randomUUID(), userId],
    );
    const wallet = rows[0];
    if (!wallet) throw new Error("钱包创建失败");
    return mapWallet(wallet);
  }

  /** 读取钱包和最近 100 条流水，供账号页展示。 */
  async function getWalletSummary(
    userId: string,
  ): Promise<{ wallet: CreditWallet; ledger: CreditLedgerEntry[] }> {
    const wallet = await ensureWallet(userId);
    const rows = await sql.query<Row>(
      `select * from credit_ledger
       where wallet_id = $1
       order by created_at desc, id desc
       limit 100`,
      [wallet.id],
    );
    return { wallet, ledger: rows.map(mapLedger) };
  }

  /** 原子领取首次免费权益；每个钱包只允许成功一次。 */
  async function claimFreeTrial(userId: string, planId: string | null): Promise<CreditLedgerEntry> {
    const rows = await sql.query<Row>(
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
    const entry = rows[0];
    if (!entry) throw new Error("免费体验已使用或钱包不存在");
    return mapLedger(entry);
  }

  /**
   * 原子预留 1 点。条件更新钱包行让并发请求串行化，
   * `balance - reserved >= 1` 保证可用点数不会被双花。
   */
  async function reserveCredit(
    userId: string,
    planId: string,
    ttlMinutes = 15,
  ): Promise<CreditReservation> {
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      throw new Error("预留有效期必须大于 0");
    }

    const rows = await sql.query<Row>(
      `with updated as (
         update credit_wallets
         set reserved = reserved + 1,
             version = version + 1,
             updated_at = now()
         where user_id = $1 and balance - reserved >= 1
         returning id
       ), reservation as (
         insert into credit_reservations (id, wallet_id, plan_id, status, expires_at)
         select $2, id, $3, 'reserved',
                now() + ($4::double precision * interval '1 minute')
         from updated
         returning *
       )
       select * from reservation`,
      [userId, randomUUID(), planId, ttlMinutes],
    );
    const reservation = rows[0];
    if (!reservation) throw new Error("点数不足或钱包不存在");
    return mapReservation(reservation);
  }

  /**
   * 原子消费预留。预留状态条件更新确保同一预留只能成功一次，
   * 钱包余额与预占同时扣减，并写入唯一一条消费流水。
   */
  async function consumeReservation(
    reservationId: string,
    planId: string,
  ): Promise<CreditLedgerEntry> {
    const rows = await sql.query<Row>(
      `with consumed as (
         update credit_reservations
         set status = 'consumed', plan_id = $2, updated_at = now()
         where id = $1
           and status = 'reserved'
           and expires_at > now()
           and plan_id = $2
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
         from wallet_update u
         join consumed c on c.wallet_id = u.id
         returning *
       )
       select * from ledger`,
      [reservationId, planId, randomUUID()],
    );
    const entry = rows[0];
    if (!entry) throw new Error("点数预留不存在、已消费或已过期");
    return mapLedger(entry);
  }

  /** 原子释放预留；重复释放是安全 no-op，不会重复归还预占。 */
  async function releaseReservation(reservationId: string): Promise<void> {
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

  /** 批量回收已过期预留，并返回本次实际过期的预留数量。 */
  async function expireReservations(now = new Date()): Promise<number> {
    const rows = await sql.query<{ count: number }>(
      `with expired as (
         update credit_reservations
         set status = 'expired', updated_at = now()
         where status = 'reserved' and expires_at <= $1
         returning wallet_id
       ), grouped as (
         select wallet_id, count(*)::int as count
         from expired
         group by wallet_id
       ), wallet_update as (
         update credit_wallets w
         set reserved = w.reserved - g.count,
             version = w.version + 1,
             updated_at = now()
         from grouped g
         where w.id = g.wallet_id and w.reserved >= g.count
         returning w.id
       )
       select count(*)::int as count from expired`,
      [now.toISOString()],
    );
    return Number(rows[0]?.count ?? 0);
  }

  return {
    ensureWallet,
    getWalletSummary,
    claimFreeTrial,
    reserveCredit,
    consumeReservation,
    releaseReservation,
    expireReservations,
  };
}

let defaultServicePromise: Promise<CreditsService> | null = null;

async function getDefaultService(): Promise<CreditsService> {
  defaultServicePromise ??= (async () => {
    const { getSql } = await import("./db.ts");
    return createCreditsService(await getSql());
  })().catch((error) => {
    defaultServicePromise = null;
    throw error;
  });
  return defaultServicePromise;
}

/** 读取钱包；不存在时原子创建，重复调用始终返回同一钱包。 */
export async function ensureWallet(userId: string): Promise<CreditWallet> {
  return (await getDefaultService()).ensureWallet(userId);
}

/** 读取钱包和最近 100 条流水，供账号页展示。 */
export function getWalletSummary(
  userId: string,
): Promise<{ wallet: CreditWallet; ledger: CreditLedgerEntry[] }> {
  return getDefaultService().then((service) => service.getWalletSummary(userId));
}

/** 原子领取首次免费权益；每个钱包只允许成功一次。 */
export function claimFreeTrial(userId: string, planId: string | null): Promise<CreditLedgerEntry> {
  return getDefaultService().then((service) => service.claimFreeTrial(userId, planId));
}

/** 原子预留 1 点；通过条件更新阻止并发双花。 */
export function reserveCredit(
  userId: string,
  planId: string,
  ttlMinutes = 15,
): Promise<CreditReservation> {
  return getDefaultService().then((service) => service.reserveCredit(userId, planId, ttlMinutes));
}

/** 原子消费预留，成功时同步扣减余额、预占并写流水。 */
export function consumeReservation(
  reservationId: string,
  planId: string,
): Promise<CreditLedgerEntry> {
  return getDefaultService().then((service) => service.consumeReservation(reservationId, planId));
}

/** 原子释放预留；重复调用不会重复归还预占。 */
export async function releaseReservation(reservationId: string): Promise<void> {
  await (await getDefaultService()).releaseReservation(reservationId);
}

/** 批量回收已过期预留，返回实际过期数量。 */
export function expireReservations(now = new Date()): Promise<number> {
  return getDefaultService().then((service) => service.expireReservations(now));
}
