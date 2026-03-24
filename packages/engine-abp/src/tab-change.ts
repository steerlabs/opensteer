import type { PageRef, StepEvent } from "@opensteer/browser-core";

import type { AbpActionResponse } from "./types.js";

export interface DiscoveredTabEffects {
  readonly events: readonly StepEvent[];
  readonly activePageRef?: PageRef;
}

export function resolveTabChangePageRef(input: {
  readonly controllerPageRef: PageRef;
  readonly response: Pick<AbpActionResponse, "tab_changed">;
  readonly actionEvents: readonly StepEvent[];
  readonly discoveredTabs: DiscoveredTabEffects;
  readonly activePageRef: PageRef | undefined;
}): PageRef {
  if (!input.response.tab_changed) {
    return input.controllerPageRef;
  }

  if (input.discoveredTabs.activePageRef !== undefined) {
    return input.discoveredTabs.activePageRef;
  }

  for (const event of [...input.actionEvents, ...input.discoveredTabs.events].reverse()) {
    if (event.kind === "popup-opened") {
      return event.pageRef;
    }
  }

  return input.activePageRef ?? input.controllerPageRef;
}

export function collectPopupPageRefs(events: readonly StepEvent[]): readonly PageRef[] {
  const seen = new Set<PageRef>();
  const pageRefs: PageRef[] = [];
  for (const event of events) {
    if (event.kind !== "popup-opened" || seen.has(event.pageRef)) {
      continue;
    }
    seen.add(event.pageRef);
    pageRefs.push(event.pageRef);
  }
  return pageRefs;
}
