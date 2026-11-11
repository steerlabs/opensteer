import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { parseTeamLinkOffer, parseTeamPageLink, teamPageUrl } from "@opensteer/protocol";
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    const page = parseTeamPageLink(value);
    if (page) {
      const team = teams.find((candidate) => candidate.origin === page.origin);
      if (team && page.target.kind !== "invite")
        void navigate(
          channelPath(team.teamId, page.target.channelId, {
            messageId: page.target.kind === "message" ? page.target.messageId : null,
          }),
        );
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
