export type GuidebookPageIdentity = {
  runId: string;
  index: number;
  checksum: string;
};

export type GuidebookPageAcceptanceState = {
  runId: string;
  nextIndex: number;
  seen: Set<string>;
};

export function createGuidebookPageAcceptanceState(runId: string): GuidebookPageAcceptanceState {
  return { runId, nextIndex: 0, seen: new Set() };
}

/** 服务端与客户端共用同一套 run、连续 index 和 checksum 判重规则。 */
export function acceptGuidebookPage(
  state: GuidebookPageAcceptanceState,
  page: GuidebookPageIdentity,
): boolean {
  if (page.runId !== state.runId) return false;
  if (!Number.isInteger(page.index) || page.index !== state.nextIndex) return false;
  if (!page.checksum || state.seen.has(page.checksum)) return false;
  state.seen.add(page.checksum);
  state.nextIndex += 1;
  return true;
}