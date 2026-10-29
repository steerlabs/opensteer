import type { ToolIdentity } from "@opensteer/core";

/**
 * The identity a tool call made through an MCP server is reported under.
 *
 * Opensteer's own two servers are named for what they are, because a reader
 * should see "an Opensteer tool" rather than the transport it arrived on;
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
      serverName === "opensteer"
        ? "opensteer"
        : serverName === "opensteer_integrations"
          ? "opensteer.integrations"
          : `mcp:${serverName}`,
  };
}
