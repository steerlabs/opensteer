import { TabGroupIdSchema, TabIdSchema, type TabLayout } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { moveBefore, moveGroupBefore } from "./tab-entries.js";

const tabId = (name: string) => TabIdSchema.parse(`tab_${name}`);
const groupId = (n: number) =>
  TabGroupIdSchema.parse(`tgp_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

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
