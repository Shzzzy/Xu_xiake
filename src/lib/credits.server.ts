import { randomUUID } from "node:crypto";
import type { CreditLedgerEntry, CreditReservation, CreditWallet } from "./credits/types.ts";

type Row = Record<string, unknown>;
type CreditSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: CreditSql) => Promise<T>): Promise<T>;
};
type ConsumeReservationResult =
  { entry: CreditLedgerEntry } | { expired: true } | { error: string };

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

function availableBalance(wallet: Row): number {
  return Number(wallet.balance) - Number(wallet.reserved);
}

function reservationExpiry(ttlMinutes: number): string {
  return new Date(Date.now() + ttlMinutes * 60_000).toISOString();
}

async function lockWalletByUserId(sql: CreditSql, userId: string): Promise<Row> {
  const rows = await sql.query<Row>("select * from credit_wallets where user_id = $1 for update", [
    userId,
  ]);
  const wallet = rows[0];
  if (!wallet) throw new Error("钱包不存在");
  return wallet;
}

async function lockWalletById(sql: CreditSql, walletId: string): Promise<Row> {
  const rows = await sql.query<Row>("select * from credit_wallets where id = $1 for update", [
    walletId,
  ]);
  const wallet = rows[0];
  if (!wallet) throw new Error("钱包不存在");
  return wallet;
}

async function reservationWalletId(sql: CreditSql, reservationId: string): Promise<string | null> {
  const rows = await sql.query<{ wallet_id: string }>(
    "select wallet_id from credit_reservations where id = $1",
    [reservationId],
  );
  return rows[0]?.wallet_id ?? null;
}

/**
 * 使用注入的 Sql.query()/transaction() 构造钱包服务。
 * 生产入口注入 getSql()，测试可注入真实 PGlite，两者执行同一套原子逻辑。
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
   * 原子预留 1 点。事务先锁钱包，再按 (wallet_id, plan_id) 锁既有预留：
   * reserved/consumed 直接返回原记录；released/expired 复用原记录重新预留。
   */
  async function reserveCredit(
    userId: string,
    planId: string,
    ttlMinutes = 15,
  ): Promise<CreditReservation> {
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      throw new Error("预留有效期必须大于 0");
    }

    return sql.transaction(async (tx) => {
      const wallet = await lockWalletByUserId(tx, userId);
      const walletId = String(wallet.id);
      const existingRows = await tx.query<Row>(
        `select * from credit_reservations
         where wallet_id = $1 and plan_id = $2
         for update`,
        [walletId, planId],
      );
      const existing = existingRows[0];

      if (existing) {
        const status = String(existing.status);
        if (status === "reserved" || status === "consumed") {
          return mapReservation(existing);
        }
        if (status !== "released" && status !== "expired") {
          throw new Error("点数预留状态异常");
        }
        if (availableBalance(wallet) < 1) throw new Error("点数不足");

        const walletUpdate = await tx.query<{ id: string }>(
          `update credit_wallets
           set reserved = reserved + 1,
               version = version + 1,
               updated_at = now()
           where id = $1
           returning id`,
          [walletId],
        );
        if (walletUpdate.length !== 1) throw new Error("钱包预占更新数量异常");

        const reactivatedRows = await tx.query<Row>(
          `update credit_reservations
           set status = 'reserved',
               expires_at = $2,
               updated_at = now()
           where id = $1
           returning *`,
          [existing.id, reservationExpiry(ttlMinutes)],
        );
        const reactivated = reactivatedRows[0];
        if (!reactivated) throw new Error("预留重新激活失败");
        return mapReservation(reactivated);
      }

      if (availableBalance(wallet) < 1) throw new Error("点数不足");

      const walletUpdate = await tx.query<{ id: string }>(
        `update credit_wallets
         set reserved = reserved + 1,
             version = version + 1,
             updated_at = now()
         where id = $1
         returning id`,
        [walletId],
      );
      if (walletUpdate.length !== 1) throw new Error("钱包预占更新数量异常");

      const insertedRows = await tx.query<Row>(
        `insert into credit_reservations (
           id, wallet_id, plan_id, status, expires_at
         ) values ($1, $2, $3, 'reserved', $4)
         returning *`,
        [randomUUID(), walletId, planId, reservationExpiry(ttlMinutes)],
      );
      const inserted = insertedRows[0];
      if (!inserted) throw new Error("点数预留创建失败");
      return mapReservation(inserted);
    });
  }

  /**
   * 原子消费预留。事务按 wallet -> reservation 顺序加锁；
   * consumed 重试返回原流水，reserved 才扣余额/预占并写 generation 流水。
   */
  async function consumeReservation(
    reservationId: string,
    planId: string,
  ): Promise<CreditLedgerEntry> {
    const result = await sql.transaction<ConsumeReservationResult>(async (tx) => {
      const walletId = await reservationWalletId(tx, reservationId);
      if (!walletId) throw new Error("点数预留不存在、已消费或已过期");

      const wallet = await lockWalletById(tx, walletId);
      const reservationRows = await tx.query<Row>(
        "select * from credit_reservations where id = $1 for update",
        [reservationId],
      );
      const reservation = reservationRows[0];
      if (!reservation) throw new Error("点数预留不存在、已消费或已过期");
      if (String(reservation.wallet_id) !== walletId) throw new Error("点数预留归属异常");
      if (nullableString(reservation.plan_id) !== planId) {
        throw new Error("点数预留与行程不匹配");
      }

      const status = String(reservation.status);
      if (status === "consumed") {
        const ledgerRows = await tx.query<Row>(
          `select * from credit_ledger
           where wallet_id = $1 and plan_id = $2 and reason = 'generation'
           order by created_at desc, id desc
           limit 1`,
          [walletId, planId],
        );
        const ledger = ledgerRows[0];
        if (!ledger) throw new Error("已消费预留缺少生成流水");
        return { entry: mapLedger(ledger) };
      }
      if (status === "released" || status === "expired") {
        return { error: "点数预留不存在、已消费或已过期" };
      }
      if (status !== "reserved") throw new Error("点数预留状态异常");

      const expiresAt = new Date(String(reservation.expires_at)).getTime();
      if (expiresAt <= Date.now()) {
        if (Number(wallet.reserved) < 1) throw new Error("钱包预占状态异常");
        const expiredUpdate = await tx.query<{ id: string }>(
          `update credit_reservations
           set status = 'expired', updated_at = now()
           where id = $1 and status = 'reserved'
           returning id`,
          [reservationId],
        );
        if (expiredUpdate.length !== 1) throw new Error("预留过期更新数量异常");
        const walletUpdate = await tx.query<{ id: string }>(
          `update credit_wallets
           set reserved = reserved - 1,
               version = version + 1,
               updated_at = now()
           where id = $1 and reserved >= 1
           returning id`,
          [walletId],
        );
        if (walletUpdate.length !== 1) throw new Error("钱包预占更新数量异常");
        return { expired: true };
      }

      if (Number(wallet.balance) < 1 || Number(wallet.reserved) < 1) {
        throw new Error("钱包余额或预占状态异常");
      }

      const consumedUpdate = await tx.query<{ id: string }>(
        `update credit_reservations
         set status = 'consumed', updated_at = now()
         where id = $1 and status = 'reserved'
         returning id`,
        [reservationId],
      );
      if (consumedUpdate.length !== 1) throw new Error("预留消费更新数量异常");

      const walletUpdate = await tx.query<{ balance: number }>(
        `update credit_wallets
         set balance = balance - 1,
             reserved = reserved - 1,
             version = version + 1,
             updated_at = now()
         where id = $1 and balance >= 1 and reserved >= 1
         returning balance`,
        [walletId],
      );
      const updatedWallet = walletUpdate[0];
      if (!updatedWallet) throw new Error("钱包扣点更新数量异常");

      const ledgerRows = await tx.query<Row>(
        `insert into credit_ledger (
           id, wallet_id, delta, balance_after, reason, plan_id, note
         ) values ($1, $2, -1, $3, 'generation', $4, '生成旅行方案')
         returning *`,
        [randomUUID(), walletId, updatedWallet.balance, planId],
      );
      const ledger = ledgerRows[0];
      if (!ledger) throw new Error("生成流水写入失败");
      return { entry: mapLedger(ledger) };
    });

    if ("error" in result) throw new Error(result.error);
    if ("expired" in result) throw new Error("点数预留不存在、已消费或已过期");
    return result.entry;
  }

  /** 原子释放预留；重复释放是安全 no-op，不会重复归还预占。 */
  async function releaseReservation(reservationId: string): Promise<void> {
    await sql.transaction(async (tx) => {
      const walletId = await reservationWalletId(tx, reservationId);
      if (!walletId) return;

      const wallet = await lockWalletById(tx, walletId);
      const reservationRows = await tx.query<Row>(
        "select * from credit_reservations where id = $1 for update",
        [reservationId],
      );
      const reservation = reservationRows[0];
      if (!reservation) return;
      if (String(reservation.wallet_id) !== walletId) {
        throw new Error("点数预留归属异常");
      }
      if (String(reservation.status) !== "reserved") return;
      if (Number(wallet.reserved) < 1) throw new Error("钱包预占状态异常");

      const walletUpdate = await tx.query<{ id: string }>(
        `update credit_wallets
         set reserved = reserved - 1,
             version = version + 1,
             updated_at = now()
         where id = $1 and reserved >= 1
         returning id`,
        [walletId],
      );
      if (walletUpdate.length !== 1) throw new Error("钱包预占更新数量异常");

      const releasedRows = await tx.query<{ id: string }>(
        `update credit_reservations
         set status = 'released', updated_at = now()
         where id = $1 and status = 'reserved'
         returning id`,
        [reservationId],
      );
      if (releasedRows.length !== 1) throw new Error("预留释放更新数量异常");
    });
  }

  /** 批量回收已过期预留；任何钱包预占不变量异常都会让事务整体回滚。 */
  async function expireReservations(now = new Date()): Promise<number> {
    return sql.transaction(async (tx) => {
      const candidates = await tx.query<{ id: string; wallet_id: string }>(
        `select id, wallet_id
         from credit_reservations
         where status = 'reserved' and expires_at <= $1
         order by wallet_id, id`,
        [now.toISOString()],
      );
      if (candidates.length === 0) return 0;

      const walletIds = [...new Set(candidates.map((row) => row.wallet_id))].sort();
      const wallets = new Map<string, Row>();
      for (const walletId of walletIds) {
        wallets.set(walletId, await lockWalletById(tx, walletId));
      }

      const expiredRows: Array<{ id: string; walletId: string }> = [];
      for (const candidate of candidates) {
        const rows = await tx.query<Row>(
          "select * from credit_reservations where id = $1 for update",
          [candidate.id],
        );
        const reservation = rows[0];
        if (!reservation) continue;
        if (String(reservation.wallet_id) !== candidate.wallet_id) {
          throw new Error("点数预留归属异常");
        }
        if (
          String(reservation.status) === "reserved" &&
          new Date(String(reservation.expires_at)).getTime() <= now.getTime()
        ) {
          expiredRows.push({ id: candidate.id, walletId: candidate.wallet_id });
        }
      }
      if (expiredRows.length === 0) return 0;

      const counts = new Map<string, number>();
      for (const row of expiredRows) {
        counts.set(row.walletId, (counts.get(row.walletId) ?? 0) + 1);
      }

      for (const walletId of [...counts.keys()].sort()) {
        const count = counts.get(walletId)!;
        const wallet = wallets.get(walletId);
        if (!wallet) throw new Error("钱包不存在");
        if (Number(wallet.reserved) < count) {
          throw new Error("钱包预占状态异常，已回滚过期操作");
        }
        const walletUpdate = await tx.query<{ id: string }>(
          `update credit_wallets
           set reserved = reserved - $2,
               version = version + 1,
               updated_at = now()
           where id = $1 and reserved >= $2
           returning id`,
          [walletId, count],
        );
        if (walletUpdate.length !== 1) {
          throw new Error("钱包预占更新数量异常，已回滚过期操作");
        }
      }

      for (const row of expiredRows) {
        const reservationUpdate = await tx.query<{ id: string }>(
          `update credit_reservations
           set status = 'expired', updated_at = now()
           where id = $1 and status = 'reserved'
           returning id`,
          [row.id],
        );
        if (reservationUpdate.length !== 1) {
          throw new Error("预留过期更新数量异常，已回滚过期操作");
        }
      }

      return expiredRows.length;
    });
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

/** 原子预留 1 点；同一行程重复或并发调用返回同一预留。 */
export function reserveCredit(
  userId: string,
  planId: string,
  ttlMinutes = 15,
): Promise<CreditReservation> {
  return getDefaultService().then((service) => service.reserveCredit(userId, planId, ttlMinutes));
}

/** 原子消费预留；重复消费返回原流水。 */
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
