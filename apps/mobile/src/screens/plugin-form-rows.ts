import type { PluginInputForm } from "@opensteer/client/plugins";
import type { NativeSettingsRow } from "./native-settings-page.types.js";

export type PluginFormAnswers = Readonly<Record<string, readonly string[]>>;

/**
 * A plugin's input form as native settings rows: text and numbers as fields,
 * yes or no as a switch, one choice as a picker and several as switches.
 */
export function pluginFormRows(
  form: PluginInputForm,
  answers: PluginFormAnswers,
  onChange: (answers: PluginFormAnswers) => void,
): NativeSettingsRow[] {
  const set = (id: string, values: readonly string[]) => onChange({ ...answers, [id]: values });
  return form.fields.flatMap((field): NativeSettingsRow[] => {
    const label = field.required ? field.prompt : `${field.prompt} (optional)`;
    const values = answers[field.id] ?? [];
    switch (field.kind) {
      case "boolean":
        return [
          {
            key: field.id,
            kind: "toggle",
            label,
            ...(field.description ? { detail: field.description } : {}),
            value: values[0] === "true",
            onChange: (value) => set(field.id, [String(value)]),
          },
        ];
      case "choice":
        return [
          {
            key: field.id,
            kind: "chips",
            label,
            value: values[0] ?? "",
            choices: field.required
              ? field.choices
              : [{ value: "", label: "None" }, ...field.choices],
            onChange: (value) => set(field.id, value ? [value] : []),
          },
        ];
      case "choices":
        return field.choices.map((choice) => ({
          key: `${field.id}:${choice.value}`,
          kind: "toggle" as const,
          label: `${field.prompt}: ${choice.label}`,
          value: values.includes(choice.value),
          onChange: (on: boolean) =>
            set(
              field.id,
              on ? [...values, choice.value] : values.filter((value) => value !== choice.value),
            ),
        }));
      default:
        return [
          {
            key: field.id,
            kind: "input",
            label,
            value: values[0] ?? "",
            onChange: (value) => set(field.id, [value]),
          },
        ];
    }
  });
}
