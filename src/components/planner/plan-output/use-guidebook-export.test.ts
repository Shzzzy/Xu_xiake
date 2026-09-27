import assert from "node:assert/strict";
import test from "node:test";
import { runGuidebookExportAttempt } from "./use-guidebook-export.ts";
import type { TripPlan } from "@/lib/travel-plan";

function plan(): TripPlan {
  return { meta: { title: "导出恢复测试" } } as unknown as TripPlan;
}

test("会话仍在解析时导出控制器回到 idle，不卡在 preparing", async () => {
  const result = await runGuidebookExportAttempt({
    isPending: true,
    hasUser: false,
    plan: plan(),
    planId: "plan-pending",
    entitlementToken: "token",
    requestFingerprint: "plan-pending",
    ensureExport: async () => {
      throw new Error("不应调用权益接口");
    },
    exportPdf: async () => ({ status: "failed", message: "不应调用导出" }),
  });
  assert.equal(result.state.stage, "idle");
  assert.equal(result.state.progress, 0);
  assert.equal(result.redirect, null);
});

test("登录回跳后的 paid 计划直接通过权益校验并进入导出", async () => {
  let ensureCalls = 0;
  const result = await runGuidebookExportAttempt({
    isPending: false,
    hasUser: true,
    plan: plan(),
    planId: "plan-paid",
    entitlementToken: "token",
    requestFingerprint: "plan-paid",
    ensureExport: async () => {
      ensureCalls += 1;
    },
    exportPdf: async () => ({ status: "failed", message: "不应调用服务端导出" }),
    printDocument: () => "printed",
  });
  assert.equal(ensureCalls, 1);
  assert.equal(result.state.stage, "ready");
  assert.equal(result.redirect, null);
});
