import {
  BrowserSurfaceIdSchema,
  resolveBrowserTabOrder,
  type BrowserTabArrangement,
  type BrowserTabOrderTab,
} from "@opensteer/core";
import type { BrowserTabLayout } from "@opensteer/protocol";
import type { BrowserTabStore } from "./browser-tab-store.js";

export function browserTabOrderTabs(
  store: BrowserTabStore | undefined,
): readonly BrowserTabOrderTab[] {
  return store?.structure().map((tab) => ({ ...tab, id: tab.tabId })) ?? [];
}

export function browserTabArrangement(
  layout: BrowserTabLayout,
  tabs: readonly BrowserTabOrderTab[],
): BrowserTabArrangement {
  const groupOf = new Map(
    layout.groups.flatMap((group) => group.tabIds.map((id) => [id, group.id] as const)),
  );
  return { order: resolveBrowserTabOrder(layout.order, tabs, groupOf), groupOf };
}

/** Keep untouched group objects so a different row's move does not redraw them. */
export function arrangedBrowserTabLayout(
  layout: BrowserTabLayout,
  arrangement: BrowserTabArrangement,
): BrowserTabLayout {
  const order = arrangement.order.map((id) => BrowserSurfaceIdSchema.parse(id));
  const placed = new Set(arrangement.order);
  const members = new Map<string, typeof order>();
  for (const id of [...order, ...[...arrangement.groupOf.keys()].filter((id) => !placed.has(id))]) {
    const groupId = arrangement.groupOf.get(id);
    if (groupId === undefined) continue;
    const tabIds = members.get(groupId) ?? [];
    tabIds.push(BrowserSurfaceIdSchema.parse(id));
    members.set(groupId, tabIds);
  }
  return {
    ...layout,
    order,
    groups: layout.groups.flatMap((group) => {
      const tabIds = members.get(group.id);
      if (!tabIds?.length) return [];
      return [
        tabIds.length === group.tabIds.length && tabIds.every((id, i) => id === group.tabIds[i])
          ? group
          : { ...group, tabIds },
      ];
    }),
  };
}
