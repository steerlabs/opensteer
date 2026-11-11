import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { teamComputerCommand } from "./team-computer.js";
import { placeHas } from "./team-place.js";
import { canDeleteProject, canListAllProjects } from "./team-presentation.js";
import { unplacedOutcomes } from "./team-thread.js";

const allowed = { allowed: true } as const;

describe("who sees what on a team place", () => {
  it("offers Tabs and a person's own engine choice only outside a team place", () => {
    for (const part of ["tabs", "execution-choice"] as const) {
      expect(placeHas({ teamAdministrationAvailable: false }, part)).toBe(true);
      expect(placeHas({}, part)).toBe(true);
      expect(placeHas({ teamAdministrationAvailable: true }, part)).toBe(false);
    }
  });

  it("lists every Project and deletes one only on the Host's own can, never on a neighbour's", () => {
    expect(canListAllProjects({ can: { projects: allowed } })).toBe(true);
    expect(canListAllProjects({ can: {} })).toBe(false);
    expect(canListAllProjects(null)).toBe(false);
    expect(canDeleteProject({ can: { delete: allowed } })).toBe(true);
    expect(
      canDeleteProject({ can: { delete: { allowed: false, reason: "project-manage-required" } } }),
    ).toBe(false);
    expect(canDeleteProject({ can: {} })).toBe(false);
  });

  it("gives the team computer's command only with the image the Host names", () => {
    const input = {
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" } as const,
      hostOrigin: "https://acme.example",
      team: "Acme",
      replaced: {
        enrollmentId: "ren_00000000-0000-4000-8000-000000000001",
        token: "MOCK-TEAM-COMPUTER-CODE-0001",
      },
    };
    expect(
      teamComputerCommand({ ...input, replaced: { ...input.replaced, runnerImage: null } }).kind,
    ).toBe("unavailable");
    expect(teamComputerCommand(input).kind).toBe("unavailable");
    const named = teamComputerCommand({
      ...input,
      replaced: { ...input.replaced, runnerImage: "registry.example/opensteer/runner:sha-abc" },
    });
    expect(named.kind).toBe("command");
    expect(named.text).toContain("registry.example/opensteer/runner:sha-abc");
  });

  it("shows an outcome as its own line only when the transcript doesn't hold its question", () => {
    const placed = createId("request");
    const unseen = createId("request");
    const outcome = (requestId: typeof placed) => ({
      requestId,
      status: "fulfilled" as const,
      at: "2026-11-09T07:04:00.000Z",
      resolvedByName: "Dev Patel",
    });
    expect(
      unplacedOutcomes(
        [outcome(placed), outcome(unseen)],
        [{ kind: "request", requestId: placed }],
      ),
    ).toEqual([outcome(unseen)]);
  });
});
