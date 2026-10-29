import { apiKeyDisclosure } from "@opensteer/client/integrations";
import { useState, type ReactNode } from "react";
import type { AuthMethod } from "@opensteer/integration-core";
import type { IntegrationDefinitionSummaryView } from "@opensteer/integration-core/adapter";

type ApiKeyMethod = Extract<AuthMethod, { kind: "api-key" }>;

/**
 * Definition-driven credential form: the inputs come entirely from the auth
 * method's declared variables, so a new API-key integration needs zero UI
 * work. The Host checks the key against the live service when the definition
 * names a check; failures surface a safe message inline.
 */
export function ApiKeyForm({
  definition,
  displayName: reconnectedName,
  error,
  method,
  onSubmit,
  pending,
  proposed = false,
  secondaryAction,
}: {
  readonly definition: IntegrationDefinitionSummaryView;
  /** The account's current name, when the key reconnects an existing account. */
  readonly displayName?: string;
  readonly error: string | null;
  readonly method: ApiKeyMethod;
  readonly onSubmit: (input: {
    readonly displayName?: string | undefined;
    readonly values: Readonly<Record<string, string>>;
  }) => void;
  readonly pending: boolean;
  readonly proposed?: boolean;
  /** The surface's own other answer, kept in one row with the submit. */
  readonly secondaryAction?: ReactNode;
}) {
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [displayName, setDisplayName] = useState(reconnectedName ?? "");
  const disclosure = apiKeyDisclosure(definition);
  const complete = method.inputs.every((input) => (values[input.variable] ?? "").trim().length > 0);
  if (disclosure === null) return null;
  return (
    <form
      className="card__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete || pending) return;
        const trimmed = Object.fromEntries(
          method.inputs.map((input) => [input.variable, (values[input.variable] ?? "").trim()]),
        );
        onSubmit({ displayName: displayName.trim() || undefined, values: trimmed });
      }}
    >
      {/* The host stays visible because an agent may have chosen the setup URL. */}
      <p className="field__hint">
        {disclosure.setupInstruction.prefix}
        {disclosure.setupUrl ? (
          <a href={disclosure.setupUrl} rel="noreferrer" target="_blank">
            {new URL(disclosure.setupUrl).host}
          </a>
        ) : null}
        {disclosure.setupInstruction.suffix}
      </p>
      {method.inputs.map((input) => (
        <label className="field" key={input.variable}>
          <span className="field__label">{input.label}</span>
          {input.description ? (
            <span className="field__hint">
              {proposed ? "From the agent’s proposal: " : ""}
              {input.description}
            </span>
          ) : null}
          <input
            autoComplete="off"
            className="text-input"
            onChange={(event) =>
              setValues((current) => ({ ...current, [input.variable]: event.target.value }))
            }
            placeholder={input.placeholder}
            required
            spellCheck={false}
            type={input.secret ? "password" : "text"}
            value={values[input.variable] ?? ""}
          />
        </label>
      ))}
      <label className="field">
        <span className="field__label">Account label (optional)</span>
        <input
          className="text-input"
          maxLength={160}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={`${definition.name} account`}
          value={displayName}
        />
      </label>
      <p className="field__hint">{disclosure.custody}</p>
      <p className="field__hint">{disclosure.check}</p>
      <div className="form-actions">
        {error ? (
          <span className="form-actions__error" role="alert">
            {error}
          </span>
        ) : null}
        {secondaryAction}
        <button className="btn btn--primary" disabled={!complete || pending} type="submit">
          {pending
            ? definition.apiKey?.check
              ? "Checking…"
              : "Saving…"
            : reconnectedName === undefined
              ? `Connect ${definition.name}`
              : "Reconnect account"}
        </button>
      </div>
    </form>
  );
}
