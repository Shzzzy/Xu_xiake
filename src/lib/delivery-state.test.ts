import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceDeliveryState,
  canFinalize,
  isPreviewReady,
  type DeliveryState,
} from "./delivery-state.ts";

test("delivery cannot finalize before preview is ready", () => {
  const generating: DeliveryState = { key: "preview_generating", draftId: "draft-1" };
  assert.equal(canFinalize(generating), false);

  const ready = advanceDeliveryState(generating, {
    type: "preview_completed",
    pageCount: 13,
    manifestHash: "manifest-1",
  });
  assert.equal(ready.key, "awaiting_finalize");
  assert.equal(isPreviewReady(ready), true);
  assert.equal(canFinalize(ready), true);
});

test("delivery rejects out-of-order finalize success", () => {
  assert.throws(
    () =>
      advanceDeliveryState(
        { key: "brief" },
        { type: "finalize_succeeded", versionId: "version-1" },
      ),
    /不允许/,
  );
});

test("delivery records preview failure and reservation release", () => {
  const failed = advanceDeliveryState(
    { key: "preview_generating", draftId: "draft-2" },
    {
      type: "preview_failed",
      step: "pages",
      message: "页面校验失败",
      released: true,
    },
  );

  assert.deepEqual(failed, {
    key: "failed",
    step: "pages",
    message: "页面校验失败",
    released: true,
  });
});