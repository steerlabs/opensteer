type JsonSchemaObject = Readonly<Record<string, unknown>>;
type Definitions = Readonly<Record<string, JsonSchemaObject>>;

const definitionReferencePrefix = "#/$defs/";
const maximumDepth = 2;
const maximumVariants = 5;
const encoder = new TextEncoder();

function record(value: unknown): JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonSchemaObject)
    : {};
}

function dereferenced(schema: JsonSchemaObject, definitions: Definitions): JsonSchemaObject {
  const reference = schema.$ref;
  if (typeof reference !== "string" || !reference.startsWith(definitionReferencePrefix))
    return schema;
  const name = reference.slice(definitionReferencePrefix.length).split("/", 1)[0]!;
  return definitions[name.replaceAll("~1", "/").replaceAll("~0", "~")] ?? schema;
}

function objectType(schema: JsonSchemaObject, definitions: Definitions, depth: number): string {
  const properties = Object.entries(record(schema.properties));
  if (properties.length === 0) return "{}";
  if (depth >= maximumDepth) return "{…}";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shown = properties
    .filter(([name]) => required.has(name))
    .map(([name, value]) => `${name}: ${typeText(record(value), definitions, depth + 1)}`);
  return `{ ${[...shown, ...(shown.length < properties.length ? ["…"] : [])].join("; ")} }`;
}

function typeText(input: JsonSchemaObject, definitions: Definitions, depth: number): string {
  const schema = dereferenced(input, definitions);
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.length <= maximumVariants
      ? schema.enum.map((value) => JSON.stringify(value)).join("|")
      : "string";
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const types = [
      ...new Set(variants.map((variant) => typeText(record(variant), definitions, depth))),
    ];
    return types.length <= maximumVariants ? types.join("|") : "unknown";
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  if (type === "array") return `${typeText(record(schema.items), definitions, depth)}[]`;
  if (type === "object" || Object.hasOwn(schema, "properties"))
    return objectType(schema, definitions, depth);
  if (type === "integer") return "number";
  return typeof type === "string" ? type : "unknown";
}

/**
 * A tool's top-level arguments as one line of TypeScript, so a search result is
 * enough to call most operations. Required arguments always stay; optional
 * ones are dropped from the end to fit, and `…` marks that the shape was cut.
 * Nested objects show only what they require. `integration_describe` has the rest.
 */
export function integrationToolSignature(
  input: { readonly definitions: Definitions; readonly inputSchema: JsonSchemaObject },
  maximumBytes = 480,
): string {
  const { definitions, inputSchema } = input;
  const properties = Object.entries(record(inputSchema.properties));
  if (properties.length === 0) return "{}";
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  const entries = [
    ...properties
      .filter(([name]) => required.has(name))
      .map(([name, value]) => `${name}: ${typeText(record(value), definitions, 1)}`),
    ...properties
      .filter(([name]) => !required.has(name))
      .map(([name, value]) => `${name}?: ${typeText(record(value), definitions, 1)}`),
  ];
  const render = (shown: readonly string[], cut: boolean) =>
    `{ ${[...shown, ...(cut ? ["…"] : [])].join("; ")} }`;
  let shown = entries.length;
  while (
    shown > required.size &&
    encoder.encode(render(entries.slice(0, shown), shown < entries.length)).length > maximumBytes
  )
    shown -= 1;
  return render(entries.slice(0, shown), shown < entries.length);
}
