import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon.js";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HarnessAuthenticationEnvelope,
  type HostClient,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../ui-utils.js";
import { Dialog } from "./dialog.js";
import { ExternalLink } from "./external-link.js";
import type { HostApiClient } from "@opensteer/protocol";

/** How often the dialog re-reads the envelope while the sign-in is unfinished. */
const harnessAuthenticationPollIntervalMs = 1_500;

/**
 * How often the idempotent ensure POST is repeated while the Runner is
 * connected but the Host has not started the device flow yet. That gap is a
 * tick wide in the normal case; repeating the ensure heals the case where the
 * attempt was lost (Host restart) instead of spinning forever.
 */
export const harnessAuthenticationEnsureIntervalMs = 5_000;

/**
 * How long closing waits for an in-flight ensure POST before sending the cancel
 * anyway. Cancelling has to land after the last ensure — a DELETE that overtakes
 * an in-flight POST is undone by it, and the re-created attempt holds the Cloud
 * Computer awake for its whole window with nobody watching. The bound is what
 * keeps a wedged POST from making the dialog feel stuck instead: past it the
 * cancel goes out regardless, and the worst case is the old race.
 */
const harnessAuthenticationCancelWaitMs = 5_000;

/**
 * What the dialog draws. Every state is either actionable or actively polling —
 * there is no view here that spins without something happening behind it.
 */
export type HarnessAuthenticationView =
  | { readonly kind: "starting" }
  | {
      readonly kind: "pending";
      /** True when a replacement sandbox issued a new code mid-flow. */
      readonly codeReplaced: boolean;
      readonly inputKind?: "code" | "secret";
      readonly inputPrompt?: string;
      readonly userCode: string;
      readonly verificationUrl?: string;
    }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "disconnected" };

/**
 * The view plus the last device code observed. The code outlives the pending
 * view on purpose: a sandbox replacement dips through "not-started" before the
 * new flow starts, and the user may already have typed the old code into
 * ChatGPT, so the replacement still has to be announced when it arrives.
 */
export interface HarnessAuthenticationSession {
  readonly userCode: string | null;
  readonly view: HarnessAuthenticationView;
}

/**
 * Folds one envelope into the session.
 *
 * Authentication outcomes are read first because they are durable facts about
 * the sign-in; the environment status only explains a sign-in that has not
 * started. That ordering keeps "not-started" from ever being the whole story:
 * on a stopped or waking computer it means the wake is in flight, on a
 * connected one it means the Host is about to start the flow, and on an
 * unavailable or disconnected one it means nothing more will happen.
 */
export function nextHarnessAuthenticationSession(
  previous: HarnessAuthenticationSession | null,
  envelope: HarnessAuthenticationEnvelope,
): HarnessAuthenticationSession {
  const view = resolveView(previous, envelope);
  return {
    userCode:
      view.kind === "pending"
        ? view.userCode || (previous?.userCode ?? "")
        : (previous?.userCode ?? null),
    view,
  };
}

/** Whether the dialog stops polling and waits for the person to act. */
export function harnessAuthenticationSettled(view: HarnessAuthenticationView): boolean {
  return view.kind === "ready" || view.kind === "failed" || view.kind === "disconnected";
}

/** Whether a fresh ensure POST is due for a connected-but-not-started flow. */
export function harnessAuthenticationEnsureDue(
  view: HarnessAuthenticationView,
  lastEnsureAt: number,
  now: number,
): boolean {
  return view.kind === "starting" && now - lastEnsureAt >= harnessAuthenticationEnsureIntervalMs;
}

function resolveView(
  previous: HarnessAuthenticationSession | null,
  envelope: HarnessAuthenticationEnvelope,
): HarnessAuthenticationView {
  const { authentication, environmentStatus } = envelope;
  if (authentication.status === "ready") return { kind: "ready" };
  if (authentication.status === "failed") {
    return { detail: authentication.detail, kind: "failed" };
  }
  if (authentication.status === "pending") {
    if (authentication.challenge.kind === "device-code") {
      return {
        codeReplaced: codeWasReplaced(previous, authentication.challenge.userCode),
        inputKind: "code",
        kind: "pending",
        userCode: authentication.challenge.userCode,
        verificationUrl: authentication.challenge.verificationUrl,
      };
    }
    if (authentication.challenge.kind === "browser-code")
      return {
        codeReplaced: false,
        inputKind: "code",
        inputPrompt: authentication.challenge.inputPrompt,
        kind: "pending",
        userCode: "",
        verificationUrl: authentication.challenge.authorizationUrl,
      };
    return {
      codeReplaced: false,
      inputKind: "secret",
      inputPrompt: authentication.challenge.inputLabel,
      kind: "pending",
      userCode: "",
    };
  }
  switch (environmentStatus) {
    case "connected":
      return { kind: "starting" };
    case "disconnected":
      return { kind: "disconnected" };
  }
}

/** Sticky: the notice stays up for as long as the replacement code is shown. */
function codeWasReplaced(previous: HarnessAuthenticationSession | null, userCode: string): boolean {
  if (previous === null || previous.userCode === null) return false;
  if (previous.userCode !== userCode) return true;
  return previous.view.kind === "pending" && previous.view.codeReplaced;
}

/** The slice of the Host client this flow needs, so tests can supply four functions. */
export type HarnessAuthenticationClient = Pick<HostClient, "dispatch" | "refresh"> & {
  readonly rpc: Pick<HostApiClient, "harness.authentication.get">;
};

export interface HarnessAuthenticationRun {
  /** Idempotent; safe from an effect cleanup that races the in-flight request. */
  stop: () => void;
  /**
   * Resolves once the ensure POST that was in flight at the call has settled,
   * or once the wait bound elapses. Never rejects: a failed ensure has settled
   * too, and the caller only needs to know that nothing more is on the wire.
   */
  whenEnsureSettled: () => Promise<void>;
  submit: (value: string) => Promise<void>;
}

/**
 * Drives one sign-in attempt: ensure, then read until the state settles.
 *
 * The loop lives outside React because the interesting behavior is in its
 * timing — the wake is carried by polling rather than by a blocking Host call,
 * and a connected work location that has not started the flow is healed by
 * repeating the ensure rather than by waiting longer.
 */
export function startHarnessAuthentication({
  client,
  connectionSlot,
  environmentId,
  harnessInstanceId,
  methodId,
  now = Date.now,
  onError,
  onReady,
  onSession,
  sleep = defaultSleep,
}: {
  readonly client: HarnessAuthenticationClient;
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  readonly methodId: string;
  readonly connectionSlot?: string;
  readonly now?: () => number;
  readonly onError: (message: string) => void;
  readonly onReady: () => void;
  readonly onSession: (session: HarnessAuthenticationSession) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}): HarnessAuthenticationRun {
  let stopped = false;
  let current: HarnessAuthenticationSession | null = null;
  let lastEnsureAt = 0;
  let inFlightEnsure: Promise<unknown> | null = null;

  const apply = (envelope: HarnessAuthenticationEnvelope) => {
    current = nextHarnessAuthenticationSession(current, envelope);
    onSession(current);
    return current;
  };
  const ensure = async () => {
    lastEnsureAt = now();
    const request = client.dispatch({
      ...(connectionSlot ? { connectionSlot } : {}),
      environmentId,
      harnessInstanceId,
      idempotencyKey: mutationIdempotencyKey(`harness-auth:${harnessInstanceId}`),
      methodId,
      type: "harness.authentication.begin",
    });
    inFlightEnsure = request;
    try {
      const result = await request;
      if (result.type !== "harness.authentication.begin") {
        throw new Error("Harness authentication command mismatch.");
      }
      return apply(result);
    } finally {
      if (inFlightEnsure === request) inFlightEnsure = null;
    }
  };

  const run = async () => {
    try {
      let session = await ensure();
      while (!stopped) {
        if (session.view.kind === "ready") {
          await client.refresh();
          if (!stopped) onReady();
          return;
        }
        if (harnessAuthenticationSettled(session.view)) return;
        await sleep(harnessAuthenticationPollIntervalMs);
        if (stopped) return;
        session = apply(
          unwrapRpcResult(
            await client.rpc["harness.authentication.get"]({ environmentId, harnessInstanceId }),
          ),
        );
        if (stopped) return;
        if (harnessAuthenticationEnsureDue(session.view, lastEnsureAt, now())) {
          session = await ensure();
        }
      }
    } catch (cause) {
      if (!stopped) onError(actionErrorMessage(cause));
    }
  };

  void run();
  return {
    stop: () => {
      stopped = true;
    },
    whenEnsureSettled: async () => {
      const request = inFlightEnsure;
      if (request === null) return;
      await Promise.race([
        request.then(
          () => undefined,
          () => undefined,
        ),
        sleep(harnessAuthenticationCancelWaitMs),
      ]);
    },
    submit: async (value: string) => {
      if (stopped) return;
      const result = await client.dispatch({
        environmentId,
        harnessInstanceId,
        idempotencyKey: mutationIdempotencyKey(`harness-auth:${harnessInstanceId}`),
        type: "harness.authentication.submit",
        value,
      });
      if (result.type !== "harness.authentication.submit") {
        throw new Error("Harness authentication command mismatch.");
      }
      apply(result);
    },
  };
}

/**
 * Ends an attempt from the dialog: stop the loop, let the ensure POST that is
 * already on the wire land, then cancel. The order is the whole point — the
 * Host reads the last request it receives, so a cancel sent while an ensure is
 * in flight can be overwritten by that ensure and leave the sign-in attempt
 * active after the dialog is gone.
 */
export async function releaseHarnessAuthentication({
  client,
  environmentId,
  harnessInstanceId,
  run,
}: {
  readonly client: Pick<HostClient, "dispatch">;
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  readonly run: HarnessAuthenticationRun | null;
}): Promise<void> {
  if (run !== null) {
    run.stop();
    await run.whenEnsureSettled();
  }
  await client.dispatch({
    environmentId,
    harnessInstanceId,
    idempotencyKey: mutationIdempotencyKey(`harness-auth:${harnessInstanceId}`),
    type: "harness.authentication.cancel",
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Copies the one-time code so the person doesn't retype it into the provider's page. */
function CopyValueButton({ value }: { readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );
  if (!globalThis.navigator?.clipboard) return null;
  return (
    <button
      aria-label={copied ? "Code copied" : "Copy code"}
      className="btn btn--small harness-authentication__copy"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          if (resetTimer.current !== null) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => {
            resetTimer.current = null;
            setCopied(false);
          }, 1_500);
        });
      }}
      type="button"
    >
      <Icon name={copied ? "check" : "copy"} />
      {copied ? "Copied" : "Copy code"}
    </button>
  );
}

export function HarnessAuthenticationDialog({
  client,
  onClose,
  onReady,
  placement,
}: {
  readonly client: HostClient;
  readonly onClose: () => void;
  readonly onReady: () => void;
  readonly placement: ThreadPlacementOption;
}) {
  const interactiveMethods = placement.setupMethods;
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(
    interactiveMethods.length === 1 ? interactiveMethods[0]!.methodId : null,
  );
  const selectedMethod = interactiveMethods.find((method) => method.methodId === selectedMethodId);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<HarnessAuthenticationSession | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Closing has to reach the loop that is still running, so the cancel can wait
  // for its in-flight ensure instead of racing it.
  const runRef = useRef<HarnessAuthenticationRun | null>(null);

  useEffect(() => {
    if (!selectedMethod) return;
    setError(null);
    setSession(null);
    const run = startHarnessAuthentication({
      client,
      ...(selectedMethod.connectionSlot ? { connectionSlot: selectedMethod.connectionSlot } : {}),
      environmentId: placement.environmentId,
      harnessInstanceId: placement.harnessInstanceId,
      methodId: selectedMethod.methodId,
      onError: setError,
      onReady,
      onSession: setSession,
    });
    runRef.current = run;
    return () => {
      if (runRef.current === run) runRef.current = null;
      run.stop();
    };
  }, [
    attempt,
    client,
    onReady,
    placement.environmentId,
    placement.harnessInstanceId,
    selectedMethod,
  ]);

  const view = session?.view ?? null;
  const release = () => {
    const run = runRef.current;
    runRef.current = null;
    void releaseHarnessAuthentication({
      client,
      environmentId: placement.environmentId,
      harnessInstanceId: placement.harnessInstanceId,
      run,
    }).catch(() => undefined);
  };
  const close = () => {
    // Closing releases the attempt in every state except the one where it is
    // already gone.
    if (view === null || view.kind !== "ready") release();
    onClose();
  };
  // Cancels the in-flight attempt and returns to the method chooser.
  const backToMethods = () => {
    release();
    setSelectedMethodId(null);
    setSession(null);
    setError(null);
    setCode("");
  };

  return (
    <Dialog
      footer={
        <>
          {interactiveMethods.length > 1 && selectedMethod ? (
            <button className="btn btn--ghost" onClick={backToMethods} type="button">
              Back
            </button>
          ) : null}
          <button className="btn btn--ghost" onClick={close} type="button">
            Cancel
          </button>
          {view?.kind === "pending" && view.verificationUrl ? (
            <ExternalLink
              className="btn btn--primary"
              href={view.verificationUrl}
              onOpenError={(reason) => setError(actionErrorMessage(reason))}
            >
              Continue in browser
            </ExternalLink>
          ) : error !== null || view?.kind === "failed" ? (
            <button
              className="btn btn--primary"
              onClick={() => setAttempt((value) => value + 1)}
              type="button"
            >
              Try again
            </button>
          ) : null}
        </>
      }
      labelledBy="harness-authentication-title"
      onClose={close}
      // A model server takes a key, not a sign-in; its account is the server.
      title={
        placement.source?.kind === "compatible-endpoint"
          ? `Connect ${placement.accountName}`
          : `Sign in to ${placement.engineName}`
      }
    >
      <p className="form-hint harness-authentication__account">
        {placement.accountName === placement.engineName
          ? `${placement.source?.label ?? placement.engineName} on ${placement.whereLabel}.`
          : `The account “${placement.accountName}” (${placement.source?.label ?? placement.engineName}) on ${placement.whereLabel}.`}
      </p>
      {!selectedMethod ? (
        <div aria-label="Choose how to connect" className="settings-choice-group" role="group">
          <p className="form-hint">Choose how to connect.</p>
          {interactiveMethods.map((method) => (
            <button
              className="settings-choice settings-choice--button"
              key={method.methodId}
              onClick={() => setSelectedMethodId(method.methodId)}
              type="button"
            >
              <span className="settings-choice__copy">
                <span className="settings-choice__title">{method.label}</span>
                {method.detail ? (
                  <span className="settings-choice__detail">{method.detail}</span>
                ) : null}
              </span>
              <Icon name="chevron-right" />
            </button>
          ))}
        </div>
      ) : (
        <HarnessAuthenticationBody
          code={code}
          error={error}
          onCodeChange={setCode}
          onSubmit={async () => {
            if (runRef.current === null || code.length === 0) return;
            setSubmitting(true);
            try {
              await runRef.current.submit(code);
              setCode("");
            } catch (cause) {
              setError(actionErrorMessage(cause));
            } finally {
              setSubmitting(false);
            }
          }}
          submitting={submitting}
          view={view}
        />
      )}
    </Dialog>
  );
}

/** Pure rendering of one state; the dialog owns every transition into it. */
export function HarnessAuthenticationBody({
  code = "",
  error,
  onCodeChange = () => undefined,
  onSubmit = async () => undefined,
  submitting = false,
  view,
}: {
  readonly code?: string;
  readonly error: string | null;
  readonly onCodeChange?: (value: string) => void;
  readonly onSubmit?: () => Promise<void>;
  readonly submitting?: boolean;
  readonly view: HarnessAuthenticationView | null;
}) {
  if (error !== null) {
    return (
      <div className="notice notice--error" role="alert">
        {error}
      </div>
    );
  }
  switch (view?.kind) {
    case "pending":
      return (
        <>
          <p>
            {view.inputKind === "secret"
              ? "The secret goes directly to the AI engine on this work location. Opensteer does not save it in the Host."
              : "Continue in your browser and complete the provider's sign-in. Credentials stay on this work location."}
          </p>
          {view.inputPrompt === undefined ? (
            <div className="harness-authentication__code">
              <span>One-time code</span>
              <code>{view.userCode}</code>
              <CopyValueButton value={view.userCode} />
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void onSubmit();
              }}
            >
              <label className="field">
                <span className="field__label">{view.inputPrompt}</span>
                <input
                  autoComplete={view.inputKind === "secret" ? "off" : "one-time-code"}
                  className="text-input"
                  disabled={submitting}
                  onChange={(event) => onCodeChange(event.target.value)}
                  value={code}
                  type={view.inputKind === "secret" ? "password" : "text"}
                />
              </label>
              <button
                className="btn btn--primary"
                disabled={submitting || code.length === 0}
                type="submit"
              >
                {submitting
                  ? "Submitting…"
                  : view.inputKind === "secret"
                    ? "Save credential"
                    : "Submit code"}
              </button>
            </form>
          )}
          {view.codeReplaced ? (
            <div className="notice notice--warn" role="status">
              This work location issued a new code. Any earlier code no longer works — use the one
              above.
            </div>
          ) : null}
          <p className="form-hint" role="status">
            Waiting for sign-in…
          </p>
        </>
      );
    case "failed":
      return (
        <div className="notice notice--error" role="alert">
          {view.detail}
        </div>
      );
    case "disconnected":
      return (
        <div className="notice notice--error" role="alert">
          This work location is not connected, and it cannot be woken from here. Bring its Runner
          back online, then sign in again.
        </div>
      );
    case "ready":
      return (
        <p className="form-hint" role="status">
          Signed in.
        </p>
      );
    case "starting":
      return (
        <div className="empty-state" role="status">
          <span className="spinner" />
          <p>Starting sign-in on this work location…</p>
        </div>
      );
    default:
      return (
        <div className="empty-state" role="status">
          <span className="spinner" />
          <p>Preparing secure sign-in…</p>
        </div>
      );
  }
}
