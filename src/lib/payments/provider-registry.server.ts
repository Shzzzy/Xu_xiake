import type { PaymentProvider } from "./provider.ts";
import { createTestPaymentProvider } from "./test-provider.server.ts";

type PaymentEnv = {
  NODE_ENV?: string | undefined;
  PAYMENT_PROVIDER?: string | undefined;
};

/**
 * 根据运行环境解析支付服务商。
 * 非生产环境默认 test；生产环境永远不允许回退到 test。
 */
export function resolvePaymentProvider(env: PaymentEnv = process.env): PaymentProvider {
  const production = env.NODE_ENV === "production";
  const configured = env.PAYMENT_PROVIDER?.trim();

  if (production) {
    if (!configured) throw new Error("生产环境必须配置 PAYMENT_PROVIDER");
    if (configured === "test") throw new Error("生产环境禁止使用 test 支付服务商");
    throw new Error(`暂不支持支付服务商：${configured}`);
  }

  if (!configured || configured === "test") return createTestPaymentProvider();
  throw new Error(`暂不支持支付服务商：${configured}`);
}

export function getPaymentProvider(): PaymentProvider {
  return resolvePaymentProvider(process.env);
}
