import { useState, type FormEvent } from "react";
import {
  identityPasswordMaxLength,
  identityPasswordMinLength,
  type IdentityConfig,
} from "@opensteer/core";
import { deploymentKindLabel } from "@opensteer/protocol/deployment-status";
import type { InitialOwnerClaimInput, PasswordSignInInput } from "@opensteer/client/host";
import { actionErrorMessage } from "../ui-utils.js";
import { CredentialForm } from "./credential-form.js";
import { ErrorNotice, OnboardingCard, StartupFailure } from "./onboarding-card.js";
import { Icon } from "./icon.js";

interface AsyncFormProps {
  readonly error: string | null;
  readonly pending: boolean;
}

/**
 * A setup link that could not be redeemed. It is the same screen as any other
 * failure to start — the shared one — carrying the only thing particular to
 * this moment: where a fresh link comes from.
 */
export function SetupAdmissionFailure({
  error,
  onRetry,
}: {
  readonly error: string;
  readonly onRetry: () => void;
}) {
  return (
    <StartupFailure
      detail={error}
      eyebrow="First run"
      footnote={
        <>
          <Icon name="help-circle" />
          <span>
            If this link is no longer valid, restart the server and use the setup link it prints.
          </span>
        </>
      }
      onRetry={onRetry}
      retryLabel="Try setup again"
      title="Opensteer couldn’t finish setup"
    />
  );
}

export function PasswordRecovery({
  onReset,
  token,
}: {
  readonly onReset: (token: string, newPassword: string) => Promise<void>;
  readonly token: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || pending) return;
    const values = new FormData(event.currentTarget);
    const newPassword = String(values.get("newPassword") ?? "");
    const confirmation = String(values.get("confirmation") ?? "");
    if (newPassword !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onReset(token, newPassword);
    } catch (reason) {
      setError(actionErrorMessage(reason));
      setPending(false);
    }
  }

  return (
    <OnboardingCard
      description="Resetting your password signs out every device signed in here."
      eyebrow="Account recovery"
      title="Choose a new password"
      titleId="password-recovery-heading"
    >
      {!token ? (
        <p className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>This recovery link is incomplete. Generate a new link on the server.</span>
        </p>
      ) : (
        <form className="onboarding__form" onSubmit={(event) => void submit(event)}>
          <ErrorNotice message={error} />
          <div className="field">
            <label className="field__label" htmlFor="recovery-password">
              New password
            </label>
            <input
              autoComplete="new-password"
              autoFocus
              className="text-input"
              disabled={pending}
              id="recovery-password"
              maxLength={identityPasswordMaxLength}
              minLength={identityPasswordMinLength}
              name="newPassword"
              required
              type="password"
            />
            <p className="field__hint">At least {identityPasswordMinLength} characters.</p>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="recovery-password-confirmation">
              Confirm new password
            </label>
            <input
              autoComplete="new-password"
              className="text-input"
              disabled={pending}
              id="recovery-password-confirmation"
              maxLength={identityPasswordMaxLength}
              minLength={identityPasswordMinLength}
              name="confirmation"
              required
              type="password"
            />
          </div>
          <button className="btn btn--primary" disabled={pending} type="submit">
            {pending ? "Resetting password…" : "Reset password"}
            <Icon name="arrow-right" />
          </button>
        </form>
      )}
    </OnboardingCard>
  );
}

/**
 * The Door: the one access screen every deployment web origin renders. The
 * place's own name is the title — a Door belongs to somewhere — with one muted
 * line saying what and where it is, and then the single relevant action: the
 * owner-account claim on first run, the sign-in form after. By the time
 * someone stands at a Door the choice of place has been made, so it never
 * shows a menu.
 *
 * A setup code appears as a field only when the browser does not already hold
 * one. A loopback deployment (pnpm dev, the packaged Personal runtime) hands
 * the code to the browser in the opening URL, and an operator's setup link
 * carries it too — in both cases the code is spent before this renders. Only
 * someone who arrived at an unclaimed networked deployment without a link is
 * asked to paste the code, and it joins the owner-account form rather than
 * gating it behind a separate screen.
 */
export function HostAccessOnboarding({
  admitted,
  config,
  error,
  onAdmit,
  onClaim,
  onOidc,
  onSignIn,
  pending,
}: AsyncFormProps & {
  /** True once a setup code has been accepted for this browser. */
  readonly admitted: boolean;
  readonly config: IdentityConfig;
  readonly onAdmit: (token: string) => Promise<void>;
  readonly onClaim: (input: InitialOwnerClaimInput) => Promise<void>;
  readonly onOidc: (providerId: string) => Promise<void>;
  readonly onSignIn: (input: PasswordSignInInput) => Promise<void>;
}) {
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const [admissionPending, setAdmissionPending] = useState(false);
  const claiming = config.setupState === "required";
  const needsCode = claiming && !admitted;
  const active = claiming ? "claim" : "sign-in";
  const busy = pending || admissionPending;
  // A deployment with only OIDC cannot fold the claim into one form — the
  // provider redirect needs the admission settled first — so the code is its
  // own step there, on the same Door.
  const codeOnly = needsCode && !config.localPasswordEnabled;

  async function submit(values: FormData) {
    if (needsCode) {
      const token = String(values.get("setupToken") ?? "").trim();
      if (!token) return;
      setAdmissionError(null);
      setAdmissionPending(true);
      try {
        await onAdmit(token);
      } catch (reason) {
        setAdmissionError(actionErrorMessage(reason));
        return;
      } finally {
        setAdmissionPending(false);
      }
    }
    if (codeOnly) return;
    const email = String(values.get("email") ?? "").trim();
    const password = String(values.get("password") ?? "");
    if (!email || !password) return;
    if (active === "claim") await onClaim({ email, password });
    else await onSignIn({ email, password });
  }

  return (
    <OnboardingCard
      description={doorContext(config, active, admitted)}
      eyebrow={active === "claim" ? "First run" : "Welcome back"}
      footnote={
        needsCode ? (
          <>
            <Icon name="key" />
            <span>
              This code can authorize only the first administrator. It is not an account password.
            </span>
          </>
        ) : (
          <>
            <Icon name="shield" />
            <span>
              Credentials travel only to this server’s signed address over this connection.
            </span>
          </>
        )
      }
      title={doorName(config)}
      titleId="host-access-heading"
    >
      <CredentialForm
        busy={busy}
        config={config}
        credentials={config.localPasswordEnabled}
        error={admissionError ?? error}
        fields={
          needsCode ? (
            <div className="field">
              <label className="field__label" htmlFor="host-setup-token">
                One-time setup code
              </label>
              <input
                autoComplete="off"
                autoFocus
                className="text-input"
                disabled={busy}
                id="host-setup-token"
                maxLength={4_096}
                minLength={16}
                name="setupToken"
                required
                spellCheck={false}
                type="password"
              />
            </div>
          ) : null
        }
        idPrefix="host"
        mode={active === "claim" ? "create" : "sign-in"}
        onOidc={(providerId) => void onOidc(providerId)}
        onSubmit={(values) => void submit(values)}
        pendingLabel={
          codeOnly
            ? "Checking code…"
            : active === "claim"
              ? "Creating the owner account…"
              : "Signing in…"
        }
        providers={!needsCode}
        submitLabel={
          codeOnly ? "Continue" : active === "claim" ? "Create the owner account" : "Sign in"
        }
      />
    </OnboardingCard>
  );
}

/**
 * A Door is titled with the place's name. A place nobody has named yet still
 * has an honest identity: its kind, or for a self-hosted server the hostname
 * the visitor can see in their address bar.
 */
function doorName(config: IdentityConfig): string {
  if (config.deployment.name) return config.deployment.name;
  // A self-hosted server has no honest generic name, so the visitor's own
  // address bar supplies one. Every other kind names itself once, shared.
  if (config.deployment.kind === "self-hosted") {
    return originHostname(config.publicOrigin) ?? "Opensteer";
  }
  return deploymentKindLabel(config.deployment.kind);
}

/** One muted line saying what and where this place is. */
function doorContext(
  config: IdentityConfig,
  active: "claim" | "sign-in",
  admitted: boolean,
): string {
  const kind = config.deployment.kind;
  if (active === "claim") {
    if (kind === "development") {
      return admitted
        ? "Development, started by pnpm dev. The setup code was supplied automatically."
        : "Development, started by pnpm dev.";
    }
    if (kind === "personal") return "Set up Opensteer on this computer.";
    if (kind === "self-hosted") return "Set up Opensteer on this server.";
    return "Set up Opensteer here.";
  }
  if (kind === "development") return "Development";
  if (kind === "personal") {
    return reachedThroughRemoteRoute(config) ? "Your computer · opened remotely" : "Your computer";
  }
  return "Server";
}

/**
 * A Personal deployment answers on its own machine and, when Connect is on,
 * through a remote route. Which side of that Door the visitor stands on is
 * visible from the browser alone: the address bar origin either is the
 * deployment's canonical origin or it is the route's.
 */
function reachedThroughRemoteRoute(config: IdentityConfig): boolean {
  if (typeof window === "undefined") return false;
  const canonical = originHostname(config.publicOrigin);
  return canonical !== null && window.location.hostname !== canonical;
}

function originHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
