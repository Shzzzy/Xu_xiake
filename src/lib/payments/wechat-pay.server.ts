import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createSign,
  randomBytes,
  verify,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import {
  PaymentProviderRecoveryRequiredError,
  type CreatePaymentInput,
  type CreatedPayment,
  type PaymentProvider,
  type PaymentWebhookEvent,
} from "./provider.ts";

const WECHAT_API_BASE_URL = "https://api.mch.weixin.qq.com";
const WECHAT_NATIVE_PATH = "/v3/pay/transactions/native";
const WECHAT_NATIVE_URL = `${WECHAT_API_BASE_URL}${WECHAT_NATIVE_PATH}`;
const WECHAT_TIMESTAMP_SKEW_SECONDS = 300;
const WECHAT_API_V3_KEY_BYTES = 32;

type PaymentEnv = Record<string, string | undefined>;

export type WechatPayConfig = {
  mchId: string;
  appId: string;
  serialNo: string;
  privateKey: KeyObject;
  apiV3Key: string;
  platformPublicKey: KeyObject;
  platformSerialNumber: string | null;
  notifyUrl: string;
};

export type WechatPayProviderOptions = {
  env?: PaymentEnv;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
};

type Row = Record<string, unknown>;

function asRecord(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}格式不正确`);
  }
  return value as Row;
}

function requiredString(body: Row, key: string, label = "微信支付回调"): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}缺少 ${key}`);
  }
  return value.trim();
}

function parseJsonObject(text: string, label: string): Row {
  try {
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed, label);
  } catch (error) {
    if (error instanceof Error && error.message.includes("格式不正确")) throw error;
    throw new Error(`${label}不是合法 JSON`);
  }
}

function normalizePem(value: string): string {
  // 环境变量中常把换行写成字面量 \n，先还原后再交给 Node 解析。
  return value.replace(/\\n/g, "\n").trim();
}

function requireEnv(env: PaymentEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`微信支付缺少环境变量：${key}`);
  return value;
}

function normalizeSerial(value: string): string {
  return value.replace(/:/g, "").trim().toUpperCase();
}

function readPlatformKey(value: string): {
  publicKey: KeyObject;
  serialNumber: string | null;
} {
  const pem = normalizePem(value);
  if (pem.includes("-----BEGIN CERTIFICATE-----")) {
    const certificate = new X509Certificate(pem);
    return {
      publicKey: certificate.publicKey,
      serialNumber: normalizeSerial(certificate.serialNumber),
    };
  }

  if (
    pem.includes("-----BEGIN PUBLIC KEY-----") ||
    pem.includes("-----BEGIN RSA PUBLIC KEY-----")
  ) {
    return { publicKey: createPublicKey(pem), serialNumber: null };
  }

  throw new Error("微信支付平台证书格式不正确");
}

/** 校验微信回调金额必须为正整数，并与本地订单金额完全一致。 */
export function assertWechatAmount(amountCents: number, localOrderCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("微信支付金额不正确");
  }
  if (!Number.isInteger(localOrderCents) || localOrderCents <= 0) {
    throw new Error("本地订单金额不正确");
  }
  if (amountCents !== localOrderCents) {
    throw new Error("微信支付金额不匹配");
  }
}

/** 读取并校验微信支付生产配置，缺失或格式错误时立即 fail closed。 */
export function loadWechatPayConfig(env: PaymentEnv = process.env): WechatPayConfig {
  const mchId = requireEnv(env, "WECHAT_PAY_MCH_ID");
  const appId = requireEnv(env, "WECHAT_PAY_APP_ID");
  const serialNo = requireEnv(env, "WECHAT_PAY_SERIAL_NO");
  const privateKeyText = normalizePem(requireEnv(env, "WECHAT_PAY_PRIVATE_KEY"));
  const apiV3Key = requireEnv(env, "WECHAT_PAY_API_V3_KEY");
  const platformCertificate = requireEnv(env, "WECHAT_PAY_PLATFORM_CERT");
  const configuredPlatformSerial = env.WECHAT_PAY_PLATFORM_SERIAL_NO?.trim();
  const notifyUrl = requireEnv(env, "WECHAT_PAY_NOTIFY_URL");

  if (Buffer.byteLength(apiV3Key, "utf8") !== WECHAT_API_V3_KEY_BYTES) {
    throw new Error("微信支付 API v3 密钥必须为 32 字节");
  }

  const privateKey = createPrivateKey(privateKeyText);
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error("微信支付商户私钥必须是 RSA 私钥");
  }

  const platform = readPlatformKey(platformCertificate);
  if (platform.publicKey.asymmetricKeyType !== "rsa") {
    throw new Error("微信支付平台证书必须是 RSA 公钥或证书");
  }

  const platformSerialNumber = configuredPlatformSerial
    ? normalizeSerial(configuredPlatformSerial)
    : platform.serialNumber;
  if (
    configuredPlatformSerial &&
    platform.serialNumber &&
    normalizeSerial(configuredPlatformSerial) !== platform.serialNumber
  ) {
    throw new Error("微信支付平台序列号与证书不一致");
  }

  const parsedNotifyUrl = new URL(notifyUrl);
  if (parsedNotifyUrl.protocol !== "https:") {
    throw new Error("微信支付回调地址必须使用 HTTPS");
  }

  return {
    mchId,
    appId,
    serialNo,
    privateKey,
    apiV3Key,
    platformPublicKey: platform.publicKey,
    platformSerialNumber,
    notifyUrl,
  };
}

function buildAuthorization(
  config: WechatPayConfig,
  method: string,
  urlPath: string,
  body: string,
  timestamp: string,
  nonce: string,
): string {
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = createSign("RSA-SHA256")
    .update(message, "utf8")
    .sign(config.privateKey, "base64");
  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.serialNo}"`;
}

function readSignatureHeaders(headers: Headers): {
  timestamp: string;
  nonce: string;
  signature: string;
  serial: string;
} {
  return {
    timestamp: headers.get("Wechatpay-Timestamp")?.trim() ?? "",
    nonce: headers.get("Wechatpay-Nonce")?.trim() ?? "",
    signature: headers.get("Wechatpay-Signature")?.trim() ?? "",
    serial: headers.get("Wechatpay-Serial")?.trim() ?? "",
  };
}

/** 校验微信 API v3 的同步响应或回调签名，必须先于任何业务字段解析。 */
function verifySignedPayload(
  rawBody: string,
  headers: Headers,
  config: WechatPayConfig,
  nowMs: number,
  label: string,
): void {
  const { timestamp, nonce, signature, serial } = readSignatureHeaders(headers);
  if (!timestamp || !nonce || !signature || !serial) {
    throw new Error(`${label}缺少验签响应头`);
  }
  if (config.platformSerialNumber && normalizeSerial(serial) !== config.platformSerialNumber) {
    throw new Error(`${label}平台证书序列号不匹配`);
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds)) {
    throw new Error(`${label}时间戳不正确`);
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > WECHAT_TIMESTAMP_SKEW_SECONDS) {
    throw new Error(`${label}时间戳已过期`);
  }

  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const signatureValid = verify(
    "RSA-SHA256",
    Buffer.from(message, "utf8"),
    config.platformPublicKey,
    Buffer.from(signature, "base64"),
  );
  if (!signatureValid) throw new Error(`${label}签名验证失败`);
}

function decryptResource(resource: Row, apiV3Key: string): Row {
  const algorithm = requiredString(resource, "algorithm", "微信支付回调资源");
  if (algorithm !== "AEAD_AES_256_GCM") {
    throw new Error("微信支付回调加密算法不受支持");
  }

  const ciphertext = Buffer.from(
    requiredString(resource, "ciphertext", "微信支付回调资源"),
    "base64",
  );
  if (ciphertext.length <= 16) throw new Error("微信支付回调密文不正确");

  const nonce = requiredString(resource, "nonce", "微信支付回调资源");
  const associatedData =
    typeof resource.associated_data === "string" ? resource.associated_data : "";
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const authTag = ciphertext.subarray(ciphertext.length - 16);

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(apiV3Key, "utf8"),
      Buffer.from(nonce, "utf8"),
    );
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      "utf8",
    );
    return parseJsonObject(plaintext, "微信支付回调解密结果");
  } catch (error) {
    if (error instanceof Error && error.message.includes("不是合法 JSON")) throw error;
    throw new Error("微信支付回调解密失败");
  }
}

function mapTradeState(value: string): PaymentWebhookEvent["status"] {
  if (value === "SUCCESS") return "paid";
  if (value === "REFUND") return "refunded";
  if (value === "CLOSED" || value === "REVOKED" || value === "PAYERROR") return "failed";
  throw new Error(`微信支付交易状态不受支持：${value}`);
}

function assertWebhookAmount(amount: Row): { amountCents: number; currency: string } {
  const amountCents = Number(amount.total);
  assertWechatAmount(amountCents, amountCents);
  const currency = requiredString(amount, "currency", "微信支付回调金额");
  if (currency !== "CNY") {
    throw new Error("微信支付回调币种不匹配");
  }
  return { amountCents, currency };
}

/** 创建微信支付 API v3 Native 支付适配器。 */
export function createWechatPayProvider(options: WechatPayProviderOptions = {}): PaymentProvider {
  const config = loadWechatPayConfig(options.env ?? process.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持 fetch");

  const now = options.now ?? Date.now;
  const nonceFactory = options.nonce ?? (() => randomBytes(16).toString("hex"));
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("微信支付请求超时时间不正确");
  }

  function parseApiError(rawBody: string, status: number): { code: string; message: string } {
    try {
      const parsed = parseJsonObject(rawBody, "微信支付错误响应");
      return {
        code: typeof parsed.code === "string" && parsed.code ? parsed.code : "UNKNOWN",
        message: typeof parsed.message === "string" && parsed.message ? parsed.message : "未知错误",
      };
    } catch {
      return { code: "UNKNOWN", message: `HTTP ${status}` };
    }
  }

  async function sendRequest(
    method: "GET" | "POST",
    urlPath: string,
    body: string | null,
  ): Promise<{ response: Response; rawBody: string }> {
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = nonceFactory();
    const authorization = buildAuthorization(config, method, urlPath, body ?? "", timestamp, nonce);

    try {
      const response = await fetchImpl(`${WECHAT_API_BASE_URL}${urlPath}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          ...(body == null ? {} : { "Content-Type": "application/json" }),
        },
        body: body ?? undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { response, rawBody: await response.text() };
    } catch (error) {
      const name =
        error && typeof error === "object" ? String((error as { name?: unknown }).name) : "";
      if (name === "AbortError" || name === "TimeoutError") {
        throw new Error("微信支付请求超时");
      }
      throw new Error("微信支付请求失败");
    }
  }

  async function queryOrder(outTradeNo: string): Promise<Row> {
    const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`;
    const { response, rawBody } = await sendRequest("GET", urlPath, null);
    if (!response.ok) {
      const detail = parseApiError(rawBody, response.status);
      throw new Error(`微信支付查单失败（${detail.code}：${detail.message}）`);
    }
    verifySignedPayload(rawBody, response.headers, config, now(), "微信支付查单响应");
    return parseJsonObject(rawBody, "微信支付查单响应");
  }

  async function recoverExistingOrder(
    outTradeNo: string,
    amountCents: number,
  ): Promise<CreatedPayment> {
    const order = await queryOrder(outTradeNo);
    const queriedOrderId = requiredString(order, "out_trade_no", "微信支付查单响应");
    if (queriedOrderId !== outTradeNo) {
      throw new Error("微信支付查单订单号不匹配");
    }

    const amount = asRecord(order.amount, "微信支付查单金额");
    const queriedAmount = Number(amount.total);
    assertWechatAmount(queriedAmount, amountCents);
    const currency = requiredString(amount, "currency", "微信支付查单金额");
    if (currency !== "CNY") throw new Error("微信支付查单币种不匹配");

    const tradeState = requiredString(order, "trade_state", "微信支付查单响应");
    const tradeStateDesc =
      typeof order.trade_state_desc === "string" ? order.trade_state_desc.trim() : "";
    if (tradeState === "SUCCESS") {
      const providerTransactionId = requiredString(order, "transaction_id", "微信支付查单响应");
      return {
        provider: "wechat",
        providerOrderId: outTradeNo,
        providerTransactionId,
        status: "paid",
        redirectUrl: null,
        payload: {
          recoveredFromQuery: true,
          tradeState,
          tradeStateDesc,
          transactionId: providerTransactionId,
        },
      };
    }

    if (tradeState === "NOTPAY" || tradeState === "USERPAYING") {
      throw new PaymentProviderRecoveryRequiredError(
        outTradeNo,
        `微信支付订单已存在但当前状态为 ${tradeState}，请稍后查询或重试`,
        { recoveredFromQuery: true, tradeState, tradeStateDesc },
      );
    }

    throw new Error(`微信支付订单状态不可恢复：${tradeState}`);
  }

  return {
    id: "wechat",
    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      assertWechatAmount(input.amountCents, input.amountCents);
      const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
      if (orderId.length < 6 || orderId.length > 32) {
        throw new Error("微信支付订单号长度必须为 6-32 位");
      }
      if (typeof input.description !== "string" || !input.description.trim()) {
        throw new Error("微信支付商品描述不能为空");
      }

      const body = JSON.stringify({
        appid: config.appId,
        mchid: config.mchId,
        description: input.description.trim(),
        out_trade_no: orderId,
        notify_url: config.notifyUrl,
        amount: { total: input.amountCents, currency: "CNY" },
      });
      const { response, rawBody } = await sendRequest("POST", WECHAT_NATIVE_PATH, body);
      if (!response.ok) {
        const detail = parseApiError(rawBody, response.status);
        if (detail.code === "OUT_TRADE_NO_USED") {
          return recoverExistingOrder(orderId, input.amountCents);
        }
        throw new Error(`微信支付预下单失败（${detail.code}：${detail.message}）`);
      }

      verifySignedPayload(rawBody, response.headers, config, now(), "微信支付预下单响应");
      const responseBody = parseJsonObject(rawBody, "微信支付预下单响应");
      const codeUrl = requiredString(responseBody, "code_url", "微信支付预下单响应");
      const prepayId =
        typeof responseBody.prepay_id === "string" && responseBody.prepay_id.trim()
          ? responseBody.prepay_id.trim()
          : null;

      // 回调关联字段是 out_trade_no，因此 providerOrderId 固定使用本地订单号；
      // prepay_id 只作为微信侧预支付标识放入 payload，避免与订单主键语义混淆。
      return {
        provider: "wechat",
        providerOrderId: orderId,
        providerTransactionId: null,
        status: "created",
        redirectUrl: codeUrl,
        payload: { prepayId, codeUrl },
      };
    },

    async verifyWebhook(request: Request): Promise<PaymentWebhookEvent> {
      const rawBody = await request.text();
      verifySignedPayload(rawBody, request.headers, config, now(), "微信支付回调");

      const outerBody = parseJsonObject(rawBody, "微信支付回调");
      const eventType = requiredString(outerBody, "event_type", "微信支付回调");
      if (eventType !== "TRANSACTION.SUCCESS") {
        throw new Error(`微信支付回调事件类型不受支持：${eventType}`);
      }
      const resourceType = requiredString(outerBody, "resource_type", "微信支付回调");
      if (resourceType !== "encrypt-resource") {
        throw new Error(`微信支付回调 resource_type 不受支持：${resourceType}`);
      }
      const resource = asRecord(outerBody.resource, "微信支付回调 resource");
      const transaction = decryptResource(resource, config.apiV3Key);

      const mchId = requiredString(transaction, "mchid", "微信支付交易");
      if (mchId !== config.mchId) throw new Error("微信支付回调商户号不匹配");
      const appId = requiredString(transaction, "appid", "微信支付交易");
      if (appId !== config.appId) throw new Error("微信支付回调 AppID 不匹配");

      const providerOrderId = requiredString(transaction, "out_trade_no", "微信支付交易");
      const providerTransactionId = requiredString(transaction, "transaction_id", "微信支付交易");
      const tradeState = requiredString(transaction, "trade_state", "微信支付交易");
      const amount = assertWebhookAmount(asRecord(transaction.amount, "微信支付交易 amount"));

      return {
        provider: "wechat",
        providerEventId: requiredString(outerBody, "id", "微信支付回调"),
        providerOrderId,
        providerTransactionId,
        status: mapTradeState(tradeState),
        amountCents: amount.amountCents,
        currency: amount.currency,
        raw: transaction,
      };
    },
  };
}
