import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceGuidebookProgress,
  GUIDEBOOK_GENERATION_STAGES,
  isGuidebookReady,
  type GuidebookGenerationState,
} from "./guidebook-generation.ts";

test("guidebook generation stages cover preparation through download readiness", () => {
  assert.deepEqual(
    GUIDEBOOK_GENERATION_STAGES.map((stage) => stage.key),
    ["idle", "preparing", "rendering", "finalizing", "ready"],
  );
  assert.deepEqual(
    GUIDEBOOK_GENERATION_STAGES.map((stage) => stage.progress),
    [0, 35, 75, 92, 100],
  );
});

test("progress advances stage by stage and never moves backwards", () => {
  let state: GuidebookGenerationState = { stage: "idle", progress: 0 };
  state = advanceGuidebookProgress(state, "preparing");
  assert.equal(state.stage, "preparing");
  assert.equal(state.progress, 35);

  state = advanceGuidebookProgress(state, "rendering");
  assert.equal(state.progress, 75);

  state = advanceGuidebookProgress(state, "preparing");
  assert.equal(state.progress, 75, "回退阶段不会让进度条倒退");

  state = advanceGuidebookProgress(state, "ready");
  assert.equal(state.progress, 100);
  assert.equal(isGuidebookReady(state), true);
});

test("failed state keeps the last reached progress", () => {
  const rendering: GuidebookGenerationState = { stage: "rendering", progress: 75 };
  const failed: GuidebookGenerationState = { stage: "failed", progress: 75, message: "渲染失败" };

  assert.equal(isGuidebookReady(failed), false);
  assert.equal(advanceGuidebookProgress(failed, "rendering").progress, rendering.progress);
});
