import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import type { TeamSessionClient, TeamSessionSnapshot } from "@opensteer/client/team";
import { Dialog } from "../components/dialog.js";
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
import { useTeamSession, useTeams, type TeamAttachment } from "./team-attachments.js";
import { teamTile } from "./team-people.js";
import { channelPath, teamPath } from "./team-paths.js";
import { sidebarView } from "./team-view-models.js";

export function teamConnection(
  team: TeamAttachment,
  snapshot: TeamSessionSnapshot | null,
): TeamConnection {
  if (team.link?.state === "revoked") return "removed";
  if (team.link?.state === "needs_update") return "update-app";
  if (snapshot?.connection === "connected") return "online";
  if (snapshot?.connection === "connecting") return "reconnecting";
  return "offline";
}

/** Every team session's snapshot, read together; a change in one redraws only what reads this. */
function useTeamSnapshots(
  clients: readonly (TeamSessionClient | null)[],
): readonly (TeamSessionSnapshot | null)[] {
  const cache = useRef<readonly (TeamSessionSnapshot | null)[]>([]);
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
    const next = clients.map((client) => client?.getSnapshot() ?? null);
    const held = cache.current;
    if (held.length === next.length && held.every((value, index) => value === next[index]))
      return held;
    cache.current = next;
    return next;
  }, [clients]);
  return useSyncExternalStore(subscribe, read, read);
}

function mentions(snapshot: TeamSessionSnapshot | null): number {
  return (snapshot?.sidebar?.channels ?? []).reduce((sum, row) => sum + row.mentionCount, 0);
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
  const { teams } = useTeams();
  const clients = useStableClients(teams);
  const snapshots = useTeamSnapshots(clients);
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState<TeamAttachment | null>(null);
  if (teams.length === 0) return null;
  const go = (path: string) => {
    onNavigate();
    void navigate(path);
  };
  const menu = (team: TeamAttachment, snapshot: TeamSessionSnapshot | null): TeamMenuActions => ({
    onKnowledge: team.client ? () => go(teamPath(team.teamId, "knowledge")) : undefined,
    onInvite: snapshot?.bootstrap?.can.manageInvites
      ? () => go(`/settings/teams/${team.teamId}/invites`)
      : undefined,
    onSettings: team.client ? () => go(`/settings/teams/${team.teamId}/profile`) : undefined,
    onLeave: team.link ? () => setLeaving(team) : undefined,
  });
  return (
    <>
      <SidebarSwitch
        active={side}
        onSelect={onSide}
        segments={[
          { id: "tasks", label: "Tasks", badge: tasksBadge },
          ...teams.map((team, index) => {
            const snapshot = snapshots[index] ?? null;
            const name = snapshot?.bootstrap?.teamName ?? team.name;
            return {
              id: team.teamId,
              label: name,
              tile: teamTile(team.teamId, name),
              badge: { kind: "mentions" as const, count: mentions(snapshot) },
              menu: menu(team, snapshot),
            };
          }),
        ]}
      />
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

function LeaveTeamDialog({
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
  const { teams, leave } = useTeams();
  const team = teams.find((candidate) => candidate.teamId === teamId) ?? null;
  const snapshot = useTeamSession(team?.client ?? null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();
  if (!team) return null;
  if (!team.client)
    return (
      <div className="team-left">
        <TeamTile tile={teamTile(team.teamId, team.name)} />
        <div className="team-left__text">
          <p className="team-left__title">{team.name}</p>
          <p className="team-left__detail">Opens at {new URL(team.origin).host}</p>
        </div>
        <a className="btn btn--small" href={team.origin} rel="noreferrer" target="_blank">
          Open
        </a>
      </div>
    );
  const open = pathname.startsWith(`/teams/${team.teamId}/c/`)
    ? (pathname.split("/")[4] ?? null)
    : null;
  const go = (path: string) => {
    onNavigate();
    void navigate(path);
  };
  return (
    <TeamSide
      actions={{
        onOpenChannel: (channelId) => go(channelPath(team.teamId, channelId)),
        hrefFor: (channelId) => channelPath(team.teamId, channelId),
        onBrowseChannels: () => go(teamPath(team.teamId, "browse")),
        onNewChannel: snapshot?.bootstrap?.can.createChannel
          ? () => go(teamPath(team.teamId, "browse?new=1"))
          : undefined,
        onNewMessage: () => go(teamPath(team.teamId, "people")),
        onMoreDms: () => go(teamPath(team.teamId, "people")),
        onRemoveFromSidebar: () =>
          void leave(team.teamId).catch((error: unknown) => toast.error(actionErrorMessage(error))),
        onRetry: () => team.client?.connect(),
      }}
      openChannelId={open}
      team={sidebarView({
        teamId: team.teamId,
        tile: teamTile(team.teamId, snapshot?.bootstrap?.teamName ?? team.name),
        connection: teamConnection(team, snapshot),
        sidebar: snapshot?.sidebar ?? null,
      })}
    />
  );
}
