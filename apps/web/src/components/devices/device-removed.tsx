import { DeploymentIdSchema } from "@opensteer/core";
import { useState } from "react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { actionErrorMessage } from "../../ui-utils.js";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { resumeDeviceSignIn } from "./device-setup.js";

/**
 * Where a Mac lands once it is no longer a device of an Opensteer, whichever
 * happened first: its session ended, or its Runner heard it was removed.
 * Nothing signs back in by itself; "Set up again" is the person's choice.
 */
export function DeviceRemovedScreen({
  bridge,
  deploymentId,
  name,
  onSetUpAgain,
  unconfirmed,
  detail,
  onChoose,
}: {
  readonly bridge: Pick<OpensteerDesktopBridge, "cancel" | "setUpDevice" | "select">;
  readonly deploymentId: string;
  readonly name: string;
  /** Opens setup again, signing in first where this window has no session. */
  readonly onSetUpAgain: () => void | Promise<void>;
  /** The signed leave hasn't reached the Host yet. */
  readonly unconfirmed: boolean;
  readonly detail?: string;
  readonly onChoose?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (operation: () => void | Promise<void>) => {
    setPending(true);
    setError(null);
    void Promise.resolve()
      .then(operation)
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  };
  return (
    <OnboardingCard
      bare
      description={
        unconfirmed
          ? (detail ?? `Signed out here. Removal from ${name} is unconfirmed.`)
          : "Your agent can no longer use it. Your files stay on this Mac."
      }
      live
      title={`This Mac was removed from ${name}`}
      titleId="device-removed-title"
    >
      <ErrorNotice message={error} />
      <div className="onboarding__actions device-removed__actions">
        <button
          className="btn btn--primary onboarding__primary"
          disabled={pending}
          onClick={() =>
            run(async () => {
              await resumeDeviceSignIn(bridge, deploymentId);
              await onSetUpAgain();
            })
          }
          type="button"
        >
          Set up again
        </button>
        <button
          className="btn btn--ghost"
          disabled={pending}
          onClick={() => (onChoose ? onChoose() : run(() => bridge.cancel()))}
          type="button"
        >
          Not now
        </button>
      </div>
    </OnboardingCard>
  );
}

export function DeviceSignInScreen({
  bridge,
  deploymentId,
  name,
  confirming = false,
  detail,
  onChoose,
}: {
  readonly bridge: Pick<
    OpensteerDesktopBridge,
    "setUpDevice" | "select" | "retryDeviceConnection" | "leaveDeployment"
  >;
  readonly deploymentId: string;
  readonly name: string;
  readonly confirming?: boolean;
  readonly detail?: string;
  readonly onChoose: () => void;
}) {
  const id = DeploymentIdSchema.parse(deploymentId);
  const [pending, setPending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <OnboardingCard
      bare
      title={confirming ? "Checking this Mac’s connection" : "Sign in again"}
      description={
        confirming
          ? `Waiting for ${name} to confirm this Mac is still a device.`
          : `This Mac is still one of your devices in ${name}.`
      }
      titleId="device-sign-in-title"
    >
      <ErrorNotice message={error} />
      {confirming ? <p role="status">{detail}</p> : null}
      {confirming ? (
        <div className="onboarding__actions device-removed__actions">
          <button
            className="btn btn--primary"
            disabled={pending || retrying}
            type="button"
            onClick={() => {
              setRetrying(true);
              setError(null);
              void bridge
                .retryDeviceConnection({ deploymentId: id })
                .catch((reason: unknown) => setError(actionErrorMessage(reason)))
                .finally(() => setRetrying(false));
            }}
          >
            Retry
          </button>
          <button
            className="btn btn--ghost"
            disabled={pending}
            type="button"
            onClick={() => {
              setPending(true);
              setError(null);
              void bridge
                .leaveDeployment({ deploymentId: id })
                .catch((reason: unknown) => setError(actionErrorMessage(reason)))
                .finally(() => setPending(false));
            }}
          >
            Leave this Opensteer
          </button>
        </div>
      ) : null}
      {!confirming ? (
        <button
          className="btn btn--primary"
          disabled={pending}
          type="button"
          onClick={() => {
            setPending(true);
            setError(null);
            void resumeDeviceSignIn(bridge, deploymentId)
              .catch((reason: unknown) => setError(actionErrorMessage(reason)))
              .finally(() => setPending(false));
          }}
        >
          {pending ? "Signing in…" : "Sign in again"}
        </button>
      ) : null}
      <button className="btn btn--ghost" type="button" onClick={onChoose}>
        Choose an Opensteer
      </button>
    </OnboardingCard>
  );
}
