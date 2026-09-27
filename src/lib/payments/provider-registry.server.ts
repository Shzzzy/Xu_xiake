import type { PaymentProvider } from "./provider.ts";
import { createTestPaymentProvider } from "./test-provider.server.ts";

type PaymentEnv = {
  NODE_ENV?: string | undefined;
  PAYMENT_PROVIDER?: string | undefined;
};

/**
 * 根据运行环境解析支付服务商。
 * 只有明确处于测试或开发环境时才允许 test provider，其他环境一律 fail closed。
 */
export function resolvePaymentProvider(env: PaymentEnv = process.env): PaymentProvider {
  const nodeEnv = env.NODE_ENV?.trim();
  const configured = env.PAYMENT_PROVIDER?.trim();
  const testEnvironment = nodeEnv === "test" || nodeEnv === "development";

  if (!testEnvironment) {
    if (nodeEnv === "production") {
      if (!configured) throw new Error("生产环境必须配置 PAYMENT_PROVIDER");
      if (configured === "test") throw new Error("生产环境禁止使用 test 支付服务商");
      throw new Error(`暂不支持支付服务商：${configured}`);
    }
    throw new Error("仅 NODE_ENV=test 或 development 允许使用 test 支付服务商");
  }

  if (!configured || configured === "test") return createTestPaymentProvider();
  throw new Error(`暂不支持支付服务商：${configured}`);
}

export function getPaymentProvider(): PaymentProvider {
  return resolvePaymentProvider(process.env);
}
