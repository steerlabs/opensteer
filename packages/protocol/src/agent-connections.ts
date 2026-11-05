import { z } from "zod";
import {
  ThreadAccessModeSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  DeploymentIdSchema,
} from "@opensteer/core";

export const AgentConnectionIdSchema = z.string().regex(/^mcn_[0-9a-f-]{36}$/);
export const AgentConnectionReachSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("workspace"), workspaceId: WorkspaceIdSchema }),
]);
export type AgentConnectionReach = z.infer<typeof AgentConnectionReachSchema>;
const AgentConnectionReachViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("workspace"), workspaceId: WorkspaceIdSchema }),
]);
export const AgentConnectionSchema = z.object({
  id: AgentConnectionIdSchema,
  userId: UserIdSchema,
  label: z.string().min(1).max(120),
  clientName: z.string().min(1).max(100),
  accessMode: ThreadAccessModeSchema,
  reach: AgentConnectionReachViewSchema,
  createdAt: z.iso.datetime({ offset: true }),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type AgentConnection = z.infer<typeof AgentConnectionSchema>;
export const AgentConnectionConsentSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  clientName: z.string().min(1).max(100),
  redirectUri: z.url(),
  resource: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  workspaces: z.array(z.object({ id: WorkspaceIdSchema, name: z.string() })),
});
export type AgentConnectionConsent = z.infer<typeof AgentConnectionConsentSchema>;

export const AgentConnectionAuthorizationTargetSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  requestId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type AgentConnectionAuthorizationTarget = z.infer<
  typeof AgentConnectionAuthorizationTargetSchema
>;
export function agentConnectionDeepLink(
  applicationId: string,
  target: AgentConnectionAuthorizationTarget,
): string {
  const parsed = AgentConnectionAuthorizationTargetSchema.parse(target);
  return `${applicationId}:/mcp-authorization?${new URLSearchParams(parsed)}`;
}
export function parseAgentConnectionDeepLink(
  value: string,
  applicationId: string,
): AgentConnectionAuthorizationTarget | null {
  try {
    if (value.includes("#")) return null;
    const url = new URL(value);
    if (
      url.protocol !== `${applicationId}:` ||
      url.host ||
      url.hash ||
      url.pathname !== "/mcp-authorization" ||
      url.searchParams.size !== 2
    )
      return null;
    const target = AgentConnectionAuthorizationTargetSchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    return target.success ? target.data : null;
  } catch {
    return null;
  }
}
