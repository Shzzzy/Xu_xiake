import type { TransportPlanLeg } from "./transport-planner.server.ts";

export type PriceConfidence = "verified" | "reference" | "fallback";

export type PriceReference = {
  kind: "transport" | "ticket";
  label: string;
  amount: number;
  currency: "CNY";
  source?: string;
  confidence: PriceConfidence;
};

export type BudgetPriceReference = {
  kind: "transport" | "ticket" | "lodging" | "food" | "other";
  label: string;
  amount: number;
  currency: "CNY";
  source?: string;
  confidence: PriceConfidence;
  quantity: number;
  total: number;
};

export type BudgetPlanInput = {
  travelers: { adults: number; children: number };
  days: number;
  transport: TransportPlanLeg[];
  ticketPrices: PriceReference[];
  lodgingPerNight: number;
  foodPerPersonPerDay: number;
};

export type BudgetPlan = {
  transport: number;
  lodging: number;
  food: number;
  tickets: number;
  other: number;
  estimatedTotal: number;
  priceReferences: BudgetPriceReference[];
  provenance: {
    transport: BudgetPriceReference[];
    tickets: BudgetPriceReference[];
    lodging: BudgetPriceReference;
    food: BudgetPriceReference;
    other: BudgetPriceReference;
  };
};

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeAmount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isChildTicket(reference: PriceReference): boolean {
  return /儿童|小孩|优待|优惠|半价/.test(reference.label);
}

function withReferenceLabel(label: string, confidence: PriceConfidence): string {
  return confidence !== "verified" && !label.includes("参考价") ? `${label}（参考价）` : label;
}

function createReference(
  reference: Omit<BudgetPriceReference, "label"> & { label: string },
): BudgetPriceReference {
  return {
    ...reference,
    label: withReferenceLabel(reference.label, reference.confidence),
  };
}

export function calculateBudget(input: BudgetPlanInput): BudgetPlan {
  const adults = normalizeCount(input.travelers.adults);
  const children = normalizeCount(input.travelers.children);
  const travelerCount = adults + children;
  const days = normalizeCount(input.days);
  const nights = Math.max(0, days - 1);

  // 交通价格统一以单人价格为基准，再乘以同行人数和交通段数。
  const transportReferences = input.transport.map((leg) => {
    const amount = normalizeAmount(leg.minimumPerPersonCost);
    const total = amount * travelerCount;
    return createReference({
      kind: "transport",
      label: `${leg.from}至${leg.to}交通单人最低价`,
      amount,
      currency: "CNY",
      source: "本地交通最低价",
      confidence: "fallback",
      quantity: travelerCount,
      total,
    });
  });
  const transport = transportReferences.reduce((sum, reference) => sum + reference.total, 0);

  const rooms = travelerCount > 0 ? Math.ceil(travelerCount / 2) : 0;
  const lodgingPerNight = normalizeAmount(input.lodgingPerNight);
  const lodging = rooms * nights * lodgingPerNight;

  const foodPerPersonPerDay = normalizeAmount(input.foodPerPersonPerDay);
  const food = travelerCount * days * foodPerPersonPerDay;

  const ticketInputs = input.ticketPrices.filter((reference) => reference.kind === "ticket");
  const ticketReferences = ticketInputs.map((reference) => {
    const amount = normalizeAmount(reference.amount);
    const quantity = isChildTicket(reference) ? children : adults;
    const budgetReference = createReference({
      kind: "ticket",
      label: reference.label,
      amount,
      currency: reference.currency,
      confidence: reference.confidence,
      quantity,
      total: amount * quantity,
    });
    if (reference.source !== undefined) budgetReference.source = reference.source;
    return budgetReference;
  });
  const tickets = ticketReferences.reduce((sum, reference) => sum + reference.total, 0);

  const subtotal = transport + lodging + food + tickets;
  const other = Math.max(200, subtotal * 0.1);
  const estimatedTotal = subtotal + other;

  const lodgingReference = createReference({
    kind: "lodging",
    label: `住宿每晚 ${lodgingPerNight} 元（${rooms} 间 × ${nights} 晚）`,
    amount: lodgingPerNight,
    currency: "CNY",
    confidence: "reference",
    quantity: rooms * nights,
    total: lodging,
  });
  const foodReference = createReference({
    kind: "food",
    label: `餐饮每人每天 ${foodPerPersonPerDay} 元`,
    amount: foodPerPersonPerDay,
    currency: "CNY",
    confidence: "reference",
    quantity: travelerCount * days,
    total: food,
  });
  const otherReference = createReference({
    kind: "other",
    label: "其他费用",
    amount: other,
    currency: "CNY",
    confidence: "fallback",
    quantity: 1,
    total: other,
  });

  const provenance = {
    transport: transportReferences,
    tickets: ticketReferences,
    lodging: lodgingReference,
    food: foodReference,
    other: otherReference,
  };

  return {
    transport,
    lodging,
    food,
    tickets,
    other,
    estimatedTotal,
    priceReferences: [
      ...provenance.transport,
      ...provenance.tickets,
      provenance.lodging,
      provenance.food,
      provenance.other,
    ],
    provenance,
  };
}
