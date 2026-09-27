import { createFileRoute } from "@tanstack/react-router";
import { getPaymentProvider } from "@/lib/payments/provider-registry.server";
import { createPaymentWebhookHandler } from "@/lib/payments/webhook.server";

export const Route = createFileRoute("/api/payments/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // 每次请求解析 provider，确保缺失或错误的生产支付配置 fail closed。
        return createPaymentWebhookHandler({ provider: getPaymentProvider() })(request);
      },
    },
  },
});
