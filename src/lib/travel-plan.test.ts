import test from "node:test";
import assert from "node:assert/strict";
import { estimateBudget, normalizeRadarScores } from "./travel-plan.ts";

test("adds a ten percent other budget with a minimum of 200", () => {
  const budget = estimateBudget({ transport: 1000, lodging: 500, food: 300, tickets: 200 });
  assert.equal(budget.other, 200);
  assert.equal(budget.total, 2200);
});

test("expands clustered radar scores without changing order", () => {
  assert.deepEqual(normalizeRadarScores([52, 55, 58, 61, 64]), [22, 43, 64, 85, 94]);
});

test("builds a complete trip budget from total budget and travelers", () => {
  const budget = estimateBudget({
    totalBudget: 10000,
    travelers: { adults: 2, children: 1 },
    transport: 1000,
    lodging: 500,
    food: 300,
    tickets: 200,
  });

  assert.equal(budget.estimatedTotal, 2200);
  assert.equal(budget.other.amount, 200);
  assert.equal(budget.remaining, 7800);
  assert.equal(budget.overBudget, 0);
  assert.equal(budget.perPersonBudget, 10000 / 3);
  assert.equal(budget.perPersonEstimated, 2200 / 3);
  assert.equal(budget.transport.ratio, 1000 / 2200);
});

test("keeps over-budget amounts explicit", () => {
  const budget = estimateBudget({
    totalBudget: 1000,
    travelers: { adults: 1, children: 0 },
    transport: 900,
    lodging: 200,
    food: 100,
    tickets: 100,
  });

  assert.equal(budget.estimatedTotal, 1500);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.overBudget, 500);
});
