import { describe, expect, it } from "vitest";
import { sectionSortRows, slotMove, sortSlots, stepSlot, type SortRow } from "./tab-sort.js";

const tab = (id: string, section: string): SortRow => ({
  kind: "tab",
  key: `browser:${id}`,
  section,
  tabId: id,
  group: null,
});

describe("moving a tab among device sections", () => {
  // Mac mini's two tabs, then Studio Mac's two: a tab runs where it runs.
  const rows = [tab("a", "mini"), tab("b", "mini"), tab("c", "studio"), tab("d", "studio")];

  it("refuses to carry a tab into another device's section and keeps moves inside its own", () => {
    const studio = sectionSortRows(rows, "browser:c");
    expect(studio.map((row) => row.key)).toEqual(["browser:c", "browser:d"]);
    // Up from the top of its section there is nowhere to go.
    expect(stepSlot(studio, 0, -1)).toBeNull();
    const slots = sortSlots(studio, 0, null);
    const befores = slots.map((slot) => slot.before);
    expect(befores).not.toContainEqual({ tabId: "a" });
    expect(befores).not.toContainEqual({ tabId: "b" });
    const down = stepSlot(studio, 0, 1)!;
    expect(slotMove(studio, 0, down.slots, down.slot)).toEqual({
      item: { tabIds: ["c"] },
      to: { groupId: null, before: null },
    });
    expect(sectionSortRows(rows, "browser:missing")).toEqual([]);
  });
});
