import type { PageRef } from "@opensteer/browser-core";

export function shouldClaimBootstrapTab(
  bootstrapTabId: string | undefined,
  openerPageRef: PageRef | undefined,
): bootstrapTabId is string {
  return bootstrapTabId !== undefined && openerPageRef === undefined;
}

export function shouldParkPageAsBootstrap(input: {
  readonly launchOwned: boolean;
  readonly remainingLogicalPages: number;
}): boolean {
  return input.launchOwned && input.remainingLogicalPages === 0;
}

export function chooseNextActivePageRef(
  pageRefs: readonly PageRef[],
  preferredPageRef?: PageRef,
): PageRef | undefined {
  if (preferredPageRef !== undefined && pageRefs.includes(preferredPageRef)) {
    return preferredPageRef;
  }
  return pageRefs[0];
}
