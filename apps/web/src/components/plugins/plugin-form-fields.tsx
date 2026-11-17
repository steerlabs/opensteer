import { useId } from "react";
import type { PluginInputForm } from "@opensteer/client/plugins";

/**
 * A plugin's JSON Schema form drawn with the same field, row and input
 * components the app uses for a question's form.
 */
export function PluginFormFields({
  answers,
  disabled = false,
  form,
  onChange,
}: {
  readonly answers: Readonly<Record<string, string[]>>;
  readonly disabled?: boolean;
  readonly form: PluginInputForm;
  readonly onChange: (answers: Record<string, string[]>) => void;
}) {
  const id = useId();
  const set = (field: string, values: string[]) => onChange({ ...answers, [field]: values });
  return (
    <>
      {form.fields.map((field, index) => {
        const promptId = `${id}-${field.id}`;
        const selected = answers[field.id] ?? [];
        return (
          <div className="action-form__field" key={field.id}>
            <p className="action-form__prompt" id={promptId}>
              {field.prompt}
              {field.required ? null : <span className="plugin-form__optional"> (optional)</span>}
            </p>
            {field.description ? (
              <p className="plugin-form__description">{field.description}</p>
            ) : null}
            {field.choices.length ? (
              <div aria-labelledby={promptId} className="action-rows" role="group">
                {field.choices.map((choice) => {
                  const checked = selected.includes(choice.value);
                  return (
                    <label
                      className={checked ? "action-row action-row--selected" : "action-row"}
                      key={choice.value}
                    >
                      <input
                        checked={checked}
                        disabled={disabled}
                        name={promptId}
                        onChange={(event) =>
                          field.kind === "choices"
                            ? set(
                                field.id,
                                event.target.checked
                                  ? [...selected, choice.value]
                                  : selected.filter((value) => value !== choice.value),
                              )
                            : set(field.id, [choice.value])
                        }
                        type={field.kind === "choices" ? "checkbox" : "radio"}
                      />
                      <span className="action-row__text">
                        <span className="action-row__label">{choice.label}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <input
                aria-labelledby={promptId}
                autoFocus={index === 0}
                className="text-input"
                disabled={disabled}
                inputMode={
                  field.kind === "number"
                    ? "decimal"
                    : field.kind === "integer"
                      ? "numeric"
                      : undefined
                }
                onChange={(event) => set(field.id, event.target.value ? [event.target.value] : [])}
                placeholder={field.kind === "text" ? "Type your answer…" : "A number"}
                type="text"
                value={selected[0] ?? ""}
              />
            )}
          </div>
        );
      })}
      {form.unsupported.length ? (
        <p className="action-note" role="alert">
          This form also asks for {form.unsupported.join(", ")}, which Opensteer can't show. You can
          only decline it.
        </p>
      ) : null}
    </>
  );
}
