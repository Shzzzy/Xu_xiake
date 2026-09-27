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
  providerTransactionId?: string | null;
  /** paid 表示通过查单恢复了已支付订单，而不是本次新建支付。 */
  status?: "created" | "paid";
};

/** 微信已有支付单但暂时无法恢复 code_url 时抛出，调用方应保留订单号和待查询状态。 */
export class PaymentProviderRecoveryRequiredError extends Error {
  readonly code = "PAYMENT_PROVIDER_RECOVERY_REQUIRED";
  readonly retryable = true;
  readonly providerOrderId: string;
  readonly payload: Record<string, unknown>;

  constructor(providerOrderId: string, message: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = "PaymentProviderRecoveryRequiredError";
    this.providerOrderId = providerOrderId;
    this.payload = payload;
  }
}

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
