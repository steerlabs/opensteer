import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TeamTaskOrigin } from "@opensteer/core";
import type { PersonalTeamLink, TeamBootstrapSchema } from "@opensteer/protocol";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { PersonalTeamLinks, type HostClient } from "@opensteer/client/host";
import {
  TeamSessionClient,
  TeamTransportRegistry,
  type TeamCacheScope,
  type TeamSessionSnapshot,
  type TeamSidebar,
} from "@opensteer/client/team";
import type { z } from "zod";
import type { TaskSourceView } from "../components/home/home-models.js";
import { channelKind } from "./team-view-models.js";
import { teamTile } from "./team-people.js";
import { browserTeamSession, desktopTeamSession } from "./team-transports.js";

/** One team as this surface knows it. */
export interface TeamAttachment {
  readonly teamId: string;
  readonly name: string;
  /** The team's own web address, where its pages and invite links live. */
  readonly origin: string;
  /** Its live session; null where this surface only links to it (the personal web app). */
  readonly client: TeamSessionClient | null;
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
    };

interface TeamsValue {
  readonly surface: TeamSurface["kind"] | null;
  readonly teams: readonly TeamAttachment[];
  /** The personal Host's team commands; null on a team's own web app. */
  readonly links: PersonalTeamLinks | null;
  readonly reload: () => Promise<void>;
  /** Leaves a team: cuts the link, ends the session and forgets what this device kept. */
  readonly leave: (teamId: string) => Promise<void>;
  /** A notification was opened: the channel it names. */
  readonly opened: { readonly teamId: string; readonly channelId: string } | null;
  readonly consumeOpened: () => void;
}

const TeamsContext = createContext<TeamsValue>({
  surface: null,
  teams: [],
  links: null,
  reload: async () => undefined,
  leave: async () => undefined,
  opened: null,
  consumeOpened: () => undefined,
});

export function useTeams(): TeamsValue {
  return useContext(TeamsContext);
}

export function useTeamAttachment(teamId: string | undefined): TeamAttachment | null {
  const { teams } = useTeams();
  return teams.find((team) => team.teamId === teamId) ?? null;
}

const activeLink = new Set<PersonalTeamLink["state"]>(["active", "unreachable", "needs_update"]);

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
  children,
  surface,
}: {
  readonly children: ReactNode;
  readonly surface: TeamSurface;
}) {
  const hostClient =
    surface.kind === "personal-web" || surface.kind === "desktop" ? surface.hostClient : null;
  const bridge = surface.kind === "desktop" ? surface.bridge : null;
  const links = useMemo(
    () => (hostClient ? new PersonalTeamLinks(hostClient.rpc) : null),
    [hostClient],
  );
  const [linked, setLinked] = useState<readonly PersonalTeamLink[]>([]);
  const [clients, setClients] = useState<ReadonlyMap<string, TeamSessionClient>>(new Map());
  const [opened, setOpened] = useState<TeamsValue["opened"]>(null);
  const origins = useMemo(
    () => new Map<string, PersonalTeamLink>(linked.map((link) => [link.teamId, link])),
    [linked],
  );
  const registry = useMemo(
    () =>
      bridge
        ? new TeamTransportRegistry("desktop", (scope: TeamCacheScope) => {
            const link = origins.get(scope.teamDeploymentId);
            if (!link) throw new Error("This team is not linked.");
            return desktopTeamSession({
              bridge,
              origin: link.origin,
              scope,
              notify: (entry) =>
                notifyTeam(link.teamName, entry, (channelId) =>
                  setOpened({ teamId: link.teamId, channelId }),
                ),
            });
          })
        : null,
    [bridge, origins],
  );
  useEffect(() => () => registry?.dispose(), [registry]);
  // A team's own web app and the mock build hold their sessions directly.
  const heldTeam = surface.kind === "team-web" ? surface.attachment : null;
  const heldTeams = surface.kind === "preview" ? surface.teams : null;
  useEffect(() => {
    for (const team of heldTeam ? [heldTeam] : (heldTeams ?? []))
      void team.client?.load().catch(() => undefined);
  }, [heldTeam, heldTeams]);

  const reload = useCallback(async () => {
    if (!links) return;
    setLinked(await links.list());
  }, [links]);
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  // Desktop keeps a sidebar socket to every linked team the person is still in.
  useEffect(() => {
    if (!registry) return;
    let live = true;
    const next = new Map<string, TeamSessionClient>();
    void Promise.all(
      linked
        .filter((link) => activeLink.has(link.state) && link.ownerUserId !== null)
        .map(async (link) => {
          try {
            next.set(
              link.teamId,
              await registry.join({ teamDeploymentId: link.teamId, userId: link.ownerUserId! }),
            );
          } catch {
            // Not signed in to that team on this computer yet: it shows as a link.
          }
        }),
    ).then(() => {
      if (live) setClients(next);
    });
    return () => {
      live = false;
    };
  }, [linked, registry]);

  const leave = useCallback(
    async (teamId: string) => {
      const link = linked.find((row) => row.teamId === teamId);
      await links?.leave(teamId);
      if (registry && link?.ownerUserId)
        await registry.remove({ teamDeploymentId: teamId, userId: link.ownerUserId });
      await reload();
    },
    [linked, links, registry, reload],
  );

  const value = useMemo<TeamsValue>(() => {
    const teams: readonly TeamAttachment[] =
      surface.kind === "team-web"
        ? [surface.attachment]
        : surface.kind === "preview"
          ? surface.teams
          : linked
              .filter((link) => link.state !== "leaving")
              .map((link) => ({
                teamId: link.teamId,
                name: link.teamName,
                origin: link.origin,
                client: clients.get(link.teamId) ?? null,
                link,
              }));
    return {
      surface: surface.kind,
      teams,
      links,
      reload,
      leave,
      opened,
      consumeOpened: () => setOpened(null),
    };
  }, [clients, leave, linked, links, opened, reload, surface]);
  return <TeamsContext value={value}>{children}</TeamsContext>;
}

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

/** A team session's snapshot, or null without a session. */
export function useTeamSession(client: TeamSessionClient | null): TeamSessionSnapshot | null {
  return useSyncExternalStore(
    client?.subscribe ?? noSubscribe,
    client?.getSnapshot ?? nothing,
    client?.getSnapshot ?? nothing,
  );
}
