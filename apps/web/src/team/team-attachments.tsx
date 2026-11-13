import { teamEntryRefusalOutcome } from "@opensteer/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TeamTaskOrigin } from "@opensteer/core";
import type { PersonalTeamLink, TeamBootstrapSchema } from "@opensteer/protocol";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import {
  HostClientRequestError,
  PersonalTeamLinks,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import {
  createMemoryTeamPersistence,
  listedTeams,
  TeamSessionClient,
  TeamTransportRegistry,
  type MockTeamHost,
  type MockTeamWorld,
  type TeamCacheScope,
  type TeamConnectionIntent,
  type TeamMembership,
  type TeamSessionOptions,
  type TeamSessionSnapshot,
  type TeamSidebar,
} from "@opensteer/client/team";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema } from "@opensteer/core";
import type { z } from "zod";
import type { TaskSourceView } from "../components/home/home-models.js";
import { channelKind } from "./team-view-models.js";
import { teamTile } from "./team-people.js";
import { browserTeamSession, desktopTeamSession } from "./team-transports.js";
import {
  desktopTeamSessions,
  desktopTeamCoordination,
  previewTeamCoordination,
  type WebTeamCoordination,
} from "./team-coordination.js";
import { channelPath, teamPath } from "./team-paths.js";

/** One team as this surface knows it. */
export interface TeamAttachment {
  readonly teamId: string;
  readonly name: string;
  /** The team's own web address, where its pages and invite links live. */
  readonly origin: string;
  /** Its live session; null where this surface only links to it (the personal web app). */
  readonly client: TeamSessionClient | null;
  readonly failure?: "sign-in" | "join" | "unavailable" | "pending" | undefined;
  /** The personal Host's link to it, where there is a personal Host. */
  readonly link: PersonalTeamLink | null;
}

export type TeamSurface =
  /** The personal web app: linked teams, each opened at its own address. */
  | { readonly kind: "personal-web"; readonly hostClient: HostClient }
  /** The desktop app: every linked team's sidebar, live, beside the person's own tasks. */
  | {
      readonly kind: "desktop";
      readonly hostClient: HostClient;
      readonly bridge: OpensteerDesktopBridge;
    }
  /** A team's own web app: that team only. */
  | { readonly kind: "team-web"; readonly attachment: TeamAttachment }
  /** The mock build: the personal mock Host beside live mock team sessions. */
  | {
      readonly kind: "preview";
      readonly hostClient: HostClient;
      readonly teams: readonly TeamAttachment[];
      /** Hosted teams it creates and joins, in memory. */
      readonly world?: MockTeamWorld | undefined;
    };

/** Who is signed in to Opensteer Account on this surface, where it knows. */
export interface TeamAccount {
  readonly subject: string;
  readonly email: string | null;
}

interface TeamsValue {
  readonly surface: TeamSurface["kind"] | null;
  readonly teams: readonly TeamAttachment[];
  /** The personal Host's team commands; null on a team's own web app. */
  readonly links: PersonalTeamLinks | null;
  readonly reload: () => Promise<void>;
  /** Ends membership on the team Host, then removes this viewer’s saved state. */
  readonly leave: (teamId: string) => Promise<void>;
  readonly forget: (teamId: string) => Promise<void>;
  /**
   * Signs in here to a listed team this computer holds no session for, such as one joined on
   * another device; null where teams open at their own address instead.
   */
  readonly enter: ((teamId: string) => Promise<void>) | null;
  /** Creating and joining hosted teams in this app; null where they open in the browser. */
  readonly coordination: WebTeamCoordination | null;
  readonly account: TeamAccount | null;
  /** Where the app goes when a team is entered; bound by the router. */
  readonly navigator: { current: ((path: string) => void) | null };
}

const TeamsContext = createContext<TeamsValue>({
  surface: null,
  teams: [],
  links: null,
  reload: async () => undefined,
  leave: async () => undefined,
  forget: async () => undefined,
  enter: null,
  coordination: null,
  account: null,
  navigator: { current: null },
});

export function useTeams(): TeamsValue {
  return useContext(TeamsContext);
}

export function useTeamAttachment(teamId: string | undefined): TeamAttachment | null {
  const { teams } = useTeams();
  return teams.find((team) => team.teamId === teamId) ?? null;
}

/** A desktop notification for a team message, from the team's own sidebar socket. */
function notifyTeam(
  name: string,
  entry: TeamSidebar["channels"][number],
  open: (channelId: string) => void,
): void {
  if (typeof Notification === "undefined" || Notification.permission === "denied") return;
  const show = () => {
    const notification = new Notification(name, {
      body:
        entry.mentionCount > 0
          ? `You were mentioned in ${entry.channel.kind === "dm" || entry.channel.kind === "group_dm" ? entry.channel.name : `#${entry.channel.name}`}`
          : `New messages in ${entry.channel.kind === "dm" || entry.channel.kind === "group_dm" ? entry.channel.name : `#${entry.channel.name}`}`,
      tag: `${name}:${entry.channel.id}`,
    });
    notification.onclick = () => {
      window.focus();
      open(entry.channel.id);
      notification.close();
    };
  };
  // Nothing for what is on screen.
  if (document.hasFocus() && window.location.pathname.includes(`/c/${entry.channel.id}`)) return;
  if (Notification.permission === "granted") show();
  else
    void Notification.requestPermission().then((permission) => permission === "granted" && show());
}

export function TeamsProvider({
  account = null,
  accountTeams = noTeams,
  children,
  surface,
}: {
  readonly account?: TeamAccount | null;
  /** The teams Account's catalog lists the person in, wherever they joined. */
  readonly accountTeams?: readonly TeamMembership[];
  readonly children: ReactNode;
  readonly surface: TeamSurface;
}) {
  const hostClient =
    surface.kind === "personal-web" || surface.kind === "desktop" || surface.kind === "preview"
      ? surface.hostClient
      : null;
  const bridge = surface.kind === "desktop" ? surface.bridge : null;
  const links = useMemo(
    () => (hostClient ? new PersonalTeamLinks(hostClient.rpc) : null),
    [hostClient],
  );
  const [linked, setLinked] = useState<readonly PersonalTeamLink[]>([]);
  const [failures, setFailures] = useState<
    ReadonlyMap<string, "sign-in" | "join" | "unavailable" | "pending">
  >(new Map());
  const [clients, setClients] = useState<ReadonlyMap<string, TeamSessionClient>>(new Map());
  const navigator = useRef<((path: string) => void) | null>(null);
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(new Set());
  /** Bumped by each sign-in here, so the sidebar sockets are joined again. */
  const [entered, setEntered] = useState(0);
  const world = surface.kind === "preview" ? (surface.world ?? null) : null;
  const accountSubject = account?.subject ?? null;
  // Made in the effect so React's double effects never resume a disposed coordinator.
  const [coordination, setCoordination] = useState<WebTeamCoordination | null>(null);
  useEffect(() => {
    const open = (teamId: string) => navigator.current?.(teamPath(teamId, ""));
    const made =
      world && hostClient
        ? previewTeamCoordination({ world, hostClient, open })
        : bridge && hostClient
          ? desktopTeamCoordination({
              bridge,
              hostClient,
              accountSubject: () => {
                const parsed = ControlPlaneAccountIdSchema.safeParse(accountSubject);
                return parsed.success ? parsed.data : null;
              },
              open,
              originOf: (teamId) => memberRef.current.get(teamId)?.origin ?? null,
            })
          : null;
    setCoordination(made);
    void made?.coordinator.resume().catch(() => undefined);
    return () => made?.coordinator.dispose();
  }, [world, bridge, hostClient, accountSubject]);
  const intents = useSyncExternalStore(
    coordination?.coordinator.subscribe ?? noSubscribe,
    () => coordination?.coordinator.getSnapshot().intents ?? noIntents,
    () => coordination?.coordinator.getSnapshot().intents ?? noIntents,
  );
  // By content: the catalog snapshot is rebuilt on every status change, and each new member list
  // rejoins every team's sidebar.
  const accountKey = JSON.stringify(accountTeams);
  const members = useMemo(
    () =>
      new Map(
        listedTeams({
          account: JSON.parse(accountKey) as readonly TeamMembership[],
          links: linked,
          intents,
        }).map((team) => [team.teamDeploymentId, { origin: team.origin, name: team.name }]),
      ),
    [accountKey, linked, intents],
  );
  const memberRef = useRef(members);
  memberRef.current = members;
  const registry = useMemo(
    () =>
      bridge
        ? new TeamTransportRegistry("desktop", (scope: TeamCacheScope) => {
            const team = memberRef.current.get(scope.teamDeploymentId);
            if (!team) throw new Error("This team is not on this computer.");
            return desktopTeamSession({
              bridge,
              origin: team.origin,
              scope,
              notify: (entry) =>
                notifyTeam(team.name, entry, (channelId) =>
                  navigator.current?.(channelPath(scope.teamDeploymentId, channelId)),
                ),
            });
          })
        : null,
    [bridge, accountSubject],
  );
  useEffect(() => {
    setClients(new Map());
    return () => registry?.dispose();
  }, [registry]);
  // A team's own web app and the mock build hold their sessions directly.
  const heldTeam = surface.kind === "team-web" ? surface.attachment : null;
  const heldTeams = surface.kind === "preview" ? surface.teams : null;
  useEffect(() => {
    for (const team of heldTeam ? [heldTeam] : (heldTeams ?? []))
      void team.client?.load().catch(() => undefined);
  }, [heldTeam, heldTeams]);
  const worldTeams = useWorldTeams(world);

  const reload = useCallback(async () => {
    if (!links) return;
    setLinked(await links.list());
  }, [links]);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);
  // A new agent link shows in the switch as soon as the coordinator records it.
  useEffect(() => {
    if (intents.some((intent) => intent.state === "connected"))
      void reload().catch(() => undefined);
  }, [intents, reload]);

  // Desktop keeps a sidebar socket to every team the person is in on this computer.
  useEffect(() => {
    if (!registry || !bridge) return;
    let live = true;
    setFailures(new Map([...members.keys()].map((id) => [id, "pending" as const])));
    setClients((previous) => new Map([...previous].filter(([id]) => members.has(id))));
    for (const [teamId, team] of members) {
      void (async () => {
        try {
          const userId = await readTeamUser(
            desktopTeamSession({
              bridge,
              origin: team.origin,
              scope: { teamDeploymentId: teamId, userId: "pending" },
            }),
          );
          if (!live) return;
          const client = await registry.join({ teamDeploymentId: teamId, userId });
          if (!live) return;
          setClients((previous) => new Map(previous).set(teamId, client));
          setFailures((previous) => {
            const updated = new Map(previous);
            updated.delete(teamId);
            return updated;
          });
        } catch (error) {
          if (!live) return;
          const failure =
            error instanceof HostClientRequestError &&
            teamEntryRefusalOutcome(error.reason) === "membership"
              ? "join"
              : error instanceof HostClientRequestError && error.code === "unauthorized"
                ? "sign-in"
                : "unavailable";
          setFailures((previous) => new Map(previous).set(teamId, failure));
          if (failure !== "unavailable")
            setClients((previous) => {
              const updated = new Map(previous);
              updated.delete(teamId);
              return updated;
            });
        }
      })();
    }
    return () => {
      live = false;
    };
  }, [members, linked, registry, bridge, entered]);

  const sessionOf = useCallback(
    (teamId: string) =>
      clients.get(teamId) ??
      (surface.kind === "team-web"
        ? surface.attachment.client
        : surface.kind === "preview"
          ? [...surface.teams, ...worldTeams].find((team) => team.teamId === teamId)?.client
          : null),
    [clients, surface, worldTeams],
  );

  const leave = useCallback(
    async (teamId: string) => {
      const owner = sessionOf(teamId)?.getSnapshot().bootstrap?.member.userId;
      const coordinated =
        coordination !== null &&
        (world === null || worldTeams.some((team) => team.teamId === teamId));
      if (coordinated) await coordination.coordinator.leaveTeam(DeploymentIdSchema.parse(teamId));
      else {
        const session = sessionOf(teamId);
        if (!session) throw new Error("Sign in to the team before leaving it.");
        await session.leave();
      }
      if (registry && owner) await registry.remove({ teamDeploymentId: teamId, userId: owner });
      await reload();
    },
    [linked, coordination, world, worldTeams, sessionOf, registry, reload],
  );

  const forget = useCallback(
    async (teamId: string) => {
      const owner = sessionOf(teamId)?.getSnapshot().bootstrap?.member.userId;
      await sessionOf(teamId)?.remove();
      if (registry && owner) await registry.remove({ teamDeploymentId: teamId, userId: owner });
      setForgotten((held) => new Set([...held, teamId]));
    },
    [sessionOf, linked, registry],
  );

  const enter = useMemo(
    () =>
      coordination && (bridge || world)
        ? async (teamId: string) => {
            const team = memberRef.current.get(teamId);
            if (!team) throw new Error("This team is not on this computer.");
            if (bridge?.teamSessions) {
              const sessions = desktopTeamSessions({
                ...bridge,
                teamSessions: bridge.teamSessions,
              });
              await sessions.signIn(await sessions.verify(team.origin), null);
            } else await coordination.coordinator.enterTeam(team.origin);
            setEntered((count) => count + 1);
          }
        : null,
    [bridge, world, coordination],
  );

  const value = useMemo<TeamsValue>(() => {
    const teams: readonly TeamAttachment[] =
      surface.kind === "team-web"
        ? [surface.attachment]
        : surface.kind === "preview"
          ? withAccountTeams([...surface.teams, ...worldTeams], accountKey)
          : [...members].map(([teamId, team]) => ({
              teamId,
              name: team.name,
              origin: team.origin,
              client: clients.get(teamId) ?? null,
              failure:
                failures.get(teamId) ?? (bridge && !clients.has(teamId) ? "pending" : undefined),
              link: linked.find((link) => link.teamId === teamId) ?? null,
            }));
    return {
      surface: surface.kind,
      teams: teams.filter((team) => !forgotten.has(team.teamId)),
      links,
      reload,
      leave,
      forget,
      enter,
      coordination,
      account,
      navigator,
    };
  }, [
    account,
    clients,
    failures,
    coordination,
    leave,
    forget,
    enter,
    forgotten,
    linked,
    links,
    members,
    reload,
    surface,
    worldTeams,
    accountKey,
  ]);
  return <TeamsContext value={value}>{children}</TeamsContext>;
}

/** The mock build lists teams Account names beside the ones it holds sessions for, as desktop does. */
function withAccountTeams(
  held: readonly TeamAttachment[],
  accountKey: string,
): readonly TeamAttachment[] {
  const ids = new Set(held.map((team) => team.teamId));
  const listed = (JSON.parse(accountKey) as readonly TeamMembership[])
    .filter((team) => !ids.has(team.teamDeploymentId))
    .map((team) => ({
      teamId: team.teamDeploymentId,
      name: team.name,
      origin: team.origin,
      client: null,
      link: null,
    }));
  return [...held, ...listed];
}

const noIntents: readonly TeamConnectionIntent[] = [];
const noTeams: readonly TeamMembership[] = [];

async function readTeamUser(options: TeamSessionOptions): Promise<string> {
  return unwrapRpcResult(await options.rpc["team.bootstrap.get"]({})).member.userId;
}

/** The mock world's joined teams as attachments, each with one live session. */
function useWorldTeams(world: MockTeamWorld | null): readonly TeamAttachment[] {
  const held = useRef(new WeakMap<MockTeamHost, TeamAttachment>());
  const subscribe = useCallback(
    (listener: () => void) => (world ? world.subscribe(listener) : () => undefined),
    [world],
  );
  const hosts = useSyncExternalStore(
    subscribe,
    () => world?.joined() ?? noHosts,
    () => world?.joined() ?? noHosts,
  );
  return useMemo(
    () =>
      hosts.map((host) => {
        let attachment = held.current.get(host);
        if (!attachment) {
          const client = new TeamSessionClient({
            scope: { teamDeploymentId: host.teamId, userId: host.userId },
            persistence: createMemoryTeamPersistence(),
            rpc: host.rpc,
            connect: host.connect,
            readFile: host.readFile,
            uploadFile: host.uploadFile,
          });
          void client.load().catch(() => undefined);
          attachment = {
            teamId: host.teamId,
            name: host.bootstrap.teamName,
            origin: host.origin,
            client,
            link: null,
          };
          held.current.set(host, attachment);
        }
        return attachment;
      }),
    [hosts],
  );
}
const noHosts: readonly MockTeamHost[] = [];

/** The team web app's own session, for the member signed in at this origin. */
export function createTeamWebAttachment(
  bootstrap: z.infer<typeof TeamBootstrapSchema>,
): TeamAttachment {
  return {
    teamId: bootstrap.teamId,
    name: bootstrap.teamName,
    origin: window.location.origin,
    client: new TeamSessionClient(
      browserTeamSession({
        bootstrap,
        scope: { teamDeploymentId: bootstrap.teamId, userId: bootstrap.member.userId },
      }),
    ),
    link: null,
  };
}

/** "A #support" for a task a team thread started, as far as this app knows the team. */
export function useTaskSourceView(origin: TeamTaskOrigin | null): TaskSourceView | null {
  const team = useTeamAttachment(origin?.teamId);
  const sidebar = useTeamSession(team?.client ?? null)?.sidebar ?? null;
  if (!origin) return null;
  const entry = sidebar?.channels.find((row) => row.channel.id === origin.channelId);
  return {
    team: teamTile(origin.teamId, team?.name ?? "Team"),
    channel: entry
      ? { kind: channelKind(entry.channel.kind), name: entry.channel.name }
      : { kind: "public", name: "channel" },
    available: team !== null && team.link?.state !== "revoked",
  };
}

const noSubscribe = () => () => undefined;
const nothing = () => null;

/**
 * One value read from a team session, redrawing only when it changes: a
 * sidebar reads its rows, not every message, typing line and presence dot.
 * `select` returns a value the session keeps, or a primitive.
 */
export function useTeamSessionValue<T>(
  client: TeamSessionClient | null,
  select: (snapshot: TeamSessionSnapshot | null) => T,
): T {
  const read = () => select(client?.getSnapshot() ?? null);
  return useSyncExternalStore(client?.subscribe ?? noSubscribe, read, read);
}

/** A team session's snapshot, or null without a session. */
export function useTeamSession(client: TeamSessionClient | null): TeamSessionSnapshot | null {
  return useSyncExternalStore(
    client?.subscribe ?? noSubscribe,
    client?.getSnapshot ?? nothing,
    client?.getSnapshot ?? nothing,
  );
}
