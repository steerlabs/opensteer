import { teamEntryRefusalOutcome } from "@opensteer/protocol";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  recentTeam,
  type SidebarSide,
  type SidebarSides,
  type TeamSessionClient,
  type TeamSessionSnapshot,
} from "@opensteer/client/team";
import { Dialog } from "../components/dialog.js";
import { SetupEntries, useTeamDialogs } from "./hosted-teams.js";
import { TeamTile } from "../components/team/team-marks.js";
import type { TeamConnection } from "../components/team/team-models.js";
import {
  SidebarSwitch,
  TeamSide,
  type SegmentBadge,
  type SwitchTeam,
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
}

/**
 * Each team's name and mention total, read together. Only a change in those
 * redraws the switch; a new message, typing or presence does not, and the
 * lists below never redraw for a badge.
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
      };
    });
    const held = cache.current;
    if (
      held.length === next.length &&
      held.every(
        (value, index) =>
          value.name === next[index]!.name && value.mentions === next[index]!.mentions,
      )
    )
      return held;
    cache.current = next;
    return next;
  }, [clients]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The `Tasks | Acme` switch, once this computer has joined a team, and any
 * team still being set up. Its own component, so a badge changing never
 * redraws the task or channel lists. Making or joining a team, and each
 * team's settings, live in Settings and the sidebar's own menu, not here.
 */
export function TeamSwitch({
  onSide,
  sides,
  tasksBadge,
}: {
  readonly onSide: (side: SidebarSide) => void;
  readonly sides: SidebarSides;
  readonly tasksBadge: SegmentBadge;
}) {
  const { teams } = useTeams();
  const clients = useStableClients(teams);
  const facts = useSegmentFacts(clients);
  const switchTeams = useMemo(
    () =>
      teams.map((team, index): SwitchTeam => {
        const fact = facts[index];
        const name = fact?.name ?? team.name;
        return {
          id: team.teamId,
          name,
          tile: teamTile(team.teamId, name),
          mentions: fact?.mentions ?? 0,
        };
      }),
    [facts, teams],
  );
  const recent = recentTeam(
    sides,
    teams.map((team) => team.teamId),
  );
  return (
    <>
      {recent === null ? null : (
        <SidebarSwitch
          active={sides.side}
          onSelect={onSide}
          recent={recent}
          tasksBadge={tasksBadge}
          teams={switchTeams}
        />
      )}
      <SetupEntries />
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
  const { openInvite, openNewChannel, openNewMessage } = useTeamDialogs();
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
    onKnowledge: () => go(teamPath(teamId, "knowledge")),
    onBrowseChannels: () => go(teamPath(teamId, "browse")),
    onNewChannel: canCreate
      ? () => {
          onNavigate();
          openNewChannel(teamId);
        }
      : undefined,
    onNewMessage: () => {
      onNavigate();
      openNewMessage(teamId);
    },
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
  if (!team.client || teamEntryRefusalOutcome(refusal) === "membership")
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
                : team.failure === "update-app"
                  ? "Update Opensteer to open this team."
                  : team.failure === "update-server"
                    ? "This team's server needs an update."
                    : team.failure === "join" || teamEntryRefusalOutcome(refusal) === "membership"
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
              : team.failure === "unavailable" ||
                  team.failure === "update-app" ||
                  team.failure === "update-server"
                ? "Retry"
                : team.failure === "join" || teamEntryRefusalOutcome(refusal) === "membership"
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
      knowledgeOpen={pathname.startsWith(`/teams/${team.teamId}/knowledge`)}
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
