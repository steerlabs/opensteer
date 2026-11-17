import type { ToolIdentity } from "./events.js";

/** The namespace every tool the one Opensteer MCP server offers is reported under. */
export const opensteerToolNamespace = "opensteer";

/** Host-authored Computer use steps are separate from the agent's outer MCP call. */
export const computerToolNamespace = "opensteer.integrations";

const gatewayToolNames = new Set([
  "computer_use",
  "computer_apps",
  "app_access_request",
  "plugin_search",
  "plugin_describe",
  "plugin_call",
]);

export function isIntegrationGatewayTool(tool: ToolIdentity): boolean {
  return tool.namespace === opensteerToolNamespace
    ? gatewayToolNames.has(tool.name)
    : tool.namespace === computerToolNamespace && tool.name.startsWith("computer.");
}
