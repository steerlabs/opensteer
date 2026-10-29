import { useEffect, useState } from "react";
import type { HostClient } from "@opensteer/client/host";
import {
  IntegrationAuthorizationAttemptIdSchema,
  integrationAuthorizationError,
  waitForIntegrationAuthorization,
} from "@opensteer/client/integrations";
import { actionErrorMessage } from "../ui-utils.js";
import { ErrorNotice, OnboardingCard } from "./onboarding-card.js";

type CompletionState =
  | { readonly kind: "opening" }
  | { readonly kind: "opening-timeout" }
  | { readonly kind: "checking" }
  | { readonly kind: "completed" }
  | { readonly kind: "terminal-error"; readonly message: string }
  | { readonly kind: "read-error"; readonly message: string }
  | { readonly kind: "invalid" };

/**
 * The browser tab that hosts a provider authorization round trip.
 *
 * It begins life without an attempt id so the source tab can open it during a
 * user gesture. The provider return adds only the opaque id; this page then
 * asks the authenticated Host for the durable result.
 */
export function IntegrationAuthorizationCompletion({
  client,
  integrationAttempt,
}: {
  readonly client: Pick<HostClient, "rpc">;
  readonly integrationAttempt: string | null;
}) {
  const parsedAttempt = IntegrationAuthorizationAttemptIdSchema.safeParse(integrationAttempt);
  const attemptId = parsedAttempt.success ? parsedAttempt.data : null;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<CompletionState>(() =>
    integrationAttempt === null
      ? { kind: "opening" }
      : attemptId
        ? { kind: "checking" }
        : { kind: "invalid" },
  );

  useEffect(() => {
    if (!attemptId) {
      if (integrationAttempt !== null) {
        setState({ kind: "invalid" });
        return;
      }
      setState({ kind: "opening" });
      const timeout = window.setTimeout(() => setState({ kind: "opening-timeout" }), 45_000);
      return () => window.clearTimeout(timeout);
    }
    const controller = new AbortController();
    setState({ kind: "checking" });
    void waitForIntegrationAuthorization({ attemptId, client, signal: controller.signal })
      .then((status) => {
        if (controller.signal.aborted) return;
        const error = integrationAuthorizationError(status.status, status.failureCode);
        setState(error ? { kind: "terminal-error", message: error } : { kind: "completed" });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: "read-error", message: actionErrorMessage(reason) });
        }
      });
    return () => controller.abort();
  }, [attemptId, client, integrationAttempt, retry]);

  if (state.kind === "opening") {
    return (
      <OnboardingCard
        description="Waiting for Opensteer to start the provider authorization."
        eyebrow="Authorization"
        title="Opening authorization…"
        titleId="integration-authorization-heading"
      />
    );
  }

  if (state.kind === "checking") {
    return (
      <OnboardingCard
        description="Checking the authorization result with this Opensteer deployment."
        eyebrow="Authorization"
        title="Finishing authorization…"
        titleId="integration-authorization-heading"
      />
    );
  }

  if (state.kind === "opening-timeout") {
    return (
      <OnboardingCard
        description="Return to your original Opensteer tab and try again."
        eyebrow="Authorization"
        footnote="This tab did not cancel an authorization that may still be in progress."
        title="Authorization didn’t open"
        titleId="integration-authorization-heading"
      />
    );
  }

  if (state.kind === "completed") {
    return (
      <OnboardingCard
        description="Return to your original Opensteer tab to finish setting up this connection."
        eyebrow="Authorization"
        footnote="You can close this tab."
        title="Account authorization complete"
        titleId="integration-authorization-heading"
      />
    );
  }

  if (state.kind === "invalid") {
    return (
      <OnboardingCard
        description="Return to your original Opensteer tab and start the connection again."
        eyebrow="Authorization"
        title="This authorization link is invalid"
        titleId="integration-authorization-heading"
      />
    );
  }

  return (
    <OnboardingCard
      description="Return to your original Opensteer tab to continue."
      eyebrow="Authorization"
      footnote="You can close this tab."
      title={
        state.kind === "read-error"
          ? "We couldn’t check the authorization"
          : "Authorization wasn’t completed"
      }
      titleId="integration-authorization-heading"
    >
      <ErrorNotice message={state.message} />
      {state.kind === "read-error" ? (
        <div className="onboarding__actions">
          <button
            className="btn btn--primary onboarding__primary"
            onClick={() => setRetry((value) => value + 1)}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}
    </OnboardingCard>
  );
}
