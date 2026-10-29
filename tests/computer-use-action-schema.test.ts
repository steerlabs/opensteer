import { validateJsonSchema } from "../packages/integration-adapters/src/index.js";
import { LoginTextSchema } from "../packages/protocol/src/password-sign-in.js";
import { isRecord } from "@opensteer/shared/isRecord";
import { describe, expect, it } from "vitest";
import { getIntegrationDefinition } from "../packages/integration-catalog/src/index.js";
import { parseComputerAppConfig } from "../packages/integration-core/src/computer-app.js";
import { AndroidPhoneActionSchema } from "../packages/protocol/src/android-phone.js";
import { ComputerUseActionSchema } from "../packages/protocol/src/computer-use.js";

interface JsonObjectSchema {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
}

function objectSchema(value: unknown): JsonObjectSchema {
  if (!isRecord(value) || !isRecord(value.properties) || !Array.isArray(value.required)) {
    throw new Error("Expected an object schema with properties and required");
  }
  return {
    properties: value.properties,
    required: value.required.filter((name): name is string => typeof name === "string"),
  };
}

/** The catalog's action variants, keyed by the `type` each one fixes. */
function catalogActionVariants(
  definitionId: "android-phone" | "macos-app" = "macos-app",
): ReadonlyMap<string, JsonObjectSchema> {
  const definition = getIntegrationDefinition(definitionId);
  if (!definition) throw new Error(`The catalog must define ${definitionId}`);
  const act = parseComputerAppConfig(definition).operations.find(({ name }) => name === "act");
  const actions = objectSchema(act?.inputSchema).properties.actions;
  if (!isRecord(actions) || !isRecord(actions.items) || !Array.isArray(actions.items.oneOf)) {
    throw new Error("act must declare its actions as a oneOf");
  }
  return new Map(
    actions.items.oneOf.map((variant) => {
      const schema = objectSchema(variant);
      const type = schema.properties.type;
      if (!isRecord(type) || typeof type.const !== "string") {
        throw new Error("Every action variant must fix its type");
      }
      return [type.const, schema] as const;
    }),
  );
}

/**
 * The model learns the action shape from the catalog's JSON Schema; the Host
 * enforces the protocol's zod union. A field one has and the other lacks is a
 * call the model is told it may make and the Host then refuses, or a
 * capability the model never learns about. Bounds may differ: the protocol
 * caps an element index at what one observation can name, and a published
 * schema that did too would turn that refusal from a tool error into a throw.
 */
interface ProtocolActionVariant {
  readonly shape: Readonly<Record<string, { safeParse(value: unknown): { success: boolean } }>>;
}

/** The fields and required fields of each protocol variant, keyed like the catalog's. */
function protocolActionVariants(variants: readonly ProtocolActionVariant[]) {
  return variants.map((variant) => {
    const shape = variant.shape;
    const type = shape.type;
    if (!type || !("value" in type) || typeof type.value !== "string") {
      throw new Error("Every protocol action variant must fix its type");
    }
    return {
      fields: Object.keys(shape).sort(),
      // A field is required exactly when leaving it out fails to parse;
      // optional and defaulted fields both parse from nothing.
      required: Object.entries(shape)
        .filter(([, field]) => !field.safeParse(undefined).success)
        .map(([name]) => name)
        .sort(),
      type: type.value,
    };
  });
}

describe("android phone action schema", () => {
  it("offers exactly the fields the protocol accepts, with the same ones required", () => {
    const catalog = catalogActionVariants("android-phone");
    const protocol = protocolActionVariants(AndroidPhoneActionSchema.options);
    expect([...catalog.keys()].sort()).toEqual(protocol.map(({ type }) => type).sort());
    for (const variant of protocol) {
      const declared = catalog.get(variant.type);
      expect({
        fields: Object.keys(declared?.properties ?? {}).sort(),
        type: variant.type,
      }).toEqual({ fields: variant.fields, type: variant.type });
      expect({ required: [...(declared?.required ?? [])].sort(), type: variant.type }).toEqual({
        required: variant.required,
        type: variant.type,
      });
    }
  });
});

describe("computer use action schema", () => {
  it("offers exactly the fields the protocol accepts, with the same ones required", () => {
    const catalog = catalogActionVariants();
    const protocol = ComputerUseActionSchema.options.map((variant) => {
      const shape: Readonly<Record<string, { safeParse(value: unknown): { success: boolean } }>> =
        variant.shape;
      return {
        fields: Object.keys(shape).sort(),
        // A field is required exactly when leaving it out fails to parse;
        // optional and defaulted fields both parse from nothing.
        required: Object.entries(shape)
          .filter(([, field]) => !field.safeParse(undefined).success)
          .map(([name]) => name)
          .sort(),
        type: variant.shape.type.value,
      };
    });
    expect([...catalog.keys()].sort()).toEqual(protocol.map(({ type }) => type).sort());
    for (const variant of protocol) {
      const declared = catalog.get(variant.type);
      expect({
        fields: Object.keys(declared?.properties ?? {}).sort(),
        type: variant.type,
      }).toEqual({ fields: variant.fields, type: variant.type });
      expect({ required: [...(declared?.required ?? [])].sort(), type: variant.type }).toEqual({
        required: variant.required,
        type: variant.type,
      });
    }
  });

  it("lets type name its target, as the protocol does", () => {
    const type = catalogActionVariants().get("type");
    expect(type?.properties.target).toMatchObject({ oneOf: expect.any(Array) });
    expect(type?.required).not.toContain("target");
    expect(
      ComputerUseActionSchema.safeParse({ target: { index: 3 }, text: "hi", type: "type" }).success,
    ).toBe(true);
    expect(
      ComputerUseActionSchema.safeParse({ target: { x: 10, y: 20 }, text: "hi", type: "type" })
        .success,
    ).toBe(true);
  });
});

// The published schema is the contract integration_describe gives to integration_call.
describe.each(["android-phone", "macos-app"] as const)("%s saved login contract", (id) => {
  const variants = catalogActionVariants(id);
  const textSchema = variants.get("type")!.properties.text;
  const max = id === "android-phone" ? 5_000 : 20_000;
  it.each(["username", "password", "code"])("accepts a saved %s", (field) => {
    expect(validateJsonSchema(textSchema, { loginRef: `lgn_${"a".repeat(32)}`, field })).toEqual(
      [],
    );
  });
  it("agrees with strict LoginText and retains the literal bounds", () => {
    for (const value of [
      { loginRef: `lgn_${"a".repeat(32)}`, field: "password" },
      { loginRef: "lgn_bad", field: "password" },
      { loginRef: `lgn_${"A".repeat(32)}`, field: "password" },
      { loginRef: `lgn_${"a".repeat(32)}`, field: "totp" },
      { loginRef: `lgn_${"a".repeat(32)}`, field: "password", extra: true },
      { field: "password" },
      { loginRef: `lgn_${"a".repeat(32)}` },
      {},
      null,
    ])
      expect(validateJsonSchema(textSchema, value).length === 0).toBe(
        LoginTextSchema.safeParse(value).success,
      );
    expect(validateJsonSchema(textSchema, "a")).toEqual([]);
    expect(validateJsonSchema(textSchema, "a".repeat(max))).toEqual([]);
    expect(validateJsonSchema(textSchema, "")).not.toEqual([]);
    expect(validateJsonSchema(textSchema, "a".repeat(max + 1))).not.toEqual([]);
  });
});
