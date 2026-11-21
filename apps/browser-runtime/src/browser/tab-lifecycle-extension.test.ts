import { randomUUID } from "node:crypto";
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
}

/** One start of the helper's service worker against a fake `chrome`, as Chromium starts it. */
function startWorker(tabs: FakeTab[]) {
  const replaced: Array<(added: number, removed: number) => void> = [];
  const removed: Array<(tabId: number) => void> = [];
  const globals: Record<string, unknown> = {
    crypto: { randomUUID },
    chrome: {
      tabs: {
        onReplaced: { addListener: (listener: never) => replaced.push(listener) },
        onRemoved: { addListener: (listener: never) => removed.push(listener) },
        query: async () => tabs.map((tab) => ({ ...tab })),
      },
      debugger: { getTargets: async () => [] },
    },
  };
  globals.globalThis = globals;
  runInNewContext(extensionServiceWorkerJs, globals);
  const api = globals.__opensteer as {
    inventory(): Promise<
      Array<{ tabId: number; replacedFromTabIds: number[]; helperEpoch: string }>
    >;
  };
  return {
    inventory: () => api.inventory(),
    replace(added: number, removedId: number) {
      const tab = tabs.find((candidate) => candidate.id === removedId)!;
      tab.id = added;
      for (const listener of replaced) listener(added, removedId);
    },
    remove(tabId: number) {
      tabs.splice(
        tabs.findIndex((tab) => tab.id === tabId),
        1,
      );
      for (const listener of removed) listener(tabId);
    },
  };
}

describe("tab lifecycle helper", () => {
  it("names every tab a row was replaced from, nearest first, and a restarted worker by a new epoch (C4)", async () => {
    const tabs: FakeTab[] = [
      {
        id: 10,
        windowId: 1,
        index: 0,
        url: "https://twice.test/",
        active: false,
        discarded: false,
        status: "complete",
      },
    ];
    const worker = startWorker(tabs);
    const [first] = await worker.inventory();
    expect(first).toMatchObject({ tabId: 10, replacedFromTabIds: [] });

    // Parked by discard (10 -> 20), claimed and woken, then slept by discard (20 -> 30).
    worker.replace(20, 10);
    worker.replace(30, 20);
    const [twice] = await worker.inventory();
    expect(twice).toMatchObject({ tabId: 30, replacedFromTabIds: [20, 10] });
    expect(twice!.helperEpoch).toBe(first!.helperEpoch);

    // A worker started again has forgotten the chain, and says so by its epoch.
    const restarted = startWorker(tabs);
    const [afterRestart] = await restarted.inventory();
    expect(afterRestart).toMatchObject({ tabId: 30, replacedFromTabIds: [] });
    expect(afterRestart!.helperEpoch).not.toBe(first!.helperEpoch);

    // A removed tab's record goes with it.
    worker.remove(30);
    expect(await worker.inventory()).toEqual([]);
  });
});
