import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { tabSuggestions } from "./tab-suggestions.js";

it("refreshes a suggestion's title and site by key without reading unchanged rows", () => {
  const client = new MockHostClient({ latencyMs: 0 });
  const store = client.browserTabs;
  const first = store.structure()[0]!;
  const row = store.tab(first.groupId, first.tabId)!;
  const rows = Array.from({ length: 10_000 }, (_, i) => ({
    ...row,
    id: BrowserSurfaceIdSchema.parse(`suggestion-${i}`),
    order: i,
    openerId: null,
  }));
  store.applyTabs(first.groupId, { op: "begin", generation: "suggestions" });
  store.applyTabs(first.groupId, { op: "rows", rows });
  store.applyTabs(first.groupId, { op: "end", revision: 0, count: rows.length, meta: {} });
  const selection = tabSuggestions(client, first.groupId);
  let current = selection.read();
  const release = selection.subscribe(() => {
    current = selection.read();
  });
  const read = vi.spyOn(store, "tab");
  try {
    const before = current;
    for (let i = 0; i < 20; i++) expect(selection.read()).toBe(before);
    expect(read).not.toHaveBeenCalled();
    store.applyTabs(first.groupId, {
      op: "change",
      generation: "suggestions",
      base: 0,
      revision: 1,
      update: [{ id: rows[0]!.id, title: "Fresh title", site: "https://fresh.example" }],
    });
    expect(current[0]).toMatchObject({ title: "Fresh title", site: "fresh.example" });
    expect(current[1]).toBe(before[1]);
    expect(read).toHaveBeenCalledTimes(1);
    store.applyTabs(first.groupId, {
      op: "change",
      generation: "suggestions",
      base: 1,
      revision: 2,
      remove: [rows[0]!.id],
    });
    expect(current).toHaveLength(9_999);
    expect(current.some((suggestion) => suggestion.id === rows[0]!.id)).toBe(false);
  } finally {
    read.mockRestore();
    release();
    client.dispose();
  }
});
