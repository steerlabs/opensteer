import type { LocalMcpSecretField } from "@opensteer/client/integrations";
import type { ReactNode } from "react";
import { Field } from "../ui/primitives.js";

/** Masked fields for the secrets an MCP server asks its computer's owner for. */
export function LocalMcpSecretFields(props: {
  readonly disabled: boolean;
  readonly fields: readonly LocalMcpSecretField[];
  readonly onChange: (name: string, value: string) => void;
  readonly values: Readonly<Record<string, string>>;
}): ReactNode {
  return props.fields.map((field) => (
    <Field
      hint={`${field.description ? `From the plugin: ${field.description} ` : ""}Its program receives this as ${field.name}.`}
      hintPosition="before"
      input={{
        autoCapitalize: "none",
        autoComplete: "off",
        autoCorrect: false,
        editable: !props.disabled,
        onChangeText: (value: string) => props.onChange(field.name, value),
        ...(field.saved ? { placeholder: "Saved. Leave blank to keep it." } : {}),
        secureTextEntry: true,
        value: props.values[field.name] ?? "",
      }}
      key={field.name}
      label={field.title}
    />
  ));
}
