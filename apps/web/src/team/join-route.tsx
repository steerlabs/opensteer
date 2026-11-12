import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { parseTeamPageLink, teamPageUrl } from "@opensteer/core";
import { parseTeamLinkOffer } from "@opensteer/protocol";
import { AreaHeader } from "../components/workspace/conversation-header.js";
import { useShell } from "../components/app-shell.js";
import { actionErrorMessage } from "../ui-utils.js";
import { useTeams } from "./team-attachments.js";
import { channelPath } from "./team-paths.js";

/**
 * Join a team, or connect this computer's agent to one: paste the link the
 * team gave you. An invite opens on the team's own page, where you sign in;
 * a connect link links this Opensteer to the team so your agent can be asked.
 */
export function JoinTeamRoute() {
  const { hostClient } = useShell();
  const { links, reload, teams } = useTeams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [text, setText] = useState(params.get("link") ?? "");
  const [state, setState] = useState<{ readonly busy: boolean; readonly error: string | null }>({
    busy: false,
    error: null,
  });
  // A channel or message link of a team this computer is in opens there at once.
  const linked = params.get("link");
  useEffect(() => {
    const path = linked ? joinedTeamPath(linked, teams) : null;
    if (path) void navigate(path, { replace: true });
  }, [linked, navigate, teams]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    const page = parseTeamPageLink(value);
    if (page) {
      const path = joinedTeamPath(value, teams);
      if (path) void navigate(path);
      else window.open(teamPageUrl(page), "_blank", "noopener,noreferrer");
      return;
    }
    if (!parseTeamLinkOffer(value) || !links) {
      setState({ busy: false, error: "That isn’t a team link. Copy it again from the team." });
      return;
    }
    setState({ busy: true, error: null });
    void links
      .join(value)
      .then(async (link) => {
        await reload();
        void navigate(`/teams/${encodeURIComponent(link.teamId)}/browse`);
      })
      .catch((error: unknown) => setState({ busy: false, error: actionErrorMessage(error) }));
  };
  return (
    <div className="thread team-page">
      <AreaHeader hostClient={hostClient} title="Join a team" />
      <form className="team-join-form" onSubmit={submit}>
        <p className="hero__subtitle">
          Paste an invite or a connect link from your team. Your agent stays on your computers; the
          team sees only what you, or your agent when you ask it, post there.
        </p>
        <input
          aria-label="Team link"
          autoFocus
          className="text-input"
          onChange={(event) => setText(event.currentTarget.value)}
          placeholder="https://chat.acme.example/…"
          value={text}
        />
        {state.error ? (
          <p className="notice notice--error" role="alert">
            {state.error}
          </p>
        ) : null}
        <button className="btn btn--primary" disabled={!text.trim() || state.busy} type="submit">
          {state.busy ? "Joining…" : "Continue"}
        </button>
      </form>
    </div>
  );
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
