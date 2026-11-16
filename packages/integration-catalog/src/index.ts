import type { IntegrationDefinition } from "@opensteer/integration-core/adapter";
import { deviceDefinitions } from "./devices.js";
import { serviceDefinitions } from "./services.js";

export * from "./devices.js";
export * from "./services.js";

export const integrationDefinitions: readonly IntegrationDefinition[] = [
  ...deviceDefinitions,
  ...serviceDefinitions,
];

const definitionsById = new Map(
  integrationDefinitions.map((definition) => [definition.id, definition]),
);

export function getIntegrationDefinition(id: string): IntegrationDefinition | undefined {
  return definitionsById.get(id);
}
