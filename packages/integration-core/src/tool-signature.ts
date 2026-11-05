type JsonSchemaObject = Readonly<Record<string, unknown>>;
type Definitions = Readonly<Record<string, JsonSchemaObject>>;

const definitionReferencePrefix = "#/$defs/";
const maximumObjectDepth = 2;
const maximumSteps = 8;
const maximumVariants = 5;
const encoder = new TextEncoder();

function record(value: unknown): JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonSchemaObject)
    : {};
}

function referenced(reference: string, definitions: Definitions): JsonSchemaObject | undefined {
  if (!reference.startsWith(definitionReferencePrefix)) return undefined;
  const name = reference.slice(definitionReferencePrefix.length).split("/", 1)[0]!;
  return definitions[name.replaceAll("~1", "/").replaceAll("~0", "~")];
}

interface Position {
  /** Objects opened so far; only the outer ones are worth showing. */
  readonly objects: number;
  /** Every step taken, because a definition can reach itself without opening an object. */
  readonly steps: number;
}

function objectType(
  schema: JsonSchemaObject,
  definitions: Definitions,
  { objects, steps }: Position,
): string {
  const properties = Object.entries(record(schema.properties));
  if (properties.length === 0) return "{}";
  if (objects >= maximumObjectDepth) return "{…}";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shown = properties
    .filter(([name]) => required.has(name))
    .map(
      ([name, value]) =>
        `${name}: ${typeText(record(value), definitions, { objects: objects + 1, steps: steps + 1 })}`,
    );
  return `{ ${[...shown, ...(shown.length < properties.length ? ["…"] : [])].join("; ")} }`;
}

function typeText(schema: JsonSchemaObject, definitions: Definitions, position: Position): string {
  if (position.steps > maximumSteps) return "unknown";
  const next = { ...position, steps: position.steps + 1 };
  if (typeof schema.$ref === "string") {
    const target = referenced(schema.$ref, definitions);
    return target ? typeText(target, definitions, next) : "{…}";
  }
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.length <= maximumVariants
      ? schema.enum.map((value) => JSON.stringify(value)).join("|")
      : "string";
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants) && variants.length > 0) {
    if (variants.length > maximumVariants) return "unknown";
    return [
      ...new Set(variants.map((variant) => typeText(record(variant), definitions, next))),
    ].join("|");
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  if (type === "array") return `${typeText(record(schema.items), definitions, next)}[]`;
  if (type === "object" || Object.hasOwn(schema, "properties"))
    return objectType(schema, definitions, position);
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
  const { inputSchema } = input;
  // A catalog shares its definitions; an MCP tool keeps its own in its schema.
  const definitions = {
    ...(record(inputSchema.$defs) as Definitions),
    ...input.definitions,
  };
  const properties = Object.entries(record(inputSchema.properties));
  if (properties.length === 0) return "{}";
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  const start = { objects: 1, steps: 1 };
  const entries = [
    ...properties
      .filter(([name]) => required.has(name))
      .map(([name, value]) => `${name}: ${typeText(record(value), definitions, start)}`),
    ...properties
      .filter(([name]) => !required.has(name))
      .map(([name, value]) => `${name}?: ${typeText(record(value), definitions, start)}`),
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
