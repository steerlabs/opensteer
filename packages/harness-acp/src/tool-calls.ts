import { ToolIdentitySchema, type ToolIdentity } from "@opensteer/core";
import { opensteerToolIdentity } from "@opensteer/harness";
import { isRecord } from "@opensteer/shared/isRecord";
import type { AcpToolCall } from "./types.js";

/** The ACP tool statuses after which a call takes no further frames. */
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

export function isTerminalAcpToolCall(call: AcpToolCall): boolean {
  return terminalStatuses.has(call.status ?? "");
}

/**
 * Reads one ACP `tool_call`, `tool_call_update` or permission subject. A frame
 * without an id names no call, so it is no call at all: inventing one would
 * fold every such frame onto a single fabricated call.
 */
export function parseAcpToolCall(value: unknown): AcpToolCall | undefined {
  if (!isRecord(value) || typeof value.toolCallId !== "string" || !value.toolCallId.trim())
    return undefined;
  return {
    id: value.toolCallId,
    ...(Array.isArray(value.content) ? { content: value.content } : {}),
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    ...(Array.isArray(value.locations) ? { locations: value.locations } : {}),
    ...(isRecord(value._meta) ? { meta: value._meta } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(value.rawInput !== undefined ? { rawInput: value.rawInput } : {}),
    ...(value.rawOutput !== undefined ? { rawOutput: value.rawOutput } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
  };
}

/**
 * The MCP tool a call addressed, when the engine says so in structured
 * fields: `_meta.mcp` ({ server, tool }), or an MCP dispatch envelope's
 * `ServerName`/`ToolName` arguments.
 */
export function acpMcpTool(
  call: AcpToolCall,
): { readonly server: string; readonly tool: string } | undefined {
  const mcp = isRecord(call.meta?.mcp) ? call.meta.mcp : undefined;
  const input = isRecord(call.rawInput) ? call.rawInput : undefined;
  const server = text(mcp?.server) ?? text(input?.ServerName);
  const tool = text(mcp?.tool) ?? text(input?.ToolName);
  return server && tool ? { server, tool } : undefined;
}

/**
 * Names a call from its structured fields. ACP has no tool name: `title` is
 * free text for people (Antigravity titles a command call with the whole
 * command), so it is never an identity. An engine hook that knows its own
 * title convention runs first; this is what remains.
 */
export function acpToolIdentity(call: AcpToolCall): ToolIdentity {
  const mcp = acpMcpTool(call);
  return (
    (mcp && validToolIdentity(opensteerToolIdentity(mcp.server, mcp.tool))) ||
    (call.name && validToolIdentity({ name: call.name, namespace: "acp" })) || {
      name: validToolIdentity({ name: call.kind ?? "", namespace: "acp" })?.name ?? "other",
      namespace: "acp",
    }
  );
}

/** The identity when the Host can record it, otherwise nothing. */
export function validToolIdentity(identity: ToolIdentity): ToolIdentity | undefined {
  const parsed = ToolIdentitySchema.safeParse({
    name: identity.name.trim(),
    namespace: identity.namespace.trim(),
  });
  return parsed.success ? parsed.data : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
