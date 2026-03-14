import type { JsonSchema, JsonSchemaType, JsonValue } from "./json.js";

export interface JsonSchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  path = "$",
): readonly JsonSchemaValidationIssue[] {
  return validateSchemaNode(schema, value, path);
}

function validateSchemaNode(
  schema: JsonSchema,
  value: unknown,
  path: string,
): JsonSchemaValidationIssue[] {
  const issues: JsonSchemaValidationIssue[] = [];

  if ("const" in schema && !isJsonValueEqual(schema.const, value)) {
    issues.push({
      path,
      message: `must equal ${JSON.stringify(schema.const)}`,
    });
    return issues;
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => isJsonValueEqual(candidate, value))) {
    issues.push({
      path,
      message: `must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`,
    });
    return issues;
  }

  if (schema.oneOf !== undefined) {
    const branchIssues = schema.oneOf.map((member) => validateSchemaNode(member, value, path));
    const validBranches = branchIssues.filter((current) => current.length === 0).length;
    if (validBranches !== 1) {
      issues.push({
        path,
        message:
          validBranches === 0
            ? "must match exactly one supported shape"
            : "matches multiple supported shapes",
      });
      return issues;
    }
  }

  if (schema.anyOf !== undefined) {
    const hasMatch = schema.anyOf.some((member) => validateSchemaNode(member, value, path).length === 0);
    if (!hasMatch) {
      issues.push({
        path,
        message: "must match at least one supported shape",
      });
      return issues;
    }
  }

  if (schema.allOf !== undefined) {
    for (const member of schema.allOf) {
      issues.push(...validateSchemaNode(member, value, path));
    }
    if (issues.length > 0) {
      return issues;
    }
  }

  if (schema.type !== undefined && !matchesSchemaType(schema.type, value)) {
    issues.push({
      path,
      message: `must be ${describeSchemaType(schema.type)}`,
    });
    return issues;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({
        path,
        message: `must have length >= ${String(schema.minLength)}`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({
        path,
        message: `must have length <= ${String(schema.maxLength)}`,
      });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      issues.push({
        path,
        message: `must match pattern ${schema.pattern}`,
      });
    }
    return issues;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({
        path,
        message: `must be >= ${String(schema.minimum)}`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({
        path,
        message: `must be <= ${String(schema.maximum)}`,
      });
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      issues.push({
        path,
        message: `must be > ${String(schema.exclusiveMinimum)}`,
      });
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      issues.push({
        path,
        message: `must be < ${String(schema.exclusiveMaximum)}`,
      });
    }
    return issues;
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({
        path,
        message: `must have at least ${String(schema.minItems)} items`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({
        path,
        message: `must have at most ${String(schema.maxItems)} items`,
      });
    }
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          issues.push({
            path,
            message: "must not contain duplicate items",
          });
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        issues.push(
          ...validateSchemaNode(schema.items, value[index], `${path}[${String(index)}]`),
        );
      }
    }
    return issues;
  }

  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in value)) {
        issues.push({
          path: joinObjectPath(path, requiredKey),
          message: "is required",
        });
      }
    }

    for (const [key, propertyValue] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema !== undefined) {
        issues.push(
          ...validateSchemaNode(propertySchema, propertyValue, joinObjectPath(path, key)),
        );
        continue;
      }

      if (schema.additionalProperties === false) {
        issues.push({
          path: joinObjectPath(path, key),
          message: "is not allowed",
        });
        continue;
      }

      if (
        schema.additionalProperties !== undefined &&
        schema.additionalProperties !== true
      ) {
        issues.push(
          ...validateSchemaNode(
            schema.additionalProperties,
            propertyValue,
            joinObjectPath(path, key),
          ),
        );
      }
    }
  }

  return issues;
}

function matchesSchemaType(
  expected: JsonSchemaType | readonly JsonSchemaType[],
  value: unknown,
): boolean {
  const candidates = Array.isArray(expected) ? expected : [expected];
  return candidates.some((candidate) => matchesSingleSchemaType(candidate, value));
}

function matchesSingleSchemaType(expected: JsonSchemaType, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
  }
}

function describeSchemaType(expected: JsonSchemaType | readonly JsonSchemaType[]): string {
  const candidates = Array.isArray(expected) ? expected : [expected];
  return candidates.join(" or ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function joinObjectPath(base: string, key: string): string {
  return `${base}.${key}`;
}

function isJsonValueEqual(expected: JsonValue | undefined, actual: unknown): boolean {
  if (expected === undefined) {
    return actual === undefined;
  }
  if (
    expected === null ||
    typeof expected === "string" ||
    typeof expected === "number" ||
    typeof expected === "boolean"
  ) {
    return actual === expected;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((entry, index) => isJsonValueEqual(entry, actual[index]))
    );
  }
  if (!isPlainObject(actual)) {
    return false;
  }

  const expectedObject = expected as Record<string, JsonValue>;
  const expectedKeys = Object.keys(expectedObject).sort((left, right) => left.localeCompare(right));
  const actualKeys = Object.keys(actual).sort((left, right) => left.localeCompare(right));
  return (
    expectedKeys.length === actualKeys.length &&
    expectedKeys.every(
      (key, index) =>
        key === actualKeys[index] && isJsonValueEqual(expectedObject[key], actual[key]),
    )
  );
}
