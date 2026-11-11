import { describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { mockTeamScenarios } from "../mock/mock-team-access.js";
import { isTeamPlace } from "./team-place.js";

describe("which shell a place gets", () => {
  it.each(["seeded", "first-run", "busy"] as const)(
    "never takes the team path on a Personal place (%s world)",
    (world) => {
      const host = new MockHostClient({ world });
      const snapshot = host.getSnapshot();
      expect(snapshot.deploymentShape?.kind).toBe("personal");
      expect(isTeamPlace(snapshot)).toBe(false);
      host.dispose();
    },
  );

  it("takes the team path only when the Host offers team administration", () => {
    expect(isTeamPlace({})).toBe(false);
    expect(isTeamPlace({ teamAdministrationAvailable: false })).toBe(false);
    expect(isTeamPlace({ teamAdministrationAvailable: true })).toBe(true);
  });

  it.each(mockTeamScenarios.filter((scenario) => scenario !== "absent"))(
    "serves the %s team scenario as a team server: no Main, no Chat, only its own Projects",
    (team) => {
      const host = new MockHostClient({ team });
      const snapshot = host.getSnapshot();
      expect(isTeamPlace(snapshot)).toBe(true);
      expect(snapshot).toMatchObject({ homeWorkspaceId: null, homeThreadId: null });
      expect(snapshot.workspaces.every(({ kind }) => kind === "project")).toBe(true);
      // Only Projects this person is on; a paused, removed or unplaced person has none.
      expect(snapshot.workspaces.length > 0).toBe(
        ["admin", "admin-stale", "member", "guest"].includes(team),
      );
      host.dispose();
    },
  );
});
