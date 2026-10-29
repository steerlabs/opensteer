import type { FormEvent, ReactNode } from "react";
import {
  identityPasswordMaxLength,
  identityPasswordMinLength,
  type IdentityConfig,
} from "@opensteer/core";
import { ErrorNotice } from "./onboarding-card.js";
import { Icon } from "./icon.js";

/** Everything a deployment tells the browser about how to get in. */
export type CredentialConfig = Pick<
  IdentityConfig,
  "localPasswordEnabled" | "oidcProviders" | "passkeysEnabled"
>;

/**
 * The way in, wherever the product asks for one: the deployment's own email and
 * password, the providers it federates to, or both with a rule for which is the
 * screen's single primary action.
 *
 * The rule is the point of sharing this. A screen has exactly one primary
 * action. When a password form exists, that action is its submit button and
 * every provider is secondary; when there is no password form, the first
 * configured provider takes the role instead. Both first run and a Workspace
 * invitation obey it because they render the same component.
 *
 * `fields` puts a flow's own inputs — a one-time setup code — inside this form,
 * so a visitor who needs both answers gives them once rather than through two
 * screens. `credentials` turns the email and password off for the case where
 * the extra field is the whole question.
 */
export function CredentialForm({
  busy,
  config,
  credentials,
  error = null,
  fields = null,
  footer = null,
  idPrefix,
  mode,
  onOidc,
  onSubmit,
  pendingLabel,
  providers = true,
  submitLabel,
}: {
  readonly busy: boolean;
  readonly config: CredentialConfig;
  /** Off when the surrounding flow only needs `fields` answered. */
  readonly credentials?: boolean;
  readonly error?: string | null;
  /** Extra inputs, above the credentials and inside the same form. */
  readonly fields?: ReactNode;
  /** A quiet line under the submit button — the account-mode switch. */
  readonly footer?: ReactNode;
  /** Namespaces the field ids so two forms can never collide. */
  readonly idPrefix: string;
  /** "create" applies the new-password floor and says so. */
  readonly mode: "create" | "sign-in";
  readonly onOidc: (providerId: string) => void;
  readonly onSubmit: (values: FormData) => void;
  readonly pendingLabel: string;
  /** Off while a prior step of the same form is still unanswered. */
  readonly providers?: boolean;
  readonly submitLabel: string;
}) {
  const withCredentials = credentials ?? config.localPasswordEnabled;
  const withForm = withCredentials || fields !== null;
  const withProviders = providers && config.oidcProviders.length > 0;
  const creating = mode === "create";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    onSubmit(new FormData(event.currentTarget));
  }

  return (
    <>
      <ErrorNotice message={error} />
      {withForm ? (
        <form className="onboarding__form" onSubmit={submit}>
          {fields}
          {withCredentials ? (
            <>
              <div className="field">
                <label className="field__label" htmlFor={`${idPrefix}-email`}>
                  Email
                </label>
                <input
                  autoComplete={config.passkeysEnabled ? "email webauthn" : "email"}
                  autoFocus={fields === null}
                  className="text-input"
                  disabled={busy}
                  id={`${idPrefix}-email`}
                  maxLength={320}
                  name="email"
                  required
                  type="email"
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${idPrefix}-password`}>
                  Password
                </label>
                <input
                  autoComplete={passwordAutoComplete(creating, config.passkeysEnabled)}
                  className="text-input"
                  disabled={busy}
                  id={`${idPrefix}-password`}
                  maxLength={identityPasswordMaxLength}
                  minLength={creating ? identityPasswordMinLength : 1}
                  name="password"
                  required
                  type="password"
                />
                {creating ? (
                  <p className="field__hint">At least {identityPasswordMinLength} characters.</p>
                ) : null}
              </div>
            </>
          ) : null}
          <button className="btn btn--primary" disabled={busy} type="submit">
            {busy ? pendingLabel : submitLabel}
            <Icon name="arrow-right" />
          </button>
          {footer}
        </form>
      ) : null}
      {withProviders ? (
        <div className="onboarding__form">
          {withForm ? <p className="onboarding__divider">or</p> : null}
          {config.oidcProviders.map((provider, index) => {
            const primary = !withForm && index === 0;
            return (
              <button
                className={primary ? "btn btn--primary" : "btn"}
                disabled={busy}
                key={provider.id}
                onClick={() => onOidc(provider.id)}
                type="button"
              >
                Continue with {provider.label}
                {primary ? <Icon name="arrow-right" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {!withForm && !withProviders ? (
        <p className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>This deployment has no sign-in method configured. Contact its administrator.</span>
        </p>
      ) : null}
    </>
  );
}

/**
 * A deployment with passkeys enabled advertises them on the credential fields so
 * a password manager can offer one; this is a browser hint on existing fields
 * and changes no sign-in flow.
 */
function passwordAutoComplete(creating: boolean, passkeysEnabled: boolean): string {
  if (creating) return "new-password";
  return passkeysEnabled ? "current-password webauthn" : "current-password";
}
