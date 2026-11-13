import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { parseTeamPageLink, teamPageUrl } from "@opensteer/core";
import { useOptionalShell } from "../components/app-shell.js";
import { AreaHeader } from "../components/workspace/conversation-header.js";
import { TeamsHome, useTeamDialogs } from "./hosted-teams.js";
import { useTeams } from "./team-attachments.js";
import { channelPath } from "./team-paths.js";

/** Teams: create one, or join with an invite. */
export function TeamsRoute() {
  const shell = useOptionalShell();
  return (
    <div className="thread team-page">
      <AreaHeader hostClient={shell?.hostClient ?? null} title="Teams" />
      <TeamsHome portalOrigin={shell?.snapshot.identityConfig?.portalOrigin ?? null} />
    </div>
  );
}

/**
 * A team page the app was asked to open (`/join?link=…`): a channel or message of a team this
 * computer is in opens there, an invite opens the join confirmation, and anything else opens at
 * the team's own address.
 */
export function JoinTeamRoute() {
  const { coordination, teams } = useTeams();
  const { openJoin } = useTeamDialogs();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const linked = params.get("link");
  useEffect(() => {
    const page = linked ? parseTeamPageLink(linked) : null;
    if (!page || !linked) return void navigate("/teams", { replace: true });
    const path = joinedTeamPath(linked, teams);
    if (path) return void navigate(path, { replace: true });
    if (page.target.kind === "invite" && coordination) {
      openJoin(linked);
      return void navigate("/teams", { replace: true });
    }
    window.open(teamPageUrl(page), "_blank", "noopener,noreferrer");
    void navigate("/teams", { replace: true });
  }, [linked, coordination, navigate, openJoin, teams]);
  return null;
}

/** Where a team page link opens in this app, when it names a channel of a team already joined. */
export function joinedTeamPath(
  url: string,
  teams: readonly { readonly origin: string; readonly teamId: string }[],
): string | null {
  const page = parseTeamPageLink(url);
  if (!page || page.target.kind === "invite") return null;
  const team = teams.find((candidate) => candidate.origin === page.origin);
  return team
    ? channelPath(team.teamId, page.target.channelId, {
        messageId: page.target.kind === "message" ? page.target.messageId : null,
      })
    : null;
}
