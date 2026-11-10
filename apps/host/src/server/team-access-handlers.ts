import { OpensteerError } from "@opensteer/core";
import {
  hostApi,
  rpcSuccess,
  type HostApiHandlers,
  type HostApiServerContext,
  type TeamCommand,
  type teamReadSchemas,
} from "@opensteer/protocol";
import type { TeamAdministrationService } from "../team/team-administration-service.js";

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

export function createTeamAccessHandlers(service?: TeamAdministrationService) {
  if (service) {
    const read = (
      name: keyof typeof teamReadSchemas,
      input: unknown,
      context: HostApiServerContext,
    ) => service.read(name, input, context);
    return {
      "team.summary.get": async (input, context) =>
        rpcSuccess(
          hostApi["team.summary.get"].success.parse(await read("team.summary.get", input, context)),
        ),
      "team.people.list": async (input, context) =>
        rpcSuccess(
          hostApi["team.people.list"].success.parse(await read("team.people.list", input, context)),
        ),
      "team.member.get": async (input, context) =>
        rpcSuccess(
          hostApi["team.member.get"].success.parse(await read("team.member.get", input, context)),
        ),
      "team.directory.search": async (input, context) =>
        rpcSuccess(
          hostApi["team.directory.search"].success.parse(
            await read("team.directory.search", input, context),
          ),
        ),
      "team.groups.list": async (input, context) =>
        rpcSuccess(
          hostApi["team.groups.list"].success.parse(await read("team.groups.list", input, context)),
        ),
      "team.group.get": async (input, context) =>
        rpcSuccess(
          hostApi["team.group.get"].success.parse(await read("team.group.get", input, context)),
        ),
      "team.project.access.get": async (input, context) =>
        rpcSuccess(
          hostApi["team.project.access.get"].success.parse(
            await read("team.project.access.get", input, context),
          ),
        ),
      "team.access.explain": async (input, context) =>
        rpcSuccess(
          hostApi["team.access.explain"].success.parse(
            await read("team.access.explain", input, context),
          ),
        ),
      "team.access.preview": async (input, context) =>
        rpcSuccess(
          hostApi["team.access.preview"].success.parse(
            await read("team.access.preview", input, context),
          ),
        ),
      "team.member.preview": async (input, context) =>
        rpcSuccess(
          hostApi["team.member.preview"].success.parse(
            await read("team.member.preview", input, context),
          ),
        ),
      "team.audit.list": async (input, context) =>
        rpcSuccess(
          hostApi["team.audit.list"].success.parse(await read("team.audit.list", input, context)),
        ),
      "team.project.settings.get": async (input, context) =>
        rpcSuccess(
          hostApi["team.project.settings.get"].success.parse(
            await read("team.project.settings.get", input, context),
          ),
        ),
      "team.project.runtimeChoices": async (input, context) =>
        rpcSuccess(
          hostApi["team.project.runtimeChoices"].success.parse(
            await read("team.project.runtimeChoices", input, context),
          ),
        ),
      "team.invitation.preview": async (input, context) =>
        rpcSuccess(
          hostApi["team.invitation.preview"].success.parse(
            await read("team.invitation.preview", input, context),
          ),
        ),
      "team.invitation.exchange": async (input, context) =>
        rpcSuccess(
          hostApi["team.invitation.exchange"].success.parse(
            await read("team.invitation.exchange", input, context),
          ),
        ),
      "team.invitation.accept": async (input, context) =>
        rpcSuccess(
          hostApi["team.invitation.accept"].success.parse(
            await read("team.invitation.accept", input, context),
          ),
        ),
    } satisfies Pick<HostApiHandlers, `team.${string}` & keyof HostApiHandlers>;
  }
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

export async function handleTeamCommand(
  command: TeamCommand,
  context: HostApiServerContext,
  service?: TeamAdministrationService,
) {
  if (!context.session) refuseTeamUnavailable(context);
  if (!service) return refuseTeamUnavailable(context);
  return rpcSuccess(await service.command(command, context));
}
