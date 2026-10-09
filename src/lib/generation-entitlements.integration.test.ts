import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createCreditsService, type CreditsService } from "./credits.server.ts";
import {
  createEntitlementsService,
  hashGenerationToken,
  type EntitlementsService,
} from "./entitlements.server.ts";
import { trustedClientIp } from "./generation-entitlements.server.ts";
import { hashTripPlan } from "./plans.repository.ts";
import {
  resetGuidebookExportAfterPendingAuth,
  resolveGuidebookExportGate,
  shouldReleaseGenerationOnCleanup,
} from "./guidebook-access.ts";
import type { TripPlan } from "./travel-plan.ts";

const migrationNames = [
  "0001_public_auth.sql",
  "0002_discovered_places.sql",
  "0003_clear_discovered_route_context.sql",
  "0004_commercial_accounts.sql",
  "0005_username_auth.sql",
  "0006_credit_reservation_idempotency.sql",
  "0007_payment_order_idempotency.sql",
  "0008_provider_creation_lease.sql",
  "0009_payment_credits_applied.sql",
  "0010_generation_entitlements.sql",
  "0011_travel_plan_hash.sql",
  "0012_generation_entitlement_failure_reason.sql",
  "0013_generation_entitlement_retry.sql",
  "0014_delivery_drafts.sql",
] as const;

type TestSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: TestSql) => Promise<T>): Promise<T>;
};

async function createTestContext(): Promise<{
  pg: PGlite;
  sql: TestSql;
  credits: CreditsService;
  entitlements: EntitlementsService;
}> {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of migrationNames) {
    const migration = await readFile(
      fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
      "utf8",
    );
    await pg.exec(migration);
  }

  const query = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  };
  const transaction = async <T>(fn: (tx: TestSql) => Promise<T>): Promise<T> =>
    pg.transaction(async (tx) => {
      const txQuery = async <U = Record<string, unknown>>(
        text: string,
        params: unknown[] = [],
      ): Promise<U[]> => {
        const result = await tx.query<U>(text, params);
        return result.rows;
      };
      let txSql: TestSql;
      txSql = {
        query: txQuery,
        transaction: (inner) => inner(txSql),
      };
      return fn(txSql);
    });

  const sql: TestSql = { query, transaction };
  return {
    pg,
    sql,
    credits: createCreditsService(sql),
    entitlements: createEntitlementsService(sql),
  };
}

let phoneSequence = 0;

async function createUser(sql: TestSql): Promise<string> {
  const id = randomUUID();
  phoneSequence += 1;
  const phone = `13${String(300_000_000 + phoneSequence).padStart(9, "0")}`;
  await sql.query(
    'insert into "user" (id, name, email, "emailVerified", phone) values ($1,$2,$3,true,$4)',
    [id, phone, `${phone}@phone.invalid`, phone],
  );
  return id;
}

function samplePlan(title = "凭证行程"): TripPlan {
  return {
    meta: {
      title,
      origin: "上海",
      waypoints: [],
      destination: "北京",
      startDate: "2026-10-01",
      days: 3,
      travelers: { adults: 1, children: 0 },
      perPersonBudget: 3000,
      transportPreference: "balanced",
      pace: "balanced",
      interests: ["历史"],
    },
  } as unknown as TripPlan;
}

async function fundWallet(sql: TestSql, userId: string, points: number): Promise<void> {
  await sql.transaction(async (tx) => {
    const wallets = await tx.query<{ id: string; balance: number }>(
      `update credit_wallets
       set balance = balance + $2,
           version = version + 1,
           updated_at = now()
       where user_id = $1
       returning id, balance`,
      [userId, points],
    );
    const wallet = wallets[0];
    if (!wallet) throw new Error("测试充值失败：钱包不存在");
    await tx.query(
      `insert into credit_ledger (
         id, wallet_id, delta, balance_after, reason, note
       ) values ($1, $2, $3, $4, 'purchase', '测试充值')`,
      [randomUUID(), wallet.id, points, wallet.balance],
    );
  });
}

test("pending auth resets the export state instead of leaving it preparing", () => {
  assert.equal(resolveGuidebookExportGate({ isPending: true, hasUser: false }), "wait");
  assert.deepEqual(resetGuidebookExportAfterPendingAuth(), { stage: "idle", progress: 0 });
});

test("cleanup releases only the active, unfinalized attempt", () => {
  assert.equal(
    shouldReleaseGenerationOnCleanup({
      attemptPlanId: "old",
      currentPlanId: "old",
      finalizedPlanId: null,
      hasToken: true,
    }),
    true,
  );
  assert.equal(
    shouldReleaseGenerationOnCleanup({
      attemptPlanId: "old",
      currentPlanId: "old",
      finalizedPlanId: "old",
      hasToken: true,
    }),
    false,
  );
  assert.equal(
    shouldReleaseGenerationOnCleanup({
      attemptPlanId: "old",
      currentPlanId: "new",
      finalizedPlanId: null,
      hasToken: true,
    }),
    false,
  );
});

test("generation and preview reject missing credentials", async () => {
  const { pg, entitlements } = await createTestContext();
  try {
    await assert.rejects(
      () =>
        entitlements.authorizeGeneration({
          entitlementToken: "",
          requestFingerprint: "fingerprint",
          userId: null,
          cookieEntitlementId: null,
        }),
      /无效|不存在/,
    );
    await assert.rejects(
      () =>
        entitlements.resolvePreviewPlan({
          userId: null,
          planId: "missing-plan",
          plan: samplePlan(),
        }),
      /未授权预览/,
    );
  } finally {
    await pg.close();
  }
});

test("guest preparation stores only a token hash and atomically limits the bucket", async () => {
  const { pg, sql, entitlements } = await createTestContext();
  try {
    const planId = randomUUID();
    const first = await entitlements.prepareGuestGeneration({
      planId,
      requestFingerprint: planId,
      guestBucket: "guest-bucket-a",
    });
    assert.equal(first.kind, "guest");
    if (first.kind !== "guest") return;
    assert.ok(first.token.length > 20);

    const stored = await sql.query<{ token_hash: string; status: string }>(
      "select token_hash, status from generation_entitlements where id = $1",
      [first.entitlementId],
    );
    assert.equal(stored[0]?.token_hash, hashGenerationToken(first.token));
    assert.notEqual(stored[0]?.token_hash, first.token);
    assert.equal(stored[0]?.status, "available");

    const second = await entitlements.prepareGuestGeneration({
      planId: randomUUID(),
      requestFingerprint: randomUUID(),
      guestBucket: "guest-bucket-a",
    });
    assert.deepEqual(second, { kind: "needs_login" });

    await sql.query(
      "update generation_entitlements set created_at = now() - interval '25 hours' where id = $1",
      [first.entitlementId],
    );
    const afterWindow = await entitlements.prepareGuestGeneration({
      planId: randomUUID(),
      requestFingerprint: randomUUID(),
      guestBucket: "guest-bucket-a",
    });
    assert.equal(afterWindow.kind, "guest");
  } finally {
    await pg.close();
  }
});

test("generation entitlement rejects missing token, replay and wrong guest cookie", async () => {
  const { pg, entitlements } = await createTestContext();
  try {
    const planId = randomUUID();
    const prepared = await entitlements.prepareGuestGeneration({
      planId,
      requestFingerprint: planId,
      guestBucket: "guest-bucket-b",
    });
    if (prepared.kind !== "guest") throw new Error("未创建访客凭证");

    await assert.rejects(
      () =>
        entitlements.authorizeGeneration({
          entitlementToken: "missing",
          requestFingerprint: planId,
          userId: null,
          cookieEntitlementId: prepared.entitlementId,
        }),
      /无效|不存在|已使用/,
    );
    await assert.rejects(
      () =>
        entitlements.authorizeGeneration({
          entitlementToken: prepared.token,
          requestFingerprint: planId,
          userId: null,
          cookieEntitlementId: "other-cookie",
        }),
      /无效|不存在|无权|Cookie|匹配/,
    );

    const authorized = await entitlements.authorizeGeneration({
      entitlementToken: prepared.token,
      requestFingerprint: planId,
      userId: null,
      cookieEntitlementId: prepared.entitlementId,
    });
    assert.equal(authorized.kind, "guest");
    await assert.rejects(
      () =>
        entitlements.authorizeGeneration({
          entitlementToken: prepared.token,
          requestFingerprint: planId,
          userId: null,
          cookieEntitlementId: prepared.entitlementId,
        }),
      /已使用|重放|不可重复/,
    );
  } finally {
    await pg.close();
  }
});

test("guest release requires the same token and fingerprint and cannot clear another attempt", async () => {
  const { pg, entitlements } = await createTestContext();
  try {
    const firstPlanId = randomUUID();
    const first = await entitlements.prepareGuestGeneration({
      planId: firstPlanId,
      requestFingerprint: firstPlanId,
      guestBucket: "guest-bucket-c",
    });
    if (first.kind !== "guest") throw new Error("未创建访客凭证");

    await assert.rejects(
      () =>
        entitlements.releaseGeneration({
          entitlementToken: "wrong-token",
          requestFingerprint: firstPlanId,
          userId: null,
          cookieEntitlementId: first.entitlementId,
        }),
      /无效|不存在|无权|匹配/,
    );
    await assert.rejects(
      () =>
        entitlements.releaseGeneration({
          entitlementToken: first.token,
          requestFingerprint: "wrong-fingerprint",
          userId: null,
          cookieEntitlementId: first.entitlementId,
        }),
      /fingerprint|指纹|匹配/,
    );

    await entitlements.releaseGeneration({
      entitlementToken: first.token,
      requestFingerprint: firstPlanId,
      userId: null,
      cookieEntitlementId: first.entitlementId,
    });
    await assert.rejects(
      () =>
        entitlements.authorizeGeneration({
          entitlementToken: first.token,
          requestFingerprint: firstPlanId,
          userId: null,
          cookieEntitlementId: first.entitlementId,
        }),
      /已使用|重放|失效/,
    );

    const replacement = await entitlements.prepareGuestGeneration({
      planId: firstPlanId,
      requestFingerprint: firstPlanId,
      guestBucket: "guest-bucket-c",
    });
    if (replacement.kind !== "guest") throw new Error("合法重试应签发新访客凭证");
    assert.notEqual(replacement.token, first.token);
    await assert.rejects(
      () =>
        entitlements.authorizeGeneration({
          entitlementToken: first.token,
          requestFingerprint: firstPlanId,
          userId: null,
          cookieEntitlementId: first.entitlementId,
        }),
      /已使用|重放|失效/,
    );
    const authorized = await entitlements.authorizeGeneration({
      entitlementToken: replacement.token,
      requestFingerprint: firstPlanId,
      userId: null,
      cookieEntitlementId: replacement.entitlementId,
    });
    assert.equal(authorized.kind, "guest");
  } finally {
    await pg.close();
  }
});

test("failed entitlement enforces retry limit and concurrent retries issue one token", async () => {
  const { pg, sql, entitlements } = await createTestContext();
  try {
    const planId = randomUUID();
    const bucket = "guest-bucket-retry-limit";
    let current = await entitlements.prepareGuestGeneration({
      planId,
      requestFingerprint: planId,
      guestBucket: bucket,
    });
    if (current.kind !== "guest") throw new Error("首次访客凭证创建失败");

    for (let retry = 0; retry < 2; retry += 1) {
      await entitlements.authorizeGeneration({
        entitlementToken: current.token,
        requestFingerprint: planId,
        userId: null,
        cookieEntitlementId: current.entitlementId,
      });
      await entitlements.releaseGenerationAfterFailure({
        entitlementToken: current.token,
        requestFingerprint: planId,
        userId: null,
        cookieEntitlementId: current.entitlementId,
        reason: `failure-${retry}`,
      });

      if (retry === 0) {
        const results = await Promise.allSettled([
          entitlements.prepareGuestGeneration({
            planId,
            requestFingerprint: planId,
            guestBucket: bucket,
          }),
          entitlements.prepareGuestGeneration({
            planId,
            requestFingerprint: planId,
            guestBucket: bucket,
          }),
        ]);
        const issued = results.filter(
          (result) => result.status === "fulfilled" && result.value.kind === "guest",
        );
        assert.equal(issued.length, 1, "并发重试只能签发一个访客 token");
        const activeRows = await sql.query<{ count: number }>(
          "select count(*)::int as count from generation_entitlements where guest_bucket = $1 and status = 'available'",
          [bucket],
        );
        assert.equal(activeRows[0]?.count, 1);
        const fulfilled = results.find(
          (
            result,
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof entitlements.prepareGuestGeneration>>
          > => result.status === "fulfilled" && result.value.kind === "guest",
        );
        if (!fulfilled || fulfilled.value.kind !== "guest") throw new Error("并发重试未返回新凭证");
        current = fulfilled.value;
      } else {
        current = await entitlements.prepareGuestGeneration({
          planId,
          requestFingerprint: planId,
          guestBucket: bucket,
        });
        if (current.kind !== "guest") throw new Error("第二次合法重试未签发凭证");
      }
    }

    await entitlements.authorizeGeneration({
      entitlementToken: current.token,
      requestFingerprint: planId,
      userId: null,
      cookieEntitlementId: current.entitlementId,
    });
    await entitlements.releaseGenerationAfterFailure({
      entitlementToken: current.token,
      requestFingerprint: planId,
      userId: null,
      cookieEntitlementId: current.entitlementId,
      reason: "failure-limit",
    });
    await assert.rejects(
      () =>
        entitlements.prepareGuestGeneration({
          planId,
          requestFingerprint: planId,
          guestBucket: bucket,
        }),
      /上限|次数/,
    );
  } finally {
    await pg.close();
  }
});

test("paid retry reserves a new point reservation and old token stays failed", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);
    const planId = randomUUID();

    const firstReservation = await entitlements.reservePaidPlan(userId, planId, 0);
    const first = await entitlements.preparePaidGeneration({
      userId,
      planId,
      requestFingerprint: planId,
      reservationId: firstReservation.id,
    });
    await entitlements.authorizeGeneration({
      entitlementToken: first.token,
      requestFingerprint: planId,
      userId,
      cookieEntitlementId: null,
    });
    await entitlements.releaseGenerationAfterFailure({
      entitlementToken: first.token,
      requestFingerprint: planId,
      userId,
      cookieEntitlementId: null,
      reason: "paid_generation_failed",
    });

    const afterFailure = await credits.getWalletSummary(userId);
    assert.equal(afterFailure.wallet.balance, 1);
    assert.equal(afterFailure.wallet.reserved, 0);
    await assert.rejects(
      () =>
        entitlements.authorizeGeneration({
          entitlementToken: first.token,
          requestFingerprint: planId,
          userId,
          cookieEntitlementId: null,
        }),
      /已使用|重放|失效/,
    );

    const secondReservation = await entitlements.reservePaidPlan(userId, planId, 1);
    assert.notEqual(secondReservation.id, firstReservation.id, "付费重试不能复用旧 reservation");
    const second = await entitlements.preparePaidGeneration({
      userId,
      planId,
      requestFingerprint: planId,
      reservationId: secondReservation.id,
    });
    assert.notEqual(second.token, first.token);
    await entitlements.authorizeGeneration({
      entitlementToken: second.token,
      requestFingerprint: planId,
      userId,
      cookieEntitlementId: null,
    });

    const plan = samplePlan("付费重试成功");
    await entitlements.finishPaidPlan({
      userId,
      planId,
      plan,
      entitlementToken: second.token,
      requestFingerprint: planId,
    });
    const completed = await credits.getWalletSummary(userId);
    assert.equal(completed.wallet.balance, 0);
    assert.equal(completed.wallet.reserved, 0);
    assert.equal(completed.ledger.filter((item) => item.reason === "generation").length, 1);
  } finally {
    await pg.close();
  }
});

test("completed claims and consumed plans cannot be released again", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const freeUser = await createUser(sql);
    const freePlanId = randomUUID();
    const freePlan = samplePlan("完成后禁止释放");
    const free = await entitlements.prepareFreeGeneration({
      userId: freeUser,
      planId: freePlanId,
      requestFingerprint: freePlanId,
    });
    await entitlements.authorizeGeneration({
      entitlementToken: free.token,
      requestFingerprint: freePlanId,
      userId: freeUser,
      cookieEntitlementId: null,
    });
    await entitlements.claimFirstFreePlan({
      userId: freeUser,
      planId: freePlanId,
      plan: freePlan,
      entitlementToken: free.token,
      requestFingerprint: freePlanId,
    });
    const freeRelease = await entitlements.releaseGenerationAfterFailure({
      entitlementToken: free.token,
      requestFingerprint: freePlanId,
      userId: freeUser,
      cookieEntitlementId: null,
      reason: "must_not_release_claimed",
    });
    assert.equal(freeRelease.released, false);

    const paidUser = await createUser(sql);
    await credits.ensureWallet(paidUser);
    await fundWallet(sql, paidUser, 1);
    const paidPlanId = randomUUID();
    const reservation = await entitlements.reservePaidPlan(paidUser, paidPlanId, 0);
    const paid = await entitlements.preparePaidGeneration({
      userId: paidUser,
      planId: paidPlanId,
      requestFingerprint: paidPlanId,
      reservationId: reservation.id,
    });
    await entitlements.authorizeGeneration({
      entitlementToken: paid.token,
      requestFingerprint: paidPlanId,
      userId: paidUser,
      cookieEntitlementId: null,
    });
    await entitlements.finishPaidPlan({
      userId: paidUser,
      planId: paidPlanId,
      plan: samplePlan("消费完成后禁止释放"),
      entitlementToken: paid.token,
      requestFingerprint: paidPlanId,
    });
    const paidRelease = await entitlements.releaseGenerationAfterFailure({
      entitlementToken: paid.token,
      requestFingerprint: paidPlanId,
      userId: paidUser,
      cookieEntitlementId: null,
      reason: "must_not_release_consumed",
    });
    assert.equal(paidRelease.released, false);
  } finally {
    await pg.close();
  }
});

test("failure reason is capped before persistence", async () => {
  const { pg, sql, entitlements } = await createTestContext();
  try {
    const planId = randomUUID();
    const guest = await entitlements.prepareGuestGeneration({
      planId,
      requestFingerprint: planId,
      guestBucket: "guest-bucket-reason",
    });
    if (guest.kind !== "guest") throw new Error("未创建访客凭证");
    const credentials = {
      entitlementToken: guest.token,
      requestFingerprint: planId,
      userId: null,
      cookieEntitlementId: guest.entitlementId,
    };
    await entitlements.authorizeGeneration(credentials);
    await entitlements.releaseGenerationAfterFailure({ ...credentials, reason: "x".repeat(800) });
    const rows = await sql.query<{ length: number }>(
      "select length(failure_reason)::int as length from generation_entitlements where id = $1",
      [guest.entitlementId],
    );
    assert.equal(rows[0]?.length, 500);
  } finally {
    await pg.close();
  }
});

test("trusted guest IP ignores spoofable UA and prefers platform headers", () => {
  const headers = new Headers({
    "x-nf-client-connection-ip": "203.0.113.9",
    "cf-connecting-ip": "203.0.113.8",
    "x-real-ip": "203.0.113.7",
    "x-forwarded-for": "203.0.113.6",
    "user-agent": "spoofed-agent",
  });
  assert.equal(trustedClientIp(headers), "203.0.113.9");

  const changedUa = new Headers({
    "x-nf-client-connection-ip": "203.0.113.9",
    "user-agent": "another-spoofed-agent",
  });
  assert.equal(trustedClientIp(changedUa), trustedClientIp(headers));
});

test("guest entitlement binds to the logged-in user and rejects another user", async () => {
  const { pg, sql, entitlements } = await createTestContext();
  try {
    const firstUser = await createUser(sql);
    const otherUser = await createUser(sql);
    const planId = randomUUID();
    const plan = samplePlan("登录后领取");
    const guest = await entitlements.prepareGuestGeneration({
      planId,
      requestFingerprint: planId,
      guestBucket: "guest-bucket-bind",
    });
    if (guest.kind !== "guest") throw new Error("未创建访客凭证");
    await entitlements.authorizeGeneration({
      entitlementToken: guest.token,
      requestFingerprint: planId,
      userId: null,
      cookieEntitlementId: guest.entitlementId,
    });
    await entitlements.finalizeGuestGeneration({
      token: guest.token,
      requestFingerprint: planId,
      planId,
      plan,
      cookieEntitlementId: guest.entitlementId,
    });

    await entitlements.claimFirstFreePlan({
      userId: firstUser,
      planId,
      plan,
      entitlementToken: guest.token,
      requestFingerprint: planId,
      cookieEntitlementId: guest.entitlementId,
    });
    const bound = await sql.query<{ user_id: string; status: string }>(
      "select user_id, status from generation_entitlements where id = $1",
      [guest.entitlementId],
    );
    assert.equal(bound[0]?.user_id, firstUser);
    assert.equal(bound[0]?.status, "claimed");

    await assert.rejects(
      () =>
        entitlements.claimFirstFreePlan({
          userId: otherUser,
          planId,
          plan,
          entitlementToken: guest.token,
          requestFingerprint: planId,
          cookieEntitlementId: guest.entitlementId,
        }),
      /绑定其他用户|无权/,
    );
  } finally {
    await pg.close();
  }
});

test("used token cannot be released by the public path and failed retry rotates the token", async () => {
  const { pg, sql, entitlements } = await createTestContext();
  try {
    const planId = randomUUID();
    const guest = await entitlements.prepareGuestGeneration({
      planId,
      requestFingerprint: planId,
      guestBucket: "guest-bucket-release",
    });
    if (guest.kind !== "guest") throw new Error("未创建访客凭证");
    const credentials = {
      entitlementToken: guest.token,
      requestFingerprint: planId,
      userId: null,
      cookieEntitlementId: guest.entitlementId,
    };
    await entitlements.authorizeGeneration(credentials);
    await assert.rejects(() => entitlements.releaseGeneration(credentials), /尚未开始/);

    const failed = await entitlements.releaseGenerationAfterFailure({
      ...credentials,
      reason: "generation_aborted",
    });
    assert.equal(failed.released, true);
    const failedRow = await sql.query<{
      status: string;
      failure_reason: string;
      retry_count: number;
    }>("select status, failure_reason, retry_count from generation_entitlements where id = $1", [
      guest.entitlementId,
    ]);
    assert.equal(failedRow[0]?.status, "failed");
    assert.equal(failedRow[0]?.failure_reason, "generation_aborted");
    assert.equal(failedRow[0]?.retry_count, 0);
    await assert.rejects(() => entitlements.authorizeGeneration(credentials), /已使用|重放|失效/);

    const replacement = await entitlements.prepareGuestGeneration({
      planId,
      requestFingerprint: planId,
      guestBucket: "guest-bucket-release",
    });
    if (replacement.kind !== "guest") throw new Error("失败后应允许合法重试");
    const retried = await entitlements.authorizeGeneration({
      entitlementToken: replacement.token,
      requestFingerprint: planId,
      userId: null,
      cookieEntitlementId: replacement.entitlementId,
    });
    assert.equal(retried.kind, "guest");
    const retryRow = await sql.query<{ retry_count: number }>(
      "select retry_count from generation_entitlements where id = $1",
      [replacement.entitlementId],
    );
    assert.equal(retryRow[0]?.retry_count, 1);
  } finally {
    await pg.close();
  }
});

test("ensurePlanExportable covers free, paid and guest plans", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const freeUser = await createUser(sql);
    const freePlanId = randomUUID();
    const freePlan = samplePlan("免费导出");
    const free = await entitlements.prepareFreeGeneration({
      userId: freeUser,
      planId: freePlanId,
      requestFingerprint: freePlanId,
    });
    await entitlements.authorizeGeneration({
      entitlementToken: free.token,
      requestFingerprint: freePlanId,
      userId: freeUser,
      cookieEntitlementId: null,
    });
    await entitlements.ensurePlanExportable({
      userId: freeUser,
      planId: freePlanId,
      plan: freePlan,
      entitlementToken: free.token,
      requestFingerprint: freePlanId,
    });

    const guestUser = await createUser(sql);
    const guestPlanId = randomUUID();
    const guestPlan = samplePlan("访客登录导出");
    const guest = await entitlements.prepareGuestGeneration({
      planId: guestPlanId,
      requestFingerprint: guestPlanId,
      guestBucket: "guest-bucket-export",
    });
    if (guest.kind !== "guest") throw new Error("未创建访客导出凭证");
    await entitlements.authorizeGeneration({
      entitlementToken: guest.token,
      requestFingerprint: guestPlanId,
      userId: null,
      cookieEntitlementId: guest.entitlementId,
    });
    await entitlements.finalizeGuestGeneration({
      token: guest.token,
      requestFingerprint: guestPlanId,
      planId: guestPlanId,
      plan: guestPlan,
      cookieEntitlementId: guest.entitlementId,
    });
    await entitlements.claimFirstFreePlan({
      userId: guestUser,
      planId: guestPlanId,
      plan: guestPlan,
      entitlementToken: guest.token,
      requestFingerprint: guestPlanId,
      cookieEntitlementId: guest.entitlementId,
    });
    const guestExported = await entitlements.ensurePlanExportable({
      userId: guestUser,
      planId: guestPlanId,
      plan: guestPlan,
      entitlementToken: guest.token,
      requestFingerprint: guestPlanId,
      cookieEntitlementId: guest.entitlementId,
    });
    assert.equal(guestExported.meta.title, "访客登录导出");

    const paidUser = await createUser(sql);
    await credits.ensureWallet(paidUser);
    await fundWallet(sql, paidUser, 1);
    const paidPlanId = randomUUID();
    const paidPlan = samplePlan("付费导出");
    const reservation = await entitlements.reservePaidPlan(paidUser, paidPlanId);
    const paid = await entitlements.preparePaidGeneration({
      userId: paidUser,
      planId: paidPlanId,
      requestFingerprint: paidPlanId,
      reservationId: reservation.id,
    });
    await entitlements.authorizeGeneration({
      entitlementToken: paid.token,
      requestFingerprint: paidPlanId,
      userId: paidUser,
      cookieEntitlementId: null,
    });
    const exported = await entitlements.ensurePlanExportable({
      userId: paidUser,
      planId: paidPlanId,
      plan: paidPlan,
      entitlementToken: paid.token,
      requestFingerprint: paidPlanId,
    });
    assert.equal(exported.meta.title, "付费导出");
    const paidSummary = await credits.getWalletSummary(paidUser);
    assert.equal(paidSummary.wallet.balance, 0);
    assert.equal(paidSummary.wallet.reserved, 0);
  } finally {
    await pg.close();
  }
});

test("a user entitlement cannot be authorized by another user", async () => {
  const { pg, sql, entitlements } = await createTestContext();
  try {
    const owner = await createUser(sql);
    const other = await createUser(sql);
    const planId = randomUUID();
    const prepared = await entitlements.prepareFreeGeneration({
      userId: owner,
      planId,
      requestFingerprint: planId,
    });
    await assert.rejects(
      () =>
        entitlements.authorizeGeneration({
          entitlementToken: prepared.token,
          requestFingerprint: planId,
          userId: other,
          cookieEntitlementId: null,
        }),
      /无权|匹配|用户/,
    );
  } finally {
    await pg.close();
  }
});

test("free finalize requires the entitlement and rejects different plan content", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = randomUUID();
    const plan = samplePlan("免费凭证最终版");
    const prepared = await entitlements.prepareFreeGeneration({
      userId,
      planId,
      requestFingerprint: planId,
    });
    await entitlements.authorizeGeneration({
      entitlementToken: prepared.token,
      requestFingerprint: planId,
      userId,
      cookieEntitlementId: null,
    });

    const first = await entitlements.claimFirstFreePlan({
      userId,
      planId,
      plan,
      entitlementToken: prepared.token,
      requestFingerprint: planId,
    });
    const second = await entitlements.claimFirstFreePlan({
      userId,
      planId,
      plan,
      entitlementToken: prepared.token,
      requestFingerprint: planId,
    });
    assert.equal(first.planId, planId);
    assert.equal(second.planId, planId);

    const planRow = await sql.query<{ plan_hash: string }>(
      "select plan_hash from travel_plans where id = $1",
      [planId],
    );
    assert.equal(planRow[0]?.plan_hash, hashTripPlan(plan));

    await assert.rejects(
      () =>
        entitlements.claimFirstFreePlan({
          userId,
          planId,
          plan: samplePlan("不同内容"),
          entitlementToken: prepared.token,
          requestFingerprint: planId,
        }),
      /内容|hash|不一致/,
    );

    const summary = await credits.getWalletSummary(userId);
    assert.equal(summary.ledger.filter((item) => item.reason === "free_trial").length, 1);
  } finally {
    await pg.close();
  }
});

test("paid finalize requires the entitlement and repeated different content is rejected", async () => {
  const { pg, sql, credits, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    await credits.ensureWallet(userId);
    await fundWallet(sql, userId, 1);
    const planId = randomUUID();
    const plan = samplePlan("付费凭证最终版");
    const reservation = await entitlements.reservePaidPlan(userId, planId);
    const prepared = await entitlements.preparePaidGeneration({
      userId,
      planId,
      requestFingerprint: planId,
      reservationId: reservation.id,
    });
    await entitlements.authorizeGeneration({
      entitlementToken: prepared.token,
      requestFingerprint: planId,
      userId,
      cookieEntitlementId: null,
    });

    const first = await entitlements.finishPaidPlan({
      userId,
      planId,
      plan,
      entitlementToken: prepared.token,
      requestFingerprint: planId,
    });
    const second = await entitlements.finishPaidPlan({
      userId,
      planId,
      plan,
      entitlementToken: prepared.token,
      requestFingerprint: planId,
    });
    assert.equal(first.id, second.id);

    await assert.rejects(
      () =>
        entitlements.finishPaidPlan({
          userId,
          planId,
          plan: samplePlan("不同付费内容"),
          entitlementToken: prepared.token,
          requestFingerprint: planId,
        }),
      /内容|hash|不一致/,
    );
  } finally {
    await pg.close();
  }
});

test("preview access uses saved user plan or a claimed guest entitlement", async () => {
  const { pg, sql, entitlements } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const planId = randomUUID();
    const plan = samplePlan("可预览行程");
    await entitlements.saveTravelPlan({ userId, planId, plan });
    const saved = await entitlements.resolvePreviewPlan({
      userId,
      planId,
      plan: undefined,
      entitlementToken: null,
      requestFingerprint: null,
      cookieEntitlementId: null,
    });
    assert.equal(saved.meta.title, "可预览行程");

    const guestPlanId = randomUUID();
    const guestPlan = samplePlan("访客预览行程");
    const guest = await entitlements.prepareGuestGeneration({
      planId: guestPlanId,
      requestFingerprint: guestPlanId,
      guestBucket: "guest-bucket-preview",
    });
    if (guest.kind !== "guest") throw new Error("未创建访客凭证");
    await entitlements.authorizeGeneration({
      entitlementToken: guest.token,
      requestFingerprint: guestPlanId,
      userId: null,
      cookieEntitlementId: guest.entitlementId,
    });
    await assert.rejects(
      () =>
        entitlements.resolvePreviewPlan({
          userId: null,
          planId: guestPlanId,
          plan: guestPlan,
          entitlementToken: guest.token,
          requestFingerprint: guestPlanId,
          cookieEntitlementId: guest.entitlementId,
        }),
      /hash|绑定/,
    );
    await entitlements.finalizeGuestGeneration({
      token: guest.token,
      requestFingerprint: guestPlanId,
      planId: guestPlanId,
      plan: guestPlan,
      cookieEntitlementId: guest.entitlementId,
    });
    const previewed = await entitlements.resolvePreviewPlan({
      userId: null,
      planId: guestPlanId,
      plan: guestPlan,
      entitlementToken: guest.token,
      requestFingerprint: guestPlanId,
      cookieEntitlementId: guest.entitlementId,
    });
    assert.equal(previewed.meta.title, "访客预览行程");

    await assert.rejects(
      () =>
        entitlements.resolvePreviewPlan({
          userId: null,
          planId: guestPlanId,
          plan: samplePlan("伪造内容"),
          entitlementToken: guest.token,
          requestFingerprint: guestPlanId,
          cookieEntitlementId: guest.entitlementId,
        }),
      /hash|内容|不一致/,
    );
  } finally {
    await pg.close();
  }
});
