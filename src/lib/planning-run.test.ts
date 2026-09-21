import test from "node:test";
import assert from "node:assert/strict";
import { canStartStage, createPlanningRun, setStageStatus } from "./planning-run.ts";

test("后续阶段在前置阶段通过前不能启动", () => {
  const run = createPlanningRun("run-1");
  assert.equal(canStartStage(run, "pois"), false);
  const routePassed = setStageStatus(run, "route", "passed");
  assert.equal(canStartStage(routePassed, "pois"), true);
});

test("降级的前置阶段仍允许后续阶段启动", () => {
  const routeDegraded = setStageStatus(createPlanningRun("run-2"), "route", "degraded");
  assert.equal(canStartStage(routeDegraded, "pois"), true);
});

test("任一更早的前置阶段未完成时不能启动后续阶段", () => {
  const poisPassed = setStageStatus(createPlanningRun("run-3"), "pois", "passed");
  assert.equal(canStartStage(poisPassed, "selection"), false);
});

test("阶段状态更新保持不可变并同步错误信息", () => {
  const run = createPlanningRun("run-4");
  const failed = setStageStatus(run, "route", "failed", "路线查询失败");

  assert.notEqual(failed, run);
  assert.notEqual(failed.stages, run.stages);
  assert.deepEqual(run.stages.route, { status: "pending" });
  assert.deepEqual(failed.stages.route, { status: "failed", error: "路线查询失败" });

  const passed = setStageStatus(failed, "route", "passed");

  assert.deepEqual(failed.stages.route, { status: "failed", error: "路线查询失败" });
  assert.deepEqual(passed.stages.route, { status: "passed" });
});

test("目标阶段只有 pending 时才能启动，重复启动需要显式重置", () => {
  const run = createPlanningRun("run-repeat");
  const running = setStageStatus(run, "route", "running");
  const passed = setStageStatus(run, "route", "passed");
  const reset = setStageStatus(passed, "route", "pending");

  assert.equal(canStartStage(running, "route"), false);
  assert.equal(canStartStage(passed, "route"), false);
  assert.equal(canStartStage(reset, "route"), true);
});
