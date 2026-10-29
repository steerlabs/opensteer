import { describe, expect, it } from "vitest";
import {
  groupBrowserTabs,
  moveBrowserTabs,
  resolveBrowserTabOrder,
  ungroupBrowserTabs,
  type BrowserTabArrangement,
  type BrowserTabMoveInput,
  type BrowserTabOrderTab,
} from "./browser-tab-order.js";

/** Tabs recorded in the order given, one second apart, in one lineage unless named. */
function tabs(...specs: readonly (string | [string, string | null, string?])[]) {
  return specs.map((spec, index): BrowserTabOrderTab => {
    const [id, openerId, lineage] = typeof spec === "string" ? [spec, null] : spec;
    return {
      id,
      openerId: openerId ?? null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      lineageCreatedAt: lineage ?? "2026-01-01T00:00:00.000Z",
      order: index,
    };
  });
}
const groups = (entries: Record<string, string>) => new Map(Object.entries(entries));
function contiguous({ order, groupOf }: BrowserTabArrangement) {
  const seen = new Set<string>();
  for (const [index, id] of order.entries()) {
    const group = groupOf.get(id);
    if (group === undefined || groupOf.get(order[index - 1] ?? "") === group) continue;
    if (seen.has(group)) return false;
    seen.add(group);
  }
  return new Set(order).size === order.length;
}
function moved(arrangement: BrowserTabArrangement, move: BrowserTabMoveInput) {
  const result = moveBrowserTabs(arrangement, move);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(contiguous(result.arrangement)).toBe(true);
  return result.arrangement;
}
function refused(arrangement: BrowserTabArrangement, move: BrowserTabMoveInput) {
  const result = moveBrowserTabs(arrangement, move);
  return result.ok ? "accepted" : result.code;
}

describe("resolveBrowserTabOrder", () => {
  it("keeps saved places, drops absent tabs and appends the rest as recorded (R1, R2, R11)", () => {
    const all = tabs("A", "B", "C", "D");
    expect(resolveBrowserTabOrder(["C", "gone", "A", "C"], all, new Map())).toEqual([
      "C",
      "A",
      "B",
      "D",
    ]);
    expect(resolveBrowserTabOrder(undefined, all, new Map())).toEqual(["A", "B", "C", "D"]);
  });

  it("orders unsaved tabs by recording time across lineages, not by lineage (R2)", () => {
    const all = [
      ...tabs(["old", null, "2025-01-01T00:00:00.000Z"]),
      {
        id: "new-in-old-lineage",
        openerId: null,
        createdAt: "2026-02-01T00:00:00.000Z",
        lineageCreatedAt: "2025-01-01T00:00:00.000Z",
        order: 9,
      },
      {
        id: "mid",
        openerId: null,
        createdAt: "2026-01-15T00:00:00.000Z",
        lineageCreatedAt: "2026-01-15T00:00:00.000Z",
        order: 0,
      },
    ];
    expect(resolveBrowserTabOrder([], all, new Map())).toEqual([
      "old",
      "mid",
      "new-in-old-lineage",
    ]);
  });

  it("puts link-opened tabs after their opener in opening order (R3)", () => {
    const all = tabs("O", "X", ["c1", "O"], ["c2", "O"], ["c3", "O"]);
    expect(resolveBrowserTabOrder([], all, new Map())).toEqual(["O", "c1", "c2", "c3", "X"]);
    // A saved place wins: c1 stays where the person put it, its siblings follow O.
    expect(resolveBrowserTabOrder(["O", "X", "c1"], all, new Map())).toEqual([
      "O",
      "c2",
      "c3",
      "X",
      "c1",
    ]);
  });

  it("puts a loose child of a grouped opener right after the group, never inside another (R4, R5)", () => {
    const all = tabs("A", "O", "B", "H", ["c", "O"]);
    const groupOf = groups({ A: "G", O: "G", H: "K" });
    const order = resolveBrowserTabOrder(["A", "O", "H", "B"], all, groupOf);
    expect(order).toEqual(["A", "O", "c", "H", "B"]);
    expect(contiguous({ order, groupOf })).toBe(true);
  });

  it("puts a member at the end of its group, or after its opener there (R6, R7)", () => {
    const all = tabs("A", "B", "C", "M", ["N", "A"], "S");
    const groupOf = groups({ A: "G", B: "G", M: "G", N: "G", S: "K" });
    const order = resolveBrowserTabOrder(["A", "B", "C"], all, groupOf);
    expect(order).toEqual(["A", "N", "B", "M", "C", "S"]);
    expect(contiguous({ order, groupOf })).toBe(true);
  });

  it("gives the same order from the first resolution plus a new tab as from nothing (R8)", () => {
    const first = tabs("A", "B", ["C", "B"]);
    const groupOf = groups({ A: "G", C: "G" });
    const resolved = resolveBrowserTabOrder(undefined, first, groupOf);
    expect(resolved).toEqual(["A", "C", "B"]);
    const all = [...first, ...tabs("_", "_", "_", ["D", "C"]).slice(3)];
    expect(resolveBrowserTabOrder(resolved, all, groupOf)).toEqual(
      resolveBrowserTabOrder(undefined, all, groupOf),
    );
    expect(resolveBrowserTabOrder(resolved, all, groupOf)).toEqual(["A", "C", "D", "B"]);
  });

  it("is idempotent and keeps groups adjacent (R9, R10)", () => {
    const all = tabs("A", "B", ["C", "A"], ["D", "B"], "E", ["F", "C"]);
    const groupOf = groups({ A: "G", D: "G", E: "K", F: "K" });
    const once = resolveBrowserTabOrder(undefined, all, groupOf);
    expect(resolveBrowserTabOrder(once, all, groupOf)).toEqual(once);
    expect(contiguous({ order: once, groupOf })).toBe(true);
    expect([...once].sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
  });
});

describe("moveBrowserTabs", () => {
  // a  [G: g1 g2 g3]  b  [K: k1]  c
  const base: BrowserTabArrangement = {
    order: ["a", "g1", "g2", "g3", "b", "k1", "c"],
    groupOf: groups({ g1: "G", g2: "G", g3: "G", k1: "K" }),
  };
  const tab = (tabId: string) => ({ tabId });

  it("moves at the top level before a tab, before a group and to the end (M1)", () => {
    expect(
      moved(base, { item: { tabIds: ["c"] }, to: { groupId: null, before: tab("b") } }).order,
    ).toEqual(["a", "g1", "g2", "g3", "c", "b", "k1"]);
    expect(
      moved(base, { item: { tabIds: ["c"] }, to: { groupId: null, before: { groupId: "G" } } })
        .order,
    ).toEqual(["a", "c", "g1", "g2", "g3", "b", "k1"]);
    expect(
      moved(base, { item: { tabIds: ["a"] }, to: { groupId: null, before: null } }).order,
    ).toEqual(["g1", "g2", "g3", "b", "k1", "c", "a"]);
  });

  it("moves into a group from the top level, from another group and within it (M2)", () => {
    const joined = moved(base, {
      item: { tabIds: ["b"] },
      to: { groupId: "G", before: tab("g2") },
    });
    expect(joined.order).toEqual(["a", "g1", "b", "g2", "g3", "k1", "c"]);
    expect(joined.groupOf.get("b")).toBe("G");
    const fromK = moved(base, { item: { tabIds: ["k1"] }, to: { groupId: "G", before: null } });
    expect(fromK.order).toEqual(["a", "g1", "g2", "g3", "k1", "b", "c"]);
    expect(fromK.groupOf.get("k1")).toBe("G");
    expect([...fromK.groupOf.values()]).not.toContain("K");
    expect(
      moved(base, { item: { tabIds: ["g3"] }, to: { groupId: "G", before: tab("g1") } }).order,
    ).toEqual(["a", "g3", "g1", "g2", "b", "k1", "c"]);
  });

  it("moves out of a group, before or after its own group (M3)", () => {
    const before = moved(base, {
      item: { tabIds: ["g2"] },
      to: { groupId: null, before: { groupId: "G" } },
    });
    expect(before.order).toEqual(["a", "g2", "g1", "g3", "b", "k1", "c"]);
    expect(before.groupOf.has("g2")).toBe(false);
    expect(
      moved(base, { item: { tabIds: ["g1"] }, to: { groupId: null, before: tab("b") } }).order,
    ).toEqual(["a", "g2", "g3", "g1", "b", "k1", "c"]);
  });

  it("keeps several tabs from different places in their relative order (M4)", () => {
    const result = moved(base, {
      item: { tabIds: ["c", "g2", "a"] },
      to: { groupId: "K", before: tab("k1") },
    });
    expect(result.order).toEqual(["g1", "g3", "b", "a", "g2", "c", "k1"]);
    expect(["a", "g2", "c"].map((id) => result.groupOf.get(id))).toEqual(["K", "K", "K"]);
  });

  it("moves a group as a block before a tab, before a group and to the end (M5)", () => {
    expect(
      moved(base, { item: { groupId: "G" }, to: { groupId: null, before: tab("c") } }).order,
    ).toEqual(["a", "b", "k1", "g1", "g2", "g3", "c"]);
    expect(
      moved(base, { item: { groupId: "K" }, to: { groupId: null, before: { groupId: "G" } } })
        .order,
    ).toEqual(["a", "k1", "g1", "g2", "g3", "b", "c"]);
    expect(
      moved(base, { item: { groupId: "G" }, to: { groupId: null, before: null } }).order,
    ).toEqual(["a", "b", "k1", "c", "g1", "g2", "g3"]);
  });

  it("refuses impossible moves as bad requests (M6)", () => {
    expect(refused(base, { item: { groupId: "G" }, to: { groupId: "K", before: null } })).toBe(
      "bad_request",
    );
    expect(
      refused(base, { item: { groupId: "G" }, to: { groupId: null, before: tab("g2") } }),
    ).toBe("bad_request");
    expect(
      refused(base, { item: { groupId: "G" }, to: { groupId: null, before: { groupId: "G" } } }),
    ).toBe("bad_request");
    expect(
      refused(base, { item: { tabIds: ["a", "b"] }, to: { groupId: null, before: tab("b") } }),
    ).toBe("bad_request");
    expect(
      refused(base, { item: { tabIds: ["k1"] }, to: { groupId: null, before: { groupId: "K" } } }),
    ).toBe("bad_request");
    expect(
      refused(base, { item: { tabIds: ["a"] }, to: { groupId: "G", before: { groupId: "K" } } }),
    ).toBe("bad_request");
  });

  it("refuses an anchor that is no longer in the destination instead of guessing (M7)", () => {
    expect(
      refused(base, { item: { tabIds: ["a"] }, to: { groupId: null, before: tab("g2") } }),
    ).toBe("conflict");
    expect(refused(base, { item: { tabIds: ["a"] }, to: { groupId: "G", before: tab("b") } })).toBe(
      "conflict",
    );
    expect(
      refused(base, { item: { tabIds: ["a"] }, to: { groupId: null, before: { groupId: "Z" } } }),
    ).toBe("conflict");
  });

  it("refuses unknown tabs and groups (M8)", () => {
    expect(refused(base, { item: { tabIds: ["zz"] }, to: { groupId: null, before: null } })).toBe(
      "not_found",
    );
    expect(refused(base, { item: { groupId: "Z" }, to: { groupId: null, before: null } })).toBe(
      "not_found",
    );
    expect(refused(base, { item: { tabIds: ["a"] }, to: { groupId: "Z", before: null } })).toBe(
      "not_found",
    );
    expect(
      refused(base, { item: { tabIds: ["a"] }, to: { groupId: null, before: tab("zz") } }),
    ).toBe("not_found");
  });

  it("leaves no membership when the last member moves out (M9)", () => {
    const result = moved(base, { item: { tabIds: ["k1"] }, to: { groupId: null, before: null } });
    expect([...result.groupOf.values()]).not.toContain("K");
  });

  it("changes nothing more when the same move lands twice (M10)", () => {
    const move: BrowserTabMoveInput = {
      item: { tabIds: ["c", "a"] },
      to: { groupId: "G", before: tab("g2") },
    };
    const once = moved(base, move);
    const twice = moved(once, move);
    expect(twice.order).toEqual(once.order);
    expect(twice.groupOf).toEqual(once.groupOf);
    const all = moved(base, {
      item: { tabIds: ["g1", "g2", "g3"] },
      to: { groupId: "G", before: null },
    });
    expect(all.order).toEqual(base.order);
  });
});

describe("group commands keep the order", () => {
  const base: BrowserTabArrangement = {
    order: ["a", "g1", "g2", "g3", "b", "k1", "c"],
    groupOf: groups({ g1: "G", g2: "G", g3: "G", k1: "K" }),
  };

  it("joins an existing group at its end, from anywhere (G1)", () => {
    const result = groupBrowserTabs(base, ["c", "a", "k1"], "G");
    expect(result.order).toEqual(["g1", "g2", "g3", "a", "k1", "c", "b"]);
    expect(contiguous(result)).toBe(true);
    expect(groupBrowserTabs(base, ["g2"], "G")).toBe(base);
  });

  it("forms a new group at its earliest tab, or after the group that tab leaves (G2)", () => {
    const loose = groupBrowserTabs(base, ["c", "b"], "N");
    expect(loose.order).toEqual(["a", "g1", "g2", "g3", "b", "c", "k1"]);
    expect(contiguous(loose)).toBe(true);
    const fromMiddle = groupBrowserTabs(base, ["g2", "c"], "N");
    expect(fromMiddle.order).toEqual(["a", "g1", "g3", "g2", "c", "b", "k1"]);
    expect(contiguous(fromMiddle)).toBe(true);
    const fromFirst = groupBrowserTabs(base, ["g1"], "N");
    expect(fromFirst.order).toEqual(["a", "g1", "g2", "g3", "b", "k1", "c"]);
    expect(contiguous(fromFirst)).toBe(true);
  });

  it("ungroups a whole group in place and some members after it (G3, G4, G5)", () => {
    const whole = ungroupBrowserTabs(base, ["g1", "g2", "g3"]);
    expect(whole.order).toEqual(base.order);
    expect(whole.groupOf.size).toBe(1);
    const some = ungroupBrowserTabs(base, ["g1", "g3", "k1"]);
    expect(some.order).toEqual(["a", "g2", "g1", "g3", "b", "k1", "c"]);
    expect([...some.groupOf.entries()]).toEqual([["g2", "G"]]);
    expect(contiguous(some)).toBe(true);
  });
});
