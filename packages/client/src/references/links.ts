import type { Reference, Tab, TabId } from "@opensteer/core";
import type { TabsReadModel } from "../host/tabs-contract.js";

/** A reference resolved by its ID through `references.resolve`: everything but a tab. */
export type IdReference = Exclude<Reference, { readonly kind: "tab" }>;
export type IdReferenceKind = IdReference["kind"];

export type TabReferenceState =
  | { readonly state: "unresolved" }
  | { readonly state: "available"; readonly tab: Tab }
  | { readonly state: "unavailable" };

/**
 * A tab link names an open tab in the person's list, or nothing: a closed or
 * foreign tab is unavailable, and following the link never reopens it. Until
 * the list is complete an absent tab is not known to be gone.
 */
export function tabReferenceState(tabs: TabsReadModel, tabId: string): TabReferenceState {
  const tab = tabs.get(tabId as TabId);
  if (!tab) return tabs.complete ? unavailable : unresolved;
  let state = available.get(tab);
  if (!state) available.set(tab, (state = { state: "available", tab }));
  return state;
}
const unresolved: TabReferenceState = { state: "unresolved" };
const unavailable: TabReferenceState = { state: "unavailable" };
// The same answer for the same row, so a subscribed view redraws only on change.
const available = new WeakMap<Tab, TabReferenceState>();
