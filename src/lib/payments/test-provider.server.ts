import type { PaymentProvider, PaymentWebhookEvent } from "./provider.ts";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("测试支付回调格式不正确");
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`测试支付回调缺少 ${key}`);
  }
  return value;
}

function parseStatus(value: unknown): PaymentWebhookEvent["status"] {
  if (value === "paid" || value === "failed" || value === "refunded") return value;
  throw new Error("测试支付回调状态不正确");
}

/** 本地与自动化测试使用的支付服务商，不产生真实资金流。 */
export function createTestPaymentProvider(): PaymentProvider {
  return {
    id: "test",
    async createPayment(input) {
      return {
        provider: "test",
        providerOrderId: `test-${input.orderId}`,
        providerTransactionId: null,
        status: "created",
        redirectUrl: `/pricing?testOrder=${encodeURIComponent(input.orderId)}`,
        payload: {
          amountCents: input.amountCents,
          description: input.description,
        },
      };
    },
    async verifyWebhook(request) {
      const body = asRecord(await request.json());
      const amountCents = Number(body.amountCents);
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        throw new Error("测试支付回调金额不正确");
      }
      return {
        provider: "test",
        providerEventId: requiredString(body, "eventId"),
        providerOrderId: requiredString(body, "providerOrderId"),
        providerTransactionId: requiredString(body, "transactionId"),
        status: parseStatus(body.status ?? "paid"),
        amountCents,
        currency: typeof body.currency === "string" && body.currency ? body.currency : "CNY",
        raw: body,
      };
    },
  };
}
