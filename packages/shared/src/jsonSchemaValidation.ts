import { isRecord } from "./isRecord.js";

export interface JsonSchemaIssue {
  readonly message: string;
  readonly path: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** The JSON Schema subset tool and operation schemas use, checked before a call is sent. */
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
