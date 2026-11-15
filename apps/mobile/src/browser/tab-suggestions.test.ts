import { expect, it, vi } from "vitest";
import { TabStore } from "@opensteer/client/host";
import { tabFixture } from "@opensteer/client/test-support";
import { TabIdSchema } from "@opensteer/core";
import { tabSuggestions } from "./tab-suggestions.js";

it("offers the list's pages in order and refreshes one by key without rereading unchanged rows", () => {
  const pages = Array.from({ length: 1_000 }, (_, i) =>
    tabFixture({ tabId: TabIdSchema.parse(`tab_p${i}`), title: `Page ${i}` }),
  );
  const rows = [...pages, tabFixture({ tabId: TabIdSchema.parse("tab_pixel"), kind: "phone" })];
  const model = new TabStore();
  model.apply({ op: "begin", generation: "g1" });
  model.apply({ op: "rows", rows });
  model.apply({
    op: "end",
    revision: 0,
    count: rows.length,
    meta: {
      layout: { revision: 1, items: rows.map((tab) => ({ kind: "tab", tabId: tab.tabId })) },
    },
  });
  const selection = tabSuggestions(model);
  let current = selection.read();
  const release = selection.subscribe(() => {
    current = selection.read();
  });
  // Subscribing rereads once, for a change between the first read and the subscription.
  const before = selection.read();
  const get = vi.spyOn(model, "get");
  try {
    expect(before).toHaveLength(1_000);
    for (let i = 0; i < 20; i++) expect(selection.read()).toBe(before);
    expect(get).not.toHaveBeenCalled();

    model.apply({
      op: "change",
      generation: "g1",
      base: 0,
      revision: 1,
      update: [{ tabId: pages[0]!.tabId, title: "Fresh title", url: "https://fresh.example/" }],
    });
    expect(current[0]).toMatchObject({ site: "fresh.example", title: "Fresh title" });
    expect(current[1]).toBe(before[1]);

    model.apply({
      op: "change",
      generation: "g1",
      base: 1,
      revision: 2,
      remove: [pages[0]!.tabId],
      meta: {
        layout: {
          revision: 2,
          items: rows.slice(1).map((tab) => ({ kind: "tab", tabId: tab.tabId })),
        },
      },
    });
    expect(current).toHaveLength(999);
    expect(current.some(({ id }) => id === pages[0]!.tabId)).toBe(false);
  } finally {
    get.mockRestore();
    release();
  }
});
