import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  createPluginAccount,
  forgetPluginOAuthApp,
  linkPluginAccount,
  pluginAccountComplete,
  pluginAccountValues,
  pluginConsentLines,
  pluginLinkableAccounts,
  pluginSignInRetryable,
  readPluginAccountReview,
  type PluginAccountReviewView,
  type PluginRequirementTarget,
} from "@opensteer/client/plugins";
import { usePluginSignIn } from "@opensteer/client/react";
import { pluginSignInSurface } from "../../integrations/plugin-sign-in-surface.js";
import { useShell } from "../app-shell.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { SettingsError } from "../settings/primitives.js";
import { actionErrorMessage } from "../../ui-utils.js";

/**
 * Connecting an account to one plugin requirement: what the person agrees to
 * first, then the ways in. The Host checks the consent again when it links.
 */
export function PluginConnectDialog({
  onClose,
  onLinked,
  target,
}: {
  readonly onClose: () => void;
  readonly onLinked: () => void;
  readonly target: PluginRequirementTarget;
}) {
  const { hostClient } = useShell();
  const [review, setReview] = useState<PluginAccountReviewView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  const titleId = useId();
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    // One round trip for the review; a sign-in is prepared only when it offers one.
    // A change elsewhere re-reads it in place, keeping what the person entered.
    const read = () =>
      void readPluginAccountReview(hostClient, target).then(
        (value) => alive && (setReview(value), setLoadError(null)),
        (error: unknown) => alive && setLoadError(error),
      );
    read();
    const unsubscribe = hostClient.subscribePluginsChanged(read);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [hostClient, target, generation]);
  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      title={
        <span id={titleId}>
          {review ? `Connect ${review.requirement.providerName}` : "Connect an account"}
        </span>
      }
    >
      <div className="plugin-connect">
        <SettingsError message={loadError ? actionErrorMessage(loadError) : null} />
        {review ? (
          <ConnectBody
            onChanged={() => {
              setReview(null);
              setGeneration((value) => value + 1);
            }}
            onLinked={onLinked}
            review={review}
            target={target}
          />
        ) : loadError ? null : (
          <LoadingRows label="Loading what this plugin asks for" rows={3} />
        )}
      </div>
    </Dialog>
  );
}

function ConnectBody({
  onChanged,
  onLinked,
  review,
  target,
}: {
  readonly onChanged: () => void;
  readonly onLinked: () => void;
  readonly review: PluginAccountReviewView;
  readonly target: PluginRequirementTarget;
}) {
  const { hostClient } = useShell();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; changed: boolean } | null>(null);
  const [method, setMethod] = useState(review.methods[0]?.method ?? null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const saved = pluginLinkableAccounts(review);
  const fields = review.methods.find((entry) => entry.method === method)?.fields ?? [];
  const run = (key: string, action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(key);
    setError(null);
    void action()
      .then(onLinked)
      .catch((reason: unknown) =>
        setError({
          message: actionErrorMessage(reason),
          changed:
            typeof reason === "object" &&
            reason !== null &&
            "reason" in reason &&
            reason.reason === "plugin-consent-changed",
        }),
      )
      .finally(() => setPending(null));
  };
  return (
    <>
      <section className="plugin-consent" aria-label="What you agree to">
        <h3 className="plugin-consent__title">What linking agrees to</h3>
        <ul className="plugin-consent__lines">
          {pluginConsentLines({
            consent: review.consent,
            author: review.plugin.author,
            pluginName: review.plugin.name,
            providerName: review.requirement.providerName,
          }).map((line) => (
            <li className={`plugin-consent__line plugin-consent__line--${line.key}`} key={line.key}>
              <Icon
                name={
                  line.key === "sites"
                    ? "globe"
                    : line.key === "credential"
                      ? "key"
                      : line.key === "trust"
                        ? "shield"
                        : "code"
                }
              />
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      </section>
      {error ? (
        <div className="plugin-connect__error">
          <SettingsError message={error.message} />
          {error.changed ? (
            <button className="btn btn--small" onClick={onChanged} type="button">
              Review again
            </button>
          ) : null}
        </div>
      ) : null}
      {review.signIn ? (
        <SignInPart
          onLinked={onLinked}
          providerName={review.requirement.providerName}
          target={target}
        />
      ) : null}
      {saved.length ? (
        <section className="plugin-connect__part">
          <h3>Use a saved account</h3>
          <div className="card">
            {saved.map((account) => (
              <div className="card__row" key={account.id}>
                <span className="card__row-body">
                  <span className="card__row-title">{account.label}</span>
                  {account.linked ? (
                    <span className="card__row-detail">Linked to {review.plugin.name}</span>
                  ) : null}
                </span>
                <span className="card__row-actions">
                  <button
                    className="btn btn--small"
                    disabled={pending !== null}
                    onClick={() =>
                      run(`link:${account.id}`, () =>
                        linkPluginAccount(hostClient, target, account.id, review.consent),
                      )
                    }
                    type="button"
                  >
                    {pending === `link:${account.id}`
                      ? "Linking…"
                      : account.linked
                        ? "Link again"
                        : "Link"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {review.methods.length ? (
        <section className="plugin-connect__part">
          <h3>{saved.length || review.signIn ? "Or add an API key" : "Add an API key"}</h3>
          {review.methods.length > 1 ? (
            <div aria-label="How to connect" className="settings-segmented" role="group">
              {review.methods.map((entry) => (
                <button
                  aria-pressed={entry.method === method}
                  key={entry.method}
                  onClick={() => setMethod(entry.method)}
                  type="button"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}
          <form
            className="plugins-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!method || !pluginAccountComplete(fields, values)) return;
              run("create", () =>
                createPluginAccount(hostClient, {
                  provider: review.requirement.provider,
                  method,
                  fields: pluginAccountValues(fields, values),
                  ...(label.trim() ? { label: label.trim() } : {}),
                  link: { ...target, consent: review.consent },
                }),
              );
            }}
          >
            {fields.map((field) => (
              <label className="plugins-field" key={field.name}>
                <span>
                  {field.title}
                  {field.required ? null : (
                    <span className="plugin-form__optional"> (optional)</span>
                  )}
                </span>
                {field.choices ? (
                  <select
                    className="text-input"
                    onChange={(event) =>
                      setValues({ ...values, [field.name]: event.currentTarget.value })
                    }
                    value={values[field.name] ?? ""}
                  >
                    <option value="">Choose…</option>
                    {field.choices.map((choice) => (
                      <option key={String(choice)} value={String(choice)}>
                        {String(choice)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    autoComplete="off"
                    className="text-input"
                    inputMode={field.type === "string" ? undefined : "decimal"}
                    onChange={(event) =>
                      setValues({ ...values, [field.name]: event.currentTarget.value })
                    }
                    spellCheck={false}
                    type={field.plain || field.type !== "string" ? "text" : "password"}
                    value={values[field.name] ?? ""}
                  />
                )}
                {field.description ? (
                  <span className="plugin-form__description">{field.description}</span>
                ) : null}
              </label>
            ))}
            <label className="plugins-field">
              <span>
                Name<span className="plugin-form__optional"> (optional)</span>
              </span>
              <input
                className="text-input"
                maxLength={120}
                onChange={(event) => setLabel(event.currentTarget.value)}
                placeholder={`My ${review.requirement.providerName} account`}
                value={label}
              />
            </label>
            <div className="action-buttons">
              <button
                className="btn btn--primary"
                disabled={!method || !pluginAccountComplete(fields, values) || pending !== null}
                type="submit"
              >
                {pending === "create" ? "Connecting…" : "Save and link"}
              </button>
            </div>
          </form>
        </section>
      ) : null}
      {!review.methods.length && !saved.length && !review.signIn ? (
        <p className="settings-footnote">
          {review.requirement.providerName} accounts can't be connected from here.
        </p>
      ) : null}
    </>
  );
}

/**
 * Signing in at the provider: the ways the Host prepared, then the browser,
 * then how it ended. Closing the dialog leaves an open sign-in running; only
 * Cancel ends it.
 */
function SignInPart({
  onLinked,
  providerName,
  target,
}: {
  readonly onLinked: () => void;
  readonly providerName: string;
  readonly target: PluginRequirementTarget;
}) {
  const { desktopBridge, hostClient } = useShell();
  const surface = useMemo(
    () => pluginSignInSurface(desktopBridge, hostClient),
    [desktopBridge, hostClient],
  );
  const { flow, state } = usePluginSignIn({ client: hostClient, surface, target, providerName });
  const [ownApp, setOwnApp] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [remember, setRemember] = useState(true);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const linked = state.step === "ended" && state.end.kind === "completed";
  const reported = useRef(false);
  useEffect(() => {
    if (!linked || reported.current) return;
    reported.current = true;
    onLinked();
  }, [linked, onLinked]);
  if (state.step === "preparing")
    return (
      <section className="plugin-connect__part" aria-busy="true">
        <h3>Sign in</h3>
        <p className="settings-footnote">Getting sign-in ready…</p>
      </section>
    );
  if (state.step === "ended") {
    if (state.end.kind === "completed") return null;
    const { end } = state;
    return (
      <section className="plugin-connect__part">
        <h3>Sign in</h3>
        <p className={`notice${end.kind === "cancelled" ? "" : " notice--error"}`} role="status">
          {end.message}
        </p>
        <div className="action-buttons">
          {end.kind === "account-link-required" ? (
            <Link className="btn btn--small" to="/settings/account">
              Link to an Account
            </Link>
          ) : null}
          {pluginSignInRetryable(end) ? (
            <button className="btn btn--small" onClick={() => void flow.prepare()} type="button">
              {end.kind === "review-changed" ? "Review again" : "Try again"}
            </button>
          ) : null}
        </div>
      </section>
    );
  }
  const { choices } = state;
  if (!choices.options.length && !choices.ownApp) return null;
  if (state.step === "waiting")
    return (
      <section className="plugin-connect__part">
        <h3>Sign in</h3>
        <p className="notice notice--accent plugin-engine-notice" role="status">
          <span aria-hidden className="plugin-engine-notice__dot" />
          {desktopBridge
            ? "Finish signing in in your browser. If it offers to open Opensteer, choose it. This updates by itself."
            : "Finish signing in in the tab that opened. This updates by itself."}
        </p>
        <div className="action-buttons">
          <button
            className="btn btn--small btn--ghost"
            disabled={state.cancelling}
            onClick={() => void flow.cancel()}
            type="button"
          >
            {state.cancelling ? "Cancelling…" : "Cancel sign-in"}
          </button>
        </div>
      </section>
    );
  const busy = state.step === "starting";
  const form = choices.ownApp;
  const ready =
    clientId.trim() !== "" && (form?.secret !== "required" || clientSecret.trim() !== "");
  return (
    <section className="plugin-connect__part">
      <h3>Sign in</h3>
      <div className="plugin-connect__methods">
        {choices.options.map((option) => (
          <span className="plugin-connect__method" key={option.key}>
            <button
              className={`btn${option.kind === "one-click" ? " btn--primary" : ""}`}
              disabled={busy || forgetting !== null}
              onClick={() => flow.start({ option })}
              title={option.detail ?? undefined}
              type="button"
            >
              {busy && state.key === option.key ? "Opening…" : option.label}
            </button>
            {option.savedApp ? (
              <button
                aria-label={`Forget ${option.label}`}
                className="btn btn--small btn--ghost"
                disabled={busy || forgetting !== null}
                onClick={() => {
                  const app = option.savedApp!;
                  setForgetting(app);
                  void forgetPluginOAuthApp(hostClient, app)
                    .then(() => flow.prepare())
                    .finally(() => setForgetting(null));
                }}
                type="button"
              >
                {forgetting === option.savedApp ? "Forgetting…" : "Forget"}
              </button>
            ) : null}
          </span>
        ))}
        {form && !ownApp ? (
          <button className="btn" disabled={busy} onClick={() => setOwnApp(true)} type="button">
            Use your own OAuth app
          </button>
        ) : null}
      </div>
      {choices.options[0]?.kind === "one-click" && choices.options[0].detail ? (
        <p className="settings-footnote">{choices.options[0].detail}</p>
      ) : null}
      {form && ownApp ? (
        <form
          className="plugins-form plugin-own-app"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || busy) return;
            flow.start({
              ownApp: {
                clientId,
                ...(form.secret === "none" ? {} : { clientSecret }),
                save: remember,
              },
            });
          }}
        >
          <label className="plugins-field">
            <span>Address to register as the redirect URL</span>
            <input
              className="text-input"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={form.redirectUri}
            />
          </label>
          {form.scopes.length ? (
            <p className="settings-footnote">
              It asks for: <code>{form.scopes.join(" ")}</code>
            </p>
          ) : null}
          <label className="plugins-field">
            <span>Client ID</span>
            <input
              autoComplete="off"
              className="text-input"
              onChange={(event) => setClientId(event.currentTarget.value)}
              spellCheck={false}
              value={clientId}
            />
          </label>
          {form.secret === "none" ? null : (
            <label className="plugins-field">
              <span>
                Client secret
                {form.secret === "optional" ? (
                  <span className="plugin-form__optional"> (optional)</span>
                ) : null}
              </span>
              <input
                autoComplete="off"
                className="text-input"
                onChange={(event) => setClientSecret(event.currentTarget.value)}
                spellCheck={false}
                type="password"
                value={clientSecret}
              />
            </label>
          )}
          <label className="plugin-own-app__remember">
            <input
              checked={remember}
              onChange={(event) => setRemember(event.currentTarget.checked)}
              type="checkbox"
            />
            Remember this app for the next sign-in
          </label>
          <div className="action-buttons">
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => setOwnApp(false)}
              type="button"
            >
              Back
            </button>
            <button className="btn btn--primary" disabled={!ready || busy} type="submit">
              {busy && state.key === "own-app" ? "Opening…" : "Sign in with this app"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
