import type { IntegrationDefinition } from "@opensteer/integration-core/adapter";
import { computerAppIntegrations } from "./definitions/computer-apps.js";

/**
 * The device definitions: Mac apps, the Agent Phone and the iPhone's apps. Native
 * contracts are generated from these, so their serialised form is pinned.
 */
export { computerAppIntegrations } from "./definitions/computer-apps.js";

export const deviceDefinitions: readonly IntegrationDefinition[] = computerAppIntegrations;

const definitionsById = new Map(deviceDefinitions.map((definition) => [definition.id, definition]));

export function getDeviceDefinition(id: string): IntegrationDefinition | undefined {
  return definitionsById.get(id);
}
