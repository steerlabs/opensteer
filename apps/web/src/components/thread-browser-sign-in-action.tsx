import { useEffect, useId, useRef, useState } from "react";
import type { BrowserSourceId, Request } from "@opensteer/core";
import {
  browserSignInProblemClearsInChrome,
  browserSignInProblemMessage,
  browserSignInProblemResolvesItself,
  browserSiteLabel,
  browserSitePreferredSource,
  chromeSignInAvailability,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type ChromeSignInAvailability,
  type ChromeSignInChoice,
  type HostClient,
} from "@opensteer/client/host";
import type { BrowserSignInOutcome } from "@opensteer/protocol/browser-sources";
import { actionErrorMessage } from "../ui-utils.js";
import { ActionNote } from "./action-rows.js";
import { useShell } from "./app-shell.js";
import type { ChromeConnectEnvironment } from "./chrome/chrome-environment.js";
import { ConnectChrome } from "./chrome/connect-chrome.js";
import { useChromeInspection } from "./chrome/use-chrome-inspection.js";
import { useShellChromeEnvironment } from "./chrome/use-shell-chrome-environment.js";
import { Icon } from "./icon.js";

export type BrowserSignInRequestClient = Pick<HostClient, "dispatch" | "rpc">;

export function ThreadBrowserSignInAction({
  disabled,
  request,
}: {
  readonly disabled: boolean;
  readonly request: Request;
}) {
  const { hostClient, snapshot } = useShell();
  const environment = useShellChromeEnvironment();
  const sessionId = request.payload.kind === "browser.sign-in" ? request.payload.sessionId : null;
  const session = snapshot.browserSessions.find(({ id }) => id === sessionId);
  const profileName = session?.profileId
    ? (snapshot.browserProfiles.find(({ id }) => id === session.profileId)?.name ?? null)
    : null;
  return (
    <BrowserSignInRequestBody
      client={hostClient}
      disabled={disabled}
      environment={environment}
      key={request.id}
      profileName={profileName}
      request={request}
      workspaceName={
        snapshot.workspaces.find(({ id }) => id === request.targetWorkspaceId)?.name ??
        "this Workspace"
      }
    />
  );
}

/** An Allow the Host answered with a problem, pinned to the Chrome the person chose. */
interface AllowedSignIn {
  readonly outcome: BrowserSignInOutcome;
  readonly sourceId: BrowserSourceId;
}

/**
 * An agent wants one site signed in, in its live browser, with the person's
 * own Chrome sign-in. The card follows Chrome while it is on screen, so every
 * blocker says its one fix. After an Allow the card never picks a Chrome by
 * itself: it retries only the Chrome the person allowed, once, when that
 * Chrome turns signed in, and only while the site is still allowed.
 */
export function BrowserSignInRequestBody({
  client,
  disabled,
  environment,
  profileName,
  request,
  workspaceName,
}: {
  readonly client: BrowserSignInRequestClient;
  readonly disabled: boolean;
  readonly environment: ChromeConnectEnvironment;
  readonly profileName: string | null;
  readonly request: Request;
  readonly workspaceName: string;
}) {
  const payload = request.payload.kind === "browser.sign-in" ? request.payload : null;
  const site = payload?.site ?? null;
  const pending = request.status === "pending";
  const { error: checkError, inspection, refresh } = useChromeInspection(client, site, pending);
  const [chosenId, setChosenId] = useState<BrowserSourceId | null>(null);
  const [answer, setAnswer] = useState<"allow" | "decline" | null>(null);
  const [allowed, setAllowed] = useState<AllowedSignIn | null>(null);
  // Set when the allowed Chrome turned signed in but the site is no longer
  // allowed with it: only the person's own Try again may allow it again.
  const [retryStopped, setRetryStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The allowed Chrome's status in the last inspection, so a retry fires on
  // its change to `available` and never on a reading that merely repeats.
  const allowedStatus = useRef<string | undefined>(undefined);
  const latestInspection = useRef(inspection);
  latestInspection.current = inspection;
  const groupName = useId();

  const availability: ChromeSignInAvailability | null = inspection
    ? chromeSignInAvailability(inspection, { offlineCounts: true })
    : null;
  const choices = availability?.kind === "choices" ? availability.choices : [];
  const chosen =
    choices.find((choice) => choice.sourceId === chosenId) ??
    choices.find((choice) => choice.online) ??
    choices[0] ??
    null;
  // A Chrome disconnected since the Allow can't be retried; the person chooses again.
  const pinned =
    allowed?.outcome.status === "problem" &&
    (!inspection || inspection.candidates.some(({ sourceId }) => sourceId === allowed.sourceId))
      ? allowed
      : null;

  const respond = (
    decision: "allow" | "decline",
    sourceId: BrowserSourceId | null = chosen?.sourceId ?? null,
  ) => {
    if (answer || disabled || !payload) return;
    if (decision === "allow" && !sourceId) return;
    setAnswer(decision);
    setError(null);
    void client
      .dispatch({
        decision:
          decision === "allow" && sourceId
            ? { decision: "allow", sourceId }
            : { decision: "decline" },
        idempotencyKey: mutationIdempotencyKey(`browser-sign-in:${request.id}`),
        requestId: request.id,
        type: "browser.sign-in.respond",
      })
      .then((result) => {
        if (result.type !== "browser.sign-in.respond" || decision !== "allow") return;
        if (!result.outcome || !sourceId) return;
        allowedStatus.current = latestInspection.current?.candidates.find(
          (candidate) => candidate.sourceId === sourceId,
        )?.status;
        setChosenId(sourceId);
        setRetryStopped(false);
        setAllowed({ outcome: result.outcome, sourceId });
        if (result.outcome.status === "problem") refresh();
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setAnswer(null));
  };
  const respondRef = useRef(respond);
  respondRef.current = respond;

  const retryable =
    pinned?.outcome.status === "problem" &&
    browserSignInProblemClearsInChrome(pinned.outcome.problem) &&
    !retryStopped;
  useEffect(() => {
    if (!retryable || !pinned || !inspection || !site) return;
    const status = inspection.candidates.find(
      (candidate) => candidate.sourceId === pinned.sourceId,
    )?.status;
    const before = allowedStatus.current;
    allowedStatus.current = status;
    if (status !== "available" || before === "available") return;
    // Removing the site since the Allow withdraws it; retrying would add it back.
    void client.rpc["browser.sources.get"]({})
      .then(unwrapRpcResult)
      .then((state) => {
        if (
          browserSitePreferredSource(state, request.targetWorkspaceId, site) === pinned.sourceId
        ) {
          respondRef.current("allow", pinned.sourceId);
        } else {
          setRetryStopped(true);
        }
      })
      .catch(() => setRetryStopped(true));
  }, [client, inspection, pinned, request.targetWorkspaceId, retryable, site]);

  if (!payload || !site) return <ActionNote alert>This sign-in request is invalid.</ActionNote>;
  if (!pending) {
    return <ActionNote>{request.status === "declined" ? "Not allowed." : "Answered."}</ActionNote>;
  }

  const domain = browserSiteLabel(site);
  const single = choices.length === 1 ? choices[0] : undefined;
  const signedIn = allowed?.outcome.status === "applied";
  const pinnedName = pinned
    ? (inspection?.candidates.find(({ sourceId }) => sourceId === pinned.sourceId)?.name ?? null)
    : null;
  const allowSource = pinned ? pinned.sourceId : (chosen?.sourceId ?? null);

  return (
    <div className="sign-in-card">
      <p className="sign-in-card__lead">
        Your agent wants to use your {domain} sign-in from{" "}
        {pinnedName || single ? <strong>{pinnedName ?? single?.name}</strong> : "Chrome"}.
      </p>
      <div aria-live="polite" className="sign-in-card__state">
        {signedIn ? (
          <p className="sign-in-card__line sign-in-card__line--ok" role="status">
            <Icon name="check-circle" />
            Signed in to {domain}.
          </p>
        ) : pinned?.outcome.status === "problem" ? (
          <SignInProblem
            detail={
              browserSignInProblemResolvesItself(pinned.outcome.problem)
                ? "Allowed. This finishes by itself when that Chrome is back."
                : retryable
                  ? "Allowed. This finishes by itself once that’s fixed."
                  : "Choose Try again once that’s fixed."
            }
            message={browserSignInProblemMessage(pinned.outcome.problem, {
              context: "request",
              site,
              sourceName: pinned.outcome.sourceName,
            })}
          />
        ) : availability === null ? (
          <p className="sign-in-card__line">
            <span aria-hidden className="spinner" />
            {checkError ?? "Checking Chrome…"}
          </p>
        ) : availability.kind === "no-chrome" ? (
          <ConnectChrome
            client={client}
            compact
            environment={environment}
            intro="Chrome isn’t connected yet. Connect it, then choose Allow."
            onConnected={refresh}
          />
        ) : availability.kind === "problem" ? (
          <SignInProblem
            detail="This updates by itself."
            message={browserSignInProblemMessage(availability.problem, {
              context: "request",
              site,
              sourceName: availability.sourceName,
            })}
          />
        ) : single ? (
          single.online ? (
            <p className="sign-in-card__line">
              <span aria-hidden className="status-dot status-dot--ok" />
              {single.name} is signed in to {domain}.
            </p>
          ) : (
            <SignInProblem
              detail="Allow now; this finishes by itself when Chrome opens."
              message={`${single.name} is offline. Open Chrome on that computer.`}
            />
          )
        ) : (
          <ChromeChoice
            choices={choices}
            chosenId={chosen?.sourceId ?? null}
            name={groupName}
            onChoose={setChosenId}
          />
        )}
      </div>
      <ul className="sign-in-card__facts">
        <li>
          <Icon name="workspace" />
          Agents in {workspaceName} will be able to use {domain} as you.
        </li>
        {profileName ? (
          <li>
            <Icon name="user" />
            Saved to profile {profileName}.
          </li>
        ) : null}
      </ul>
      {error ? (
        <p className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="action-buttons">
        <button
          className="btn"
          disabled={disabled || answer !== null || signedIn}
          onClick={() => respond("decline")}
          type="button"
        >
          {answer === "decline" ? "Declining…" : "Don’t allow"}
        </button>
        <button
          className="btn btn--primary"
          disabled={disabled || answer !== null || signedIn || allowSource === null}
          onClick={() => respond("allow", allowSource)}
          type="button"
        >
          {answer === "allow" ? <span aria-hidden className="spinner" /> : <Icon name="key" />}
          {answer === "allow" ? "Signing in…" : pinned ? "Try again" : "Allow"}
        </button>
      </div>
    </div>
  );
}

function SignInProblem({ detail, message }: { readonly detail: string; readonly message: string }) {
  return (
    <div className="sign-in-card__problem">
      <Icon name="alert-circle" />
      <p>
        {message} <span className="sign-in-card__problem-detail">{detail}</span>
      </p>
    </div>
  );
}

function ChromeChoice({
  choices,
  chosenId,
  name,
  onChoose,
}: {
  readonly choices: readonly ChromeSignInChoice[];
  readonly chosenId: string | null;
  readonly name: string;
  readonly onChoose: (sourceId: BrowserSourceId) => void;
}) {
  return (
    <fieldset className="browser-choice sign-in-card__choice">
      <legend>More than one Chrome can sign in. Use the sign-in from</legend>
      {choices.map((choice) => (
        <label className="browser-choice__option" key={choice.sourceId}>
          <input
            checked={choice.sourceId === chosenId}
            name={name}
            onChange={() => onChoose(choice.sourceId)}
            type="radio"
          />
          <span className="browser-choice__text">
            <span className="browser-choice__label">{choice.name}</span>
            {choice.online ? null : (
              <span className="browser-choice__detail">
                Offline · finishes when this Chrome opens
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
