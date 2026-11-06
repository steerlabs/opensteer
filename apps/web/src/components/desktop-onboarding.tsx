import type { CSSProperties } from "react";
import type {
  DesktopDeploymentSummary,
  DesktopPersonalDeploymentStatus,
  DesktopPersonalDeploymentStep,
} from "@opensteer/protocol/desktop";
import { thisComputerLabel } from "../desktop/places.js";
import { Icon } from "./icon.js";
import { SetupFooter, SetupFrame } from "./first-run/setup-frame.js";
import { SetupList, SetupRow, SetupStatus } from "./first-run/setup-list.js";
import { ErrorNotice, OnboardingCard } from "./onboarding-card.js";
import { OptionRow } from "./option-row.js";

/** The words for each step, in the order the supervisor runs them. */
const personalSteps: ReadonlyArray<{
  readonly label: string;
  readonly step: DesktopPersonalDeploymentStep;
}> = [
  { label: "Checking this computer", step: "checking-computer" },
  { label: "Preparing your private database", step: "preparing-database" },
  { label: "Starting Opensteer", step: "starting-host" },
  { label: "Connecting this computer", step: "connecting-computer" },
  { label: "Starting local agents", step: "starting-local-agents" },
  { label: "Creating your workspace", step: "creating-main" },
  { label: "Opening Opensteer", step: "ready" },
];

export function DesktopPersonalLoadFailure({
  accountAvailable,
  detail,
  onAccount,
  onAddDeployment,
}: {
  readonly accountAvailable: boolean;
  readonly detail: string;
  readonly onAccount: () => void;
  readonly onAddDeployment: () => void;
}) {
  return (
    <OnboardingCard
      bare
      description="Opensteer won’t set this computer up again until its existing setup can be read."
      eyebrow="This computer needs attention"
      title="Opensteer on this computer couldn’t be loaded."
    >
      <ErrorNotice message={detail} />
      <div className="desktop-intent-actions">
        {accountAvailable ? (
          <OptionRow
            as="button"
            detail="Open another computer or server while this one is unavailable."
            framed
            leading={
              <span className="option-row__glyph">
                <Icon name="user" />
              </span>
            }
            onClick={onAccount}
            title="Sign in to see your other computers"
            trailing={<Icon name="chevron-right" />}
          />
        ) : null}
      </div>
      <div className="onboarding__rule" />
      <p className="onboarding__switch">
        <button onClick={onAddDeployment} type="button">
          Connect to a server or another computer
        </button>
      </p>
    </OnboardingCard>
  );
}

export function DesktopVerifiedDeployment({
  authorizing,
  deployment,
  error,
  onBack,
  onContinue,
}: {
  readonly authorizing: boolean;
  readonly deployment: DesktopDeploymentSummary;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  return (
    <OnboardingCard
      bare
      description="Opensteer verified this server’s identity. Continue with the sign-in its owner set up."
      eyebrow="Server"
      live
      title={deployment.name}
    >
      <dl className="desktop-verified-identity">
        <div>
          <dt>Verified address</dt>
          <dd>{deployment.canonicalOrigin}</dd>
        </div>
      </dl>
      {/* The identifier proves nothing to a reader and means everything to a
          support transcript, so it stays one disclosure away. */}
      <details className="desktop-verified-diagnostics">
        <summary>Diagnostics</summary>
        <dl className="desktop-verified-identity">
          <div>
            <dt>Identifier</dt>
            <dd>{deployment.id}</dd>
          </div>
        </dl>
      </details>
      <ErrorNotice message={error} />
      {authorizing ? (
        <>
          <div
            aria-atomic="true"
            aria-live="polite"
            className="desktop-account-progress"
            role="status"
          >
            <span className="spinner desktop-account-progress__spinner" />
            <p>Finish signing in in your browser. This window will continue automatically.</p>
          </div>
          {/* The browser tab can die without anything reaching this window —
              closed, refused by the Host, never opened at all — so the wait is
              never the only thing on offer. */}
          <button className="btn btn--ghost onboarding__back" onClick={onContinue} type="button">
            <Icon name="reload" />
            Open the sign-in page again
          </button>
        </>
      ) : (
        <button className="btn btn--primary onboarding__primary" onClick={onContinue} type="button">
          {error ? "Try sign-in again" : "Continue to sign in"}
          <Icon name={error ? "reload" : "arrow-right"} />
        </button>
      )}
      <button className="btn btn--ghost onboarding__back" onClick={onBack} type="button">
        <Icon name="arrow-left" />
        Back
      </button>
    </OnboardingCard>
  );
}

export function DesktopPersonalSetup({
  actionError,
  computerName,
  onBack,
  onRetry,
  requestPending = false,
  status,
}: {
  readonly actionError: string | null;
  /** What this computer is called, so the row keeps its name once the app opens. */
  readonly computerName: string;
  readonly onBack: () => void;
  readonly onRetry: () => void;
  readonly requestPending?: boolean;
  readonly status: DesktopPersonalDeploymentStatus;
}) {
  const error = status.issue?.detail ?? actionError;
  const failed =
    status.state === "degraded" ||
    status.state === "repair-required" ||
    status.state === "update-required" ||
    error !== null;
  const stepIndex = personalStepIndex(status.step);
  const stopped = status.state === "stopped" && !requestPending;
  const canRetry = status.canStart;
  const title =
    status.state === "update-required"
      ? "Opensteer needs an update"
      : status.state === "stopping"
        ? "Stopping this computer"
        : "Setting up Opensteer";
  return (
    <SetupFrame
      description={
        failed || stopped ? null : (
          <span className="setup-frame__progress-step">
            {personalSteps[stepIndex]?.label ?? "Getting ready"}…
          </span>
        )
      }
      footer={
        failed ? (
          <SetupFooter
            action={
              canRetry ? (
                <button className="btn btn--primary" onClick={onRetry} type="button">
                  Try again
                </button>
              ) : null
            }
            onBack={onBack}
          />
        ) : stopped ? (
          <SetupFooter
            action={
              <button className="btn btn--primary" onClick={onRetry} type="button">
                Set up {thisComputerLabel().replace(/^This /u, "this ")}
              </button>
            }
          />
        ) : null
      }
      title={title}
    >
      <SetupList label="This computer">
        <SetupRow
          detail={
            failed ? (
              <span role="alert">{error ?? "Local setup could not be completed."}</span>
            ) : stopped ? null : (
              <span
                aria-hidden
                className="setup-meter"
                style={{ "--setup-meter": `${(stepIndex + 1) / personalSteps.length}` } as CSSProperties}
              />
            )
          }
          icon={<Icon name="laptop" />}
          title={computerName}
          tone={failed ? "attention" : "idle"}
          trailing={failed || stopped ? null : <SetupStatus label="Setting up" state="working" />}
        />
      </SetupList>
      {failed && !canRetry ? (
        <p className="setup-frame__note">
          Update or repair Opensteer, then reopen the app to continue this setup safely.
        </p>
      ) : null}
    </SetupFrame>
  );
}

export function DesktopLoadingScreen({
  error = null,
  onCancel = null,
  pending = false,
}: {
  readonly error?: string | null;
  readonly onCancel?: (() => void) | null;
  readonly pending?: boolean;
} = {}) {
  return (
    <OnboardingCard bare>
      <div aria-live="polite" className="desktop-loading" role="status">
        <span className="spinner" />
        <p>Opening Opensteer…</p>
      </div>
      <ErrorNotice message={error} />
      {onCancel ? (
        <button
          className="btn btn--ghost onboarding__back"
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          <Icon name="arrow-left" />
          {pending ? "Cancelling…" : "Back"}
        </button>
      ) : null}
    </OnboardingCard>
  );
}

export function personalStepIndex(step: DesktopPersonalDeploymentStep | null): number {
  if (step === null) return 0;
  const index = personalSteps.findIndex((candidate) => candidate.step === step);
  return index < 0 ? 0 : index;
}
