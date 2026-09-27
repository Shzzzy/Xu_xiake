import type { PackageCode } from "../billing/catalog.ts";

export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export type CreditWallet = {
  id: string;
  userId: string;
  balance: number;
  reserved: number;
  freeTrialClaimed: boolean;
  version: number;
};

export type CreditLedgerEntry = {
  id: string;
  walletId: string;
  delta: number;
  balanceAfter: number;
  reason:
    | "free_trial"
    | "purchase"
    | "generation"
    | "refund"
    | "admin_adjustment"
    | "expiration"
    | "migration";
  orderId: string | null;
  planId: string | null;
  operatorUserId: string | null;
  note: string | null;
  createdAt: string;
};

export type CreditReservation = {
  id: string;
  walletId: string;
  planId: string | null;
  status: "reserved" | "consumed" | "released" | "expired";
  expiresAt: string;
};

export type PaymentOrder = {
  id: string;
  userId: string;
  walletId: string;
  packageCode: PackageCode;
  points: number;
  amountCents: number;
  currency: string;
  provider: string;
  providerOrderId: string | null;
  providerTransactionId: string | null;
  status: "created" | "pending" | "paid" | "failed" | "expired" | "refunded" | "closed";
  paidAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  clientRequestId: string | null;
  redirectUrl: string | null;
  paymentPayload: Record<string, unknown>;
};
