import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addAccountAddressField,
  addAccountChoice,
  addAccountComplete,
  addAccountInitialValues,
  normalizeServerAddress,
  serverAddressProblem,
  type AddAccountChoice,
} from "@opensteer/client/host";
import type { HarnessSourceDescriptor, HarnessSourceField } from "@opensteer/protocol";
import { Dialog } from "../../dialog.js";

/**
 * "Add account" when an engine offers more than one source, or a source that
 * needs something typed before it can be signed in to. The list and the
 * fields are rendered from the engine's own declaration, so a new source
 * reaches this dialog with no change here.
 */
export function AddAccountDialog({
  continued = false,
  engineName,
  onClose,
  onSubmit,
  sources,
  whereLabel,
}: {
  readonly continued?: boolean;
  readonly engineName: string;
  readonly onClose: () => void;
  readonly onSubmit: (choice: AddAccountChoice) => void;
  readonly sources: readonly HarnessSourceDescriptor[];
  /** The work location the account is added to, which is where it connects from. */
  readonly whereLabel: string;
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.sourceId ?? "");
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    addAccountInitialValues(sources[0]),
  );
  // An address is only judged once the person has left it, so typing one out
  // doesn't flash an error at every keystroke on the way.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const source = sources.find((candidate) => candidate.sourceId === sourceId) ?? sources[0];
  const formRef = useRef<HTMLFormElement>(null);
  const switched = useRef(false);
  // A long source list leaves a newly chosen source's fields below the fold.
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    [...(formRef.current?.querySelectorAll(".field") ?? [])].at(-1)?.scrollIntoView({
      block: "nearest",
    });
  }, [sourceId]);
  const trimmed = (field: HarnessSourceField) => (values[field.id] ?? "").trim();
  const complete = source !== undefined && addAccountComplete(source, values);
  const address = addAccountAddressField(source);
  const server = source?.kind === "compatible-endpoint";
  const set = (id: string, value: string) => setValues((current) => ({ ...current, [id]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!source || !complete) return;
    onSubmit(addAccountChoice(source, values));
  };
  return (
    <Dialog
      continued={continued}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!complete}
            form="add-account-form"
            type="submit"
          >
            {server ? "Connect" : "Continue"}
          </button>
        </>
      }
      labelledBy="add-account-title"
      onClose={onClose}
      title={`Add ${engineName} account`}
    >
      <form className="add-account" id="add-account-form" onSubmit={submit} ref={formRef}>
        {sources.length > 1 ? (
          <fieldset className="settings-choice-group add-account__sources">
            <legend className="field__hint">Who should this account talk to?</legend>
            {sources.map((candidate) => (
              <label
                className={`settings-choice${candidate.sourceId === source?.sourceId ? " is-selected" : ""}`}
                key={candidate.sourceId}
              >
                <input
                  checked={candidate.sourceId === source?.sourceId}
                  name="add-account-source"
                  onChange={() => {
                    switched.current = true;
                    setSourceId(candidate.sourceId);
                    setValues(addAccountInitialValues(candidate));
                    setTouched(new Set());
                  }}
                  type="radio"
                  value={candidate.sourceId}
                />
                <span className="settings-choice__copy">
                  <span className="settings-choice__title">{candidate.label}</span>
                  {candidate.detail ? (
                    <span className="settings-choice__detail">{candidate.detail}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
        ) : source?.detail ? (
          <p className="field__hint">{source.detail}</p>
        ) : null}
        {source?.fields.map((field) => {
          const shown = touched.has(field.id) && trimmed(field) !== "";
          const problem =
            field.kind === "url" && shown ? serverAddressProblem(trimmed(field)) : null;
          const hint =
            problem ??
            (server && field === address
              ? `Opensteer connects from ${whereLabel}, so localhost is that computer.`
              : field.detail);
          return (
            <label className="field" key={field.id}>
              <span className="field__label">
                {server && field === address ? "Address" : field.label}
                {field.required === false ? " (optional)" : null}
              </span>
              {field.kind === "select" ? (
                <select
                  className="select-input"
                  id={`add-account-${field.id}`}
                  onChange={(event) => set(field.id, event.target.value)}
                  required={field.required !== false}
                  value={values[field.id] ?? ""}
                >
                  {field.defaultValue === undefined ? (
                    <option disabled={field.required !== false} value="">
                      {field.required === false ? "None" : "Choose…"}
                    </option>
                  ) : null}
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-invalid={problem !== null}
                  autoFocus={
                    source.fields.find((first) => first.kind !== "select")?.id === field.id
                  }
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="text-input"
                  id={`add-account-${field.id}`}
                  inputMode={field.kind === "url" ? "url" : "text"}
                  onBlur={() => {
                    if (field.kind !== "url" || trimmed(field) === "") return;
                    setTouched((current) => new Set(current).add(field.id));
                    if (serverAddressProblem(trimmed(field)) === null)
                      set(field.id, normalizeServerAddress(trimmed(field)));
                  }}
                  onChange={(event) => set(field.id, event.target.value)}
                  placeholder={field.placeholder}
                  required={field.required !== false}
                  spellCheck={false}
                  // Not type="url": the browser would refuse "localhost:11434",
                  // which is how servers print their own address.
                  type="text"
                  value={values[field.id] ?? ""}
                />
              )}
              {hint ? <span className="field__hint">{hint}</span> : null}
            </label>
          );
        })}
      </form>
    </Dialog>
  );
}
