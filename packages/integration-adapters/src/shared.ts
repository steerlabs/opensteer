// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/invoke.ts (MIT).
import type { AdapterToolResult } from "@opensteer/integration-core";
import { isRecord } from "@opensteer/shared/isRecord";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 1_048_576;

/** The shared record predicate, in the narrowing form these adapters chain on. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function valueAtPath(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cursor = value;
  for (const segment of path.split(".")) {
    const record = asRecord(cursor);
    if (!record) return undefined;
    cursor = record[segment];
  }
  return cursor;
}

export function stringAtPath(value: unknown, path: string | undefined): string | undefined {
  const found = valueAtPath(value, path);
  if (typeof found === "string" && found.trim()) return found;
  if (typeof found === "number" || typeof found === "bigint") return String(found);
  return undefined;
}

export function errorResult(
  code: Extract<AdapterToolResult, { kind: "error" }>["code"],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AdapterToolResult {
  return { kind: "error", code, message, ...(details ? { details } : {}) };
}

export function timeoutResult(message: string): AdapterToolResult {
  return errorResult("upstream_timeout", message);
}

export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

export function decodeResponseBody(response: Response, bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const isJson =
    contentType === "application/json" ||
    contentType?.endsWith("+json") === true ||
    contentType?.includes("json") === true;
  const isText =
    isJson ||
    contentType?.startsWith("text/") === true ||
    contentType?.includes("xml") === true ||
    contentType === "application/x-www-form-urlencoded";
  if (!isText) {
    return {
      contentType: contentType ?? "application/octet-stream",
      dataBase64: Buffer.from(bytes).toString("base64"),
      size: bytes.byteLength,
    };
  }
  const text = new TextDecoder().decode(bytes);
  if (!isJson) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface JsonSchemaIssue {
  readonly message: string;
  readonly path: string;
}

export function validateJsonSchema(
  schema: unknown,
  value: unknown,
  rootSchema: unknown = schema,
  path = "$",
): readonly JsonSchemaIssue[] {
  const record = asRecord(schema);
  if (!record) return [];
  if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/")) {
    const root = asRecord(rootSchema);
    const defs = asRecord(root?.$defs);
    const target = defs?.[record.$ref.slice("#/$defs/".length)];
    return target ? validateJsonSchema(target, value, rootSchema, path) : [];
  }
  if (Array.isArray(record.anyOf)) {
    const alternatives = record.anyOf.map((entry) =>
      validateJsonSchema(entry, value, rootSchema, path),
    );
    if (!alternatives.some((issues) => issues.length === 0)) {
      return [{ path, message: "must match an allowed schema" }];
    }
  }
  if (Array.isArray(record.oneOf)) {
    const matches = record.oneOf.filter(
      (entry) => validateJsonSchema(entry, value, rootSchema, path).length === 0,
    );
    if (matches.length !== 1) return [{ path, message: "must match exactly one allowed schema" }];
  }
  if (Array.isArray(record.allOf)) {
    const issues = record.allOf.flatMap((entry) =>
      validateJsonSchema(entry, value, rootSchema, path),
    );
    if (issues.length) return issues;
  }
  if (Array.isArray(record.enum) && !record.enum.some((entry) => Object.is(entry, value))) {
    return [{ path, message: "must be one of the allowed values" }];
  }
  const types = Array.isArray(record.type) ? record.type : [record.type];
  const permits = (type: unknown): boolean => {
    if (type === undefined) return true;
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return asRecord(value) !== undefined;
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    return typeof value === type;
  };
  if (!types.some(permits)) {
    return [{ path, message: `must have type ${types.join(" or ")}` }];
  }
  if (typeof value === "string") {
    if (typeof record.minLength === "number" && value.length < record.minLength) {
      return [{ path, message: `must contain at least ${record.minLength} characters` }];
    }
    if (typeof record.maxLength === "number" && value.length > record.maxLength) {
      return [{ path, message: `must contain at most ${record.maxLength} characters` }];
    }
    if (typeof record.pattern === "string" && !new RegExp(record.pattern, "u").test(value)) {
      return [{ path, message: `must match ${record.pattern}` }];
    }
  }
  if (typeof value === "number") {
    if (typeof record.minimum === "number" && value < record.minimum) {
      return [{ path, message: `must be at least ${record.minimum}` }];
    }
    if (typeof record.maximum === "number" && value > record.maximum) {
      return [{ path, message: `must be at most ${record.maximum}` }];
    }
  }
  if (record.type === "array" && Array.isArray(value) && record.items !== undefined) {
    if (typeof record.minItems === "number" && value.length < record.minItems) {
      return [{ path, message: `must contain at least ${record.minItems} items` }];
    }
    if (typeof record.maxItems === "number" && value.length > record.maxItems) {
      return [{ path, message: `must contain at most ${record.maxItems} items` }];
    }
    return value.flatMap((entry, index) =>
      validateJsonSchema(record.items, entry, rootSchema, `${path}[${index}]`),
    );
  }
  if (record.type !== "object" || !asRecord(value)) return [];
  const objectValue = value as Record<string, unknown>;
  const properties = asRecord(record.properties) ?? {};
  const issues: JsonSchemaIssue[] = [];
  for (const required of Array.isArray(record.required) ? record.required : []) {
    if (typeof required === "string" && objectValue[required] === undefined) {
      issues.push({ path: `${path}.${required}`, message: "is required" });
    }
  }
  if (record.additionalProperties === false) {
    for (const key of Object.keys(objectValue)) {
      if (!(key in properties)) issues.push({ path: `${path}.${key}`, message: "is not allowed" });
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (objectValue[key] !== undefined) {
      issues.push(
        ...validateJsonSchema(propertySchema, objectValue[key], rootSchema, `${path}.${key}`),
      );
    }
  }
  return issues;
}
