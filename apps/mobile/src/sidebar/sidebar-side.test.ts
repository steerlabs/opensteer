import { describe, expect, it } from "vitest";
import { switchLayout } from "./side-switch-layout.js";
import { sideOfScreen } from "./sidebar-side.js";

describe("the side a screen belongs to", () => {
  it("is its team for a team's screen, Tasks for a task's, and neither for Teams", () => {
    expect(
      sideOfScreen({ name: "TeamChannel", params: { teamId: "dep_acme", channelId: "c" } }),
    ).toBe("dep_acme");
    expect(sideOfScreen({ name: "Thread", params: { deploymentId: "d", threadId: "t" } })).toBe(
      "tasks",
    );
    expect(sideOfScreen({ name: "Home", params: { deploymentId: "d" } })).toBe("tasks");
    expect(sideOfScreen({ name: "Teams", params: {} })).toBeNull();
  });
});

describe("the switch's segments", () => {
  const sides = ["tasks", "a", "b", "c", "d", "e", "f"];

  it("names both sides of a single team, and marks the rest once there are more", () => {
    expect(switchLayout(["tasks", "a"], "tasks", 260)).toEqual({
      shown: ["tasks", "a"],
      folded: [],
      named: true,
    });
    expect(switchLayout(["tasks", "a", "b", "c"], "b", 300)).toEqual({
      shown: ["tasks", "a", "b", "c"],
      folded: [],
      named: false,
    });
  });

  it("folds what the track can't hold, always drawing Tasks and the chosen side", () => {
    // 236 points hold the chosen segment and two marks: Tasks, the fold, and the chosen team.
    const narrow = switchLayout(sides, "e", 236);
    expect(narrow.shown).toEqual(["tasks", "e"]);
    expect(narrow.folded).toEqual(["a", "b", "c", "d", "f"]);
    // 316 points hold it and four marks: three teams and the fold.
    const wide = switchLayout(sides, "tasks", 316);
    expect(wide.shown).toEqual(["tasks", "a", "b", "c"]);
    expect(wide.folded).toEqual(["d", "e", "f"]);
    // Every side is reachable exactly once.
    for (const width of [180, 236, 280, 316, 400])
      for (const active of sides) {
        const layout = switchLayout(sides, active, width);
        expect([...layout.shown, ...layout.folded].sort()).toEqual([...sides].sort());
        expect(layout.shown).toContain(active);
        expect(layout.shown[0]).toBe("tasks");
      }
  });
});
