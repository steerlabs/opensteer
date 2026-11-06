import type { ToolIdentity } from "./events.js";

/** The namespace every tool the one Opensteer MCP server offers is reported under. */
export const opensteerToolNamespace = "opensteer";

/**
 * Where the retired `opensteer_integrations` server's calls are recorded. Saved
 * transcripts and native sessions resumed from before the one server still
 * carry it, and the Host still records its own Computer use operations under it.
 */
export const legacyIntegrationsNamespace = "opensteer.integrations";

/** Every namespace an integration gateway call is recorded under, newest first. */
export const integrationGatewayNamespaces = [
  opensteerToolNamespace,
  legacyIntegrationsNamespace,
  "mcp:opensteer_integrations",
] as const;

const gatewayToolNames = new Set([
  "computer",
  "integration_search",
  "integration_describe",
  "integration_call",
  "integration_request",
  "integration_propose",
]);

/**
 * Whether a recorded tool is the integration gateway. Under the one server it
 * shares a namespace with Opensteer's other tools, so its names decide; under
 * the retired server every tool was the gateway's.
 */
export function isIntegrationGatewayTool(tool: ToolIdentity): boolean {
  return tool.namespace === opensteerToolNamespace
    ? gatewayToolNames.has(tool.name)
    : (integrationGatewayNamespaces as readonly string[]).includes(tool.namespace);
}
