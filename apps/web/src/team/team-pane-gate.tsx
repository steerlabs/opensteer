import { Fragment, useState, type ReactNode } from "react";
import { teamEntryRefusalOutcome } from "@opensteer/protocol";
import { useTeamAttachment, useTeamSession, useTeams } from "./team-attachments.js";
import { actionErrorMessage } from "../ui-utils.js";

/** All team routes, including settings and knowledge, share the same recovery boundary. */
export function TeamPaneGate({
  teamId,
  children,
}: {
  readonly teamId: string;
  readonly children: ReactNode;
}) {
  const { owner, surface } = useTeams();
  if (surface === "personal-web") return <Fragment>{children}</Fragment>;
  return (
    <TeamPane key={owner?.id} teamId={teamId}>
      {children}
    </TeamPane>
  );
}
function TeamPane({ teamId, children }: { readonly teamId: string; readonly children: ReactNode }) {
  const { enter, forget, reload, surface } = useTeams();
  const team = useTeamAttachment(teamId);
  const snapshot = useTeamSession(team?.client ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const membership = teamEntryRefusalOutcome(snapshot?.refusalReason) === "membership";
  const ended = snapshot?.ended;
  if (snapshot?.bootstrap && !ended && !membership) return <Fragment>{children}</Fragment>;
  const state = membership || ended === "removed" ? "join" : ended ? "sign-in" : team?.failure;
  const name = team?.name ?? "this team";
  const pending = team && (!state || state === "pending");
  const title =
    ended === "removed"
      ? `You're no longer in ${name}`
      : state === "join"
        ? "Join this team"
        : state === "update-app"
          ? "Update Opensteer"
          : state === "update-server"
            ? "Team server needs an update"
            : state === "sign-in" || state === "suppressed"
              ? `Sign in to ${name}`
              : pending
                ? "Opening team…"
                : "This team couldn't open";
  const attempt = () => {
    setBusy(true);
    setError(null);
    void (
      surface === "team-web"
        ? Promise.resolve(window.location.reload())
        : enter
          ? enter(teamId)
          : reload()
    )
      .catch((failure: unknown) => setError(actionErrorMessage(failure)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="team-empty">
      <p>{title}</p>
      {state === "join" ? <p>Ask a team member for a new invite.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!pending && team ? (
        <>
          {state !== "join" && state !== "update-app" && state !== "update-server" ? (
            <button className="btn" disabled={busy} onClick={attempt} type="button">
              {state === "sign-in" || state === "suppressed" ? "Sign in" : "Retry"}
            </button>
          ) : null}
          {surface === "team-web" ? null : (
            <button className="btn" onClick={() => void forget(teamId)} type="button">
              Remove from this computer
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}
