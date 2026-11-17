import { TabSchema, createId, type Tab, type TabLayout } from "@opensteer/core";
import type { TabStream } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { TabStore } from "./tab-store.js";

const computer = { computerId: createId("runner"), name: "Studio Mac" };
const at = "2026-11-15T12:00:00.000Z";
function tab(tabId: string, title = tabId, extra: Partial<Tab> = {}): Tab {
  return TabSchema.parse({
    tabId,
    kind: "page",
    title,
    computer,
    groupId: null,
    state: "open",
    openedBy: "person",
    usedBy: [],
    createdAt: at,
    updatedAt: at,
    url: `https://${tabId}.example/`,
    profile: null,
    ...extra,
  });
}
const layout = (revision: number, ...ids: string[]): TabLayout => ({
  revision,
  items: ids.map((tabId) => ({ kind: "tab", tabId: tabId as Tab["tabId"] })),
});
const begin = (generation = "g1", prefix?: number): TabStream =>
  prefix === undefined ? { op: "begin", generation } : { op: "begin", generation, prefix };

describe("TabStore", () => {
  it("completes the bootstrap prefix from the stream and then patches one row in place", () => {
    const store = new TabStore();
    const a = tab("a");
    store.seed({ tabs: [a], layout: layout(1, "a", "b"), complete: false });
    expect(store.syncing).toBe(true);
    expect(store.strip.ordered).toEqual(["a"]);
    expect(store.apply(begin("g1", 1))).toBe("staged");
    expect(store.apply({ op: "rows", rows: [tab("b")] })).toBe("staged");
    expect(
      store.apply({ op: "end", revision: 0, count: 2, meta: { layout: layout(1, "a", "b") } }),
    ).toBe("applied");
    expect(store.complete).toBe(true);
    expect(store.syncing).toBe(false);
    expect(store.strip.ordered).toEqual(["a", "b"]);

    const strip = store.strip;
    const b = store.get(b_id())!;
    const onA = vi.fn();
    const onB = vi.fn();
    const onStructure = vi.fn();
    store.subscribeTab(a.tabId, onA);
    store.subscribeTab(b.tabId, onB);
    store.subscribeStructure(onStructure);
    store.apply({
      op: "change",
      generation: "g1",
      base: 0,
      revision: 1,
      update: [{ tabId: a.tabId, title: "Renamed" }],
    });
    expect(store.get(a.tabId)?.title).toBe("Renamed");
    expect(store.get(b.tabId)).toBe(b);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
    expect(onStructure).not.toHaveBeenCalled();
    expect(store.strip).toBe(strip);
  });

  it("never lets a late command answer put back a tab the stream closed", () => {
    const store = new TabStore();
    store.seed({ tabs: [tab("a"), tab("b")], layout: layout(4, "a", "b"), complete: true });
    store.apply(begin());
    store.apply({ op: "rows", rows: [tab("a"), tab("b")] });
    store.apply({ op: "end", revision: 0, count: 2, meta: { layout: layout(4, "a", "b") } });
    store.apply({
      op: "change",
      generation: "g1",
      base: 0,
      revision: 1,
      remove: ["b"],
      meta: { layout: layout(5, "a") },
    });
    // tab.open for b committed at revision 4 and answered after the close streamed.
    store.applyCommand({ layout: layout(4, "a", "b"), tabs: [tab("b")] });
    expect(store.get(b_id())).toBeUndefined();
    expect(store.strip.ordered).toEqual(["a"]);
    // Nor can an older command's answer undo a newer command's close that answered first.
    store.applyCommand({ layout: layout(6, "a", "c"), tabs: [tab("c")] });
    store.applyCommand({ layout: layout(8, "a") });
    store.applyCommand({ layout: layout(7, "c", "a"), tabs: [tab("c", "Moved")] });
    expect(store.get(tab("c").tabId)).toBeUndefined();
    expect(store.strip.ordered).toEqual(["a"]);
    expect(store.layout.revision).toBe(8);
  });

  it("shows a command answer ahead of the stream until the stream reaches it", () => {
    const store = new TabStore();
    store.seed({ tabs: [tab("a")], layout: layout(1, "a"), complete: true });
    store.apply(begin());
    store.apply({ op: "rows", rows: [tab("a")] });
    store.apply({ op: "end", revision: 0, count: 1, meta: { layout: layout(1, "a") } });
    store.applyCommand({ layout: layout(2, "a", "c"), tabs: [tab("c", "Opened")] });
    expect(store.strip.ordered).toEqual(["a", "c"]);
    store.applyCommand({ layout: layout(3, "c") });
    expect(store.strip.ordered).toEqual(["c"]);
    expect(store.get(tab("a").tabId)).toBeUndefined();
    store.apply({
      op: "change",
      generation: "g1",
      base: 0,
      revision: 1,
      add: [tab("c", "Streamed")],
      meta: { layout: layout(2, "a", "c") },
    });
    // The stream is still behind the close answer at 3.
    expect(store.strip.ordered).toEqual(["c"]);
    expect(store.get(tab("c").tabId)?.title).toBe("Streamed");
    store.apply({
      op: "change",
      generation: "g1",
      base: 1,
      revision: 2,
      remove: ["a"],
      meta: { layout: layout(3, "c") },
    });
    expect(store.strip.ordered).toEqual(["c"]);
    expect(store.layout.revision).toBe(3);
  });

  it("asks for a fresh stream on a gap and keeps rows until the reset lands", () => {
    const store = new TabStore();
    store.seed({ tabs: [tab("a")], layout: layout(1, "a"), complete: true });
    store.apply(begin());
    store.apply({ op: "rows", rows: [tab("a")] });
    store.apply({ op: "end", revision: 0, count: 1, meta: { layout: layout(1, "a") } });
    expect(
      store.apply({ op: "change", generation: "g1", base: 3, revision: 4, remove: ["a"] }),
    ).toBe("resync");
    expect(store.syncing).toBe(true);
    expect(store.strip.ordered).toEqual(["a"]);
    store.apply(begin("g2"));
    store.apply({ op: "rows", rows: [tab("b")] });
    store.apply({ op: "end", revision: 0, count: 1, meta: { layout: layout(2, "b") } });
    expect(store.syncing).toBe(false);
    expect(store.strip.ordered).toEqual(["b"]);
  });

  it("restarts cleanly after a disconnect", () => {
    const store = new TabStore();
    store.seed({ tabs: [tab("a")], layout: layout(1, "a"), complete: true });
    store.apply(begin());
    store.apply({ op: "rows", rows: [tab("a")] });
    store.apply({ op: "end", revision: 0, count: 1, meta: { layout: layout(1, "a") } });
    store.disconnected();
    expect(store.syncing).toBe(true);
    // A frame of the dead stream never applies.
    expect(
      store.apply({ op: "change", generation: "g1", base: 0, revision: 1, remove: ["a"] }),
    ).toBe("staged");
    expect(store.get(tab("a").tabId)).toBeDefined();
    store.apply(begin("g2"));
    store.apply({ op: "rows", rows: [tab("a"), tab("b")] });
    store.apply({ op: "end", revision: 0, count: 2, meta: { layout: layout(2, "a", "b") } });
    expect(store.strip.ordered).toEqual(["a", "b"]);
  });
});

function b_id() {
  return tab("b").tabId;
}
