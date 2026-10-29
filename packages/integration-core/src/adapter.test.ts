import { describe, expect, it } from "vitest";
import {
  IntegrationAdapterKindSchema,
  IntegrationAdapterSnapshotSchema,
  IntegrationDefinitionSchema,
  integrationDefinitionSummary,
  maximumIntegrationAdapterSnapshotBytes,
} from "./adapter.js";

describe("integration adapter boundaries", () => {
  it("keeps presentation facts public and executable config private", () => {
    const definition = IntegrationDefinitionSchema.parse({
      adapter: "openapi",
      authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
      config: { inline: { openapi: "3.1.0" } },
      description: "Example API",
      id: "example",
      name: "Example",
      provider: "example",
    });

    expect(integrationDefinitionSummary(definition)).not.toHaveProperty("config");
    expect(
      IntegrationAdapterSnapshotSchema.parse({
        adapter: definition.adapter,
        config: definition.config,
        definitionId: definition.id,
      }),
    ).toEqual({
      adapter: "openapi",
      config: { inline: { openapi: "3.1.0" } },
      definitionId: "example",
    });
  });

  it("accepts only executable adapter families and bounded snapshots", () => {
    expect(IntegrationAdapterKindSchema.safeParse("native").success).toBe(false);
    expect(
      IntegrationAdapterSnapshotSchema.safeParse({
        adapter: "computer",
        config: {},
        definitionId: "apple-messages",
      }).success,
    ).toBe(false);
    expect(
      IntegrationAdapterSnapshotSchema.safeParse({
        adapter: "openapi",
        config: { document: "x".repeat(maximumIntegrationAdapterSnapshotBytes) },
        definitionId: "example",
      }).success,
    ).toBe(false);
  });
});
