import { Link, useLocation } from "react-router";
import type { TeamSource } from "@opensteer/core";
import { useTeamAttachment } from "./team-attachments.js";
import { channelPath } from "./team-paths.js";

export function TeamInputSource({ source }: { readonly source: TeamSource }) {
  const location = useLocation();
  const team = useTeamAttachment(source.teamId);
  const label = `#${source.audience.channelName} ↗`;
  if (!team || team.link?.state === "revoked")
    return <small className="team-input-source">{label}</small>;
  return (
    <Link
      className="team-input-source"
      to={{
        pathname: channelPath(source.teamId, source.channelId, {
          threadId: source.threadRootId ?? source.messageId,
          messageId: source.messageId !== source.threadRootId ? source.messageId : null,
        }),
        search: location.search,
      }}
    >
      {label}
    </Link>
  );
}
