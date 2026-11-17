import { useEffect, useId, useState } from "react";
import {
  createPluginAccount,
  linkPluginAccount,
  pluginAccountComplete,
  pluginAccountValues,
  pluginConsentLines,
  pluginLinkableAccounts,
  pluginSignInMethods,
  readPluginAccountReview,
  type PluginAccountReviewView,
  type PluginRequirementTarget,
  type PluginSignInMethod,
} from "@opensteer/client/plugins";
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
  const [methods, setMethods] = useState<readonly PluginSignInMethod[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  const titleId = useId();
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    // One round trip for the review; sign-in methods arrive beside it.
    void readPluginAccountReview(hostClient, target).then(
      (value) => alive && setReview(value),
      (error: unknown) => alive && setLoadError(error),
    );
    void pluginSignInMethods(hostClient, target).then(
      (value) => alive && setMethods(value),
      () => alive && setMethods([]),
    );
    return () => {
      alive = false;
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
            methods={methods}
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
  methods,
  onChanged,
  onLinked,
  review,
  target,
}: {
  readonly methods: readonly PluginSignInMethod[];
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
  const [waiting, setWaiting] = useState(false);
  /** An action that resolves `false` started something that finishes elsewhere. */
  const run = (key: string, action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(key);
    setError(null);
    void action()
      .then((value) => (value === false ? setWaiting(true) : onLinked()))
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
      {waiting ? (
        <p className="notice" role="status">
          Finish signing in in the window that opened. This page updates when the account is linked.
        </p>
      ) : null}
      {methods.length ? (
        <section className="plugin-connect__part">
          <h3>Sign in</h3>
          <div className="plugin-connect__methods">
            {methods.map((entry) => (
              <button
                className={`btn${entry.kind === "one-click" ? " btn--primary" : ""}`}
                disabled={entry.unavailable !== null || pending !== null}
                key={entry.id}
                onClick={() =>
                  run(`sign-in:${entry.id}`, async () => {
                    const started = await hostClient.pluginSignIn!.begin({
                      ...target,
                      method: entry.id,
                      consent: review.consent,
                    });
                    // The sign-in finishes in its own window; the link lands as a plugin change.
                    if (started.url === "about:blank") return true;
                    window.open(started.url, "_blank", "noopener");
                    return false;
                  })
                }
                title={entry.unavailable ?? entry.detail ?? undefined}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
          {methods.map((entry) =>
            entry.unavailable ? (
              <p className="settings-footnote" key={entry.id}>
                {entry.unavailable}
              </p>
            ) : null,
          )}
        </section>
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
          <h3>{saved.length || methods.length ? "Or add an API key" : "Add an API key"}</h3>
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
      {!review.methods.length && !saved.length && !methods.length ? (
        <p className="settings-footnote">
          {review.requirement.providerName} accounts are connected by signing in, which this
          Opensteer doesn't offer yet.
        </p>
      ) : null}
    </>
  );
}
