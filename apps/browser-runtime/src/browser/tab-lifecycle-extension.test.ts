import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ChromiumTabLifecycleBridge, extensionServiceWorkerJs } from "./tab-lifecycle-extension.js";

interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
  active: boolean;
  discarded: boolean;
  status: string;
  groupId: number;
  autoDiscardable?: boolean;
}

type Listener<T extends unknown[]> = (...args: T) => void;

/** One start of the helper's service worker against a fake `chrome`, as Chromium starts it. */
function startWorker(tabs: FakeTab[], options: { hideGroups?: boolean } = {}) {
  const groups = new Map<number, { id: number; title: string }>();
  const calls: string[] = [];
  let nextGroup = 1;
  const created: Listener<[FakeTab]>[] = [];
  const replaced: Listener<[number, number]>[] = [];
  const globals: Record<string, unknown> = {
    chrome: {
      tabs: {
        onCreated: { addListener: (listener: never) => created.push(listener) },
        onReplaced: { addListener: (listener: never) => replaced.push(listener) },
        query: async (filter: { groupId?: number } = {}) =>
          tabs
            .filter((tab) => filter.groupId === undefined || tab.groupId === filter.groupId)
            .map((tab) => ({ ...tab })),
        get: async (tabId: number) => ({ ...tabs.find((tab) => tab.id === tabId)! }),
        // A discard gives the tab a new id, as Chromium does.
        discard: async (tabId: number) => {
          calls.push("discard");
          const tab = tabs.find((candidate) => candidate.id === tabId)!;
          Object.assign(tab, { id: tabId + 1, discarded: true, status: "unloaded" });
          return { ...tab };
        },
        update: async (tabId: number, change: { autoDiscardable?: boolean }) => {
          const tab = tabs.find((candidate) => candidate.id === tabId)!;
          Object.assign(tab, change);
          return { ...tab };
        },
        group: async ({ tabIds }: { tabIds: number[] }) => {
          calls.push("group");
          const id = nextGroup++;
          groups.set(id, { id, title: "" });
          for (const tabId of tabIds) tabs.find((tab) => tab.id === tabId)!.groupId = id;
          return id;
        },
        ungroup: async (tabIds: number | number[]) => {
          for (const tabId of [tabIds].flat()) tabs.find((tab) => tab.id === tabId)!.groupId = -1;
        },
        move: async (tabId: number, { index }: { index: number }) => {
          calls.push(`move tab ${tabId} ${index}`);
          const tab = tabs.find((candidate) => candidate.id === tabId)!;
          tab.index = index;
          return { ...tab };
        },
      },
      tabGroups: {
        // A group still being written can be missing from one read (K1).
        query: async () =>
          options.hideGroups ? [] : [...groups.values()].map((group) => ({ ...group })),
        update: async (id: number, change: { title: string }) => {
          groups.get(id)!.title = change.title;
        },
        move: async (id: number, { index }: { index: number }) => {
          calls.push(`move group ${id} ${index}`);
          for (const tab of tabs) if (tab.groupId === id) tab.index = index;
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
      rows: Array<{ tabId: number; identity: string | null; discarded: boolean }>;
    }>;
    nameTab(tabId: number, name: string): Promise<boolean>;
    nameAndDiscard(tabId: number, name: string): Promise<{ ok: boolean; newTabId: number | null }>;
    unnameTab(tabId: number): Promise<boolean>;
    moveTab(tabId: number, index: number): Promise<{ ok: boolean; tabId: number; index: number }>;
  };
  const open = (tab: FakeTab) => {
    tabs.push(tab);
    for (const listener of created) listener({ ...tab });
  };
  const replace = (from: number, to: number) => {
    tabs.find((tab) => tab.id === from)!.id = to;
    for (const listener of replaced) listener(to, from);
  };
  return { api, open, replace, options, calls };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

const tab = (id: number, patch: Partial<FakeTab> = {}): FakeTab => ({
  id,
  windowId: 1,
  index: id,
  url: `https://site.test/${id}`,
  active: false,
  discarded: false,
  status: "complete",
  groupId: -1,
  ...patch,
});

describe("tab lifecycle helper", () => {
  it("names a tab by its own group's title, gives it a group of its own each time, and takes the name away (L2)", async () => {
    const tabs = [tab(10, { discarded: true, status: "unloaded" }), tab(11)];
    const { api } = startWorker(tabs);
    expect(await api.nameTab(10, "opensteer-sleep:a")).toBe(true);
    expect(await api.nameTab(10, "opensteer-sleep:b")).toBe(true);
    const named = await api.inventory();
    expect(named.consistent).toBe(true);
    expect(named.rows.map((row) => [row.tabId, row.identity, row.discarded])).toEqual([
      [10, "opensteer-sleep:b", true],
      [11, null, false],
    ]);
    expect(await api.unnameTab(10)).toBe(true);
    expect((await api.inventory()).rows.map((row) => row.identity)).toEqual([null, null]);
  });

  it("names a tab first and discards it second, in one call, and the name stays with the tab Chromium returns (Q2)", async () => {
    const tabs = [tab(30)];
    const { api, calls } = startWorker(tabs);
    expect(await api.nameAndDiscard(30, "opensteer-sleep:c")).toEqual({ ok: true, newTabId: 31 });
    expect(calls.filter((call) => call === "group" || call === "discard")).toEqual([
      "group",
      "discard",
    ]);
    expect((await api.inventory()).rows).toMatchObject([
      { tabId: 31, discarded: true, identity: "opensteer-sleep:c" },
    ]);
  });

  it("moves a sleeping tab with its own group, taking out first a tab that only joined it, and moves an ungrouped tab alone (run 11, S2)", async () => {
    const tabs = [tab(50, { discarded: true, status: "unloaded" }), tab(51)];
    const { api, calls } = startWorker(tabs);
    await api.nameTab(50, "opensteer-sleep:s");
    // A tab opened beside it joined its group.
    tabs[1]!.groupId = tabs[0]!.groupId;
    expect(await api.moveTab(50, 0)).toEqual({ ok: true, tabId: 50, index: 0 });
    expect(calls.filter((call) => call.startsWith("move"))).toEqual(["move group 1 0"]);
    expect(
      (await api.inventory()).rows.map((row) => [row.tabId, row.identity, row.discarded]),
    ).toEqual([
      [50, "opensteer-sleep:s", true],
      [51, null, false],
    ]);
    expect(await api.moveTab(51, -1)).toMatchObject({ ok: true, tabId: 51 });
    expect(calls.at(-1)).toBe("move tab 51 -1");
  });

  it("marks every tab, at start, as it is created and as it is replaced, as not discardable by Chromium itself (L3)", async () => {
    const tabs = [tab(20)];
    const { open, replace } = startWorker(tabs);
    open(tab(21));
    replace(21, 22);
    await settle();
    expect(tabs.map((candidate) => [candidate.id, candidate.autoDiscardable])).toEqual([
      [20, false],
      [22, false],
    ]);
  });

  it("answers a read whose groups are not all among the groups read as not agreeing with itself (K1, test 4)", async () => {
    const tabs = [tab(40)];
    const worker = startWorker(tabs);
    await worker.api.nameTab(40, "opensteer-sleep:x");
    expect((await worker.api.inventory()).consistent).toBe(true);
    worker.options.hideGroups = true;
    expect(await worker.api.inventory()).toMatchObject({
      consistent: false,
      rows: [{ tabId: 40, identity: null }],
    });
  });
});

describe("the look for the helper's manifest (TS7, TS14)", () => {
  /** A private page whose manifest asks answer as `answer` says; about:blank always loads. */
  function bridge(answer: (url: string, ask: number) => Promise<unknown>) {
    const asked: string[] = [];
    const page = {
      isClosed: () => false,
      goto: (url: string) => {
        asked.push(url);
        return url === "about:blank" ? Promise.resolve(null) : answer(url, asked.length);
      },
    };
    return {
      asked,
      bridge: new ChromiumTabLifecycleBridge({} as never, {} as never, page as never),
    };
  }
  const refusal = (url: string) =>
    Promise.reject(new Error(`page.goto: net::ERR_BLOCKED_BY_CLIENT at ${url}`));

  it("calls only a browser that refused every ask of every id refused", async () => {
    const { bridge: refused, asked } = bridge(refusal);
    expect(await refused.served(["aaaa", "bbbb"])).toBe("refused");
    expect(asked.filter((url) => url.startsWith("chrome-extension://"))).toHaveLength(6);
    expect(asked.at(-1)).toBe("about:blank");
    expect(await bridge(async () => ({ ok: () => true })).bridge.served(["aaaa"])).toBe("served");
  });

  it("calls a timeout, another error or an answer that is not the manifest not known yet", async () => {
    const hanging = bridge(() => new Promise(() => {}));
    const started = performance.now();
    expect(await hanging.bridge.served(["aaaa"], performance.now() + 300)).toBe("unknown");
    // Within the look's bound, not the three asks' own time.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(hanging.asked.at(-1)).toBe("about:blank");
    expect(
      await bridge(() => Promise.reject(new Error("page.goto: net::ERR_ABORTED"))).bridge.served([
        "aaaa",
      ]),
    ).toBe("unknown");
    expect(await bridge(async () => ({ ok: () => false })).bridge.served(["aaaa"])).toBe("unknown");
    // Refused twice, then not answered in time: still not known.
    const mixed = bridge((url, ask) =>
      ask <= 2 ? refusal(url) : Promise.reject(new Error("Helper manifest check timed out.")),
    );
    expect(await mixed.bridge.served(["aaaa"])).toBe("unknown");
  });

  it("is work a stop waits for, and asks nothing after the stop", async () => {
    let release!: () => void;
    const held = bridge((url) => new Promise((resolve) => (release = () => resolve(refusal(url)))));
    const look = held.bridge.served(["aaaa"]);
    await vi.waitFor(() => expect(release).toBeDefined());
    let stopped = false;
    const stop = held.bridge.stop().then(() => (stopped = true));
    // The stop is still waiting on the ask in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    expect(await look).toBe("unknown");
    await stop;
    // One ask, then the page back where it started; nothing after the stop.
    expect(held.asked).toEqual(["chrome-extension://aaaa/manifest.json", "about:blank"]);
  });
});

describe("waking the helper's worker (TS14)", () => {
  function waking(options: { attachMs: number }) {
    const calls: string[] = [];
    const page = {
      isClosed: () => false,
      goto: async (url: string) => {
        calls.push(`goto ${url}`);
        return null;
      },
    };
    const session = {
      send: async (method: string) => {
        calls.push(method);
        return {};
      },
      detach: async () => {
        calls.push("detach");
      },
    };
    const context = {
      serviceWorkers: () => [{ url: () => "chrome-extension://helper/sw.js" }],
      newCDPSession: () =>
        new Promise((resolve) => setTimeout(() => resolve(session), options.attachMs)),
    };
    const bridge = new ChromiumTabLifecycleBridge(context as never, {} as never, page as never);
    const wake = (remainingMs: number) =>
      (
        bridge as unknown as { wakeServiceWorkerOnce(remainingMs: number): Promise<void> }
      ).wakeServiceWorkerOnce(remainingMs);
    return { bridge, calls, wake };
  }

  it("lets go of a debugger session that arrives after its wait", async () => {
    vi.useFakeTimers();
    try {
      const { calls, wake } = waking({ attachMs: 2_000 });
      const woke = wake(5_000);
      await vi.advanceTimersByTimeAsync(1_600);
      await woke;
      expect(calls).not.toContain("detach");
      await vi.advanceTimersByTimeAsync(500);
      // The late session is detached, and nothing was sent on it.
      expect(calls).toContain("detach");
      expect(calls).not.toContain("ServiceWorker.enable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nothing more once stopped between its steps", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, calls, wake } = waking({ attachMs: 100 });
      const woke = wake(5_000);
      void bridge.stop();
      await vi.advanceTimersByTimeAsync(200);
      await woke;
      expect(calls).not.toContain("ServiceWorker.enable");
      expect(calls).not.toContain("ServiceWorker.startWorker");
      // The private page is put back where it started.
      expect(calls.at(-1)).toBe("goto about:blank");
    } finally {
      vi.useRealTimers();
    }
  });
});
