import type { ToolIdentity } from "@opensteer/core";
import { opensteerToolIdentity, type HarnessSessionContext } from "@opensteer/harness";
import { acpMcpTool, validToolIdentity, type AcpToolCall } from "@opensteer/harness-acp";

/** Where Antigravity's own tools are reported, as each engine reports its native tools. */
export const antigravityToolNamespace = "antigravity";

/**
 * Antigravity titles a running call "Running <tool>" and a permission prompt
 * "Run <tool>?". A command call is titled with the command itself, so only
 * its ACP kind says what it is.
 */
const antigravityToolTitle = /^Run(?:ning)? (?<name>[^\s?]+)\??$/u;

/**
 * Names a call the way Antigravity does. agy 1.4 reports an MCP call it
 * unwrapped before running by the bare tool name, with no server, so a name
 * this Run's Opensteer tools include is that Opensteer tool.
 */
export function antigravityToolIdentity(
  call: AcpToolCall,
  context: Pick<HarnessSessionContext, "agentTools">,
): ToolIdentity | undefined {
  if (acpMcpTool(call)) return undefined;
  if (call.kind === "execute") return { name: "run_command", namespace: antigravityToolNamespace };
  const name = call.title?.match(antigravityToolTitle)?.groups?.name;
  if (!name) return undefined;
  return validToolIdentity(
    context.agentTools.tools.includes(name)
      ? opensteerToolIdentity("opensteer", name)
      : { name, namespace: antigravityToolNamespace },
  );
}
