import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon.js";
import {
  releaseHarnessAuthentication,
  startHarnessAuthentication,
  type HarnessAuthenticationRun,
  type HarnessAuthenticationSession,
  type HarnessAuthenticationView,
  type HostClient,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../ui-utils.js";
import { Dialog } from "./dialog.js";
import { ExternalLink } from "./external-link.js";

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

/** A caller that already knows the way in, such as a plan's own sign-in, skips the choice. */
export interface HarnessAuthenticationOptions {
  readonly methodId?: string;
}

export function HarnessAuthenticationDialog({
  client,
  initialMethodId = null,
  onClose,
  onReady,
  placement,
}: {
  readonly client: HostClient;
  readonly initialMethodId?: string | null;
  readonly onClose: () => void;
  readonly onReady: () => void;
  readonly placement: ThreadPlacementOption;
}) {
  const interactiveMethods = placement.setupMethods;
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(
    interactiveMethods.length === 1
      ? interactiveMethods[0]!.methodId
      : (interactiveMethods.find((method) => method.methodId === initialMethodId)?.methodId ??
          null),
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
      <p className="field__hint harness-authentication__account">
        {placement.accountName === placement.engineName
          ? `${placement.source?.label ?? placement.engineName} on ${placement.whereLabel}.`
          : `The account “${placement.accountName}” (${placement.source?.label ?? placement.engineName}) on ${placement.whereLabel}.`}
      </p>
      {!selectedMethod ? (
        <div aria-label="Choose how to connect" className="settings-choice-group" role="group">
          <p className="field__hint">Choose how to connect.</p>
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
          <p className="field__hint" role="status">
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
        <p className="field__hint" role="status">
          Signed in.
        </p>
      );
    case "starting":
      return (
        <div className="card__empty card__empty--loading" role="status">
          <span className="spinner" />
          <span>Starting sign-in on this work location…</span>
        </div>
      );
    default:
      return (
        <div className="card__empty card__empty--loading" role="status">
          <span className="spinner" />
          <span>Preparing secure sign-in…</span>
        </div>
      );
  }
}
