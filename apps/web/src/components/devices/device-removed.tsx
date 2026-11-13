import { useState } from "react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { actionErrorMessage } from "../../ui-utils.js";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { chooseSetUpAgain } from "./device-preferences.js";

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
}: {
  readonly bridge: Pick<OpensteerDesktopBridge, "cancel">;
  readonly deploymentId: string;
  readonly name: string;
  /** Opens setup again, signing in first where this window has no session. */
  readonly onSetUpAgain: () => void | Promise<void>;
  /** The signed leave hasn't reached the Host yet. */
  readonly unconfirmed: boolean;
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
          ? `Signed out here. ${name} confirms the removal the next time this Mac reaches it.`
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
            run(() => {
              chooseSetUpAgain(deploymentId, true);
              return onSetUpAgain();
            })
          }
          type="button"
        >
          Set up again
        </button>
        <button
          className="btn btn--ghost"
          disabled={pending}
          onClick={() => run(() => bridge.cancel())}
          type="button"
        >
          Not now
        </button>
      </div>
    </OnboardingCard>
  );
}
