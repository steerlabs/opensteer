import { describe, expect, it } from "vitest";
import {
  integrationDefinitionDigest,
  integrationDefinitionMaterializationVersion,
  integrationSchemaDigest,
} from "./digest.js";

describe("integration definition digest", () => {
  it("pins adapter materialization semantics as well as the declarative definition", () => {
    const definition = { adapter: "openapi", id: "example" };

    expect(integrationDefinitionDigest(definition)).toBe(
      integrationSchemaDigest({ definition, materializationVersion: 1 }),
    );
    expect(integrationDefinitionMaterializationVersion).toBe(1);
    expect(integrationDefinitionDigest(definition)).not.toBe(integrationSchemaDigest(definition));
  });

  it("rematerializes when a computer operation effect changes", () => {
    const definition = {
      adapter: "computer",
      config: {
        operations: [
          {
            effect: "read",
            inputSchema: { type: "object" },
            name: "messages",
            outputSchema: null,
          },
        ],
      },
      id: "apple-messages",
    };

    expect(
      integrationDefinitionDigest({
        ...definition,
        config: {
          operations: [{ ...definition.config.operations[0], effect: "write" }],
        },
      }),
    ).not.toBe(integrationDefinitionDigest(definition));
  });
});
