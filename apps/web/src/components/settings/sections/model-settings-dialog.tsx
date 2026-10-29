import { useState, type FormEvent } from "react";
import type { HarnessModelDescriptor, HarnessModelSettings } from "@opensteer/protocol";
import {
  mutationIdempotencyKey,
  type EnvironmentSummary,
  type HarnessSummary,
  type HostClient,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../../../ui-utils.js";
import { Dialog } from "../../dialog.js";

/** The largest limit the Host accepts, so a typo is refused here rather than there. */
const maxTokens = 10_000_000;
/**
 * The smallest context worth saving: below this the engine's instructions and
 * tools alone overflow it, so the model could never answer.
 */
const minContextTokens = 1_024;
/** Beyond this many models a list is searched rather than scrolled. */
const searchThreshold = 8;

type HarnessCatalog = EnvironmentSummary["harnessCatalogs"][number];

/** The id the endpoint answers to, which is what a limit is saved under. */
function nativeId(model: HarnessModelDescriptor): string {
  return model.nativeModelId ?? model.modelId;
}

/**
 * A context size as people write it: "32768", "32,768" or "32k". A "k" is
 * 1,024 tokens, which is how servers and model cards count them.
 */
export function parseContextSize(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(k)?$/iu.exec(text.replace(/[\s,_]/gu, ""));
  if (!match) return null;
  const value = Math.round(Number(match[1]) * (match[2] ? 1_024 : 1));
  return Number.isSafeInteger(value) && value >= minContextTokens && value <= maxTokens
    ? value
    : null;
}

function tokens(value: number): string {
  return `${value.toLocaleString("en-US")} tokens`;
}

/** Whether nothing but a context size stands between this model and a Run. */
function needsContext(model: HarnessModelDescriptor): boolean {
  return model.needsContextWindow === true;
}

/** Which models lead: the ones waiting on the person, then usable, then the server's to fix. */
function rank(model: HarnessModelDescriptor): number {
  if (needsContext(model)) return 0;
  return model.unavailableReason ? 2 : 1;
}

/**
 * The models one server account reports, and the context size each runs
 * with. A server does not always say how much context it loads a model with,
 * and a guessed number either wastes the model or overflows it, so a model
 * without one waits here for the person to say rather than reaching the
 * composer.
 */
export function ModelSettingsDialog({
  catalog,
  client,
  connected,
  onClose,
  onRefresh,
  profile,
}: {
  /** The account's catalog as it is now; a save sends it back to "preparing". */
  readonly catalog: HarnessCatalog | undefined;
  readonly client: Pick<HostClient, "dispatch">;
  /** Whether the account's computer is reachable at all. */
  readonly connected: boolean;
  readonly onClose: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly profile: HarnessSummary;
}) {
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // A save re-reads the server, so the list is the last one it answered with
  // until it answers again; the dialog never empties out under the person.
  const [models, setModels] = useState<readonly HarnessModelDescriptor[]>(
    catalog?.status === "ready" ? catalog.models : [],
  );
  const current = connected && catalog?.status === "ready";
  if (current && catalog.models !== models) setModels(catalog.models);
  const overrides = profile.modelSettings ?? {};
  const needle = query.trim().toLocaleLowerCase();
  // The order is set when the dialog opens: a model that was just given a size
  // stays where the person was looking instead of jumping down the list.
  const [order] = useState<ReadonlyMap<string, number>>(
    () =>
      new Map(
        [...models]
          .sort((left, right) => rank(left) - rank(right))
          .map((model, index) => [nativeId(model), index]),
      ),
  );
  const position = (model: HarnessModelDescriptor) =>
    order.get(nativeId(model)) ?? order.size + rank(model);
  const listed = [...models]
    .sort((left, right) => position(left) - position(right))
    .filter(
      (model) =>
        needle === "" ||
        [model.displayName, nativeId(model)].some((value) =>
          value.toLocaleLowerCase().includes(needle),
        ),
    );
  const waiting = models.some(needsContext);

  const save = (model: HarnessModelDescriptor, settings: HarnessModelSettings | null) =>
    client.dispatch({
      environmentId: profile.environmentId,
      harnessInstanceId: profile.id,
      idempotencyKey: mutationIdempotencyKey(`harness-model:${profile.id}:${nativeId(model)}`),
      nativeModelId: nativeId(model),
      settings,
      type: "harness.model.configure",
    });

  const refresh = () => {
    setRefreshing(true);
    setRefreshError(null);
    onRefresh()
      .catch((error: unknown) => setRefreshError(actionErrorMessage(error)))
      .finally(() => setRefreshing(false));
  };

  return (
    <Dialog
      footer={
        <button className="btn btn--primary" onClick={onClose} type="button">
          Done
        </button>
      }
      labelledBy="model-settings-title"
      onClose={onClose}
      title={`${profile.name} models`}
      wide
    >
      {waiting ? (
        <p className="form-hint">
          Your server doesn’t report the context size for some models. Enter the size it runs each
          one with to start using it.
        </p>
      ) : null}
      {current ? null : (
        <CatalogNotice
          catalog={catalog}
          connected={connected}
          onRefresh={refresh}
          refreshError={refreshError}
          refreshing={refreshing}
        />
      )}
      {models.length > searchThreshold ? (
        <input
          aria-label="Search models"
          className="text-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          type="search"
          value={query}
        />
      ) : null}
      {models.length === 0 ? (
        // Opened before the server has answered: what the person saved is
        // shown as it stands, and nothing here can be edited.
        Object.keys(overrides).length > 0 ? (
          <ul className="model-settings">
            {Object.entries(overrides).map(([id, settings]) => (
              <li className="model-settings__row" key={id}>
                <span className="model-settings__name">{id}</span>
                <span className="model-settings__value">{tokens(settings.contextWindow)}</span>
              </li>
            ))}
          </ul>
        ) : null
      ) : (
        <ul className="model-settings">
          {listed.map((model) => (
            <ModelRow
              editable={current}
              first={model === listed.find(needsContext)}
              key={nativeId(model)}
              model={model}
              onSave={(settings) => save(model, settings)}
              override={
                Object.hasOwn(overrides, nativeId(model)) ? overrides[nativeId(model)] : undefined
              }
            />
          ))}
          {listed.length === 0 ? (
            <li className="card__empty">No models match “{query.trim()}”.</li>
          ) : null}
        </ul>
      )}
    </Dialog>
  );
}

/**
 * One model: its name, and either the context size it runs with, a field to
 * give it one, or why the server won't run it. Saving belongs to the row, so
 * one model being saved never locks the others.
 */
function ModelRow({
  editable,
  first,
  model,
  onSave,
  override,
}: {
  readonly editable: boolean;
  /** The first model waiting on a size, which takes the focus when the dialog opens. */
  readonly first: boolean;
  readonly model: HarnessModelDescriptor;
  readonly onSave: (settings: HarnessModelSettings | null) => Promise<unknown>;
  readonly override: HarnessModelSettings | undefined;
}) {
  const asking = needsContext(model) && override === undefined;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = editable && (asking || draft !== null);
  const text = draft ?? "";
  const value = parseContextSize(text);
  const id = nativeId(model);
  const inputId = `model-context-${id}`;
  // The saved number is what the person last said; until the server is read
  // again with it, the catalog still describes the model without one.
  const shown = override?.contextWindow ?? model.contextWindow;
  const checking = override !== undefined && needsContext(model);

  const commit = (settings: HarnessModelSettings | null) => {
    setSaving(true);
    setError(null);
    onSave(settings)
      .then(() => setDraft(null))
      .catch((cause: unknown) => setError(actionErrorMessage(cause)))
      .finally(() => setSaving(false));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (value === null || saving) return;
    // An output limit saved earlier still holds while it fits the new size.
    const output = override?.maxOutputTokens;
    commit({
      contextWindow: value,
      ...(output !== undefined && output < value ? { maxOutputTokens: output } : {}),
    });
  };

  return (
    <li className={`model-settings__row${asking ? " is-waiting" : ""}`}>
      <span className="model-settings__name">
        <span className="model-settings__title">{model.displayName}</span>
        {id !== model.displayName ? <span className="model-settings__id">{id}</span> : null}
      </span>
      {editing ? (
        <form className="model-settings__form" onSubmit={submit}>
          <label className="visually-hidden" htmlFor={inputId}>
            Context size for {model.displayName}
          </label>
          <input
            aria-describedby={error ? `${inputId}-error` : undefined}
            aria-invalid={text.trim() !== "" && value === null}
            autoComplete="off"
            autoFocus={!asking || first}
            className="text-input model-settings__input"
            disabled={saving}
            id={inputId}
            inputMode="numeric"
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !asking) {
                event.stopPropagation();
                setDraft(null);
              }
            }}
            placeholder="e.g. 32k"
            value={text}
          />
          <button
            className="btn btn--primary btn--small"
            disabled={value === null || saving}
            type="submit"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {asking ? null : (
            <button
              className="btn btn--ghost btn--small"
              disabled={saving}
              onClick={() => setDraft(null)}
              type="button"
            >
              Cancel
            </button>
          )}
        </form>
      ) : (
        <span className="model-settings__value">
          {model.unavailableReason && !checking ? (
            <span className="model-settings__reason">{model.unavailableReason}</span>
          ) : shown === undefined ? null : (
            tokens(shown)
          )}
          {checking ? <span aria-label="Checking" className="spinner spinner--tiny" /> : null}
          {/* A reason the person's own number caused is theirs to change; one
              the server gives (not loaded, no tools) is fixed on the server. */}
          {editable && !checking && (!model.unavailableReason || override) ? (
            <button
              className="btn btn--ghost btn--small"
              disabled={saving}
              onClick={() => setDraft(shown === undefined ? "" : String(shown))}
              type="button"
            >
              Change
            </button>
          ) : null}
          {editable && !checking && override ? (
            <button
              className="btn btn--ghost btn--small"
              disabled={saving}
              onClick={() => commit(null)}
              title="Remove the size you entered"
              type="button"
            >
              Clear
            </button>
          ) : null}
        </span>
      )}
      {error ? (
        <span className="model-settings__error" id={`${inputId}-error`} role="alert">
          {error}
        </span>
      ) : editing && text.trim() !== "" && value === null ? (
        <span className="model-settings__error">
          Enter a size from {minContextTokens.toLocaleString("en-US")} tokens, like 32768 or 32k.
        </span>
      ) : null}
    </li>
  );
}

/**
 * Why the list is not the server's current answer, and — when it could not
 * answer — the one thing to do about it.
 */
function CatalogNotice({
  catalog,
  connected,
  onRefresh,
  refreshError,
  refreshing,
}: {
  readonly catalog: HarnessCatalog | undefined;
  readonly connected: boolean;
  readonly onRefresh: () => void;
  readonly refreshError: string | null;
  readonly refreshing: boolean;
}) {
  if (!connected) {
    return (
      <div className="notice notice--warn" role="status">
        This computer is offline. Its models can’t be changed until it reconnects.
      </div>
    );
  }
  if (catalog?.status === "error" || catalog?.status === "unavailable") {
    return (
      <div className="notice notice--error" role="alert">
        <div>
          {catalog.detail}
          {refreshError ? ` ${refreshError}` : null}
        </div>
        <button className="btn btn--small" disabled={refreshing} onClick={onRefresh} type="button">
          {refreshing ? "Trying…" : "Try again"}
        </button>
      </div>
    );
  }
  return (
    <div className="notice" role="status">
      {catalog?.status === "authentication-required"
        ? catalog.detail
        : "Checking the server’s models…"}
    </div>
  );
}
