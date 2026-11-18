import { opensteerToolNamespace, type ToolIdentity } from "@opensteer/core";

/** Opensteer's MCP calls share one identity; other servers retain their own namespace. */
export function opensteerToolIdentity(server: unknown, toolName: unknown): ToolIdentity {
  const serverName = String(server ?? "unknown");
  return {
    name: String(toolName ?? "unknown"),
    namespace:
      serverName === "opensteer" || serverName === "opensteer-direct"
        ? opensteerToolNamespace
        : `mcp:${serverName}`,
  };
}
