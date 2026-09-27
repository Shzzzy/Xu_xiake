export type PaymentWebhookEvent = {
  provider: string;
  providerEventId: string;
  providerOrderId: string;
  providerTransactionId: string;
  status: "paid" | "failed" | "refunded";
  amountCents: number;
  currency: string;
  raw: Record<string, unknown>;
};

export type CreatedPayment = {
  provider: string;
  providerOrderId: string;
  redirectUrl: string | null;
  payload: Record<string, unknown>;
};

export type CreatePaymentInput = {
  orderId: string;
  amountCents: number;
  description: string;
};

export interface PaymentProvider {
  id: string;
  /**
   * 同一 orderId 必须幂等；订单服务会使用稳定 orderId 处理客户端重试。
   */
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  verifyWebhook(request: Request): Promise<PaymentWebhookEvent>;
}
