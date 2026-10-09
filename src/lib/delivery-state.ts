export type DeliveryState =
  | { key: "brief" }
  | { key: "preflight" }
  | { key: "entitlement_reserved" }
  | { key: "draft_generating"; draftId: string }
  | { key: "draft_ready"; draftId: string }
  | { key: "preview_generating"; draftId: string }
  | {
      key: "awaiting_finalize";
      draftId: string;
      pageCount: number;
      manifestHash: string;
    }
  | { key: "finalizing"; draftId: string }
  | { key: "finalized"; draftId: string; versionId: string }
  | { key: "exporting"; versionId: string }
  | { key: "exported"; versionId: string }
  | { key: "failed"; step: string; message: string; released: boolean };

export type DeliveryEvent =
  | { type: "preflight_passed" }
  | { type: "entitlement_reserved" }
  | { type: "draft_created"; draftId: string }
  | { type: "draft_generated"; draftId: string }
  | { type: "preview_started"; draftId: string }
  | { type: "preview_completed"; pageCount: number; manifestHash: string }
  | { type: "preview_failed"; step: string; message: string; released: boolean }
  | { type: "finalize_started" }
  | { type: "finalize_succeeded"; versionId: string }
  | { type: "export_started" }
  | { type: "export_finished" }
  | { type: "reset" };

function invalidTransition(state: DeliveryState, event: DeliveryEvent): never {
  throw new Error(`不允许的交付状态迁移: ${state.key} -> ${event.type}`);
}

export function advanceDeliveryState(
  state: DeliveryState,
  event: DeliveryEvent,
): DeliveryState {
  if (event.type === "reset") return { key: "brief" };

  if (event.type === "preview_failed") {
    if (
      state.key !== "draft_generating" &&
      state.key !== "draft_ready" &&
      state.key !== "preview_generating" &&
      state.key !== "awaiting_finalize"
    ) {
      return invalidTransition(state, event);
    }
    return {
      key: "failed",
      step: event.step,
      message: event.message,
      released: event.released,
    };
  }

  switch (state.key) {
    case "brief":
      if (event.type === "preflight_passed") return { key: "preflight" };
      return invalidTransition(state, event);
    case "preflight":
      if (event.type === "entitlement_reserved") return { key: "entitlement_reserved" };
      return invalidTransition(state, event);
    case "entitlement_reserved":
      if (event.type === "draft_created") {
        return { key: "draft_generating", draftId: event.draftId };
      }
      return invalidTransition(state, event);
    case "draft_generating":
      if (event.type === "draft_generated" && event.draftId === state.draftId) {
        return { key: "draft_ready", draftId: state.draftId };
      }
      return invalidTransition(state, event);
    case "draft_ready":
      if (event.type === "preview_started" && event.draftId === state.draftId) {
        return { key: "preview_generating", draftId: state.draftId };
      }
      return invalidTransition(state, event);
    case "preview_generating":
      if (event.type === "preview_completed") {
        return {
          key: "awaiting_finalize",
          draftId: state.draftId,
          pageCount: event.pageCount,
          manifestHash: event.manifestHash,
        };
      }
      return invalidTransition(state, event);
    case "awaiting_finalize":
      if (event.type === "finalize_started") {
        return { key: "finalizing", draftId: state.draftId };
      }
      return invalidTransition(state, event);
    case "finalizing":
      if (event.type === "finalize_succeeded") {
        return { key: "finalized", draftId: state.draftId, versionId: event.versionId };
      }
      return invalidTransition(state, event);
    case "finalized":
      if (event.type === "export_started") {
        return { key: "exporting", versionId: state.versionId };
      }
      return invalidTransition(state, event);
    case "exporting":
      if (event.type === "export_finished") {
        return { key: "exported", versionId: state.versionId };
      }
      return invalidTransition(state, event);
    case "exported":
    case "failed":
      return invalidTransition(state, event);
  }
}

export function isPreviewReady(state: DeliveryState): boolean {
  return state.key === "awaiting_finalize";
}

export function canFinalize(state: DeliveryState): boolean {
  return state.key === "awaiting_finalize";
}