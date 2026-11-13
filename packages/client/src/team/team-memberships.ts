import type { PersonalTeamLink } from "@opensteer/protocol";
import type { TeamConnectionIntent } from "./team-coordinator.js";

/** A team the person is in, as a surface lists it. */
export interface TeamMembership {
  readonly teamDeploymentId: string;
  readonly origin: string;
  readonly name: string;
}

/**
 * The teams a surface lists for the person. Account's catalog says which teams they belong to,
 * wherever they joined. A team entered on this device shows until the catalog lists it, and an
 * agent link names a team Account doesn't list (a self-hosted team linked by code); neither
 * hides a team the catalog lists.
 */
export function listedTeams(input: {
  readonly account: readonly TeamMembership[];
  /** Agent links; a phone passes what it last learnt of the computer being shown. */
  readonly links: readonly (Pick<PersonalTeamLink, "teamId" | "origin" | "teamName"> &
    Partial<Pick<PersonalTeamLink, "state">>)[];
  readonly intents: readonly TeamConnectionIntent[];
}): readonly TeamMembership[] {
  const byTeam = new Map<string, TeamMembership>();
  for (const team of input.account) byTeam.set(team.teamDeploymentId, team);
  for (const link of input.links)
    if (link.state !== "leaving" && !byTeam.has(link.teamId))
      byTeam.set(link.teamId, {
        teamDeploymentId: link.teamId,
        origin: link.origin,
        name: link.teamName,
      });
  for (const intent of input.intents)
    if (intent.teamDeploymentId && !byTeam.has(intent.teamDeploymentId))
      byTeam.set(intent.teamDeploymentId, {
        teamDeploymentId: intent.teamDeploymentId,
        origin: intent.teamOrigin,
        name: new URL(intent.teamOrigin).hostname.split(".")[0] ?? intent.teamOrigin,
      });
  return [...byTeam.values()];
}
