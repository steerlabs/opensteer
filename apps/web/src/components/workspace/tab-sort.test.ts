import { expect, it } from "vitest";
import type { TabGroupId, TabId, TabLayout } from "@opensteer/core";
import { tabStrip, type TabStrip } from "@opensteer/client/host";
import {
  movedStrip,
  organizeInput,
  slotMove,
  sortSlots,
  type SortRow,
  type TabMove,
} from "./tab-sort.js";

const id = (value: string) => value as TabId;
const group = (groupId: string, tabIds: string[]) => ({
  kind: "group" as const,
  group: {
    groupId: groupId as TabGroupId,
    name: groupId,
    color: "blue" as const,
    collapsed: false,
    tabIds: tabIds.map(id),
  },
});
// a · G[b c] · d · H[e]
const layout: TabLayout = {
  revision: 1,
  items: [
    { kind: "tab", tabId: id("a") },
    group("G", ["b", "c"]),
    { kind: "tab", tabId: id("d") },
    group("H", ["e"]),
  ],
};
const rows: SortRow[] = layout.items.flatMap((item): SortRow[] =>
  item.kind === "tab"
    ? [{ kind: "tab", key: item.tabId, tabId: item.tabId, group: null }]
    : [
        {
          kind: "group",
          key: item.group.groupId,
          groupId: item.group.groupId,
          color: "blue",
          collapsed: false,
        },
        ...item.group.tabIds.map((tabId): SortRow => ({
          kind: "tab",
          key: tabId,
          tabId,
          group: { id: item.group.groupId, color: "blue" },
        })),
      ],
);
const at = (key: string) => rows.findIndex((row) => row.key === key);
/** The command a drop makes on the top-level slot just before row `beforeKey`, or at the end. */
function dropAtTop(lifted: string, beforeKey: string | null) {
  const from = at(lifted);
  const slots = sortSlots(rows, from, null);
  const rest = rows.filter((_, index) => index !== from);
  const gap = beforeKey === null ? rest.length : rest.findIndex((row) => row.key === beforeKey);
  const slot = slots.findIndex((candidate) => candidate.gap === gap && candidate.group === null);
  const move = slotMove(rows, from, slots, slot);
  return move && organizeInput(move, layout);
}

it("a drop before a group names the group's place by its first member that is not moving", () => {
  // A loose tab before G: G's first member stands for G's place in the top level.
  expect(dropAtTop("d", "G")).toEqual({ tabIds: ["d"], group: null, beforeTabId: "b" });
  // G's own first member, out before G: it cannot anchor itself, so its neighbour does.
  expect(dropAtTop("b", "G")).toEqual({ tabIds: ["b"], group: null, beforeTabId: "c" });
});

it("a whole group moves as one block, before another group or to the end", () => {
  expect(dropAtTop("G", "H")).toEqual({
    tabIds: ["b", "c"],
    group: { groupId: "G" },
    beforeTabId: "e",
  });
  expect(dropAtTop("G", null)).toEqual({ tabIds: ["b", "c"], group: { groupId: "G" } });
});

it("a drop before a group with no member left to name its place moves nothing", () => {
  const empty: TabLayout = {
    revision: 1,
    items: [{ kind: "tab", tabId: id("a") }, group("E", [])],
  };
  expect(
    organizeInput(
      { item: { tabIds: ["a"] }, to: { groupId: null, before: { groupId: "E" } } },
      empty,
    ),
  ).toBeNull();
});

/** A strip in short: tabs by ID, a group as `G[b c]`. */
const words = (strip: TabStrip) =>
  strip.entries
    .map((entry) =>
      entry.kind === "tab" ? entry.tabId : `${entry.group.groupId}[${entry.tabIds.join(" ")}]`,
    )
    .join(" ");
const strip = tabStrip(layout, { has: () => true });
/** The move a drop on the slot just before row `beforeKey` (or at the end) makes, in or out of a group. */
function dropMove(lifted: string, beforeKey: string | null, inGroup: string | null): TabMove {
  const from = at(lifted);
  const slots = sortSlots(rows, from, null);
  const rest = rows.filter((_, index) => index !== from);
  const gap = beforeKey === null ? rest.length : rest.findIndex((row) => row.key === beforeKey);
  const slot = slots.findIndex(
    (candidate) => candidate.gap === gap && (candidate.group?.id ?? null) === inGroup,
  );
  return slotMove(rows, from, slots, slot)!;
}

it("the list shows a drop at once, as the Host will order it, and the Host's answer changes nothing", () => {
  for (const [move, after] of [
    // Down the top level, past a group.
    [dropMove("a", "d", null), "G[b c] a d H[e]"],
    // Into a group, between its members.
    [dropMove("d", "c", "G"), "a G[b d c] H[e]"],
    // Out of a group at its foot, right after it.
    [dropMove("c", "d", null), "a G[b] c d H[e]"],
    // A group's only member out: the Host keeps the emptied group, and no list draws it.
    [dropMove("e", null, null), "a G[b c] d e"],
    // A whole group, before another one and to the end.
    [dropMove("G", "H", null), "a d G[b c] H[e]"],
    [dropMove("G", null, null), "a d H[e] G[b c]"],
    // Onto a collapsed group's header: its foot.
    [{ item: { tabIds: ["a"] }, to: { groupId: "H", before: null } }, "G[b c] d H[e a]"],
  ] as const) {
    const shown = movedStrip(strip, move);
    expect(words(shown)).toBe(after);
    expect(shown.ordered).toEqual(after.match(/\b[a-z]\b/g));
    // The Host's answer is that order: the move over it is the same order.
    expect(words(movedStrip(shown, move))).toBe(after);
  }
});

it("a move whose anchor or group is gone shows nothing moved, as the Host refuses it", () => {
  expect(
    movedStrip(strip, { item: { tabIds: ["a"] }, to: { groupId: null, before: { tabId: "x" } } }),
  ).toBe(strip);
  expect(movedStrip(strip, { item: { tabIds: ["a"] }, to: { groupId: "X", before: null } })).toBe(
    strip,
  );
  expect(movedStrip(strip, { item: { groupId: "X" }, to: { groupId: null, before: null } })).toBe(
    strip,
  );
});
