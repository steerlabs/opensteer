import { Link, useLocation } from "react-router";
import type { TeamTaskOrigin } from "@opensteer/core";
import { TaskSource } from "../components/home/personal-sidebar.js";
import { Icon } from "../components/icon.js";
import { channelLabel } from "../components/team/team-models.js";
import { useTaskSourceView, useTeamAttachment, useTeamSession } from "./team-attachments.js";
import { channelPath } from "./team-paths.js";
import { channelKind } from "./team-view-models.js";

/**
 * Where a task a team thread started came from, in its header. It opens the
 * channel with the thread at the asking message; once the person has left
 * the team it stays, greyed, with no way back.
 */
export function TaskSourceChip({ origin }: { readonly origin: TeamTaskOrigin }) {
  const source = useTaskSourceView(origin);
  const location = useLocation();
  const state = location.state as { teamReturn?: { pathname?: unknown; search?: unknown } } | null;
  const back = state?.teamReturn;
  const target =
    back &&
    typeof back.pathname === "string" &&
    back.pathname.startsWith(`/teams/${origin.teamId}/c/${origin.channelId}`) &&
    typeof back.search === "string"
      ? { pathname: back.pathname, search: back.search }
      : {
          pathname: channelPath(origin.teamId, origin.channelId, { threadId: origin.threadRootId }),
          search: location.search,
        };
  if (!source) return null;
  if (!source.available)
    return (
      <div className="task-source-chip task-source-chip--gone">
        <TaskSource source={source} />
      </div>
    );
  return (
    <Link
      className="task-source-chip"
      title={`Open the thread in ${channelLabel(source.channel)}`}
      to={target}
    >
      <TaskSource source={source} />
      <span className="task-source__note">· thread</span>
      <Icon name="external-link" />
    </Link>
  );
}

/** Above a team task's composer: what the channel will see, and that typing here is private. */
export function TaskAudienceLine({ origin }: { readonly origin: TeamTaskOrigin }) {
  const team = useTeamAttachment(origin.teamId);
  const sidebar = useTeamSession(team?.client ?? null)?.sidebar;
  const entry = sidebar?.channels.find((row) => row.channel.id === origin.channelId);
  if (!team || team.link?.state === "revoked" || entry?.channel.peopleOnly) return null;
  const where = entry
    ? channelLabel({ kind: channelKind(entry.channel.kind), name: entry.channel.name })
    : "the thread";
  return (
    <p className="task-audience" role="note">
      <Icon name="users" />
      Replies post to {where} in {team.name}. What you type here stays private.
    </p>
  );
}
