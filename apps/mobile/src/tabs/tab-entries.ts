import { tabGroupOf } from "@opensteer/client/host";
import type { Tab, TabGroup, TabId, TabKind, TabLayout } from "@opensteer/core";
import type { TabOrganizeInput } from "@opensteer/protocol";
import type { SFSymbolName } from "../ui/symbol.js";
import { tabSiteLabel } from "../browser/site-label.js";

/** Moves one tab to just before another, into that tab's group or out of every group. */
export function moveBefore(layout: TabLayout, tabId: TabId, anchorId: TabId): TabOrganizeInput {
  const group = tabGroupOf(layout, anchorId);
  return {
    beforeTabId: anchorId,
    group: group === null ? null : { groupId: group.groupId },
    tabIds: [tabId],
  };
}

/** The whole group as one block before an outside entry, its members in their order. */
export function moveGroupBefore(group: TabGroup, anchorId: TabId): TabOrganizeInput | null {
  if (group.tabIds.length === 0 || group.tabIds.includes(anchorId)) return null;
  return {
    beforeTabId: anchorId,
    group: { groupId: group.groupId },
    tabIds: [...group.tabIds],
  };
}

export const tabKindGlyph: Record<TabKind, SFSymbolName> = {
  app: "square.grid.2x2",
  page: "globe",
  phone: "smartphone",
  window: "rectangle.on.rectangle",
};

export const tabKindNoun: Record<TabKind, string> = {
  app: "App",
  page: "Tab",
  phone: "Agent Phone",
  window: "Window",
};

/** What a tab is, under its title: its site, its Mac app, a phone or an app. */
export function tabWhat(tab: Tab): string {
  if (tab.kind === "page") return tabSiteLabel(tab.url ?? null) ?? "Page";
  if (tab.kind === "window") return tab.appName ?? "Window";
  return tabKindNoun[tab.kind];
}

/**
 * The line under a tab's title: what it is, the profile it browses as when
 * the list mixes profiles, the computer when the list spans several, and why
 * it cannot open when it cannot.
 */
export function tabDetail(
  tab: Tab,
  options: { readonly showProfile: boolean; readonly showComputer: boolean },
): readonly string[] {
  return [
    tabWhat(tab),
    options.showProfile && tab.kind === "page" ? (tab.profile?.name ?? "Guest") : null,
    options.showComputer ? tab.computer.name : null,
    tab.state === "unavailable" ? (tab.unavailableReason ?? "Unavailable") : null,
  ].filter((part): part is string => part !== null && part !== "");
}

/** Whether rows should say which profile and which computer they belong to. */
export function tabListSpans(tabs: Iterable<Tab>): {
  readonly showComputer: boolean;
  readonly showProfile: boolean;
} {
  const computers = new Set<string>();
  const profiles = new Set<string>();
  for (const tab of tabs) {
    computers.add(tab.computer.computerId);
    if (tab.kind === "page") profiles.add(tab.profile?.profileId ?? "guest");
  }
  return { showComputer: computers.size > 1, showProfile: profiles.size > 1 };
}

export function tabTitle(tab: Tab): string {
  return tab.title.trim() || tabWhat(tab);
}
