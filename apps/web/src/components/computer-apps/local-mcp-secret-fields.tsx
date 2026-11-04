import type { LocalMcpSecretField } from "@opensteer/client/integrations";

/** Masked fields for the secrets an MCP server asks its computer's owner for. */
export function LocalMcpSecretFields(props: {
  readonly disabled: boolean;
  readonly fields: readonly LocalMcpSecretField[];
  readonly onChange: (name: string, value: string) => void;
  readonly values: Readonly<Record<string, string>>;
}) {
  return (
    <>
      {props.fields.map((field) => (
        <label className="field" key={field.name}>
          <span className="field__label">{field.title}</span>
          <input
            autoComplete="off"
            className="text-input"
            disabled={props.disabled}
            onChange={(event) => props.onChange(field.name, event.currentTarget.value)}
            placeholder={field.saved ? "Saved. Leave blank to keep it." : undefined}
            spellCheck={false}
            type="password"
            value={props.values[field.name] ?? ""}
          />
          <span className="field__hint">
            {field.description ? `From the plugin: ${field.description} ` : ""}
            {`Its program receives this as ${field.name}.`}
          </span>
        </label>
      ))}
    </>
  );
}
