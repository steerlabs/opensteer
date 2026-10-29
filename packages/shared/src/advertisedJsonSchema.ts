const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaValues = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

function compactSchema(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (key === "$schema" || key === "pattern") return [];
      if (schemaMaps.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(child).map(([name, schema]) => [name, compactSchema(schema)]),
            ),
          ],
        ];
      }
      if (schemaArrays.has(key) && Array.isArray(child)) return [[key, child.map(compactSchema)]];
      if (schemaValues.has(key))
        return [[key, Array.isArray(child) ? child.map(compactSchema) : compactSchema(child)]];
      return [[key, child]];
    }),
  );
}

/**
 * Model-facing schema only; callers validate with the original full schema.
 * `pattern` guards values agents copy from tool results (prefixed IDs, dates
 * already marked by `format`), so it costs context without guiding a call;
 * a malformed value still fails Host validation with the expected format.
 * A root union becomes one object: Anthropic rejects union input roots and
 * Claude Code then drops the tool, while the Host still enforces each variant.
 */
export function advertisedJsonSchema<T extends Record<string, unknown>>(schema: T): T {
  return objectRoot(compactSchema(schema) as Record<string, unknown>) as T;
}

function objectRoot(schema: Record<string, unknown>): Record<string, unknown> {
  if ("allOf" in schema) throw new Error("A tool input root cannot be advertised with allOf");
  const key = "oneOf" in schema ? "oneOf" : "anyOf" in schema ? "anyOf" : undefined;
  if (!key) return schema;
  const { [key]: variants, ...root } = schema;
  if (
    "properties" in root ||
    !Array.isArray(variants) ||
    !variants.every(
      (variant): variant is Record<string, unknown> =>
        !!variant &&
        typeof variant === "object" &&
        !Array.isArray(variant) &&
        (variant as Record<string, unknown>).type === "object",
    )
  ) {
    throw new Error("A tool input root union must hold only object schemas");
  }
  const options = new Map<string, unknown[]>();
  for (const variant of variants) {
    for (const [name, property] of Object.entries(
      (variant.properties ?? {}) as Record<string, unknown>,
    )) {
      const seen = options.get(name) ?? [];
      if (!seen.some((option) => JSON.stringify(option) === JSON.stringify(property))) {
        seen.push(property);
      }
      options.set(name, seen);
    }
  }
  const requiredBy = (variant: Record<string, unknown>) =>
    new Set(Array.isArray(variant.required) ? (variant.required as string[]) : []);
  const required = [...requiredBy(variants[0] ?? {})].filter((name) =>
    variants.every((variant) => requiredBy(variant).has(name)),
  );
  return {
    ...root,
    type: "object",
    ...(variants.every(({ additionalProperties }) => additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
    properties: Object.fromEntries(
      [...options].map(([name, [only, ...rest]]) => [
        name,
        rest.length ? { anyOf: [only, ...rest] } : only,
      ]),
    ),
    ...(required.length ? { required } : {}),
  };
}
