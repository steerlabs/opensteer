import { describe, expect, it } from "vitest";
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
