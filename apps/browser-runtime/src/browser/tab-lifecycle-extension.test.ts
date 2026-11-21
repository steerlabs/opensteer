import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { extensionServiceWorkerJs } from "./tab-lifecycle-extension.js";

interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
  active: boolean;
  discarded: boolean;
  status: string;
  groupId: number;
}

/** One start of the helper's service worker against a fake `chrome`, as Chromium starts it. */
function startWorker(tabs: FakeTab[]) {
  const groups = new Map<number, { id: number; title: string }>();
  let nextGroup = 1;
  const created: Array<(tab: FakeTab) => void> = [];
  const updated: Array<(tabId: number, change: { groupId?: number }) => void> = [];
  const joinGroup = (tabId: number, groupId: number) => {
    tabs.find((tab) => tab.id === tabId)!.groupId = groupId;
    for (const listener of updated) listener(tabId, { groupId });
  };
  const globals: Record<string, unknown> = {
    chrome: {
      tabs: {
        onCreated: { addListener: (listener: never) => created.push(listener) },
        onUpdated: { addListener: (listener: never) => updated.push(listener) },
        query: async (filter: { groupId?: number }) =>
          tabs
            .filter((tab) => filter.groupId === undefined || tab.groupId === filter.groupId)
            .map((tab) => ({ ...tab })),
        get: async (tabId: number) => ({ ...tabs.find((tab) => tab.id === tabId)! }),
        group: async ({ tabIds }: { tabIds: number[] }) => {
          const id = nextGroup++;
          groups.set(id, { id, title: "" });
          for (const tabId of tabIds) joinGroup(tabId, id);
          return id;
        },
        ungroup: async (tabId: number) => joinGroup(tabId, -1),
      },
      tabGroups: {
        query: async () => [...groups.values()].map((group) => ({ ...group })),
        get: async (id: number) => ({ ...groups.get(id)! }),
        update: async (id: number, change: { title: string }) => {
          groups.get(id)!.title = change.title;
        },
      },
      debugger: { getTargets: async () => [] },
    },
  };
  globals.globalThis = globals;
  runInNewContext(extensionServiceWorkerJs, globals);
  const api = globals.__opensteer as {
    inventory(): Promise<Array<{ tabId: number; identity: string | null }>>;
    nameTab(tabId: number, name: string): Promise<boolean>;
  };
  return { api, joinGroup, created };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("tab lifecycle helper", () => {
  it("names a tab by its own group's title and keeps that group to the one tab it was made for", async () => {
    const tab = (id: number): FakeTab => ({
      id,
      windowId: 1,
      index: id,
      url: `https://site.test/${id}`,
      active: false,
      discarded: false,
      status: "complete",
      groupId: -1,
    });
    const tabs = [tab(10), tab(11)];
    const { api, joinGroup } = startWorker(tabs);
    expect((await api.inventory()).map((row) => row.identity)).toEqual([null, null]);

    expect(await api.nameTab(10, "srf_a")).toBe(true);
    // Naming again with the same name is a no-op; a new name gives the tab a group of its own.
    expect(await api.nameTab(10, "srf_a")).toBe(true);
    expect((await api.inventory()).map((row) => row.identity)).toEqual(["srf_a", null]);

    // A tab Chromium adds to that group (a link opened from it) is taken out again.
    const group = tabs[0]!.groupId;
    joinGroup(11, group);
    await settle();
    await settle();
    expect((await api.inventory()).map((row) => row.identity)).toEqual(["srf_a", null]);
  });
});
