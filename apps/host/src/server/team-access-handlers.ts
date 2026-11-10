import { OpensteerError } from "@opensteer/core";
import type { HostApiHandlers, HostApiServerContext, TeamCommand } from "@opensteer/protocol";

export function refuseTeamUnavailable(context: HostApiServerContext, anonymous = false): never {
  if (!anonymous && !context.session) {
    throw new OpensteerError({
      code: "forbidden",
      reason: "human-session-required",
      message: "Team administration requires a human session.",
    });
  }
  throw new OpensteerError({
    code: "forbidden",
    reason: "team-unavailable",
    message: "Team administration is unavailable on this Deployment.",
  });
}

async function refuseAuthenticated(_input: unknown, context: HostApiServerContext): Promise<never> {
  return refuseTeamUnavailable(context);
}

async function refuseAnonymous(_input: unknown, context: HostApiServerContext): Promise<never> {
  return refuseTeamUnavailable(context, true);
}

export function createTeamAccessHandlers() {
  return {
    "team.summary.get": refuseAuthenticated,
    "team.people.list": refuseAuthenticated,
    "team.member.get": refuseAuthenticated,
    "team.directory.search": refuseAuthenticated,
    "team.groups.list": refuseAuthenticated,
    "team.group.get": refuseAuthenticated,
    "team.project.access.get": refuseAuthenticated,
    "team.access.explain": refuseAuthenticated,
    "team.access.preview": refuseAuthenticated,
    "team.member.preview": refuseAuthenticated,
    "team.audit.list": refuseAuthenticated,
    "team.project.settings.get": refuseAuthenticated,
    "team.project.runtimeChoices": refuseAuthenticated,
    "team.invitation.preview": refuseAnonymous,
    "team.invitation.exchange": refuseAnonymous,
    "team.invitation.accept": refuseAuthenticated,
  } satisfies Pick<HostApiHandlers, `team.${string}` & keyof HostApiHandlers>;
}

export function handleTeamCommand(_command: TeamCommand, context: HostApiServerContext): never {
  return refuseTeamUnavailable(context);
}
