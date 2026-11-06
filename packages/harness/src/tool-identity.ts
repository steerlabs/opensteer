import {
  legacyIntegrationsNamespace,
  opensteerToolNamespace,
  type ToolIdentity,
} from "@opensteer/core";

/**
 * The identity a tool call made through an MCP server is reported under.
 *
 * Opensteer's server is named for what it is, because a reader should see "an
 * Opensteer tool" rather than the transport it arrived on. The retired
 * `opensteer_integrations` server keeps its name only so saved transcripts and
 * resumed native sessions still render its calls as Opensteer tools;
 * every other server keeps its own name behind `mcp:` so two servers offering
 * a tool of the same name stay apart. The provider's spelling of the server
 * and the tool is whatever the harness reported, so both are accepted as
 * unknown and only then named.
 */
export function opensteerToolIdentity(server: unknown, toolName: unknown): ToolIdentity {
  const serverName = String(server ?? "unknown");
  return {
    name: String(toolName ?? "unknown"),
    namespace:
      serverName === "opensteer" || serverName === "opensteer-direct"
        ? opensteerToolNamespace
        : serverName === "opensteer_integrations"
          ? legacyIntegrationsNamespace
          : `mcp:${serverName}`,
  };
}
