import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { TeamSessionSnapshot } from "@opensteer/client/team";
import { Dialog } from "../components/dialog.js";
import { Icon } from "../components/icon.js";
import { TeamTile } from "../components/team/team-marks.js";
import type { TeamConnection } from "../components/team/team-models.js";
import { TeamSection } from "../components/team/team-sidebar.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { useTeamSession, useTeams, type TeamAttachment } from "./team-attachments.js";
import { teamTile } from "./team-people.js";
import { sidebarView } from "./team-view-models.js";
import { channelPath, teamPath } from "./team-paths.js";

const foldedKey = "opensteer.sidebar.folded-teams";

function readFolded(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(foldedKey) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

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

/** Every team, one section each, in join order, below the person's own tasks. */
export function TeamSidebarSections({ onNavigate }: { readonly onNavigate: () => void }) {
  const { teams } = useTeams();
  const [folded, setFolded] = useState(readFolded);
  if (teams.length === 0) return null;
  const toggle = (teamId: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(teamId)) next.add(teamId);
      try {
        localStorage.setItem(foldedKey, JSON.stringify([...next]));
      } catch {
        // Folding still works for this window.
      }
      return next;
    });
  return (
    <div className="team-sections">
      {teams.map((team) =>
        team.client ? (
          <LiveTeamSection
            folded={folded.has(team.teamId)}
            key={team.teamId}
            onNavigate={onNavigate}
            onToggle={() => toggle(team.teamId)}
            team={team}
          />
        ) : (
          <LinkedTeamRow key={team.teamId} team={team} />
        ),
      )}
    </div>
  );
}

/** A team this app shows at its own address only: the personal web app, or not signed in here. */
function LinkedTeamRow({ team }: { readonly team: TeamAttachment }) {
  return (
    <section aria-label={team.name} className="team-section">
      <div className="team-head">
        <a
          className="team-head__main"
          href={team.origin}
          rel="noreferrer"
          target="_blank"
          title={`Open ${team.name} at ${new URL(team.origin).host}`}
        >
          <TeamTile tile={teamTile(team.teamId, team.name)} />
          <span className="team-head__title">{team.name}</span>
          <span className="team-head__badge">Open</span>
          <Icon className="team-head__chevron" name="external-link" />
        </a>
      </div>
    </section>
  );
}

function LiveTeamSection({
  folded,
  onNavigate,
  onToggle,
  team,
}: {
  readonly folded: boolean;
  readonly onNavigate: () => void;
  readonly onToggle: () => void;
  readonly team: TeamAttachment;
}) {
  const snapshot = useTeamSession(team.client);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();
  const { leave } = useTeams();
  const [leaving, setLeaving] = useState(false);
  const open = new RegExp(`^/teams/${team.teamId}/c/([^/]+)`, "u").exec(pathname)?.[1] ?? null;
  const go = (path: string) => {
    onNavigate();
    void navigate(path);
  };
  const can = snapshot?.bootstrap?.can;
  const view = sidebarView({
    teamId: team.teamId,
    tile: teamTile(team.teamId, snapshot?.bootstrap?.teamName ?? team.name),
    connection: teamConnection(team, snapshot),
    sidebar: snapshot?.sidebar ?? null,
  });
  return (
    <>
      <TeamSection
        actions={{
          onOpenChannel: (channelId) => go(channelPath(team.teamId, channelId)),
          hrefFor: (channelId) => channelPath(team.teamId, channelId),
          onNewChannel: can?.createChannel ? () => go(teamPath(team.teamId, "browse?new=1")) : undefined,
          onNewMessage: () => go(teamPath(team.teamId, "people")),
          onBrowseChannels: () => go(teamPath(team.teamId, "browse")),
          onInvite: can?.manageInvites
            ? () => go(`/settings/teams/${team.teamId}/invites`)
            : undefined,
          onKnowledge: () => go(teamPath(team.teamId, "knowledge")),
          onSearch: () => go(teamPath(team.teamId, "search")),
          onMarkAllRead: () => {
            for (const entry of snapshot?.sidebar?.channels ?? [])
              if (entry.unread && entry.channel.latestMessageId)
                void team.client
                  ?.markRead(entry.channel.id, entry.channel.latestMessageId)
                  .catch((error: unknown) => toast.error(actionErrorMessage(error)));
          },
          onNotifications: () => go(`/settings/teams/${team.teamId}/notifications`),
          onSettings: () => go(`/settings/teams/${team.teamId}/profile`),
          onLeave: team.link ? () => setLeaving(true) : undefined,
          onRemoveFromSidebar: team.link
            ? () => void leave(team.teamId).catch((error: unknown) => toast.error(actionErrorMessage(error)))
            : undefined,
          onRetry: () => team.client?.connect(),
        }}
        folded={folded}
        onToggleFold={onToggle}
        openChannelId={open}
        team={view}
      />
      {leaving ? (
        <Dialog
          labelledBy="leave-team-title"
          onClose={() => setLeaving(false)}
          title={`Leave ${team.name}?`}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setLeaving(false)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  setLeaving(false);
                  void leave(team.teamId)
                    .then(() => go("/"))
                    .catch((error: unknown) => toast.error(actionErrorMessage(error)));
                }}
                type="button"
              >
                Leave {team.name}
              </button>
            </>
          }
        >
          You’ll lose access to its channels. Tasks your agent did for {team.name} stay on your
          computer.
        </Dialog>
      ) : null}
    </>
  );
}
