import {
  IntegrationDefinitionSchema,
  integrationDefinitionSummary,
} from "@opensteer/integration-core";
import { describe, expect, it } from "vitest";
import { installedIntegrationDefinition } from "./integration-platform-stores.js";

const definition = IntegrationDefinitionSchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "api-key",
      inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
      kind: "api-key",
      label: "Proposed API key",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
      ],
    },
  ],
  config: { specUrl: "https://api.proposed.test/openapi.json", timeoutMs: 30_000 },
  description: "Researched by an agent and approved by an administrator",
  id: "proposed-inventory",
  name: "Proposed inventory",
  provider: "proposed-inventory",
});

const adapterSnapshot = {
  adapter: definition.adapter,
  config: definition.config as Readonly<Record<string, unknown>>,
  definitionId: definition.id,
};

const manifest = { definition: integrationDefinitionSummary(definition) };

describe("installedIntegrationDefinition", () => {
  it("refuses an installation that stores no public definition", () => {
    expect(() => installedIntegrationDefinition({ adapterSnapshot, manifest: {} })).toThrow(
      "The installation stores no verified public definition",
    );
  });

  it("refuses an installation whose adapter configuration was never captured", () => {
    expect(() => installedIntegrationDefinition({ adapterSnapshot: null, manifest })).toThrow(
      `Installed integration ${definition.id} stores no adapter configuration`,
    );
  });

  it("refuses a snapshot that belongs to another definition", () => {
    expect(() =>
      installedIntegrationDefinition({
        adapterSnapshot: { ...adapterSnapshot, definitionId: "proposed-other" },
        manifest,
      }),
    ).toThrow("The adapter runtime snapshot does not match its definition");
  });

  it("refuses a snapshot that is not the shape the adapters accept", () => {
    expect(() =>
      installedIntegrationDefinition({ adapterSnapshot: { config: {} }, manifest }),
    ).toThrow("The adapter runtime snapshot is invalid");
  });
});
