import { describe, expect, it, vi } from "vitest";
import { BrowserTabStore } from "./browser-tab-store.js";
import type { BrowserGroupRow, BrowserTabRow } from "@opensteer/protocol/browser-tabs";
const group = { id: "g", createdAt: "2026-01-01", sessionId: "s" } as BrowserGroupRow;
const tab = (id: string): BrowserTabRow => ({ id, order: Number(id), title: id }) as BrowserTabRow;
const commit = (store: BrowserTabStore) => {
  store.applyGroups({ op: "begin", generation: "g" });
  store.applyGroups({ op: "rows", rows: [group] });
  store.applyGroups({ op: "end", revision: 0, count: 1, meta: {} });
  store.applyTabs("g", { op: "begin", generation: "t" });
  store.applyTabs("g", { op: "rows", rows: [tab("1"), tab("2")] });
  store.applyTabs("g", { op: "end", revision: 0, count: 2, meta: {} });
};
describe("BrowserTabStore", () => {
  it("shows a seed while syncing, replacing it only at end", () => {
    const store = new BrowserTabStore();
    store.seed({
      groups: { rows: [group], complete: false },
      tabs: [{ groupId: "g", rows: [tab("3")], complete: false }],
    });
    expect(store.tabs("g")).toEqual({ ids: ["3"], syncing: true });
    store.applyTabs("g", { op: "begin", generation: "t" });
    store.applyTabs("g", { op: "rows", rows: [tab("1")] });
    expect(store.tabs("g").ids).toEqual(["3"]);
    store.applyTabs("g", { op: "end", revision: 0, count: 1, meta: {} });
    expect(store.tabs("g")).toEqual({ ids: ["1"], syncing: false });
  });
  it("notifies just the changed row and preserves order and siblings across resync", () => {
    const store = new BrowserTabStore();
    commit(store);
    const ids = store.tabs("g").ids;
    const sibling = store.tab("g", "2");
    const row = vi.fn(),
      other = vi.fn(),
      order = vi.fn();
    store.subscribeTab("g", "1", row);
    store.subscribeTab("g", "2", other);
    store.subscribeTabs("g", order);
    store.applyTabs("g", {
      op: "change",
      generation: "t",
      base: 0,
      revision: 1,
      update: [{ id: "1", title: "New" }],
    });
    expect(row).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(order).not.toHaveBeenCalled();
    expect(store.tabs("g").ids).toBe(ids);
    expect(store.tab("g", "2")).toBe(sibling);
    store.disconnected();
    expect(store.tabs("g").syncing).toBe(true);
    expect(store.tab("g", "2")).toBe(sibling);
    commit(store);
    expect(store.tab("g", "2")).toBe(sibling);
  });
  it("keeps committed rows through gaps and discards staged rows when a group is removed", () => {
    const resync = vi.fn();
    const store = new BrowserTabStore(resync);
    commit(store);
    store.applyTabs("g", { op: "change", generation: "t", base: 99, revision: 100, remove: ["1"] });
    expect(resync).toHaveBeenCalledWith("g");
    expect(store.tab("g", "1")).toBeDefined();
    store.seed({ groups: { rows: [], complete: false }, tabs: [] });
    expect(store.group("g")).toBeDefined();
    expect(store.tab("g", "1")).toBeDefined();
    store.applyTabs("g", { op: "begin", generation: "new" });
    store.applyTabs("g", { op: "rows", rows: [tab("4")] });
    store.applyGroups({ op: "change", generation: "g", base: 0, revision: 1, remove: ["g"] });
    store.applyTabs("g", { op: "end", revision: 0, count: 1, meta: {} });
    expect(store.tab("g", "4")).toBeUndefined();
    expect(store.group("g")).toBeUndefined();
  });
  it("keeps subscriptions attached when a removed group becomes visible again", () => {
    const store = new BrowserTabStore();
    commit(store);
    const changed = vi.fn();
    store.subscribeTab("g", "1", changed);
    store.applyGroups({ op: "change", generation: "g", base: 0, revision: 1, remove: ["g"] });
    expect(store.tab("g", "1")).toBeUndefined();
    store.applyGroups({ op: "change", generation: "g", base: 1, revision: 2, add: [group] });
    store.applyTabs("g", { op: "begin", generation: "fresh" });
    store.applyTabs("g", { op: "rows", rows: [tab("1")] });
    store.applyTabs("g", { op: "end", revision: 0, count: 1, meta: {} });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(store.tab("g", "1")).toEqual(tab("1"));
  });
});
