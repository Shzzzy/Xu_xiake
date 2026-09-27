import test from "node:test";
import assert from "node:assert/strict";
import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  assertWechatAmount,
  createWechatPayProvider,
  loadWechatPayConfig,
} from "./wechat-pay.server.ts";
import { resolvePaymentProvider } from "./provider-registry.server.ts";

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
      WECHAT_PAY_NOTIFY_URL: "https://example.com/api/payments/webhook",
    },
  };
}

function signMessage(privateKey: KeyObject, message: string): string {
  return createSign("RSA-SHA256").update(message, "utf8").sign(privateKey, "base64");
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
      return Response.json({
        code_url: "weixin://wxpay/bizpayurl?pr=test-code",
        prepay_id: "wx-prepay-001",
      });
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
