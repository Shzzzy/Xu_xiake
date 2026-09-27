import assert from "node:assert/strict";
import test from "node:test";
import { applyPendingPlanRestore, pendingPlanActionLabel } from "./pending-plan-restore.ts";
import type { TripPlan } from "./travel-plan.ts";

function plan(): TripPlan {
  return {
    meta: {
      title: "登录后恢复行程",
      origin: "北京",
      waypoints: ["开封"],
      destination: "沙湖",
      startDate: "2026-10-01",
      days: 4,
      travelers: { adults: 2, children: 1 },
      perPersonBudget: 2500,
      transportPreference: "balanced",
      pace: "balanced",
      interests: ["历史", "自然"],
    },
    budget: { totalBudget: 7500 },
    route: { returnMode: "fast" },
  } as unknown as TripPlan;
}

test("登录回跳可恢复 export、share、preview 三种结果页动作", () => {
  for (const action of ["export", "share", "preview"] as const) {
    const restored = applyPendingPlanRestore({
      planId: "plan-restored",
      requestFingerprint: "plan-restored",
      entitlementToken: "token-restored",
      action,
      executionPlan: plan(),
    });
    assert.equal(restored.screen, "result");
    assert.equal(restored.planId, "plan-restored");
    assert.equal(restored.action, action);
    assert.equal(restored.executionPlan.meta.title, "登录后恢复行程");
    assert.equal(restored.brief.origin, "北京");
    assert.equal(restored.brief.destinationName, "沙湖");
    assert.equal(restored.brief.waypoints[0], "开封");
    assert.match(pendingPlanActionLabel(action), /导出|分享|查看/);
  }
});
