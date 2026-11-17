import { TabSchema, createId, type Tab, type TabLayout } from "@opensteer/core";
import { TabStore } from "../host/tab-store.js";

const at = "2026-11-15T12:00:00.000Z";
type TabInput = Partial<Tab> & Pick<Tab, "tabId">;

/** One valid tab row; a page unless `kind` says otherwise. */
export function tabFixture(input: TabInput): Tab {
  const kind = input.kind ?? "page";
  return TabSchema.parse({
    kind,
    title: input.tabId,
    computer: { computerId: createId("runner"), name: "Mac mini" },
    groupId: null,
    state: "open",
    openedBy: "person",
    usedBy: [],
    createdAt: at,
    updatedAt: at,
    ...(kind === "page" ? { url: `https://${input.tabId}.example/`, profile: null } : {}),
    ...(kind === "window" ? { appName: "Notes", bundleId: "com.apple.Notes" } : {}),
    ...(kind === "app" ? { appId: "app_00000000-0000-4000-8000-000000000001" } : {}),
    ...input,
  });
}

/** A complete catalog of these tabs, ungrouped in order unless a layout is given. */
export function tabStoreFixture(tabs: readonly Tab[], layout?: TabLayout): TabStore {
  const store = new TabStore();
  store.seed({
    tabs: [...tabs],
    layout: layout ?? {
      revision: 1,
      items: tabs.map((tab) => ({ kind: "tab", tabId: tab.tabId })),
    },
    complete: true,
  });
  return store;
}
