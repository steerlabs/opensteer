import { homesChooserTitle } from "@opensteer/client/computers";
import { DeploymentIdSchema } from "@opensteer/core";
import { useState } from "react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { act, failureWords } from "../use-action.js";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { resumeDeviceSignIn } from "./device-setup.js";

/** Whichever arrived first, session end or 4010; nothing signs back in by itself. */
export function DeviceRemovedScreen({
  bridge,
  deploymentId,
  name,
  onConnectAgain,
  unconfirmed,
  detail,
  onChoose,
}: {
  readonly bridge: Pick<OpensteerDesktopBridge, "cancel" | "setUpDevice" | "select">;
  readonly deploymentId: string;
  readonly name: string;
  /** Connects again, signing in first where this window has no session. */
  readonly onConnectAgain: () => void | Promise<void>;
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
    void act(null, { label: "do this", done: "done" }, async () => operation())
      .catch((reason: unknown) => setError(failureWords(reason)))
      .finally(() => setPending(false));
  };
  return (
    <OnboardingCard
      bare
      description={
        unconfirmed
          ? (detail ?? `Signed out here. Removal from ${name} is unconfirmed.`)
          : "Your own agents can no longer use it. Your files stay on this Mac."
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
              await act(
                null,
                { label: "sign in", done: "signed in", happened: "you were signed in" },
                () => resumeDeviceSignIn(bridge, deploymentId),
              );
              await onConnectAgain();
            })
          }
          type="button"
        >
          Connect again
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
              void act(
                null,
                { label: "connect again", done: "connected", happened: "this connected again" },
                () => bridge.retryDeviceConnection({ deploymentId: id }),
              )
                .catch((reason: unknown) => setError(failureWords(reason)))
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
              void act(
                null,
                {
                  label: "leave this Opensteer",
                  done: "left",
                  happened: "you left this Opensteer",
                },
                () => bridge.leaveDeployment({ deploymentId: id }),
              )
                .catch((reason: unknown) => setError(failureWords(reason)))
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
              .catch((reason: unknown) => setError(failureWords(reason)))
              .finally(() => setPending(false));
          }}
        >
          {pending ? "Signing in…" : "Sign in again"}
        </button>
      ) : null}
      <button className="btn btn--ghost" type="button" onClick={onChoose}>
        {homesChooserTitle}
      </button>
    </OnboardingCard>
  );
}
