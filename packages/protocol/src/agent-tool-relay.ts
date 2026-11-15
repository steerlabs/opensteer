import { z } from "zod";
export const agentToolRelayRoutePath = "/tools/call";
export const agentToolHostRoutePath = "/internal/v1/agent-tools/call";
export const AgentToolRelayRequestSchema = z.strictObject({
  callId: z.uuid(),
  name: z.string().min(1).max(255),
  input: z.json(),
});
export type AgentToolRelayRequest = z.infer<typeof AgentToolRelayRequestSchema>;
// Match MCP CallToolResult, preserving provider content and output-storage metadata.
export const AgentToolRelayResponseSchema = z.object({
  content: z.array(z.looseObject({ type: z.string().min(1) })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type AgentToolRelayResponse = z.infer<typeof AgentToolRelayResponseSchema>;
