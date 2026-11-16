/**
 * Helpers for the `$defs` of JSON Schema documents, shared by the encodings that send or keep each
 * definition once: an app's shared catalog and a kept tool listing's text.
 */
import type { Schema } from "effect";

/** Add an own entry. Assignment would set the prototype for an entry named `__proto__`. */
export const putEntry = <A>(target: Record<string, A>, name: string, value: A) => {
  if (name === "__proto__")
    Object.defineProperty(target, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  else target[name] = value;
};

type JsonEntries = { readonly [key: string]: Schema.Json };
const isEntries = (value: Schema.Json | undefined): value is JsonEntries =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON Schema document's `$defs`, when it is an object of entries. */
export const schemaDefinitions = (schema: JsonEntries | undefined): JsonEntries | undefined => {
  const definitions = schema?.$defs;
  return isEntries(definitions) ? definitions : undefined;
};
