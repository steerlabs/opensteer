/* ---- A tool's input form, from its JSON Schema ---- */

export interface PluginInputField {
  readonly id: string;
  readonly prompt: string;
  readonly description: string | null;
  readonly kind: "text" | "number" | "integer" | "boolean" | "choice" | "choices";
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  readonly required: boolean;
}
export interface PluginInputForm {
  readonly fields: readonly PluginInputField[];
  /** Properties this form cannot render; the person can only decline. */
  readonly unsupported: readonly string[];
}

/** The flat MCP form schema a tool asks with, as fields the app's form components draw. */
export function pluginInputForm(schema: Record<string, unknown>): PluginInputForm {
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((v) => typeof v === "string") : [],
  );
  const fields: PluginInputField[] = [];
  const unsupported: string[] = [];
  for (const [id, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      unsupported.push(id);
      continue;
    }
    const property = raw as Record<string, unknown>;
    const prompt = typeof property.title === "string" && property.title ? property.title : id;
    const description = typeof property.description === "string" ? property.description : null;
    const base = { id, prompt, description, required: required.has(id) };
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((value): value is string => typeof value === "string")
      : null;
    const oneOf = Array.isArray(property.oneOf)
      ? property.oneOf.flatMap((option) =>
          option &&
          typeof option === "object" &&
          typeof (option as { const?: unknown }).const === "string"
            ? [
                {
                  value: (option as { const: string }).const,
                  label:
                    typeof (option as { title?: unknown }).title === "string"
                      ? (option as { title: string }).title
                      : (option as { const: string }).const,
                },
              ]
            : [],
        )
      : null;
    const names = Array.isArray(property.enumNames) ? property.enumNames : [];
    if (property.type === "string" && (enumValues?.length || oneOf?.length)) {
      fields.push({
        ...base,
        kind: "choice",
        choices: oneOf?.length
          ? oneOf
          : enumValues!.map((value, index) => ({
              value,
              label: typeof names[index] === "string" ? (names[index] as string) : value,
            })),
      });
    } else if (property.type === "array") {
      const items = property.items as Record<string, unknown> | undefined;
      const values = Array.isArray(items?.enum)
        ? items.enum.filter((value): value is string => typeof value === "string")
        : Array.isArray(items?.anyOf)
          ? items.anyOf.flatMap((option) =>
              option &&
              typeof option === "object" &&
              typeof (option as { const?: unknown }).const === "string"
                ? [(option as { const: string }).const]
                : [],
            )
          : [];
      if (values.length)
        fields.push({
          ...base,
          kind: "choices",
          choices: values.map((value) => ({ value, label: value })),
        });
      else unsupported.push(id);
    } else if (property.type === "boolean") {
      fields.push({
        ...base,
        kind: "boolean",
        choices: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      });
    } else if (property.type === "number" || property.type === "integer") {
      fields.push({ ...base, kind: property.type, choices: [] });
    } else if (property.type === "string") {
      fields.push({ ...base, kind: "text", choices: [] });
    } else unsupported.push(id);
  }
  return { fields, unsupported };
}

/**
 * The content to send for a form's answers, or why it cannot be sent yet.
 * Answers are the app's form answers: each field's chosen or typed values.
 */
export function pluginInputContent(
  form: PluginInputForm,
  answers: Readonly<Record<string, readonly string[]>>,
):
  | { readonly content: Record<string, string | number | boolean | string[]> }
  | { readonly problem: string } {
  if (form.unsupported.length)
    return { problem: "This form asks for something Opensteer can't show. Decline it instead." };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const field of form.fields) {
    const values = answers[field.id] ?? [];
    const first = values[0]?.trim() ?? "";
    if (!values.length || (field.kind !== "choices" && first === "")) {
      if (field.required) return { problem: `${field.prompt} is required.` };
      continue;
    }
    if (field.kind === "choices") content[field.id] = [...values];
    else if (field.kind === "boolean") content[field.id] = first === "true";
    else if (field.kind === "number" || field.kind === "integer") {
      const number = Number(first);
      if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number)))
        return {
          problem: `${field.prompt} needs ${field.kind === "integer" ? "a whole number" : "a number"}.`,
        };
      content[field.id] = number;
    } else content[field.id] = first;
  }
  return { content };
}
