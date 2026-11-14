import { describe, expect, it } from "vitest";
import { chooseSide, moreTeamsKey, recentTeam, sideSwitchLayout } from "./side-switch.js";

const metrics = { padding: 3, gap: 2, mark: 28, named: 72 };
const layout = (teamIds: string[], recent: string, width: number) =>
  sideSwitchLayout({ teamIds, recent, width, tasks: 70 }, metrics);
const keys = (result: ReturnType<typeof layout>) => result.segments.map((segment) => segment.key);

describe("the sidebar's sides", () => {
  it("keeps the last team shown while the person is on Tasks, and falls back when it is gone", () => {
    const onAcme = chooseSide({ side: "tasks", recent: null }, "acme");
    const back = chooseSide(onAcme, "tasks");
    expect(back).toEqual({ side: "tasks", recent: "acme" });
    expect(recentTeam(back, ["beta", "acme"])).toBe("acme");
    expect(recentTeam(back, ["beta"])).toBe("beta");
    expect(recentTeam(back, [])).toBeNull();
  });
});

describe("the switch's layout", () => {
  it("moves no segment between Tasks and the recent team, and only renames on a team change", () => {
    const first = layout(["a", "b", "c"], "a", 260);
    const second = layout(["a", "b", "c"], "b", 260);
    expect(keys(first)).toEqual(["tasks", "a", "b", "c"]);
    expect(keys(second)).toEqual(["tasks", "a", "b", "c"]);
    expect(first.segments[0]).toEqual(second.segments[0]);
    // The recent team takes what the others leave; the track is filled exactly.
    expect(first.segments.find((s) => s.key === "a")!.width).toBe(
      second.segments.find((s) => s.key === "b")!.width,
    );
    const last = first.segments.at(-1)!;
    expect(last.x + last.width).toBe(260 - metrics.padding);
    expect(first.named).toBe(true);
  });

  it("says the name beneath once it no longer fits, before folding any team", () => {
    const tight = layout(["a", "b", "c", "d", "e"], "a", 240);
    expect(tight.named).toBe(false);
    expect(tight.folded).toEqual([]);
  });

  it("folds the teams past what fits, keeping Tasks, the recent team and every team reachable", () => {
    const teams = ["a", "b", "c", "d", "e", "f", "g"];
    for (const width of [160, 200, 240, 300, 400, 0])
      for (const recent of teams) {
        const result = layout(teams, recent, width);
        const drawn = keys(result).filter((key) => key !== "tasks" && key !== moreTeamsKey);
        expect(keys(result)[0]).toBe("tasks");
        expect(drawn).toContain(recent);
        expect([...drawn, ...result.folded].sort()).toEqual(teams);
        expect(drawn).toEqual(teams.filter((team) => drawn.includes(team)));
        expect(keys(result).includes(moreTeamsKey)).toBe(result.folded.length > 0);
        if (width > 0 && result.segments.length > 3) {
          const last = result.segments.at(-1)!;
          expect(last.x + last.width).toBeLessThanOrEqual(width - metrics.padding);
        }
      }
    const narrow = layout(teams, "e", 200);
    expect(keys(narrow)).toEqual(["tasks", "a", "b", "e", moreTeamsKey]);
    expect(narrow.folded).toEqual(["c", "d", "f", "g"]);
  });
});
