export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalizeJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite JSON number`);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalizeJsonValue(entry, `${path}[${index}]`));
  }

  if (!isPlainObject(value)) {
    throw new TypeError(`${path} must be a plain JSON object`);
  }

  const sorted = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const result: Record<string, JsonValue> = {};

  for (const key of sorted) {
    const entry = value[key];
    if (entry === undefined) {
      throw new TypeError(`${path}.${key} must not be undefined`);
    }

    result[key] = canonicalizeJsonValue(entry, `${path}.${key}`);
  }

  return result;
}

export function toCanonicalJsonValue(value: unknown): JsonValue {
  return canonicalizeJsonValue(value, "value");
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(toCanonicalJsonValue(value));
}

export function stableJsonString(value: unknown): string {
  return `${JSON.stringify(toCanonicalJsonValue(value), null, 2)}\n`;
}
