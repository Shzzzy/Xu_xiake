import assert from "node:assert/strict";
import test from "node:test";
import type { TransportPlanLeg } from "./transport-planner.server.ts";
import { calculateBudget, type PriceReference } from "./budget-planner.ts";

const outboundFlight: TransportPlanLeg = {
  id: "outbound",
  kind: "outbound",
  from: "北京",
  to: "成都",
  distanceKm: 1800,
  mode: "flight",
  doorToDoorMinutes: 330,
  minimumPerPersonCost: 1000,
};

const returnFlight: TransportPlanLeg = {
  ...outboundFlight,
  id: "return",
  kind: "return",
  from: "成都",
  to: "北京",
};

const adultTicket: PriceReference = {
  kind: "ticket",
  label: "成人门票",
  amount: 200,
  currency: "CNY",
  source: "https://example.com/tickets",
  confidence: "verified",
};

const childTicket: PriceReference = {
  kind: "ticket",
  label: "儿童优惠票",
  amount: 100,
  currency: "CNY",
  source: "https://example.com/tickets",
  confidence: "reference",
};

test("5 人往返交通按单人价格乘人数和段数", () => {
  const budget = calculateBudget({
    travelers: { adults: 5, children: 0 },
    days: 5,
    transport: [outboundFlight, returnFlight],
    ticketPrices: [],
    lodgingPerNight: 500,
    foodPerPersonPerDay: 150,
  });

  assert.equal(budget.transport, 10_000);
  assert.equal(budget.lodging, 6_000);
  assert.equal(budget.food, 3_750);
  assert.equal(budget.tickets, 0);
  assert.equal(budget.other, 1_975);
  assert.equal(
    budget.estimatedTotal,
    budget.transport + budget.lodging + budget.food + budget.tickets + budget.other,
  );
});

test("成人儿童门票分别按人数计价", () => {
  const budget = calculateBudget({
    travelers: { adults: 2, children: 1 },
    days: 2,
    transport: [],
    ticketPrices: [adultTicket, childTicket],
    lodgingPerNight: 600,
    foodPerPersonPerDay: 120,
  });

  assert.equal(budget.tickets, 500);
  assert.equal(budget.lodging, 1_200);
  assert.equal(budget.food, 720);
  assert.equal(budget.other, 242);
  assert.equal(budget.estimatedTotal, 2_662);
});

test("价格引用保留来源与置信度且低置信价格标记为参考价", () => {
  const budget = calculateBudget({
    travelers: { adults: 2, children: 1 },
    days: 3,
    transport: [outboundFlight],
    ticketPrices: [adultTicket, childTicket],
    lodgingPerNight: 500,
    foodPerPersonPerDay: 150,
  });

  const adultReference = budget.priceReferences.find((reference) =>
    reference.label.includes("成人门票"),
  );
  const childReference = budget.priceReferences.find((reference) =>
    reference.label.includes("儿童优惠票"),
  );
  const transportReference = budget.priceReferences.find(
    (reference) => reference.kind === "transport",
  );

  assert.equal(adultReference?.confidence, "verified");
  assert.equal(adultReference?.source, "https://example.com/tickets");
  assert.equal(adultReference?.total, 400);
  assert.equal(childReference?.confidence, "reference");
  assert.match(childReference?.label ?? "", /参考价/);
  assert.equal(childReference?.total, 100);
  assert.equal(transportReference?.confidence, "fallback");
  assert.match(transportReference?.label ?? "", /参考价/);
});

test("其他费用按前四项精确百分之十计算", () => {
  const budget = calculateBudget({
    travelers: { adults: 1, children: 0 },
    days: 2,
    transport: [{ ...outboundFlight, minimumPerPersonCost: 1_000 }],
    ticketPrices: [],
    lodgingPerNight: 1_001,
    foodPerPersonPerDay: 1_000,
  });

  assert.equal(budget.other, 400.1);
  assert.equal(budget.estimatedTotal, 4_401.1);
});

test("交通优先使用传入价格引用的来源和置信度", () => {
  const verifiedTransport: PriceReference = {
    kind: "transport",
    label: "航班真实报价",
    amount: 1_000,
    currency: "CNY",
    source: "tavily:flight-price",
    confidence: "verified",
  };
  const referenceTransport: PriceReference = {
    kind: "transport",
    label: "航班参考报价",
    amount: 900,
    currency: "CNY",
    confidence: "reference",
  };

  const budget = calculateBudget({
    travelers: { adults: 1, children: 0 },
    days: 1,
    transport: [
      { ...outboundFlight, minimumPerPersonCost: 1, priceReference: verifiedTransport },
      { ...returnFlight, minimumPerPersonCost: 1, priceReference: referenceTransport },
    ],
    ticketPrices: [],
    lodgingPerNight: 0,
    foodPerPersonPerDay: 0,
  });

  assert.equal(budget.transport, 1_900);
  assert.equal(budget.provenance.transport[0]?.source, "tavily:flight-price");
  assert.equal(budget.provenance.transport[0]?.confidence, "verified");
  assert.equal(budget.provenance.transport[1]?.source, undefined);
  assert.equal(budget.provenance.transport[1]?.confidence, "reference");
  assert.match(budget.provenance.transport[1]?.label ?? "", /参考价/);
});

test("住宿和餐饮保留传入价格引用的来源与置信度", () => {
  const lodgingPrice: PriceReference = {
    kind: "lodging",
    label: "酒店真实房价",
    amount: 500,
    currency: "CNY",
    source: "tavily:hotel",
    confidence: "verified",
  };
  const foodPrice: PriceReference = {
    kind: "food",
    label: "当地餐标参考",
    amount: 150,
    currency: "CNY",
    source: "tavily:food",
    confidence: "reference",
  };

  const budget = calculateBudget({
    travelers: { adults: 1, children: 0 },
    days: 2,
    transport: [],
    ticketPrices: [],
    lodgingPerNight: lodgingPrice,
    foodPerPersonPerDay: foodPrice,
  });

  assert.equal(budget.lodging, 500);
  assert.equal(budget.food, 300);
  assert.equal(budget.provenance.lodging.source, "tavily:hotel");
  assert.equal(budget.provenance.lodging.confidence, "verified");
  assert.equal(budget.provenance.food.source, "tavily:food");
  assert.equal(budget.provenance.food.confidence, "reference");
  assert.match(budget.provenance.food.label, /参考价/);
});

test("显式门票类别优先于名称关键词", () => {
  const explicitAdult: PriceReference = {
    kind: "ticket",
    label: "名称像儿童票但显式为成人",
    category: "adult",
    amount: 200,
    currency: "CNY",
    source: "ticket-api",
    confidence: "verified",
  };
  const explicitChild: PriceReference = {
    kind: "ticket",
    label: "名称像成人票但显式为儿童",
    category: "child",
    amount: 100,
    currency: "CNY",
    source: "ticket-api",
    confidence: "verified",
  };

  const budget = calculateBudget({
    travelers: { adults: 2, children: 1 },
    days: 1,
    transport: [],
    ticketPrices: [explicitAdult, explicitChild],
    lodgingPerNight: 0,
    foodPerPersonPerDay: 0,
  });

  assert.equal(budget.tickets, 500);
  assert.equal(budget.provenance.tickets[0]?.quantity, 2);
  assert.equal(budget.provenance.tickets[1]?.quantity, 1);
});

test("统一票价按全部同行人数计算", () => {
  const uniformTicket: PriceReference = {
    kind: "ticket",
    label: "统一票价联票",
    category: "uniform",
    amount: 80,
    currency: "CNY",
    source: "ticket-api",
    confidence: "verified",
  };

  const budget = calculateBudget({
    travelers: { adults: 2, children: 1 },
    days: 1,
    transport: [],
    ticketPrices: [uniformTicket],
    lodgingPerNight: 0,
    foodPerPersonPerDay: 0,
  });

  assert.equal(budget.tickets, 240);
  assert.equal(budget.provenance.tickets[0]?.quantity, 3);
});

test("交通价格引用按 legId 匹配，不依赖数组顺序", () => {
  const references: PriceReference[] = [
    {
      kind: "transport",
      legId: "return",
      label: "返程参考价",
      amount: 300,
      currency: "CNY",
      confidence: "reference",
    },
    {
      kind: "transport",
      legId: "outbound",
      label: "去程参考价",
      amount: 200,
      currency: "CNY",
      confidence: "reference",
    },
  ];
  const budget = calculateBudget({
    travelers: { adults: 1, children: 0 },
    days: 1,
    transport: [outboundFlight, returnFlight],
    transportPriceReferences: references,
    ticketPrices: [],
    lodgingPerNight: 0,
    foodPerPersonPerDay: 0,
  });

  assert.equal(budget.provenance.transport.find((item) => item.legId === "outbound")?.amount, 200);
  assert.equal(budget.provenance.transport.find((item) => item.legId === "return")?.amount, 300);
});
