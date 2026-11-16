import { createHash } from "node:crypto";

/**
 * Derive the stable identity of one MCP tool call.
 *
 * This deliberately excludes tool arguments. A call is identified by the
 * execution subject, MCP session, JSON-RPC request id, and tool name; two
 * distinct calls with identical arguments therefore remain distinct.
 */
export function mcpToolCallId(
  subjectId: string,
  sessionId: string | undefined,
  requestId: string | number,
  toolName: string,
): string {
  const hex = createHash("sha256")
    .update(
      `${subjectId}\0${sessionId ?? "initializing"}\0${String(requestId)}\0${toolName}`,
      "utf8",
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
