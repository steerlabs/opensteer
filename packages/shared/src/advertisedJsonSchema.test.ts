import { expect, it } from "vitest";
import { advertisedJsonSchema } from "./advertisedJsonSchema.js";

// Failures: mutating full validation schemas, stripping named properties or
// arbitrary default/enum data, dropping constraints, or missing nested branches.
it("removes only schema dialect and regex keywords without mutating the source", () => {
  const schema = {
    $schema: "dialect",
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: { type: "string", pattern: "^x$", minLength: 1, maxLength: 5, default: "x" },
      $schema: { type: "number", minimum: 1, maximum: 5 },
      value: {
        default: { pattern: "data", $schema: "data" },
        enum: [{ pattern: "data" }],
        const: { $schema: "data" },
      },
      list: {
        type: "array",
        items: { anyOf: [{ type: "string", pattern: "x", format: "date-time" }, { type: "null" }] },
      },
    },
    $defs: { pattern: { type: "string", pattern: "x" } },
    required: ["pattern"],
  };
  const before = structuredClone(schema);
  expect(advertisedJsonSchema(schema)).toEqual({
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: { type: "string", minLength: 1, maxLength: 5, default: "x" },
      $schema: { type: "number", minimum: 1, maximum: 5 },
      value: schema.properties.value,
      list: {
        type: "array",
        items: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      },
    },
    $defs: { pattern: { type: "string" } },
    required: ["pattern"],
  });
  expect(schema).toEqual(before);
});

// Failures: a root union reaching a provider that drops such tools, losing a
// variant's field or its schema, requiring a field some variant omits,
// forbidding a field some variant allows, mutating the validated source,
// rewriting nested unions, or silently advertising a root it cannot merge.
it("merges a root object union into one object and leaves nested unions alone", () => {
  const schema = {
    type: "object",
    description: "root",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          integration: { type: "string" },
          access: { type: "string", enum: ["read", "read-write"] },
          reason: { type: "string" },
        },
        required: ["integration", "access", "reason"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { const: "computer-app" },
          access: { type: "string", enum: ["read", "read-write"], description: "app access" },
          reason: { type: "string" },
          target: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["kind", "access", "reason"],
      },
    ],
  };
  const before = structuredClone(schema);
  expect(advertisedJsonSchema(schema)).toEqual({
    type: "object",
    description: "root",
    additionalProperties: false,
    properties: {
      integration: { type: "string" },
      access: {
        anyOf: [
          { type: "string", enum: ["read", "read-write"] },
          { type: "string", enum: ["read", "read-write"], description: "app access" },
        ],
      },
      reason: { type: "string" },
      kind: { const: "computer-app" },
      target: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["access", "reason"],
  });
  expect(schema).toEqual(before);
  const open = advertisedJsonSchema({
    anyOf: [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", additionalProperties: false, properties: { b: { type: "number" } } },
    ],
  });
  expect(open).toEqual({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "number" } },
  });
});

it("refuses a root it cannot advertise as one object", () => {
  expect(() =>
    advertisedJsonSchema({ oneOf: [{ type: "object", properties: {} }, { type: "string" }] }),
  ).toThrow(/root union/u);
  expect(() =>
    advertisedJsonSchema({ type: "object", allOf: [{ type: "object", properties: {} }] }),
  ).toThrow(/root/u);
  expect(() =>
    advertisedJsonSchema({
      type: "object",
      properties: { a: { type: "string" } },
      oneOf: [{ type: "object", properties: {} }],
    }),
  ).toThrow(/root union/u);
});
