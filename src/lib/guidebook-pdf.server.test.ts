import assert from "node:assert/strict";
import test from "node:test";
import type { BudgetCategory, TripPlan } from "./travel-plan.ts";
import { exportGuidebookForTest } from "./guidebook-pdf.server.ts";

function category(amount: number, ratio: number): BudgetCategory {
  return { min: amount, max: amount, amount, ratio };
}

const fixturePlan: TripPlan = {
  meta: {
    title: "江南水乡两日路书",
    origin: "上海",
    waypoints: ["南浔"],
    destination: "乌镇",
    startDate: "2026-09-20",
    days: 2,
    travelers: { adults: 2, children: 0 },
    perPersonBudget: 1800,
    transportPreference: "balanced",
    pace: "balanced",
    interests: ["古村古镇", "摄影"],
  },
  budget: {
    totalBudget: 3600,
    estimatedTotal: 3000,
    totalMin: 2800,
    totalMax: 3300,
    remaining: 600,
    overBudget: 0,
    perPersonBudget: 1800,
    perPersonEstimated: 1500,
    rooms: 1,
    transport: category(720, 0.24),
    lodging: category(900, 0.3),
    food: category(600, 0.2),
    tickets: category(480, 0.16),
    other: category(300, 0.1),
  },
  route: {
    outbound: [
      [121.47, 31.23],
      [120.43, 30.88],
    ],
    returnPath: [],
    outboundSegments: [],
    returnSegments: [],
    distanceKm: 150,
    durationMinutes: 120,
    returnMode: null,
  },
  days: [
    {
      date: "2026-09-20",
      theme: "水乡慢游",
      weather: "多云",
      nodes: [],
      estimatedCost: 1500,
      radar: { physical: 42, childFit: 72, weatherSensitivity: 48, timeCost: 44, crowding: 58 },
      purpose: "沿河慢走，体验江南水乡。",
      highlights: ["西栅夜色：灯光与河道相映"],
      cautions: ["周末人流较多，建议错峰用餐。"],
    },
  ],
  closing: {
    quote: null,
    source: null,
    message: "愿你在水巷橹声里，慢慢看见江南。",
  },
};

test("returns a named PDF download from the rendered guidebook", async () => {
  let renderedHtml = "";
  const result = await exportGuidebookForTest(fixturePlan, {
    renderPdf: async (html) => {
      renderedHtml = html;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.filename, "江南水乡两日路书_guidebook.pdf");
  assert.equal(result.pdfBase64, Buffer.from("%PDF").toString("base64"));
  assert.match(renderedHtml, /江南水乡两日路书/);
});

test("falls back to printable html when chromium is unavailable", async () => {
  const result = await exportGuidebookForTest(fixturePlan, {
    renderPdf: async () => {
      throw new Error("chromium unavailable");
    },
  });

  assert.equal(result.status, "html");
  if (result.status !== "html") return;
  assert.match(result.html, /江南水乡/);
  assert.match(result.message, /PDF/);
});
