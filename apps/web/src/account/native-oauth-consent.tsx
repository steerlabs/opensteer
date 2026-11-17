import { useState } from "react";
import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { consumeNativeOAuthQuery, withoutNativeOAuthQuery } from "./native-oauth-query.js";
import { ErrorNotice, OnboardingCard } from "../components/onboarding-card.js";
import { Icon } from "../components/icon.js";
import { actionErrorMessage } from "../ui-utils.js";

export function useNativeOAuthQuery(): string | null {
  const [query] = useState(() =>
    consumeNativeOAuthQuery(
      window.location,
      (url, state) => window.history.replaceState(state, "", url),
      window.history.state,
    ),
  );
  return query;
}

export function NativeOAuthConsent({
  oauthQuery,
  rpc,
}: {
  readonly oauthQuery: string;
  readonly rpc: Pick<HostClient["rpc"], "auth.native.complete">;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function complete(accept: boolean) {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const { url } = unwrapRpcResult(await rpc["auth.native.complete"]({ accept, oauthQuery }));
      window.history.replaceState(withoutNativeOAuthQuery(window.history.state), "");
      window.location.assign(url);
    } catch (failure) {
      setError(
        `${actionErrorMessage(failure)} Close this browser and start sign-in again in the Opensteer app.`,
      );
      setPending(false);
    }
  }
  return (
    <OnboardingCard
      description="Allow the Opensteer app that sent you here to access this deployment as you?"
      eyebrow="Authorization"
      footnote={
        <>
          <Icon name="shield" />
          <span>
            Approving grants the app your access to this deployment. You can end it any time from
            Settings.
          </span>
        </>
      }
      title="Connect Opensteer"
      titleId="native-authorization-heading"
    >
      <ErrorNotice message={error} />
      <div className="onboarding__form">
        <button
          className="btn btn--primary"
          disabled={pending}
          onClick={() => void complete(true)}
          type="button"
        >
          {pending ? "Authorizing…" : "Allow"}
        </button>
        <button
          className="btn btn--ghost"
          disabled={pending}
          onClick={() => void complete(false)}
          type="button"
        >
          Deny
        </button>
      </div>
    </OnboardingCard>
  );
}
