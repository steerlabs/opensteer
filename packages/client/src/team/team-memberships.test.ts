import { describe, expect, it } from "vitest";
import { createId, DeploymentIdSchema } from "@opensteer/core";
import type { PersonalTeamLink } from "@opensteer/protocol";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { listedTeams } from "./team-memberships.js";
import type { TeamConnectionIntent } from "./team-coordinator.js";

const phoneTeam = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000a1");
const disconnecting = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000a2");
const justEntered = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000a3");

function link(teamId: string, state: PersonalTeamLink["state"]): PersonalTeamLink {
  return {
    teamId: DeploymentIdSchema.parse(teamId),
    hostInstanceId: createId("hostInstance"),
    origin: "https://beta.teams.opensteer.com",
    teamName: "Beta (link)",
    remoteLinkId: null,
    ownerUserId: null,
    state,
    updateRequiredBy: null,
    lastContactAt: null,
  };
}

describe("listedTeams", () => {
  it("lists every team Account says the person is in, whatever its agent links say", () => {
    const intent: TeamConnectionIntent = {
      accountSubject: ControlPlaneAccountIdSchema.parse(
        "acct_00000000-0000-4000-8000-0000000000ff",
      ),
      teamOrigin: "https://gamma.teams.opensteer.com",
      teamDeploymentId: justEntered,
      hostedTeamId: null,
      personalDeploymentId: null,
      state: "no-agent",
      failure: null,
      updatedAt: new Date().toISOString(),
    };
    const teams = listedTeams({
      account: [
        // Joined on a phone, no agent: no link or intent on this computer.
        { teamDeploymentId: phoneTeam, origin: "https://acme.teams.opensteer.com", name: "Acme" },
        // Its agent is disconnecting; membership stays.
        { teamDeploymentId: disconnecting, origin: "https://beta.teams.opensteer.com", name: "Beta" },
      ],
      links: [link(disconnecting, "leaving")],
      // Entered here a moment ago, before Account's directory lists it.
      intents: [intent],
    });
    expect(teams).toEqual([
      { teamDeploymentId: phoneTeam, origin: "https://acme.teams.opensteer.com", name: "Acme" },
      { teamDeploymentId: disconnecting, origin: "https://beta.teams.opensteer.com", name: "Beta" },
      { teamDeploymentId: justEntered, origin: "https://gamma.teams.opensteer.com", name: "gamma" },
    ]);
  });
});
