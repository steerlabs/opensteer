import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { IdentityConfig, InvitationPreview } from "@opensteer/core";
import {
  unwrapRpcResult,
  type HostClient,
  type PasswordSignInInput,
  type PasswordSignUpInput,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { actionErrorMessage } from "../ui-utils.js";
import { CredentialForm } from "./credential-form.js";
import { ErrorNotice, OnboardingCard } from "./onboarding-card.js";
import { Icon } from "./icon.js";
import { BrandMark } from "./brand.js";

/**
 * The /invite/:selector landing. The verifier rides in the URL fragment (never
 * sent to the server) and is consumed on first render; the path itself is
 * stable through sign-in round trips.
 */
export function InviteRoute({ hostClient }: { hostClient: HostClient }) {
  const { selector } = useParams();
  const navigate = useNavigate();
  const { snapshot } = useHostSnapshot(hostClient);
  const [verifier] = useState(() => {
    const value = window.location.hash.slice(1);
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    return /^[A-Za-z0-9_-]{32,128}$/u.test(value) ? value : "";
  });
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [exchanged, setExchanged] = useState(false);

  useEffect(() => {
    if (!selector || exchanged || snapshot.session === "checking") return;
    setExchanged(true);
    hostClient.rpc["auth.invitation.exchange"]({ selector, verifier })
      .then((result) => setPreview(unwrapRpcResult(result).preview))
      .catch((exchangeError: unknown) => setError(actionErrorMessage(exchangeError)));
  }, [exchanged, hostClient, selector, snapshot.session, verifier]);

  async function finish(action: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await action();
      unwrapRpcResult(await hostClient.rpc["auth.invitation.accept"]({}));
      await hostClient.refresh();
      await navigate("/", { replace: true });
    } catch (finishError) {
      setError(actionErrorMessage(finishError));
    } finally {
      setPending(false);
    }
  }

  if (!preview || !snapshot.identityConfig) {
    // An invitation usually resolves in a beat, so the quiet variant holds the
    // ground rather than flashing a message nobody has time to read. A failure
    // has to be read, so it drops the delay.
    return (
      <main className={error ? "splash" : "splash splash--quiet"}>
        <div className="splash__inner">
          <BrandMark large />
          <p className="splash__detail">{error ?? "Checking this invitation…"}</p>
        </div>
      </main>
    );
  }

  return (
    <InvitationOnboarding
      authenticated={snapshot.session === "authenticated"}
      config={snapshot.identityConfig}
      error={error}
      onAccept={() => finish(async () => undefined)}
      onOidc={async (providerId) => {
        setError(null);
        setPending(true);
        try {
          window.location.assign(
            unwrapRpcResult(
              await hostClient.rpc["auth.oidc.begin"]({
                providerId,
                returnPath: `/invite/${selector ?? ""}`,
              }),
            ).redirectUrl,
          );
        } catch (oidcError) {
          setError(actionErrorMessage(oidcError));
          setPending(false);
        }
      }}
      onSignIn={(input) =>
        finish(async () => {
          unwrapRpcResult(
            await hostClient.rpc["auth.password.signIn"]({
              email: input.email.trim(),
              password: input.password,
            }),
          );
          await hostClient.refresh();
        })
      }
      onSignUp={(input) =>
        finish(async () => {
          unwrapRpcResult(
            await hostClient.rpc["auth.password.signUp"]({
              email: input.email.trim(),
              password: input.password,
            }),
          );
          await hostClient.refresh();
        })
      }
      pending={pending}
      preview={preview}
    />
  );
}

export function InvitationOnboarding({
  authenticated,
  config,
  error,
  onAccept,
  onOidc,
  onSignIn,
  onSignUp,
  pending,
  preview,
}: {
  authenticated: boolean;
  config: IdentityConfig;
  error: string | null;
  onAccept: () => Promise<void>;
  onOidc: (providerId: string) => Promise<void>;
  onSignIn: (input: PasswordSignInInput) => Promise<void>;
  onSignUp: (input: PasswordSignUpInput) => Promise<void>;
  pending: boolean;
  preview: InvitationPreview;
}) {
  const [mode, setMode] = useState<"create" | "sign-in">("create");

  async function submit(values: FormData) {
    const email = String(values.get("email") ?? "").trim();
    const password = String(values.get("password") ?? "");
    if (!email || !password) return;
    if (mode === "create") await onSignUp({ email, password });
    else await onSignIn({ email, password });
  }

  return (
    <OnboardingCard
      description={
        <>
          {preview.inviterName} shared this entire specialist with you as {article(preview.role)}{" "}
          {preview.role}. You’ll see its files, Threads, history, and future agent work.
        </>
      }
      eyebrow="Specialist invitation"
      footnote={
        <>
          <Icon name="key" />
          <span>
            The invite can be used once and expires {formatExpiration(preview.expiresAt)}.
          </span>
        </>
      }
      title={`Join ${preview.workspaceName}`}
      titleId="invitation-heading"
    >
      {preview.requiresVerifiedEmail ? (
        <p className="notice">
          <Icon name="shield" />
          <span>This invitation requires its matching verified company email.</span>
        </p>
      ) : null}
      {authenticated ? (
        <div className="onboarding__form">
          <ErrorNotice message={error} />
          <button
            className="btn btn--primary"
            disabled={pending}
            onClick={() => void onAccept()}
            type="button"
          >
            {pending ? "Joining…" : "Join specialist"}
            <Icon name="arrow-right" />
          </button>
        </div>
      ) : (
        <CredentialForm
          busy={pending}
          config={config}
          error={error}
          footer={
            <p className="onboarding__switch">
              <button
                disabled={pending}
                onClick={() => setMode((current) => (current === "create" ? "sign-in" : "create"))}
                type="button"
              >
                {mode === "create" ? "I already have an account" : "Create a new account"}
              </button>
            </p>
          }
          idPrefix="invite"
          mode={mode}
          onOidc={(providerId) => void onOidc(providerId)}
          onSubmit={(values) => void submit(values)}
          pendingLabel="Working…"
          submitLabel={mode === "create" ? "Create account and join" : "Sign in and join"}
        />
      )}
    </OnboardingCard>
  );
}

function article(role: string): string {
  return /^[aeiou]/iu.test(role) ? "an" : "a";
}

function formatExpiration(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
