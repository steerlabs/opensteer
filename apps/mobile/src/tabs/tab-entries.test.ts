import type { TabLayout } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { groupId, tabId } from "../../test-support/mock-tabs.js";
import { adjacentTabId, moveBefore, moveGroupBefore, tabEntries } from "./tab-entries.js";

const [page, window, phone, app, other] = ["page", "window", "phone", "app", "other"].map(tabId);
const work = (collapsed: boolean) => ({
  collapsed,
  color: "blue" as const,
  groupId: groupId(1),
  name: "Work",
  tabIds: [window!, phone!],
});
const layout = (collapsed = false): TabLayout => ({
  items: [
    { kind: "tab", tabId: page! },
    { group: work(collapsed), kind: "group" },
    { kind: "tab", tabId: app! },
    { kind: "tab", tabId: other! },
  ],
  revision: 1,
});

describe("one mixed list", () => {
  it("keeps every kind in the Host's order, a collapsed group showing only its head", () => {
    expect(
      tabEntries(layout()).map((entry) => (entry.kind === "tab" ? entry.tabId : "group")),
    ).toEqual([page, "group", window, phone, app, other]);
    expect(
      tabEntries(layout(true)).map((entry) => (entry.kind === "tab" ? entry.tabId : "group")),
    ).toEqual([page, "group", app, other]);
  });
});

describe("selection after a close", () => {
  it("moves to the entry after the closed tab, else the one before, else nowhere", () => {
    expect(adjacentTabId(layout(), phone!)).toBe(app);
    expect(adjacentTabId(layout(), other!)).toBe(app);
    expect(
      adjacentTabId({ items: [{ kind: "tab", tabId: page! }], revision: 1 }, page!),
    ).toBeNull();
  });

  it("never lands inside a collapsed group, even from one of its own tabs", () => {
    expect(adjacentTabId(layout(true), page!)).toBe(app);
    expect(adjacentTabId(layout(true), window!)).toBe(app);
  });
});

describe("moves where dragging is impractical", () => {
  it("joins the anchor's group, or leaves every group for an ungrouped anchor", () => {
    expect(moveBefore(layout(), page!, phone!)).toEqual({
      beforeTabId: phone,
      group: { groupId: groupId(1) },
      tabIds: [page],
    });
    expect(moveBefore(layout(), window!, app!)).toEqual({
      beforeTabId: app,
      group: null,
      tabIds: [window],
    });
  });

  it("moves a whole group as one block, refusing an anchor of its own", () => {
    expect(moveGroupBefore(work(false), page!)).toEqual({
      beforeTabId: page,
      group: { groupId: groupId(1) },
      tabIds: [window, phone],
    });
    expect(moveGroupBefore(work(false), phone!)).toBeNull();
  });
});
