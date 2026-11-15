import { expect, it, vi } from "vitest";
import { FakeTabs, pageTab, phoneTab, tabId } from "../../test-support/mock-tabs.js";
import { tabSuggestions } from "./tab-suggestions.js";

it("offers the list's pages in order and refreshes one by key without rereading unchanged rows", () => {
  const model = new FakeTabs();
  const pages = Array.from({ length: 1_000 }, (_, i) => pageTab(`p${i}`, `Page ${i}`));
  model.reset(
    [...pages, phoneTab("pixel")],
    [...pages, phoneTab("pixel")].map((tab) => ({ kind: "tab" as const, tabId: tab.tabId })),
  );
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

    model.patch({ ...pages[0]!, title: "Fresh title", url: "https://fresh.example/" });
    expect(current[0]).toMatchObject({ site: "fresh.example", title: "Fresh title" });
    expect(current[1]).toBe(before[1]);

    model.setLayout(
      model.layout.items.filter((item) => item.kind !== "tab" || item.tabId !== tabId("p0")),
    );
    expect(current).toHaveLength(999);
    expect(current.some(({ id }) => id === tabId("p0"))).toBe(false);
  } finally {
    get.mockRestore();
    release();
  }
});
