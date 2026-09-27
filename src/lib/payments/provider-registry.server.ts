import type { PaymentProvider } from "./provider.ts";
import { createTestPaymentProvider } from "./test-provider.server.ts";
import { createWechatPayProvider } from "./wechat-pay.server.ts";

type PaymentEnv = Record<string, string | undefined> & {
  NODE_ENV?: string | undefined;
  PAYMENT_PROVIDER?: string | undefined;
};

let cachedProvider: PaymentProvider | null = null;

/**
 * 根据运行环境解析支付服务商。
 * test provider 只能用于明确的测试或开发环境；生产环境必须显式选择生产适配器。
 */
export function resolvePaymentProvider(env: PaymentEnv = process.env): PaymentProvider {
  const nodeEnv = env.NODE_ENV?.trim();
  const configured = env.PAYMENT_PROVIDER?.trim();
  const testEnvironment = nodeEnv === "test" || nodeEnv === "development";

  if (nodeEnv === "production") {
    if (!configured) throw new Error("生产环境必须配置 PAYMENT_PROVIDER");
    if (configured === "test") throw new Error("生产环境禁止使用 test 支付服务商");
    if (configured === "wechat") return createWechatPayProvider({ env });
    throw new Error(`暂不支持支付服务商：${configured}`);
  }

  if (!testEnvironment) {
    throw new Error("仅 NODE_ENV=test、development 或 production 允许解析支付服务商");
  }

  if (!configured || configured === "test") return createTestPaymentProvider();
  if (configured === "wechat") return createWechatPayProvider({ env });
  throw new Error(`暂不支持支付服务商：${configured}`);
}

/** 获取进程级缓存的支付服务商，避免每次下单重复解析证书和私钥。 */
export function getPaymentProvider(): PaymentProvider {
  cachedProvider ??= resolvePaymentProvider(process.env);
  return cachedProvider;
}
