type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Canonical JSON requires a JSON-serializable value");
  return serialize(JSON.parse(json) as JsonValue);
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry)}`)
    .join(",")}}`;
}
