import test from "node:test";
import assert from "node:assert/strict";
import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
  randomUUID,
  verify,
  type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  assertWechatAmount,
  createWechatPayProvider,
  loadWechatPayConfig,
} from "./wechat-pay.server.ts";
import { PaymentProviderRecoveryRequiredError } from "./provider.ts";
import { resolvePaymentProvider } from "./provider-registry.server.ts";
import { createPaymentOrdersService, type PaymentSql } from "./orders.server.ts";

type WechatFixture = {
  env: Record<string, string>;
  merchantPublicKey: KeyObject;
  platformPrivateKey: KeyObject;
  apiV3Key: string;
};

function createFixture(): WechatFixture {
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const apiV3Key = "0123456789abcdef0123456789abcdef";

  return {
    merchantPublicKey: merchant.publicKey,
    platformPrivateKey: platform.privateKey,
    apiV3Key,
    env: {
      WECHAT_PAY_MCH_ID: "1900000109",
      WECHAT_PAY_APP_ID: "wx1234567890abcdef",
      WECHAT_PAY_SERIAL_NO: "MCH-SERIAL-001",
      WECHAT_PAY_PRIVATE_KEY: merchant.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      WECHAT_PAY_API_V3_KEY: apiV3Key,
      WECHAT_PAY_PLATFORM_CERT: platform.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      WECHAT_PAY_PLATFORM_SERIAL_NO: "PLATFORM-SERIAL-001",
      WECHAT_PAY_NOTIFY_URL: "https://example.com/api/payments/webhook",
    },
  };
}

function signMessage(privateKey: KeyObject, message: string): string {
  return createSign("RSA-SHA256").update(message, "utf8").sign(privateKey, "base64");
}

function createSignedResponse(
  fixture: WechatFixture,
  body: string,
  options: {
    timestamp?: string;
    nonce?: string;
    signature?: string;
    serial?: string;
    status?: number;
  } = {},
) {
  const timestamp = options.timestamp ?? "1700000000";
  const nonce = options.nonce ?? "wechat-response-nonce";
  const signature =
    options.signature ??
    signMessage(fixture.platformPrivateKey, `${timestamp}\n${nonce}\n${body}\n`);
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Signature": signature,
      "Wechatpay-Serial": options.serial ?? "PLATFORM-SERIAL-001",
    },
  });
}

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
] as const;

async function createTestContext() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of migrationNames) {
    const migration = await readFile(
      fileURLToPath(new URL(`../../../migrations/${name}`, import.meta.url)),
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
  const transaction = async <T>(fn: (tx: PaymentSql) => Promise<T>): Promise<T> =>
    pg.transaction(async (tx) => {
      const txQuery = async <U = Record<string, unknown>>(
        text: string,
        params: unknown[] = [],
      ): Promise<U[]> => {
        const result = await tx.query<U>(text, params);
        return result.rows;
      };
      let txSql: PaymentSql;
      txSql = {
        query: txQuery,
        transaction: (inner) => inner(txSql),
      };
      return fn(txSql);
    });

  return { pg, sql: { query, transaction } satisfies PaymentSql };
}

async function createUser(sql: PaymentSql): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `insert into "user" (id, name, email, "emailVerified", status)
     values ($1, $2, $3, true, 'active')`,
    [id, "微信支付集成测试", `${id}@example.com`],
  );
  return id;
}

function encryptResource(transaction: Record<string, unknown>, apiV3Key: string) {
  const nonce = "callback-resource";
  const associatedData = "transaction";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key, "utf8"),
    Buffer.from(nonce, "utf8"),
  );
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(transaction), "utf8"),
    cipher.final(),
  ]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");

  return {
    algorithm: "AEAD_AES_256_GCM",
    ciphertext,
    nonce,
    associated_data: associatedData,
  };
}

function createWebhookRequest({
  body,
  timestamp,
  nonce,
  signature,
  serial = "PLATFORM-SERIAL-001",
}: {
  body: string;
  timestamp: string;
  nonce: string;
  signature: string;
  serial?: string;
}) {
  return new Request("https://example.com/api/payments/webhook", {
    method: "POST",
    headers: {
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Signature": signature,
      "Wechatpay-Serial": serial,
    },
    body,
  });
}

test("wechat amount must match local order cents", () => {
  assert.doesNotThrow(() => assertWechatAmount(941, 941));
  assert.throws(() => assertWechatAmount(941, 1), /金额不匹配/);
  assert.throws(() => assertWechatAmount(0, 0), /金额不正确/);
});

test("wechat config fails closed when required variables are missing", () => {
  assert.throws(() => loadWechatPayConfig({}), /WECHAT_PAY_MCH_ID/);
  const fixture = createFixture();
  assert.throws(
    () => loadWechatPayConfig({ ...fixture.env, WECHAT_PAY_API_V3_KEY: "short" }),
    /32 字节/,
  );
});

test("wechat native payment signs the request and returns code_url", async () => {
  const fixture = createFixture();
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const provider = createWechatPayProvider({
    env: fixture.env,
    now: () => 1_700_000_000_000,
    nonce: () => "merchant-request-nonce",
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      const responseBody = JSON.stringify({
        code_url: "weixin://wxpay/bizpayurl?pr=test-code",
        prepay_id: "wx-prepay-001",
      });
      return createSignedResponse(fixture, responseBody);
    },
  });

  const payment = await provider.createPayment({
    orderId: "ORDER-20260927-001",
    amountCents: 941,
    description: "行旅点册 10 点",
  });

  assert.equal(provider.id, "wechat");
  assert.equal(capturedUrl, "https://api.mch.weixin.qq.com/v3/pay/transactions/native");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(payment.provider, "wechat");
  assert.equal(payment.providerOrderId, "ORDER-20260927-001");
  assert.equal(payment.redirectUrl, "weixin://wxpay/bizpayurl?pr=test-code");
  assert.deepEqual(payment.payload, {
    prepayId: "wx-prepay-001",
    codeUrl: "weixin://wxpay/bizpayurl?pr=test-code",
  });

  const body = String(capturedInit?.body);
  assert.deepEqual(JSON.parse(body), {
    appid: fixture.env.WECHAT_PAY_APP_ID,
    mchid: fixture.env.WECHAT_PAY_MCH_ID,
    description: "行旅点册 10 点",
    out_trade_no: "ORDER-20260927-001",
    notify_url: fixture.env.WECHAT_PAY_NOTIFY_URL,
    amount: { total: 941, currency: "CNY" },
  });

  const headers = new Headers(capturedInit?.headers);
  const authorization = headers.get("authorization") ?? "";
  const match = authorization.match(
    /^WECHATPAY2-SHA256-RSA2048 mchid="([^"]+)",nonce_str="([^"]+)",signature="([^"]+)",timestamp="([^"]+)",serial_no="([^"]+)"$/,
  );
  assert.ok(match, authorization);
  assert.equal(match[1], fixture.env.WECHAT_PAY_MCH_ID);
  assert.equal(match[2], "merchant-request-nonce");
  assert.equal(match[4], "1700000000");
  assert.equal(match[5], fixture.env.WECHAT_PAY_SERIAL_NO);
  const signed = `POST\n/v3/pay/transactions/native\n${match[4]}\n${match[2]}\n${body}\n`;
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(signed, "utf8"),
      fixture.merchantPublicKey,
      Buffer.from(match[3], "base64"),
    ),
    true,
  );
});

test("wechat webhook verifies signature and decrypts resource", async () => {
  const fixture = createFixture();
  const transaction = {
    mchid: fixture.env.WECHAT_PAY_MCH_ID,
    appid: fixture.env.WECHAT_PAY_APP_ID,
    out_trade_no: "ORDER-20260927-002",
    transaction_id: "420000000020260927000001",
    trade_state: "SUCCESS",
    amount: { total: 941, currency: "CNY" },
  };
  const rawBody = JSON.stringify({
    id: "EVENT-20260927-001",
    create_time: "2026-09-27T10:00:00+08:00",
    event_type: "TRANSACTION.SUCCESS",
    resource_type: "encrypt-resource",
    resource: encryptResource(transaction, fixture.apiV3Key),
  });
  const timestamp = "1700000000";
  const nonce = "callback-request-nonce";
  const signature = signMessage(fixture.platformPrivateKey, `${timestamp}\n${nonce}\n${rawBody}\n`);
  const provider = createWechatPayProvider({
    env: fixture.env,
    now: () => 1_700_000_000_000,
  });

  const event = await provider.verifyWebhook(
    createWebhookRequest({ body: rawBody, timestamp, nonce, signature }),
  );

  assert.deepEqual(event, {
    provider: "wechat",
    providerEventId: "EVENT-20260927-001",
    providerOrderId: "ORDER-20260927-002",
    providerTransactionId: "420000000020260927000001",
    status: "paid",
    amountCents: 941,
    currency: "CNY",
    raw: transaction,
  });
});

test("wechat webhook rejects tampered signatures and stale timestamps", async () => {
  const fixture = createFixture();
  const transaction = {
    mchid: fixture.env.WECHAT_PAY_MCH_ID,
    appid: fixture.env.WECHAT_PAY_APP_ID,
    out_trade_no: "ORDER-20260927-003",
    transaction_id: "420000000020260927000003",
    trade_state: "SUCCESS",
    amount: { total: 99, currency: "CNY" },
  };
  const rawBody = JSON.stringify({
    id: "EVENT-20260927-003",
    event_type: "TRANSACTION.SUCCESS",
    resource_type: "encrypt-resource",
    resource: encryptResource(transaction, fixture.apiV3Key),
  });
  const timestamp = "1700000000";
  const nonce = "callback-stale";
  const provider = createWechatPayProvider({
    env: fixture.env,
    now: () => 1_700_000_301_000,
  });

  await assert.rejects(
    provider.verifyWebhook(
      createWebhookRequest({
        body: rawBody,
        timestamp,
        nonce,
        signature: signMessage(fixture.platformPrivateKey, `${timestamp}\n${nonce}\n${rawBody}\n`),
      }),
    ),
    /时间戳已过期/,
  );

  await assert.rejects(
    provider.verifyWebhook(
      createWebhookRequest({
        body: rawBody,
        timestamp: "1700000001",
        nonce,
        signature: "invalid-signature",
      }),
    ),
    /签名验证失败/,
  );
});

test("wechat webhook rejects amount currency and trade state mismatches", async () => {
  const fixture = createFixture();
  const timestamp = "1700000000";
  const nonce = "callback-validation";
  const provider = createWechatPayProvider({
    env: fixture.env,
    now: () => 1_700_000_000_000,
  });

  async function verifyTransaction(amount: Record<string, unknown>) {
    const transaction = {
      mchid: fixture.env.WECHAT_PAY_MCH_ID,
      appid: fixture.env.WECHAT_PAY_APP_ID,
      out_trade_no: "ORDER-20260927-004",
      transaction_id: "420000000020260927000004",
      trade_state: "SUCCESS",
      amount,
    };
    const rawBody = JSON.stringify({
      id: "EVENT-20260927-004",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      resource: encryptResource(transaction, fixture.apiV3Key),
    });
    const signature = signMessage(
      fixture.platformPrivateKey,
      `${timestamp}\n${nonce}\n${rawBody}\n`,
    );
    return provider.verifyWebhook(
      createWebhookRequest({ body: rawBody, timestamp, nonce, signature }),
    );
  }

  await assert.rejects(verifyTransaction({ total: 0, currency: "CNY" }), /金额不正确/);
  await assert.rejects(verifyTransaction({ total: 941, currency: "USD" }), /币种不匹配/);
});

test("createPaymentOrder sends a WeChat-compatible out_trade_no to the adapter", async () => {
  const fixture = createFixture();
  const { pg, sql } = await createTestContext();
  try {
    const userId = await createUser(sql);
    let sentBody: Record<string, unknown> | null = null;
    const provider = createWechatPayProvider({
      env: fixture.env,
      now: () => 1_700_000_000_000,
      nonce: () => "merchant-integration-nonce",
      fetch: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return createSignedResponse(
          fixture,
          JSON.stringify({
            code_url: "weixin://wxpay/bizpayurl?pr=integration-code",
            prepay_id: "wx-prepay-integration",
          }),
        );
      },
    });
    const orders = createPaymentOrdersService(sql, provider);

    const order = await orders.createPaymentOrder(userId, "single", "integration-order-id");
    const outTradeNo = String((sentBody as unknown as Record<string, unknown>).out_trade_no);

    assert.equal(outTradeNo, order.id);
    assert.match(outTradeNo, /^payment_[0-9a-f]{24}$/);
    assert.ok(outTradeNo.length >= 6 && outTradeNo.length <= 32);
  } finally {
    await pg.close();
  }
});

test("createPaymentOrder persists a recoverable WeChat pending order", async () => {
  const fixture = createFixture();
  const { pg, sql } = await createTestContext();
  try {
    const userId = await createUser(sql);
    const provider = createWechatPayProvider({
      env: fixture.env,
      now: () => 1_700_000_000_000,
      nonce: () => "merchant-order-recovery-nonce",
      fetch: async (input) => {
        const url = String(input);
        if (url === "https://api.mch.weixin.qq.com/v3/pay/transactions/native") {
          return new Response(
            JSON.stringify({ code: "OUT_TRADE_NO_USED", message: "订单号已使用" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        const outTradeNo = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
        return createSignedResponse(
          fixture,
          JSON.stringify({
            mchid: fixture.env.WECHAT_PAY_MCH_ID,
            appid: fixture.env.WECHAT_PAY_APP_ID,
            out_trade_no: outTradeNo,
            trade_state: "USERPAYING",
            trade_state_desc: "用户支付中",
            amount: { total: 99, currency: "CNY" },
          }),
        );
      },
    });
    const orders = createPaymentOrdersService(sql, provider);
    let recoveryError: PaymentProviderRecoveryRequiredError | null = null;

    await assert.rejects(
      orders.createPaymentOrder(userId, "single", "recoverable-order"),
      (error) => {
        assert.ok(error instanceof PaymentProviderRecoveryRequiredError);
        recoveryError = error;
        return true;
      },
    );

    const rows = await sql.query<{ provider_order_id: string; status: string }>(
      "select provider_order_id, status from payment_orders",
    );
    const expectedProviderOrderId = (recoveryError as PaymentProviderRecoveryRequiredError | null)
      ?.providerOrderId;
    assert.equal(rows[0]?.provider_order_id, expectedProviderOrderId);
    assert.match(rows[0]?.provider_order_id ?? "", /^payment_[0-9a-f]{24}$/);
    assert.equal(rows[0]?.status, "pending");
  } finally {
    await pg.close();
  }
});

test("wechat native response signature is required and validated", async () => {
  const fixture = createFixture();
  const request = {
    orderId: "ORDER-20260927-RESPONSE",
    amountCents: 941,
    description: "行旅点册 10 点",
  };
  const responseBody = JSON.stringify({
    code_url: "weixin://wxpay/bizpayurl?pr=response-code",
    prepay_id: "wx-prepay-response",
  });

  const createProvider = (response: Response) =>
    createWechatPayProvider({
      env: fixture.env,
      now: () => 1_700_000_000_000,
      fetch: async () => response,
    });

  await assert.rejects(
    createProvider(Response.json(JSON.parse(responseBody))).createPayment(request),
    /缺少.*验签|签名/,
  );
  await assert.rejects(
    createProvider(
      createSignedResponse(fixture, responseBody, { signature: "invalid-response-signature" }),
    ).createPayment(request),
    /签名验证失败/,
  );
  await assert.rejects(
    createProvider(
      createSignedResponse(fixture, responseBody, { serial: "OTHER-SERIAL" }),
    ).createPayment(request),
    /序列号不匹配/,
  );
  await assert.rejects(
    createProvider(
      createSignedResponse(fixture, responseBody, { timestamp: "1699999690" }),
    ).createPayment(request),
    /时间戳已过期/,
  );
});

test("wechat requests time out through AbortSignal", async () => {
  const fixture = createFixture();
  const provider = createWechatPayProvider({
    env: fixture.env,
    now: () => 1_700_000_000_000,
    timeoutMs: 5,
    fetch: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        if (!init?.signal) {
          reject(new Error("缺少 AbortSignal"));
          return;
        }
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("请求超时", "TimeoutError")),
          { once: true },
        );
      }),
  });

  await assert.rejects(
    provider.createPayment({
      orderId: "ORDER-20260927-TIMEOUT",
      amountCents: 99,
      description: "行旅点册 1 点",
    }),
    /请求超时/,
  );
});

test("wechat createPayment recovers a paid order after OUT_TRADE_NO_USED", async () => {
  const fixture = createFixture();
  const orderId = "ORDER-20260927-RECOVERY";
  const transactionId = "420000000020260927000099";
  let nativeCalls = 0;
  let queryCalls = 0;
  const provider = createWechatPayProvider({
    env: fixture.env,
    now: () => 1_700_000_000_000,
    nonce: () => "merchant-recovery-nonce",
    fetch: async (input) => {
      const url = String(input);
      if (url === "https://api.mch.weixin.qq.com/v3/pay/transactions/native") {
        nativeCalls += 1;
        return new Response(
          JSON.stringify({ code: "OUT_TRADE_NO_USED", message: "订单号已使用" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      queryCalls += 1;
      assert.match(url, /out-trade-no/);
      return createSignedResponse(
        fixture,
        JSON.stringify({
          mchid: fixture.env.WECHAT_PAY_MCH_ID,
          appid: fixture.env.WECHAT_PAY_APP_ID,
          out_trade_no: orderId,
          transaction_id: transactionId,
          trade_state: "SUCCESS",
          amount: { total: 941, currency: "CNY" },
        }),
      );
    },
  });

  const payment = await provider.createPayment({
    orderId,
    amountCents: 941,
    description: "行旅点册 10 点",
  });

  assert.equal(nativeCalls, 1);
  assert.equal(queryCalls, 1);
  assert.equal(payment.providerOrderId, orderId);
  assert.equal(payment.providerTransactionId, transactionId);
  assert.equal(payment.status, "paid");
  assert.equal(payment.redirectUrl, null);
  assert.equal(payment.payload.recoveredFromQuery, true);
});

test("wechat retry after a lost native response recovers the existing order", async () => {
  const fixture = createFixture();
  const orderId = "ORDER-20260927-LOST-RESPONSE";
  const transactionId = "420000000020260927000100";
  let nativeCalls = 0;
  let queryCalls = 0;
  const provider = createWechatPayProvider({
    env: fixture.env,
    now: () => 1_700_000_000_000,
    nonce: () => "merchant-lost-response-nonce",
    fetch: async (input) => {
      const url = String(input);
      if (url === "https://api.mch.weixin.qq.com/v3/pay/transactions/native") {
        nativeCalls += 1;
        if (nativeCalls === 1) {
          return createSignedResponse(
            fixture,
            JSON.stringify({
              code_url: "weixin://wxpay/bizpayurl?pr=lost-response-code",
              prepay_id: "wx-prepay-lost-response",
            }),
          );
        }
        return new Response(
          JSON.stringify({ code: "OUT_TRADE_NO_USED", message: "订单号已使用" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      queryCalls += 1;
      return createSignedResponse(
        fixture,
        JSON.stringify({
          mchid: fixture.env.WECHAT_PAY_MCH_ID,
          appid: fixture.env.WECHAT_PAY_APP_ID,
          out_trade_no: orderId,
          transaction_id: transactionId,
          trade_state: "SUCCESS",
          amount: { total: 941, currency: "CNY" },
        }),
      );
    },
  });

  const first = await provider.createPayment({
    orderId,
    amountCents: 941,
    description: "行旅点册 10 点",
  });
  const recovered = await provider.createPayment({
    orderId,
    amountCents: 941,
    description: "行旅点册 10 点",
  });

  assert.equal(first.status, "created");
  assert.equal(recovered.status, "paid");
  assert.equal(recovered.providerTransactionId, transactionId);
  assert.equal(nativeCalls, 2);
  assert.equal(queryCalls, 1);
});

test("wechat createPayment reports pending recovery when the queried order has no code_url", async () => {
  const fixture = createFixture();
  const orderId = "ORDER-20260927-PENDING";
  const provider = createWechatPayProvider({
    env: fixture.env,
    now: () => 1_700_000_000_000,
    nonce: () => "merchant-pending-nonce",
    fetch: async (input) => {
      const url = String(input);
      if (url === "https://api.mch.weixin.qq.com/v3/pay/transactions/native") {
        return new Response(
          JSON.stringify({ code: "OUT_TRADE_NO_USED", message: "订单号已使用" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return createSignedResponse(
        fixture,
        JSON.stringify({
          mchid: fixture.env.WECHAT_PAY_MCH_ID,
          appid: fixture.env.WECHAT_PAY_APP_ID,
          out_trade_no: orderId,
          trade_state: "NOTPAY",
          trade_state_desc: "订单未支付",
          amount: { total: 99, currency: "CNY" },
        }),
      );
    },
  });

  await assert.rejects(
    provider.createPayment({ orderId, amountCents: 99, description: "行旅点册 1 点" }),
    (error) => {
      assert.ok(error instanceof PaymentProviderRecoveryRequiredError);
      assert.equal(error.providerOrderId, orderId);
      assert.match(error.message, /待查询|重试/);
      return true;
    },
  );
});

test("wechat webhook only accepts transaction success encrypt-resource events", async () => {
  const fixture = createFixture();
  const transaction = {
    mchid: fixture.env.WECHAT_PAY_MCH_ID,
    appid: fixture.env.WECHAT_PAY_APP_ID,
    out_trade_no: "ORDER-20260927-EVENT",
    transaction_id: "420000000020260927000101",
    trade_state: "SUCCESS",
    amount: { total: 99, currency: "CNY" },
  };
  const timestamp = "1700000000";
  const nonce = "callback-event-type";
  const provider = createWechatPayProvider({
    env: fixture.env,
    now: () => 1_700_000_000_000,
  });

  for (const [eventType, resourceType] of [
    ["TRANSACTION.CLOSED", "encrypt-resource"],
    ["TRANSACTION.SUCCESS", "plain-resource"],
  ] as const) {
    const rawBody = JSON.stringify({
      id: `EVENT-${eventType}-${resourceType}`,
      event_type: eventType,
      resource_type: resourceType,
      resource: encryptResource(transaction, fixture.apiV3Key),
    });
    const signature = signMessage(
      fixture.platformPrivateKey,
      `${timestamp}\n${nonce}\n${rawBody}\n`,
    );
    await assert.rejects(
      provider.verifyWebhook(createWebhookRequest({ body: rawBody, timestamp, nonce, signature })),
      /事件类型|resource_type/,
    );
  }
});

test("wechat provider registry uses wechat in production and remains fail closed", () => {
  const fixture = createFixture();
  const provider = resolvePaymentProvider({
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "wechat",
    ...fixture.env,
  } as NodeJS.ProcessEnv);
  assert.equal(provider.id, "wechat");

  assert.throws(
    () =>
      resolvePaymentProvider({
        NODE_ENV: "production",
        PAYMENT_PROVIDER: "wechat",
      } as NodeJS.ProcessEnv),
    /WECHAT_PAY_MCH_ID/,
  );
});
