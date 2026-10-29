import { useEffect, useId, useRef, useState } from "react";
import {
  browserSignInProblemMessage,
  browserSiteLabel,
  browserSitePreferredSource,
  chromeSignInAvailability,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import type {
  BrowserSignInOutcome,
  BrowserSourceInspection,
} from "@opensteer/protocol/browser-sources";
import { actionErrorMessage } from "../../ui-utils.js";
import type { ChromeConnectEnvironment } from "../chrome/chrome-environment.js";
import { ConnectChrome } from "../chrome/connect-chrome.js";
import { useChromeInspection } from "../chrome/use-chrome-inspection.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";

export type BrowserSignInClient = Pick<HostClient, "dispatch" | "rpc">;

export type AppliedSignIn = Extract<BrowserSignInOutcome, { status: "applied" }>;

/** The confirmation after the page reloads signed in. */
export function signedInMessage(outcome: AppliedSignIn): string {
  const saved = outcome.profileName ? ` Saved to profile ${outcome.profileName}.` : "";
  return `Signed in to ${browserSiteLabel(outcome.site)} with ${outcome.sourceName}.${saved}`;
}

/** The page menu's words for signing its site in with Chrome. */
export const browserSignInLabel = "Sign in with Chrome…";

/**
 * Signs the page's site in with the person's Chrome sign-in, in place, from
 * the page's menu. The popover hangs from that menu's button and asks only
 * what it must — connect Chrome, or which Chrome — and otherwise is one click.
 */
export function BrowserSignInPopover({
  anchor,
  client,
  environment,
  onClose,
  onSignedIn,
  sessionId,
  site,
  url,
  workspaceId,
  workspaceName,
}: {
  readonly anchor: HTMLElement;
  readonly client: BrowserSignInClient;
  readonly environment: ChromeConnectEnvironment;
  readonly onClose: () => void;
  readonly onSignedIn: (outcome: AppliedSignIn) => void;
  readonly sessionId: string;
  readonly site: string;
  readonly url: string;
  /** The session's Workspace: the one whose agents may then use the site. */
  readonly workspaceId: string;
  readonly workspaceName: string;
}) {
  return (
    <Popover
      anchor={anchor}
      className="popover--sign-in"
      label={`Sign in to ${browserSiteLabel(site)} with Chrome`}
      onClose={onClose}
      role="dialog"
    >
      <BrowserSignInPanel
        client={client}
        environment={environment}
        onSignedIn={(outcome) => {
          onClose();
          onSignedIn(outcome);
        }}
        sessionId={sessionId}
        site={site}
        url={url}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
      />
    </Popover>
  );
}

export function BrowserSignInPanel({
  client,
  environment,
  onSignedIn,
  sessionId,
  site,
  url,
  workspaceId,
  workspaceName,
}: {
  readonly client: BrowserSignInClient;
  readonly environment: ChromeConnectEnvironment;
  readonly onSignedIn: (outcome: AppliedSignIn) => void;
  readonly sessionId: string;
  readonly site: string;
  readonly url: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
}) {
  const { error: checkError, inspection, refresh } = useChromeInspection(client, site, true);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A failed sign-in's answer, shown until a later inspection reads Chrome
  // differently: from then on the live reading is the truer one.
  const [failed, setFailed] = useState<FailedSignIn | null>(null);
  const [preferredId, setPreferredId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ readonly key: string; readonly sourceId: string } | null>(null);
  const titleId = useId();
  const groupName = useId();
  const domain = browserSiteLabel(site);

  // The Chrome this Workspace last used for the site is offered first.
  useEffect(() => {
    let active = true;
    void client.rpc["browser.sources.get"]({})
      .then(unwrapRpcResult)
      .then((state) => {
        if (active) setPreferredId(browserSitePreferredSource(state, workspaceId, site));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, site, workspaceId]);

  useEffect(() => {
    if (!failed || !inspection) return;
    const reading = inspectionReading(inspection);
    if (failed.reading === null) setFailed({ ...failed, reading });
    else if (failed.reading !== reading) setFailed(null);
  }, [failed, inspection]);

  const availability = inspection
    ? chromeSignInAvailability(inspection, { offlineCounts: false })
    : null;
  const choices = availability?.kind === "choices" ? availability.choices : [];
  const chosen =
    choices.find((choice) => choice.sourceId === chosenId) ??
    choices.find((choice) => choice.sourceId === preferredId) ??
    choices[0] ??
    null;
  const outcome = failed?.outcome ?? null;

  const signIn = () => {
    if (busy || !chosen) return;
    setBusy(true);
    setError(null);
    setFailed(null);
    // A retry of the same choice after a failed send replays; a different
    // Chrome is a new sign-in.
    if (attempt.current?.sourceId !== chosen.sourceId) {
      attempt.current = {
        key: mutationIdempotencyKey(`browser-sign-in:${sessionId}`),
        sourceId: chosen.sourceId,
      };
    }
    void client
      .dispatch({
        idempotencyKey: attempt.current.key,
        sessionId,
        sourceId: chosen.sourceId,
        type: "browser.session.sign-in",
        url,
      })
      .then((result) => {
        if (result.type !== "browser.session.sign-in") return;
        attempt.current = null;
        if (result.outcome.status === "applied") {
          onSignedIn(result.outcome);
          return;
        }
        setFailed({ outcome: result.outcome, reading: null });
        refresh();
      })
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setBusy(false));
  };

  let state;
  if (outcome?.status === "problem") {
    state = (
      <p className="chrome-pop__problem" role="alert">
        <Icon name="alert-circle" />
        <span>
          {browserSignInProblemMessage(outcome.problem, {
            context: "browser",
            site,
            sourceName: outcome.sourceName,
          })}
        </span>
      </p>
    );
  } else if (availability === null) {
    state = (
      <p className="chrome-pop__line" role="status">
        <span aria-hidden className="spinner" />
        {checkError ?? "Checking Chrome…"}
      </p>
    );
  } else if (availability.kind === "no-chrome") {
    state = (
      <ConnectChrome
        client={client}
        compact
        environment={environment}
        intro="Chrome isn’t connected yet."
        onConnected={refresh}
      />
    );
  } else if (availability.kind === "problem") {
    state = (
      <p className="chrome-pop__problem" role="status">
        <Icon name="alert-circle" />
        <span>
          {browserSignInProblemMessage(availability.problem, {
            context: "browser",
            site,
            sourceName: availability.sourceName,
          })}{" "}
          <span className="chrome-pop__quiet">This updates by itself.</span>
        </span>
      </p>
    );
  } else if (choices.length > 1) {
    state = (
      <fieldset className="browser-choice chrome-pop__choice">
        <legend>Use the sign-in from</legend>
        {choices.map((choice) => (
          <label className="browser-choice__option" key={choice.sourceId}>
            <input
              checked={choice.sourceId === chosen?.sourceId}
              name={groupName}
              onChange={() => setChosenId(choice.sourceId)}
              type="radio"
            />
            <span className="browser-choice__text">
              <span className="browser-choice__label">{choice.name}</span>
            </span>
          </label>
        ))}
      </fieldset>
    );
  }

  return (
    <div aria-labelledby={titleId} className="chrome-pop" role="group">
      <div className="chrome-pop__head">
        <span aria-hidden className="chrome-pop__mark">
          <Icon name="key" />
        </span>
        <p className="chrome-pop__title" id={titleId}>
          Sign in to {domain}
        </p>
      </div>
      <p className="chrome-pop__lead">
        Use your {domain} sign-in from Chrome in this browser. The page reloads signed in.
      </p>
      <div aria-live="polite" className="chrome-pop__state">
        {state}
      </div>
      {error ? (
        <p className="chrome-pop__problem" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      {chosen ? (
        <button
          className="btn btn--primary chrome-pop__go"
          data-autofocus
          disabled={busy}
          onClick={signIn}
          type="button"
        >
          {busy ? <span aria-hidden className="spinner" /> : null}
          {busy ? "Signing in…" : choices.length > 1 ? "Sign in" : `Sign in with ${chosen.name}`}
        </button>
      ) : null}
      <p className="chrome-pop__note">
        Agents in {workspaceName} will be able to use {domain} as you.
      </p>
    </div>
  );
}

interface FailedSignIn {
  readonly outcome: Extract<BrowserSignInOutcome, { status: "problem" }>;
  /** The first inspection read after the failure; null until one arrives. */
  readonly reading: string | null;
}

/** What each Chrome reported, as one comparable value. */
function inspectionReading(inspection: BrowserSourceInspection): string {
  return inspection.candidates
    .map(({ sourceId, status }) => `${sourceId}:${status}`)
    .sort()
    .join(",");
}
