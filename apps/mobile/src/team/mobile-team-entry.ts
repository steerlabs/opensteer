import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import type { DeploymentConnectionInput, PrivateFilesystem } from "@opensteer/client/connections";
import type { HostClient } from "@opensteer/client/host";
import {
  createTeamCoordinator,
  HttpAccountTeamsClient,
  MockTeamWorld,
  type AccountTeamsClient,
  type MockTeamHost,
} from "@opensteer/client/team";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import { StackActions } from "@react-navigation/native";
import type { MobileClient, MobileClientState } from "../client/mobile-client.js";
import { mockTeamConnection } from "../client/mock-mode.js";
import { navigationRef } from "../navigation-ref.js";
import type { MobileTeams } from "./mobile-teams.js";
import type { TeamEntry } from "./team-context.js";
import {
  fileTeamIntentStore,
  mobilePersonalTeamLinks,
  mobileTeamSessions,
} from "./team-coordinator-ports.js";

/** A build without an Account service creates no hosted teams; joining older teams still works. */
const noAccountTeams: AccountTeamsClient = {
  hostedTeamAvailability: () => Promise.reject(noAccount()),
  createHostedTeam: () => Promise.reject(noAccount()),
  listHostedTeams: async () => [],
  hostedTeam: async () => null,
  retryHostedTeam: () => Promise.reject(noAccount()),
  deleteHostedTeam: () => Promise.reject(noAccount()),
};

function noAccount(): Error {
  return new Error("This build has no Opensteer Account, so it can't create teams.");
}

/**
 * The phone's one team coordinator. Mock mode runs the whole hosted-teams world in memory:
 * teams it creates or joins are added to the mock catalog and to the drawer of the computer
 * being shown, beside the seeded ones.
 */
export function createMobileTeamEntry(options: {
  readonly client: MobileClient;
  readonly teams: MobileTeams;
  readonly files: PrivateFilesystem;
  readonly directory: string;
  readonly accountOrigin: string | null;
  /** Mock mode: the in-memory team Hosts the mock transport serves. */
  readonly mockHosts: Map<string, MockTeamHost> | null;
}): TeamEntry & { readonly world: MockTeamWorld | null } {
  const { client, teams } = options;
  const mockHosts = options.mockHosts;
  // The seeded mock teams are part of the world, so connecting an agent reaches them too.
  const world = mockHosts === null ? null : new MockTeamWorld({ seeded: () => mockHosts.values() });
  let settled: Promise<void> = Promise.resolve();
  if (world !== null && options.mockHosts !== null)
    settled = syncMockWorld(world, teams, client, options.mockHosts, (next) => {
      settled = next;
    });
  const account: AccountTeamsClient =
    world?.account ??
    (options.accountOrigin === null
      ? noAccountTeams
      : new HttpAccountTeamsClient({
          accountOrigin: options.accountOrigin,
          authorization: {
            accountAuthorizationLease: () => client.oauth.accountAuthorizationLease(),
          },
          fetch: (input, init) => globalThis.fetch(input as RequestInfo, init),
        }));
  const personal = (deploymentId: string): HostClient | null => {
    const { selection } = client.getSnapshot();
    return selection.deploymentId === deploymentId && selection.row?.status === "connected"
      ? selection.hostClient
      : null;
  };
  const coordinator = createTeamCoordinator({
    account,
    sessions:
      world?.sessions ??
      mobileTeamSessions({
        teams,
        fetch: (input, init) => globalThis.fetch(input as RequestInfo, init),
      }),
    personal: world?.personal ?? mobilePersonalTeamLinks(personal),
    intents:
      world?.intents ??
      fileTeamIntentStore(options.files, `${options.directory}/team-intents.json`),
    accountSubject: () => {
      if (world !== null) return world.accountSubject();
      const subject = client.getSnapshot().account.account.identity?.subject;
      return ControlPlaneAccountIdSchema.safeParse(subject).data ?? null;
    },
    open: (teamDeploymentId) =>
      void settled
        .then(() => openTeamGeneral(client, teams, teamDeploymentId))
        .catch(() => undefined),
  });
  return { coordinator, account, world };
}

/** The team's #general, over whatever sheet led there; the team joins the drawer first. */
export async function openTeamGeneral(
  client: MobileClient,
  teams: MobileTeams,
  teamDeploymentId: DeploymentId,
): Promise<void> {
  const entry = await whenOnPhone(client, teamDeploymentId);
  if (teams.team(teamDeploymentId) === null)
    await teams.adopt({
      teamId: teamDeploymentId,
      origin: entry.connection.authority.document.canonicalOrigin,
      teamName: entry.connection.name,
    });
  const session = await teams.session(teamDeploymentId);
  if (session.getSnapshot().bootstrap === null) await session.load(false);
  const snapshot = session.getSnapshot();
  const channels = snapshot.sidebar?.channels ?? [];
  const channelId =
    snapshot.bootstrap?.generalChannelId ??
    (
      channels.find((row) => row.channel.name === "general") ??
      channels.find((row) => row.channel.kind === "public") ??
      channels[0]
    )?.channel.id;
  if (!navigationRef.isReady()) return;
  navigationRef.dispatch(StackActions.popToTop());
  if (channelId === undefined) navigationRef.navigate("TeamHome", { teamId: teamDeploymentId });
  else navigationRef.navigate("TeamChannel", { teamId: teamDeploymentId, channelId });
}

/**
 * The team's catalog entry once the phone has published it: a catalog write reaches the
 * client's snapshot a moment after it lands.
 */
function whenOnPhone(
  client: MobileClient,
  teamDeploymentId: string,
): Promise<MobileClientState["teams"][number]> {
  const find = () =>
    client
      .getSnapshot()
      .teams.find(
        ({ connection }) => connection.authority.document.deploymentId === teamDeploymentId,
      );
  const held = find();
  if (held !== undefined) return Promise.resolve(held);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("The team isn't on this phone yet. Open it from the menu."));
    }, 10_000);
    const stop = client.subscribe(() => {
      const entry = find();
      if (entry === undefined) return;
      clearTimeout(timer);
      stop();
      resolve(entry);
    });
  });
}

/** Mirrors the mock world's teams into the mock catalog and the drawer, one change at a time. */
function syncMockWorld(
  world: MockTeamWorld,
  teams: MobileTeams,
  client: MobileClient,
  hosts: Map<string, MockTeamHost>,
  track: (settled: Promise<void>) => void,
): Promise<void> {
  const held = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  const sync = async (): Promise<void> => {
    const joined = world.joined();
    for (const host of joined) {
      if (held.has(host.teamId)) continue;
      held.add(host.teamId);
      hosts.set(host.teamId, host);
      const connection: DeploymentConnectionInput = mockTeamConnection({
        deploymentId: host.teamId,
        name: host.bootstrap.teamName,
        origin: host.origin,
      });
      await client.catalog.upsert(connection);
      await teams.adopt({
        teamId: DeploymentIdSchema.parse(host.teamId),
        origin: host.origin,
        teamName: host.bootstrap.teamName,
      });
    }
    for (const teamId of held) {
      if (joined.some((host) => host.teamId === teamId)) continue;
      held.delete(teamId);
      hosts.delete(teamId);
      await teams.forget(teamId);
    }
  };
  world.subscribe(() => {
    tail = tail.then(sync, sync).catch(() => undefined);
    track(tail);
  });
  return tail;
}
