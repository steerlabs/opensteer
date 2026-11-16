import { createId, type TabGroup, type TabId, type TabLayout } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { tabAfterClose, tabAtShortcut, tabBeside, tabStrip, tabSuccessor } from "./tab-strip.js";

const id = (value: string) => value as TabId;
const group = (name: string, tabIds: string[], collapsed = false): TabGroup => ({
  groupId: createId("tabGroup"),
  name,
  color: "blue",
  collapsed,
  tabIds: tabIds.map(id),
});
// A page, a window, a phone and an app share one group between ungrouped tabs.
const mixed = (collapsed = false): TabLayout => ({
  revision: 3,
  items: [
    { kind: "tab", tabId: id("page-1") },
    { kind: "group", group: group("work", ["page-2", "window-1", "phone-1", "app-1"], collapsed) },
    { kind: "tab", tabId: id("window-2") },
  ],
});
const all = { has: () => true };

describe("tabStrip", () => {
  it("keeps the layout's mixed order with no kind sorted apart", () => {
    const strip = tabStrip(mixed(), all);
    expect(strip.ordered).toEqual(["page-1", "page-2", "window-1", "phone-1", "app-1", "window-2"]);
    expect(strip.visible).toEqual(strip.ordered);
    expect(strip.entries.map((entry) => entry.kind)).toEqual(["tab", "group", "tab"]);
  });

  it("hides a collapsed group's tabs from the visible order only", () => {
    const strip = tabStrip(mixed(true), all);
    expect(strip.visible).toEqual(["page-1", "window-2"]);
    expect(strip.ordered).toHaveLength(6);
  });

  it("skips tabs not received yet and reuses unchanged entries", () => {
    const layout = mixed();
    const first = tabStrip(layout, new Set([id("page-1"), id("page-2"), id("window-2")]));
    expect(first.ordered).toEqual(["page-1", "page-2", "window-2"]);
    expect(tabStrip(layout, new Set(first.ordered), first)).toBe(first);
    const next = tabStrip(layout, all, first);
    expect(next.entries[0]).toBe(first.entries[0]);
    expect(next.entries[1]).not.toBe(first.entries[1]);
  });

  it("walks shortcuts and ⌃Tab over the same visible order", () => {
    const strip = tabStrip(mixed(), all);
    expect(tabAtShortcut(strip, 1)).toBe("page-1");
    expect(tabAtShortcut(strip, 4)).toBe("phone-1");
    expect(tabAtShortcut(strip, 9)).toBe("window-2");
    expect(tabAtShortcut(strip, 8)).toBeNull();
    expect(tabBeside(strip, id("app-1"), 1)).toBe("window-2");
    expect(tabBeside(strip, id("window-2"), 1)).toBe("page-1");
    expect(tabBeside(strip, id("page-1"), -1)).toBe("window-2");
    expect(tabBeside(strip, null, 1)).toBe("page-1");
  });

  it("selects the adjacent visible entry after a close, falling back to none", () => {
    const strip = tabStrip(mixed(), all);
    expect(tabAfterClose(strip, id("phone-1"))).toBe("app-1");
    expect(tabAfterClose(strip, id("window-2"))).toBe("app-1");
    const collapsed = tabStrip(mixed(true), all);
    expect(tabAfterClose(collapsed, id("phone-1"))).toBe("window-2");
    const single = tabStrip({ revision: 1, items: [{ kind: "tab", tabId: id("only") }] }, all);
    expect(tabAfterClose(single, id("only"))).toBeNull();
    expect(
      tabAfterClose(strip, id("page-2"), new Set([id("window-1"), id("phone-1"), id("app-1")])),
    ).toBe("window-2");
    // Closed together elsewhere: the successor is a tab the list still holds.
    const after = tabStrip({ revision: 4, items: [{ kind: "tab", tabId: id("window-2") }] }, all);
    expect(tabSuccessor(strip, after, id("page-1"))).toBe("window-2");
    expect(tabSuccessor(strip, tabStrip({ revision: 5, items: [] }, all), id("page-1"))).toBeNull();
  });
});
