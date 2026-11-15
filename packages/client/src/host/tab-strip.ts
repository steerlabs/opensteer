import type { TabGroup, TabId, TabLayout } from "@opensteer/core";

export type TabStripEntry =
  | { readonly kind: "tab"; readonly tabId: TabId }
  | { readonly kind: "group"; readonly group: TabGroup; readonly tabIds: readonly TabId[] };

/**
 * The one order every surface draws and every shortcut walks: the Host's
 * layout, skipping tabs this device has not received yet. No kind is sorted
 * apart from another.
 */
export interface TabStrip {
  readonly entries: readonly TabStripEntry[];
  /** Every known tab in layout order, collapsed groups included. */
  readonly ordered: readonly TabId[];
  /** What a person sees: collapsed groups' tabs left out. */
  readonly visible: readonly TabId[];
}

function sameIds(a: readonly TabId[], b: readonly TabId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function tabStrip(
  layout: TabLayout,
  known: { has(tabId: TabId): boolean },
  previous?: TabStrip,
): TabStrip {
  const reuse = new Map(
    previous?.entries.map((entry) => [
      entry.kind === "tab" ? entry.tabId : entry.group.groupId,
      entry,
    ]),
  );
  const entries: TabStripEntry[] = [];
  for (const item of layout.items) {
    if (item.kind === "tab") {
      if (!known.has(item.tabId)) continue;
      const old = reuse.get(item.tabId);
      entries.push(old?.kind === "tab" ? old : { kind: "tab", tabId: item.tabId });
      continue;
    }
    const tabIds = item.group.tabIds.filter((id) => known.has(id));
    const old = reuse.get(item.group.groupId);
    entries.push(
      old?.kind === "group" && old.group === item.group && sameIds(old.tabIds, tabIds)
        ? old
        : { kind: "group", group: item.group, tabIds },
    );
  }
  const ordered = entries.flatMap((entry) => (entry.kind === "tab" ? [entry.tabId] : entry.tabIds));
  const visible = entries.flatMap((entry) =>
    entry.kind === "tab" ? [entry.tabId] : entry.group.collapsed ? [] : entry.tabIds,
  );
  return previous &&
    previous.entries.length === entries.length &&
    previous.entries.every((entry, index) => entry === entries[index])
    ? previous
    : { entries, ordered, visible };
}

/** The tab ⌘1–⌘8 name by position, and ⌘9 the last, among visible tabs. */
export function tabAtShortcut(strip: TabStrip, digit: number): TabId | null {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9) return null;
  const tabs = strip.visible;
  return (digit === 9 ? tabs.at(-1) : tabs[digit - 1]) ?? null;
}

/** ⌃Tab and ⌃⇧Tab: the visible tab after or before this one, wrapping. */
export function tabBeside(strip: TabStrip, tabId: string | null, step: 1 | -1): TabId | null {
  const tabs = strip.visible;
  if (!tabs.length) return null;
  const index = tabId === null ? -1 : tabs.indexOf(tabId as TabId);
  if (index < 0) return step === 1 ? tabs[0]! : tabs.at(-1)!;
  return tabs[(index + step + tabs.length) % tabs.length]!;
}

/**
 * What to select once `closing` leaves the list: the next visible tab, else
 * the one before it. A tab hidden in a collapsed group picks its nearest
 * visible neighbour in layout order. Null means fall back to the task or home.
 */
export function tabAfterClose(
  strip: TabStrip,
  closing: string,
  alsoClosing: ReadonlySet<string> = new Set(),
): TabId | null {
  const gone = (id: TabId) => id === closing || alsoClosing.has(id);
  const visible = new Set(strip.visible);
  const index = strip.ordered.indexOf(closing as TabId);
  if (index < 0) return null;
  for (let i = index + 1; i < strip.ordered.length; i++) {
    const id = strip.ordered[i]!;
    if (visible.has(id) && !gone(id)) return id;
  }
  for (let i = index - 1; i >= 0; i--) {
    const id = strip.ordered[i]!;
    if (visible.has(id) && !gone(id)) return id;
  }
  return null;
}

/**
 * The tab that takes over when `tabId` leaves the list, whoever closed it:
 * its neighbour in `before`, skipping every tab `after` no longer lists, as
 * when a group closes at once.
 */
export function tabSuccessor(before: TabStrip, after: TabStrip, tabId: string): TabId | null {
  const listed = new Set(after.ordered);
  return tabAfterClose(before, tabId, new Set(before.ordered.filter((id) => !listed.has(id))));
}

/** The group holding this tab in the layout, or null. */
export function tabGroupOf(layout: TabLayout, tabId: string): TabGroup | null {
  for (const item of layout.items)
    if (item.kind === "group" && item.group.tabIds.includes(tabId as TabId)) return item.group;
  return null;
}
