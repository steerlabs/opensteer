import { describe, expect, it } from "vitest";
import { IntegrationDefinitionSchema, integrationDefinitionSummary } from "./adapter.js";

describe("device definition boundary", () => {
  it("keeps executable configuration private and validates the native operation contract", () => {
    const input = {
      adapter: "computer",
      authMethods: [{ id: "computer", kind: "computer", label: "This computer" }],
      description: "Calendar records",
      id: "calendar",
      name: "Calendar",
      provider: "calendar",
      config: {
        accessLabels: { read: "Read", readWrite: "Read and write" },
        accessSummaries: { read: "Read records", readWrite: "Change records" },
        platforms: ["darwin"],
        operations: [
          {
            name: "list",
            title: "List records",
            description: "Read records",
            effect: "read",
            inputSchema: {},
            outputSchema: null,
          },
        ],
      },
    };
    const definition = IntegrationDefinitionSchema.parse(input);
    expect(integrationDefinitionSummary(definition)).not.toHaveProperty("config");
    expect(integrationDefinitionSummary(definition).computerApp?.operations).toEqual([
      { name: "list", effect: "read" },
    ]);
    expect(
      IntegrationDefinitionSchema.safeParse({
        ...input,
        config: { ...input.config, operations: [] },
      }).success,
    ).toBe(false);
  });
});
