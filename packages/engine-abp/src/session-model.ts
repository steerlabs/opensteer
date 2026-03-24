import type { PageRef } from "@opensteer/browser-core";

import type { AbpCdpTargetInfo } from "./types.js";

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

export function resolveTabOpeners(
  targets: readonly AbpCdpTargetInfo[],
  pageRefByTabId: ReadonlyMap<string, PageRef>,
): ReadonlyMap<string, PageRef> {
  const openerByTabId = new Map<string, PageRef>();

  for (const target of targets) {
    if (target.openerId === undefined) {
      continue;
    }

    const openerPageRef = pageRefByTabId.get(target.openerId);
    if (openerPageRef !== undefined) {
      openerByTabId.set(target.targetId, openerPageRef);
    }
  }

  return openerByTabId;
}
