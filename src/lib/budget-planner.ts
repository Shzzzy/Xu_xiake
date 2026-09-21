import type { TransportPlanLeg } from "./transport-planner.server.ts";

export type PriceConfidence = "verified" | "reference" | "fallback";
export type TicketPriceCategory = "adult" | "child" | "uniform";

export type PriceReference = {
  kind: "transport" | "ticket" | "lodging" | "food";
  label: string;
  amount: number;
  currency: "CNY";
  source?: string;
  confidence: PriceConfidence;
  /** 交通价格可绑定到具体 leg；缺省时按数组顺序匹配。 */
  legId?: string;
  /** 门票显式类别优先于名称关键词。 */
  category?: TicketPriceCategory;
};

export type BudgetPriceReference = {
  kind: PriceReference["kind"] | "other";
  label: string;
  amount: number;
  currency: "CNY";
  source?: string;
  confidence: PriceConfidence;
  legId?: string;
  quantity: number;
  total: number;
};

export type BudgetTransportLeg = TransportPlanLeg & {
  priceReference?: PriceReference;
};

export type BudgetPriceInput = number | PriceReference;

export type BudgetPlanInput = {
  travelers: { adults: number; children: number };
  days: number;
  transport: BudgetTransportLeg[];
  /** 可选的独立交通价格数组；leg.priceReference 优先，其次按 legId、最后按顺序匹配。 */
  transportPriceReferences?: PriceReference[];
  ticketPrices: PriceReference[];
  lodgingPerNight: BudgetPriceInput;
  foodPerPersonPerDay: BudgetPriceInput;
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

type ResolvedPrice = {
  amount: number;
  label: string;
  confidence: PriceConfidence;
  source?: string;
};

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeAmount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
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

function resolvePrice(
  value: BudgetPriceInput,
  fallbackLabel: (amount: number) => string,
): ResolvedPrice {
  if (typeof value === "number") {
    const amount = normalizeAmount(value);
    return { amount, label: fallbackLabel(amount), confidence: "reference" };
  }

  const resolved: ResolvedPrice = {
    amount: normalizeAmount(value.amount),
    label: value.label,
    confidence: value.confidence,
  };
  if (value.source !== undefined) resolved.source = value.source;
  return resolved;
}

function resolveTicketCategory(reference: PriceReference): TicketPriceCategory {
  if (
    reference.category === "adult" ||
    reference.category === "child" ||
    reference.category === "uniform"
  ) {
    return reference.category;
  }

  if (/儿童|小孩|优待|优惠|半价/.test(reference.label)) return "child";
  if (/成人|全价|标准/.test(reference.label)) return "adult";
  // 没有明确类别或成人/儿童关键词时按统一票价处理，避免静默漏算儿童。
  return "uniform";
}

function ticketQuantity(category: TicketPriceCategory, adults: number, children: number): number {
  if (category === "adult") return adults;
  if (category === "child") return children;
  return adults + children;
}

function findTransportPriceReference(
  leg: BudgetTransportLeg,
  index: number,
  references: PriceReference[],
): PriceReference | undefined {
  if (leg.priceReference) return leg.priceReference;
  if (leg.id) {
    const matched = references.find((reference) => reference.legId === leg.id);
    if (matched) return matched;
  }
  return references[index];
}

export function calculateBudget(input: BudgetPlanInput): BudgetPlan {
  const adults = normalizeCount(input.travelers.adults);
  const children = normalizeCount(input.travelers.children);
  const travelerCount = adults + children;
  const days = normalizeCount(input.days);
  const nights = Math.max(0, days - 1);
  const transportInputs = input.transportPriceReferences ?? [];

  // 交通优先使用传入 PriceReference 的单人价格、来源与置信度；缺失时才回退本地最低价。
  const transportReferences = input.transport.map((leg, index) => {
    const priceReference = findTransportPriceReference(leg, index, transportInputs);
    const amount = priceReference
      ? normalizeAmount(priceReference.amount)
      : normalizeAmount(leg.minimumPerPersonCost);
    const reference = createReference({
      kind: "transport",
      label: priceReference?.label ?? `${leg.from}至${leg.to}交通单人最低价`,
      amount,
      currency: "CNY",
      confidence: priceReference?.confidence ?? "fallback",
      legId: leg.id,
      quantity: travelerCount,
      total: amount * travelerCount,
    });
    if (priceReference) {
      if (priceReference.source !== undefined) reference.source = priceReference.source;
    } else {
      reference.source = "本地交通最低价";
    }
    return reference;
  });
  const transport = transportReferences.reduce((sum, reference) => sum + reference.total, 0);

  const rooms = travelerCount > 0 ? Math.ceil(travelerCount / 2) : 0;
  const lodgingPrice = resolvePrice(
    input.lodgingPerNight,
    (amount) => `住宿每晚 ${amount} 元（${rooms} 间 × ${nights} 晚）`,
  );
  const lodging = rooms * nights * lodgingPrice.amount;

  const foodPrice = resolvePrice(
    input.foodPerPersonPerDay,
    (amount) => `餐饮每人每天 ${amount} 元`,
  );
  const food = travelerCount * days * foodPrice.amount;

  const ticketInputs = input.ticketPrices.filter((reference) => reference.kind === "ticket");
  const ticketReferences = ticketInputs.map((reference) => {
    const amount = normalizeAmount(reference.amount);
    const quantity = ticketQuantity(resolveTicketCategory(reference), adults, children);
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
    label: lodgingPrice.label,
    amount: lodgingPrice.amount,
    currency: "CNY",
    confidence: lodgingPrice.confidence,
    quantity: rooms * nights,
    total: lodging,
  });
  if (lodgingPrice.source !== undefined) lodgingReference.source = lodgingPrice.source;

  const foodReference = createReference({
    kind: "food",
    label: foodPrice.label,
    amount: foodPrice.amount,
    currency: "CNY",
    confidence: foodPrice.confidence,
    quantity: travelerCount * days,
    total: food,
  });
  if (foodPrice.source !== undefined) foodReference.source = foodPrice.source;

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
