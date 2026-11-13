import type { ControlPlaneAccountId } from "@opensteer/control-plane-protocol";
import {
  HostedTeamAvailabilityResponseSchema,
  HostedTeamOwnerSchema,
  HostedTeamResponseSchema,
  HostedTeamViewSchema,
} from "@opensteer/control-plane-protocol/hosted-teams";
import { TeamEntryRefusedError, TeamIdentityGrantUnsupportedError } from "@opensteer/client/auth";
import { AccountRequestError } from "@opensteer/client/connections";
import {
  createHttpHostApiClient,
  PersonalTeamLinks,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import {
  createTeamCoordinator,
  revokeOwnAgentLinks,
  TeamConnectionIntentSchema,
  type AccountTeamsClient,
  type MockTeamWorld,
  type PersonalTeamLinksPort,
  type TeamConnectionIntent,
  type TeamConnectionIntentStore,
  type TeamCoordinator,
  type TeamSessionPort,
  type VerifiedTeam,
} from "@opensteer/client/team";
import { DeploymentIdSchema, teamPageUrl, type DeploymentId } from "@opensteer/core";
import {
  TeamEntryRefusalReasonSchema,
  TeamInvitePreviewResponseSchema,
  type HostApiClient,
} from "@opensteer/protocol";
import {
  DesktopTeamEnteredSchema,
  DesktopVerifiedTeamSchema,
  type DesktopAccountTeamsCall,
  type DesktopTeamSessionsCall,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { z } from "zod";
import { createDesktopHostFetch } from "../desktop/desktop-host-transport.js";

/** Account's hosted-team calls through the desktop bridge; main holds the Account session. */
export function desktopAccountTeams(
  bridge: Required<Pick<OpensteerDesktopBridge, "accountTeams">>,
): AccountTeamsClient {
  const call = async <T>(input: DesktopAccountTeamsCall, schema: z.ZodType<T>): Promise<T> => {
    const result = await bridge.accountTeams(input);
    if (!result.ok)
      throw new AccountRequestError({
        code: null,
        reason: result.error.reason,
        status: result.error.status,
        message: result.error.message,
      });
    return schema.parse(result.data);
  };
  return {
    hostedTeamAvailability: (slug) =>
      call({ call: "availability", slug }, HostedTeamAvailabilityResponseSchema),
    createHostedTeam: (request) => call({ call: "create", request }, HostedTeamResponseSchema),
    listHostedTeams: () => call({ call: "list" }, z.array(HostedTeamViewSchema).max(100)),
    hostedTeam: (id) => call({ call: "get", id }, HostedTeamResponseSchema.nullable()),
    retryHostedTeam: (id) => call({ call: "retry", id }, HostedTeamResponseSchema),
    deleteHostedTeam: (id) => call({ call: "delete", id }, HostedTeamResponseSchema.nullable()),
    hostedTeamOwners: (id) => call({ call: "owners", id }, z.array(HostedTeamOwnerSchema).max(100)),
    transferHostedTeam: (id, to) => call({ call: "transfer", id, to }, HostedTeamResponseSchema),
  };
}

/**
 * Entering teams on the desktop: main verifies, previews, mints the Account grant and exchanges
 * it, keeping the credential; link codes and leaving use the team's own API over the bridge
 * pinned to its Host.
 */
export function desktopTeamSessions(
  bridge: OpensteerDesktopBridge & Required<Pick<OpensteerDesktopBridge, "teamSessions">>,
  /** Where a team this computer already shows lives, for one not verified since launch. */
  originOf: (teamDeploymentId: DeploymentId) => string | null = () => null,
): TeamSessionPort {
  const call = async <T>(input: DesktopTeamSessionsCall, schema: z.ZodType<T>): Promise<T> => {
    const result = await bridge.teamSessions(input);
    if (result.ok) return schema.parse(result.data);
    const reason = TeamEntryRefusalReasonSchema.safeParse(result.error.reason);
    if (reason.success) throw new TeamEntryRefusedError(reason.data, result.error.message);
    if (result.error.reason === TeamIdentityGrantUnsupportedError.reason)
      throw new TeamIdentityGrantUnsupportedError();
    throw new Error(result.error.message);
  };
  const origins = new Map<DeploymentId, string>();
  const rpc = (teamDeploymentId: DeploymentId): HostApiClient => {
    const origin = origins.get(teamDeploymentId) ?? originOf(teamDeploymentId);
    if (!origin) throw new Error("Open the team on this computer first.");
    return createHttpHostApiClient({
      baseUrl: new URL(origin),
      bufferedResponses: true,
      fetch: createDesktopHostFetch(bridge, origin, teamDeploymentId),
      kind: "team",
      onAuthenticationRequired: () => undefined,
    });
  };
  return {
    verify: async (origin) => {
      const team: VerifiedTeam = await call({ call: "verify", origin }, DesktopVerifiedTeamSchema);
      origins.set(team.authority.deploymentId, team.authority.canonicalOrigin);
      return team;
    },
    exchange: async (team, invite) => ({
      ...(await call(
        { call: "enter", origin: team.authority.canonicalOrigin, invite },
        DesktopTeamEnteredSchema,
      )),
      team,
    }),
    signIn: async (team, invite) => {
      await call({ call: "sign-in", origin: team.authority.canonicalOrigin, invite }, z.null());
      const { member } = unwrapRpcResult(
        await rpc(team.authority.deploymentId)["team.bootstrap.get"]({}),
      );
      return { admitted: invite !== null, member, team };
    },
    joinInBrowser: async (team, invite) => {
      await bridge.openExternalUrl({
        url: teamPageUrl({
          origin: team.authority.canonicalOrigin,
          target: { kind: "invite", ...invite },
        }),
      });
    },
    restore: async ({ origin, teamDeploymentId }) => {
      await call({ call: "restore", origin, deploymentId: teamDeploymentId }, z.null());
      origins.set(teamDeploymentId, origin);
    },
    previewInvite: (team, invite) =>
      call(
        { call: "preview-invite", origin: team.authority.canonicalOrigin, invite },
        TeamInvitePreviewResponseSchema,
      ),
    revokeAgentLinks: (teamDeploymentId) => revokeOwnAgentLinks(rpc(teamDeploymentId)),
    createLinkCode: async (teamDeploymentId) => {
      const result = unwrapRpcResult(
        await rpc(teamDeploymentId)["commands.dispatch"]({ type: "team.link.code.create" }),
      );
      if (result.type !== "team.link.code.create") throw new Error("The team made no code.");
      return result.offer;
    },
    leave: async (teamDeploymentId) => {
      const client = rpc(teamDeploymentId);
      const me = unwrapRpcResult(await client["team.bootstrap.get"]({})).member.userId;
      unwrapRpcResult(
        await client["commands.dispatch"]({ type: "team.member.remove", userId: me }),
      );
    },
    forget: async (deploymentId) => {
      await call({ call: "forget", deploymentId }, z.null());
    },
  };
}

/** The person's own Opensteer: its team links, and offline when it can't be reached right now. */
export function personalTeamLinksPort(hostClient: HostClient): PersonalTeamLinksPort {
  const links = new PersonalTeamLinks(hostClient.rpc);
  return {
    join: async (_personal, offer) => {
      if (hostClient.getSnapshot().connection !== "connected") return { kind: "offline" };
      try {
        return { kind: "joined", link: await links.join(offer) };
      } catch (error) {
        if (error instanceof TypeError) return { kind: "offline" };
        throw error;
      }
    },
    leave: (_personal, teamDeploymentId) => links.leave(teamDeploymentId),
  };
}

const intentsKey = "opensteer:team-intents:v1";

/** Connection intents in this browser profile; they name teams, never a credential. */
export const localIntentStore: TeamConnectionIntentStore = {
  async load() {
    try {
      const parsed = z
        .array(TeamConnectionIntentSchema)
        .max(100)
        .safeParse(JSON.parse(localStorage.getItem(intentsKey) ?? "[]"));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  },
  async save(intent) {
    const held = (await this.load()).filter(
      (row) => row.accountSubject !== intent.accountSubject || row.teamOrigin !== intent.teamOrigin,
    );
    localStorage.setItem(intentsKey, JSON.stringify([...held, intent]));
  },
  async remove(key) {
    const held = (await this.load()).filter(
      (row: TeamConnectionIntent) =>
        row.accountSubject !== key.accountSubject || row.teamOrigin !== key.teamOrigin,
    );
    localStorage.setItem(intentsKey, JSON.stringify(held));
  },
};

export interface WebTeamCoordination {
  readonly coordinator: TeamCoordinator;
  readonly account: AccountTeamsClient;
  readonly personalDeploymentId: () => DeploymentId | null;
}

function personalOf(hostClient: HostClient): () => DeploymentId | null {
  return () => {
    const parsed = DeploymentIdSchema.safeParse(hostClient.getSnapshot().deploymentId);
    return parsed.success ? parsed.data : null;
  };
}

/** The desktop's coordinator, once main can both reach Account and enter teams natively. */
export function desktopTeamCoordination(input: {
  readonly bridge: OpensteerDesktopBridge;
  readonly hostClient: HostClient;
  readonly accountSubject: () => ControlPlaneAccountId | null;
  readonly open: (teamDeploymentId: DeploymentId) => void;
  readonly originOf: (teamDeploymentId: DeploymentId) => string | null;
}): WebTeamCoordination | null {
  const { bridge } = input;
  if (!bridge.accountTeams || !bridge.teamSessions) return null;
  const account = desktopAccountTeams({ accountTeams: bridge.accountTeams.bind(bridge) });
  return {
    account,
    personalDeploymentId: personalOf(input.hostClient),
    coordinator: createTeamCoordinator({
      account,
      sessions: desktopTeamSessions(
        { ...bridge, teamSessions: bridge.teamSessions },
        input.originOf,
      ),
      personal: personalTeamLinksPort(input.hostClient),
      intents: localIntentStore,
      accountSubject: input.accountSubject,
      open: input.open,
    }),
  };
}

/** The mock build's coordinator over the in-memory hosted-teams world. */
export function previewTeamCoordination(input: {
  readonly world: MockTeamWorld;
  readonly hostClient: HostClient;
  readonly open: (teamDeploymentId: DeploymentId) => void;
}): WebTeamCoordination {
  return {
    account: input.world.account,
    personalDeploymentId: () =>
      personalOf(input.hostClient)() ??
      DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000cc"),
    coordinator: createTeamCoordinator({
      account: input.world.account,
      sessions: input.world.sessions,
      personal: input.world.personal,
      intents: input.world.intents,
      accountSubject: input.world.accountSubject,
      open: input.open,
    }),
  };
}
