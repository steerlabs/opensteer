import { describe, expect, it } from "vitest";
import { teamSetupSteps } from "./team-setup.js";

const computer = {
  id: "rnr_00000000-0000-4000-8000-0000000000f1" as never,
  name: "acme-runner",
  state: "connected" as const,
  lastSeenAt: null,
};

describe("getting a new team ready", () => {
  it("ticks each step from the Host's facts alone, and says nothing until they are read", () => {
    expect(
      teamSetupSteps({ team: "Acme", computer: undefined, projects: [], invited: false }),
    ).toBeNull();
    const fresh = teamSetupSteps({ team: "Acme", computer: null, projects: [], invited: false });
    expect(fresh?.map(({ done }) => done)).toEqual([false, false, false]);
    const offline = teamSetupSteps({
      team: "Acme",
      computer: { ...computer, state: "offline" },
      projects: [{ runtime: { state: "unavailable", reason: "computer-offline" } }],
      invited: true,
    });
    expect(offline?.map(({ done }) => done)).toEqual([false, false, true]);
  });

  it("goes away once every step is done", () => {
    expect(
      teamSetupSteps({
        team: "Acme",
        computer,
        projects: [{ runtime: { state: "ready" } }],
        invited: true,
      }),
    ).toBeNull();
  });
});
