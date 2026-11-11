import { useMemo, useState } from "react";
import {
  formatRelativeTime,
  teamComputerCommand,
  teamComputerState,
  teamComputerTrustNote,
  teamErrorText,
} from "@opensteer/client/host";
import { useHostRead } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";
import {
  CopyBlock,
  containerLabel,
  containerPrerequisite,
  useCountdown,
} from "../computers/add-computer-dialog.js";
import { Dialog } from "../dialog.js";
import { LoadingRows } from "../loading-rows.js";
import { SectionHeader } from "../settings/primitives.js";
import { TeamError, useShellTeam } from "./team-ui.js";

interface Issued {
  readonly enrollmentId: string;
  readonly expiresAt: string;
  /** The connection code: held only in this screen's memory, never stored. */
  readonly token: string;
  /** The image the Host names for its own release; null when it has none to offer. */
  readonly runnerImage: string | null;
}

/**
 * The one computer every Project in the team runs on. Its only action is to
 * replace it, which with none is how the first one joins; the command it hands
 * out runs it in a container.
 */
export function TeamComputerPage() {
  const { snapshot } = useShell();
  const { team, summary, identity, generation } = useShellTeam();
  const teamName = summary?.team.name ?? "the team";
  const read = useHostRead(
    team ? () => team.computer() : null,
    `team-computer:${identity}:${generation}`,
  );
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const countdown = useCountdown(issued?.expiresAt ?? null);
  const view = read.data;
  const command = useMemo(
    () =>
      issued && snapshot.deploymentShape && snapshot.identityConfig
        ? teamComputerCommand({
            deploymentShape: snapshot.deploymentShape,
            hostOrigin: snapshot.identityConfig.publicOrigin,
            team: teamName,
            replaced: issued,
          })
        : null,
    [issued, snapshot.deploymentShape, snapshot.identityConfig, teamName],
  );

  const replace = () => {
    if (!team || !view || !summary) return;
    setPending(true);
    setError(null);
    void team
      .replaceComputer(summary.accessRevision, view.computer?.id ?? null)
      .then((result) => {
        setIssued({
          enrollmentId: result.enrollmentId,
          expiresAt: result.expiresAt,
          token: result.token,
          runnerImage: result.runnerImage ?? null,
        });
        setConfirming(false);
        read.reload();
      })
      .catch(setError)
      .finally(() => setPending(false));
  };

  const state = view ? teamComputerState(view.computer, teamName) : null;
  return (
    <>
      <SectionHeader
        lead={`Every project in ${teamName} runs its tasks on this computer.`}
        title="Team computer"
      />
      <TeamError error={read.error} onRetry={read.reload} team={teamName} />
      {!view || !state ? (
        read.error ? null : (
          <LoadingRows label="Loading the team computer" rows={2} />
        )
      ) : (
        <div className="card">
          <div className="card__row team-computer">
            <span className="card__row-body">
              <span className="card__row-title">{state.title}</span>
              <span className="card__row-detail">{state.detail}</span>
              {view.computer?.lastSeenAt ? (
                <span className="card__row-detail">
                  Last seen {formatRelativeTime(view.computer.lastSeenAt)}
                </span>
              ) : null}
            </span>
            {view.can.replace.allowed && !issued ? (
              <button
                className={view.computer ? "btn btn--small" : "btn btn--primary btn--small"}
                disabled={pending}
                onClick={() => (view.computer ? setConfirming(true) : replace())}
                type="button"
              >
                {view.computer ? "Replace computer…" : "Connect a computer"}
              </button>
            ) : null}
          </div>
          {issued && command ? (
            <div className="card__row team-computer__connect">
              {command.kind === "command" ? (
                <>
                  <p className="computers-expiry">Connection code expires in {countdown}.</p>
                  <p className="field__hint">
                    Whoever runs {teamName}’s server runs this on the new computer. It joins as{" "}
                    {teamName}’s computer.
                  </p>
                  <CopyBlock
                    hint={containerPrerequisite}
                    label={containerLabel}
                    value={command.text}
                  />
                </>
              ) : (
                <p className="field__hint" role="status">
                  {command.text}
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
      {error && !confirming ? (
        <p className="notice notice--error" role="alert">
          {teamErrorText(error, teamName)}
        </p>
      ) : null}
      <p className="settings-footnote">{teamComputerTrustNote(teamName)}</p>
      {confirming && view?.computer ? (
        <Dialog
          labelledBy="team-computer-replace"
          onClose={() => !pending && setConfirming(false)}
          title={`Replace ${view.computer.name}?`}
        >
          <p>
            It stops running tasks for {teamName} at once. Projects can run again when the new
            computer is connected and has their files. Whoever runs {teamName}’s server must copy
            the projects’ files to it first; Opensteer doesn’t move them.
          </p>
          {error ? (
            <p className="notice notice--error" role="alert">
              {teamErrorText(error, teamName)}
            </p>
          ) : null}
          <div className="form-actions">
            <button
              className="btn"
              disabled={pending}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
            <button className="btn btn--danger" disabled={pending} onClick={replace} type="button">
              {pending ? "Replacing…" : "Replace"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
