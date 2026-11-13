import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import type { TeamSessionClient, TeamSessionSnapshot } from "@opensteer/client/team";
import { Dialog } from "../components/dialog.js";
import { Icon } from "../components/icon.js";
import { SetupEntries, useTeamDialogs } from "./hosted-teams.js";
import { TeamTile } from "../components/team/team-marks.js";
import type { TeamConnection } from "../components/team/team-models.js";
import {
  SidebarSwitch,
  TeamSide,
  type SegmentBadge,
  type TeamMenuActions,
} from "../components/team/team-sidebar.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { useTeamSessionValue, useTeams, type TeamAttachment } from "./team-attachments.js";
import { useStableActions } from "../components/use-stable-actions.js";
import { teamTile } from "./team-people.js";
import { channelPath, teamPath } from "./team-paths.js";
import { sidebarView } from "./team-view-models.js";

export function teamConnection(
  team: TeamAttachment,
  snapshot:
    (Pick<TeamSessionSnapshot, "connection"> & Partial<Pick<TeamSessionSnapshot, "ended">>) | null,
): TeamConnection {
  if (snapshot?.ended === "sign-in" || snapshot?.ended === "viewer-changed") return "sign-in";
  if (team.link?.state === "revoked" || snapshot?.ended === "removed") return "removed";
  if (team.link?.state === "needs_update") return "update-app";
  if (snapshot?.connection === "connected") return "online";
  if (snapshot?.connection === "connecting") return "reconnecting";
  return "offline";
}

/** What a team's segment says. */
interface SegmentFacts {
  readonly name: string | null;
  readonly mentions: number;
  readonly invites: boolean;
}

/**
 * Each team's name, mention total and invite right, read together. Only a
 * change in those redraws the switch; a new message, typing or presence
 * does not, and the lists below never redraw for a badge.
 */
function useSegmentFacts(clients: readonly (TeamSessionClient | null)[]): readonly SegmentFacts[] {
  const cache = useRef<readonly SegmentFacts[]>([]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = clients.map((client) => client?.subscribe(listener));
      return () => {
        for (const stop of stops) stop?.();
      };
    },
    [clients],
  );
  const read = useCallback(() => {
    const next = clients.map((client): SegmentFacts => {
      const snapshot = client?.getSnapshot() ?? null;
      return {
        name: snapshot?.bootstrap?.teamName ?? null,
        mentions: snapshot?.sidebar?.totalMentionCount ?? 0,
        invites: snapshot?.bootstrap?.can.manageInvites ?? false,
      };
    });
    const held = cache.current;
    if (
      held.length === next.length &&
      held.every(
        (value, index) =>
          value.name === next[index]!.name &&
          value.mentions === next[index]!.mentions &&
          value.invites === next[index]!.invites,
      )
    )
      return held;
    cache.current = next;
    return next;
  }, [clients]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The `Tasks | Acme` switch, once this computer has joined a team. Its own
 * component, so a badge changing never redraws the task or channel lists.
 */
export function TeamSwitch({
  onNavigate,
  onSide,
  side,
  tasksBadge,
}: {
  readonly onNavigate: () => void;
  readonly onSide: (side: string) => void;
  readonly side: string;
  readonly tasksBadge: SegmentBadge;
}) {
  const { coordination, surface, teams } = useTeams();
  const { openCreate, openInvite } = useTeamDialogs();
  const clients = useStableClients(teams);
  const facts = useSegmentFacts(clients);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [leaving, setLeaving] = useState<TeamAttachment | null>(null);
  const go = (path: string) => {
    onNavigate();
    void navigate(path);
  };
  if (teams.length === 0)
    return surface === "team-web" ? null : (
      <>
        <button
          aria-current={pathname === "/teams" ? "page" : undefined}
          className="teams-nav"
          onClick={() => go("/teams")}
          type="button"
        >
          <Icon name="users" />
          Teams
        </button>
        <SetupEntries />
      </>
    );
  const menu = (team: TeamAttachment, invites: boolean): TeamMenuActions => ({
    onKnowledge: team.client ? () => go(teamPath(team.teamId, "knowledge")) : undefined,
    onInvite:
      invites && team.client
        ? () => {
            onNavigate();
            openInvite(team.teamId);
          }
        : undefined,
    onSettings: team.client ? () => go(`/settings/teams/${team.teamId}/profile`) : undefined,
    onLeave: team.client ? () => setLeaving(team) : undefined,
    onCreateTeam: coordination
      ? () => {
          onNavigate();
          openCreate();
        }
      : () => go("/teams"),
    onJoinTeam: () => go("/teams"),
  });
  return (
    <>
      <SidebarSwitch
        active={side}
        onSelect={onSide}
        segments={[
          { id: "tasks", label: "Tasks", badge: tasksBadge },
          ...teams.map((team, index) => {
            const fact = facts[index];
            const name = fact?.name ?? team.name;
            return {
              id: team.teamId,
              label: name,
              tile: teamTile(team.teamId, name),
              badge: { kind: "mentions" as const, count: fact?.mentions ?? 0 },
              menu: menu(team, fact?.invites ?? false),
            };
          }),
        ]}
      />
      <SetupEntries />
      {leaving ? (
        <LeaveTeamDialog
          onClose={() => setLeaving(null)}
          onLeft={() => {
            onSide("tasks");
            go("/");
          }}
          team={leaving}
        />
      ) : null}
    </>
  );
}

function useStableClients(teams: readonly TeamAttachment[]): readonly (TeamSessionClient | null)[] {
  const held = useRef<readonly (TeamSessionClient | null)[]>([]);
  const next = teams.map((team) => team.client);
  if (held.current.length !== next.length || held.current.some((client, i) => client !== next[i]))
    held.current = next;
  return held.current;
}

export function LeaveTeamDialog({
  onClose,
  onLeft,
  team,
}: {
  readonly onClose: () => void;
  readonly onLeft: () => void;
  readonly team: TeamAttachment;
}) {
  const { leave } = useTeams();
  const toast = useToast();
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--danger"
            onClick={() => {
              onClose();
              void leave(team.teamId)
                .then(onLeft)
                .catch((error: unknown) => toast.error(actionErrorMessage(error)));
            }}
            type="button"
          >
            Leave {team.name}
          </button>
        </>
      }
      labelledBy="leave-team-title"
      onClose={onClose}
      title={`Leave ${team.name}?`}
    >
      You’ll lose access to its channels. Tasks your agent did for {team.name} stay on your
      computer.
    </Dialog>
  );
}

/** One team's side of the sidebar: its channels and direct messages. */
export function TeamSideFor({
  onNavigate,
  teamId,
}: {
  readonly onNavigate: () => void;
  readonly teamId: string;
}) {
  const { teams, forget, enter, surface } = useTeams();
  const team = teams.find((candidate) => candidate.teamId === teamId) ?? null;
  const [entering, setEntering] = useState(false);
  const client = team?.client ?? null;
  // Only what the side draws: a message, typing or presence elsewhere never redraws it.
  const sidebar = useTeamSessionValue(client, selectSidebar);
  const teamName = useTeamSessionValue(client, selectTeamName);
  const canCreate = useTeamSessionValue(client, selectCanCreate);
  const canInvite = useTeamSessionValue(client, selectCanInvite);
  const { openInvite } = useTeamDialogs();
  const connection = useTeamSessionValue(client, selectConnection);
  const ended = useTeamSessionValue(client, (snapshot) => snapshot?.ended ?? null);
  const refusal = useTeamSessionValue(client, (snapshot) => snapshot?.refusalReason ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();
  const go = (path: string) => {
    onNavigate();
    void navigate(path);
  };
  const actions = useStableActions({
    onOpenChannel: (channelId: string) => go(channelPath(teamId, channelId)),
    onBrowseChannels: () => go(teamPath(teamId, "browse")),
    onNewChannel: canCreate ? () => go(teamPath(teamId, "browse?new=1")) : undefined,
    onNewMessage: () => go(teamPath(teamId, "people")),
    onInvite: canInvite
      ? () => {
          onNavigate();
          openInvite(teamId);
        }
      : undefined,
    onRemoveFromSidebar: () =>
      void forget(teamId).catch((error: unknown) => toast.error(actionErrorMessage(error))),
    onRetry: () =>
      ended
        ? surface === "team-web"
          ? window.location.reload()
          : enter && (ended === "sign-in" || ended === "viewer-changed")
            ? void enter(teamId).catch((error: unknown) => toast.error(actionErrorMessage(error)))
            : go("/teams")
        : client?.connect(),
  });
  const hrefFor = useCallback((channelId: string) => channelPath(teamId, channelId), [teamId]);
  if (!team) return null;
  if (!team.client || refusal === "not-a-member")
    return (
      <div className="team-left">
        <TeamTile tile={teamTile(team.teamId, team.name)} />
        <div className="team-left__text">
          <p className="team-left__title">{team.name}</p>
          <p className="team-left__detail">
            {team.failure === "pending"
              ? "Opening team…"
              : team.failure === "unavailable"
                ? "Team temporarily unavailable. Try again."
                : team.failure === "join" || refusal === "not-a-member"
                  ? "Ask a team member for an invite."
                  : enter
                    ? "Not signed in on this computer"
                    : `Opens at ${new URL(team.origin).host}`}
          </p>
        </div>
        {enter ? (
          <button
            className="btn btn--small"
            disabled={entering || team.failure === "pending"}
            onClick={() => {
              setEntering(true);
              void enter(team.teamId)
                .catch((error: unknown) => toast.error(actionErrorMessage(error)))
                .finally(() => setEntering(false));
            }}
            type="button"
          >
            {entering || team.failure === "pending"
              ? "Opening…"
              : team.failure === "unavailable"
                ? "Retry"
                : team.failure === "join" || refusal === "not-a-member"
                  ? "Join"
                  : "Sign in"}
          </button>
        ) : (
          <a className="btn btn--small" href={team.origin} rel="noreferrer" target="_blank">
            Open
          </a>
        )}
      </div>
    );
  const open = pathname.startsWith(`/teams/${team.teamId}/c/`)
    ? (pathname.split("/")[4] ?? null)
    : null;
  return (
    <TeamSide
      actions={actions}
      hasMore={Boolean(sidebar?.nextCursor)}
      loadingMore={loadingMore}
      onLoadMore={() => {
        if (!client || loadingMore) return;
        setLoadingMore(true);
        void client
          .loadMoreSidebar()
          .catch((error: unknown) => toast.error(actionErrorMessage(error)))
          .finally(() => setLoadingMore(false));
      }}
      hrefFor={hrefFor}
      openChannelId={open}
      team={sidebarView({
        teamId: team.teamId,
        tile: teamTile(team.teamId, teamName ?? team.name),
        connection: teamConnection(team, { connection, ended }),
        sidebar,
      })}
    />
  );
}

const selectSidebar = (snapshot: TeamSessionSnapshot | null) => snapshot?.sidebar ?? null;
const selectTeamName = (snapshot: TeamSessionSnapshot | null) =>
  snapshot?.bootstrap?.teamName ?? null;
const selectCanCreate = (snapshot: TeamSessionSnapshot | null) =>
  snapshot?.bootstrap?.can.createChannel ?? false;
const selectCanInvite = (snapshot: TeamSessionSnapshot | null) =>
  snapshot?.bootstrap?.can.manageInvites ?? false;
const selectConnection = (snapshot: TeamSessionSnapshot | null) =>
  snapshot?.connection ?? "offline";
