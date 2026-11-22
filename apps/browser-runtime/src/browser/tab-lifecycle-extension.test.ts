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

type Listener<T extends unknown[]> = (...args: T) => void;

/** One start of the helper's service worker against a fake `chrome`, as Chromium starts it. */
function startWorker(tabs: FakeTab[], options: { hideGroups?: boolean } = {}) {
  const groups = new Map<number, { id: number; title: string }>();
  const session = new Map<string, unknown>();
  let nextGroup = 1;
  const created: Listener<[FakeTab]>[] = [];
  const updated: Listener<[number, { groupId?: number }]>[] = [];
  const removed: Listener<[number]>[] = [];
  const replaced: Listener<[number, number]>[] = [];
  const joinGroup = (tabId: number, groupId: number) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    tab.groupId = groupId;
    for (const listener of updated) listener(tabId, { groupId });
  };
  const globals: Record<string, unknown> = {
    chrome: {
      storage: {
        session: {
          get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items))
              session.set(key, structuredClone(value));
          },
        },
      },
      tabs: {
        onCreated: { addListener: (listener: never) => created.push(listener) },
        onUpdated: { addListener: (listener: never) => updated.push(listener) },
        onRemoved: { addListener: (listener: never) => removed.push(listener) },
        onReplaced: { addListener: (listener: never) => replaced.push(listener) },
        query: async (filter: { groupId?: number }) =>
          tabs
            .filter((tab) => filter.groupId === undefined || tab.groupId === filter.groupId)
            .map((tab) => ({ ...tab })),
        get: async (tabId: number) => ({ ...tabs.find((tab) => tab.id === tabId)! }),
        update: async (tabId: number) => ({ ...tabs.find((tab) => tab.id === tabId)! }),
        group: async ({ tabIds }: { tabIds: number[] }) => {
          const id = nextGroup++;
          groups.set(id, { id, title: "" });
          for (const tabId of tabIds) joinGroup(tabId, id);
          return id;
        },
        ungroup: async (tabId: number) => joinGroup(tabId, -1),
      },
      tabGroups: {
        // A group still being written can be missing from one read (K1).
        query: async () =>
          options.hideGroups ? [] : [...groups.values()].map((group) => ({ ...group })),
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
    inventory(): Promise<{
      consistent: boolean;
      rows: Array<{ tabId: number; identity: string | null }>;
    }>;
    nameTab(tabId: number, name: string): Promise<boolean>;
  };
  // Chromium changes its tabs first and tells the worker after: `deliver: false` holds the event.
  const open = (tab: FakeTab, options: { deliver?: boolean } = {}) => {
    tabs.push(tab);
    const deliver = () => {
      for (const listener of created) listener({ ...tab });
    };
    if (options.deliver !== false) deliver();
    return deliver;
  };
  const close = (tabId: number, options: { deliver?: boolean } = {}) => {
    tabs.splice(
      tabs.findIndex((tab) => tab.id === tabId),
      1,
    );
    const deliver = () => {
      for (const listener of removed) listener(tabId);
    };
    if (options.deliver !== false) deliver();
    return deliver;
  };
  const replace = (from: number, to: number) => {
    tabs.find((tab) => tab.id === from)!.id = to;
    for (const listener of replaced) listener(to, from);
  };
  return { api, joinGroup, open, close, replace, options };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const tab = (id: number, groupId = -1): FakeTab => ({
  id,
  windowId: 1,
  index: id,
  url: `https://site.test/${id}`,
  active: false,
  discarded: false,
  status: "complete",
  groupId,
});

const names = async (api: ReturnType<typeof startWorker>["api"]) => {
  const read = await api.inventory();
  // Before K1 the worker answered a bare list; the rows are what each test reads.
  const rows = Array.isArray(read) ? (read as typeof read.rows) : read.rows;
  return Object.fromEntries(rows.map((row) => [row.tabId, row.identity]));
};

describe("tab lifecycle helper", () => {
  it("names a tab by its own group's title and takes any other member out of that group, whatever the count (K5)", async () => {
    const tabs = [tab(10), tab(11)];
    const { api, joinGroup } = startWorker(tabs);
    expect(await names(api)).toEqual({ 10: null, 11: null });

    expect(await api.nameTab(10, "srf_a")).toBe(true);
    // Naming again with the same name is a no-op.
    expect(await api.nameTab(10, "srf_a")).toBe(true);
    expect(await names(api)).toEqual({ 10: "srf_a", 11: null });

    // A tab Chromium adds to that group (a link opened from it) is taken out again.
    joinGroup(11, tabs[0]!.groupId);
    await settle();
    expect(await names(api)).toEqual({ 10: "srf_a", 11: null });
  });

  it("leaves the name with the tab it was made for when the popup's event comes after the opener's (K5, test 1)", async () => {
    const tabs = [tab(20)];
    const { api, open, joinGroup } = startWorker(tabs);
    await api.nameTab(20, "srf_opener");
    const group = tabs[0]!.groupId;
    // The popup arrives in the opener's group; then a late group event for the opener itself runs.
    open(tab(21, group));
    joinGroup(20, group);
    await settle();
    expect(await names(api)).toEqual({ 20: "srf_opener", 21: null });
  });

  it("takes every member out when the named tab closes at once after opening a popup, and follows a replaced id (K5, test 1)", async () => {
    const tabs = [tab(30)];
    const { api, open, close, replace } = startWorker(tabs);
    await api.nameTab(30, "srf_gone");
    const group = tabs[0]!.groupId;
    // The named tab's id changes (a discard); the record follows it.
    replace(30, 31);
    await settle();
    // The popup joins the group and the opener is gone before the worker hears of either: the
    // popup is then the group's only member, and still not the tab the name was made for.
    const created = open(tab(32, group), { deliver: false });
    const removed = close(31, { deliver: false });
    created();
    await settle();
    removed();
    await settle();
    expect(await names(api)).toEqual({ 32: null });
  });

  it("answers a read whose groups are not all among the groups read as not agreeing with itself (K1, test 4)", async () => {
    const tabs = [tab(40)];
    const worker = startWorker(tabs);
    await worker.api.nameTab(40, "srf_x");
    expect((await worker.api.inventory()).consistent).toBe(true);
    worker.options.hideGroups = true;
    expect(await worker.api.inventory()).toMatchObject({
      consistent: false,
      rows: [{ tabId: 40, identity: null }],
    });
  });
});
