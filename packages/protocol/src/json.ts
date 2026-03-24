export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface JsonSchema {
  readonly $id?: string;
  readonly $schema?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly enum?: readonly JsonPrimitive[];
  readonly const?: JsonValue;
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly default?: JsonValue;
  readonly examples?: readonly JsonValue[];
}

export const JSON_SCHEMA_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export function defineSchema<TSchema extends JsonSchema>(schema: TSchema): TSchema {
  return schema;
}

export function stringSchema(options: Omit<JsonSchema, "type"> = {}): JsonSchema {
  return defineSchema({
    type: "string",
    ...options,
  });
}

export function numberSchema(options: Omit<JsonSchema, "type"> = {}): JsonSchema {
  return defineSchema({
    type: "number",
    ...options,
  });
}

export function integerSchema(options: Omit<JsonSchema, "type"> = {}): JsonSchema {
  return defineSchema({
    type: "integer",
    ...options,
  });
}

export function literalSchema(
  value: JsonValue,
  options: Omit<JsonSchema, "const"> = {},
): JsonSchema {
  return defineSchema({
    const: value,
    ...options,
  });
}

export function enumSchema(
  values: readonly JsonPrimitive[],
  options: Omit<JsonSchema, "enum"> = {},
): JsonSchema {
  return defineSchema({
    enum: values,
    ...options,
  });
}

export function arraySchema(
  items: JsonSchema,
  options: Omit<JsonSchema, "type" | "items"> = {},
): JsonSchema {
  return defineSchema({
    type: "array",
    items,
    ...options,
  });
}

export function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  options: Omit<JsonSchema, "type" | "properties"> & {
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean | JsonSchema;
  } = {},
): JsonSchema {
  const { required, additionalProperties, ...rest } = options;

  return defineSchema({
    type: "object",
    properties,
    ...rest,
    ...(required === undefined ? {} : { required }),
    ...(additionalProperties === undefined
      ? { additionalProperties: false }
      : { additionalProperties }),
  });
}

export function recordSchema(
  valueSchema: JsonSchema,
  options: Omit<JsonSchema, "type" | "additionalProperties"> = {},
): JsonSchema {
  return defineSchema({
    type: "object",
    additionalProperties: valueSchema,
    ...options,
  });
}

export function oneOfSchema(
  members: readonly JsonSchema[],
  options: Omit<JsonSchema, "oneOf"> = {},
): JsonSchema {
  return defineSchema({
    oneOf: members,
    ...options,
  });
}
