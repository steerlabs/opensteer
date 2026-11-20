import { z } from "zod";
import { AgentConnectionIdentityAtConsentSchema } from "@opensteer/control-plane-protocol";
import {
  AgentGrantSchema,
  ThreadAccessModeSchema,
  UserIdSchema,
  DeploymentIdSchema,
} from "@opensteer/core";

/** The Host's one MCP resource; an agent adds the Host's origin plus this path. */
export const agentConnectionMcpPath = "/internal/v1/mcp";
export const AgentConnectionIdSchema = z.string().regex(/^mcn_[0-9a-f-]{36}$/);

/**
 * Where a connection stands. `revoked` holds from the moment authority ends;
 * `stopping` while handed-off work in its lineage has not yet confirmed it
 * ended; `stopped` once every one of them has.
 */
export const AgentConnectionStateSchema = z.enum([
  "active",
  "expired",
  "revoked",
  "stopping",
  "stopped",
]);
export type AgentConnectionState = z.infer<typeof AgentConnectionStateSchema>;

/**
 * How the Home words who asked, from what it could prove at consent: a verified embedder via a
 * verified platform, a verified platform, or the name the client gave itself.
 */
export const AgentConnectionIdentityPresentationSchema = z.object({
  evidenceKind: z.enum(["platform-and-embedder", "platform", "unverified"]),
  verified: z.boolean(),
  selfAsserted: z.boolean(),
  heading: z.string().min(1).max(300),
  detail: z.string().max(500),
  origins: z
    .array(
      z.object({
        role: z.enum(["embedder", "platform", "redirect"]),
        label: z.string().min(1).max(200),
        origin: z.string().max(2048),
      }),
    )
    .max(4),
  warning: z.string().max(200),
});
export type AgentConnectionIdentityPresentation = z.infer<
  typeof AgentConnectionIdentityPresentationSchema
>;

export const AgentConnectionSchema = z.object({
  id: AgentConnectionIdSchema,
  userId: UserIdSchema,
  label: z.string().min(1).max(120),
  /** Self-asserted by the client; shown as what it says it is. */
  clientName: z.string().min(1).max(100),
  accessMode: ThreadAccessModeSchema,
  grant: AgentGrantSchema.optional(),
  grantRevision: z.number().int().min(1).optional(),
  consentVersion: z.number().int().min(1).optional(),
  /** What the Home can prove about the client: its registration and the consented redirect. */
  client: z
    .object({
      fingerprint: z.string().max(128).nullable(),
      redirectOrigin: z.string().max(2048).nullable(),
    })
    .optional(),
  state: AgentConnectionStateSchema.optional(),
  /** Contact was lost with work in its lineage mid-effect while it was being stopped. */
  lastActionUncertain: z.boolean().optional(),
  /** What to check: the Device, the task or tool, and when contact was lost. */
  lastActionUncertainDetail: z
    .object({
      at: z.iso.datetime({ offset: true }),
      device: z.string().max(255).nullable(),
      task: z.string().max(500).nullable(),
      taskId: z.string().max(255).nullable(),
      tool: z.string().max(100).nullable(),
      reason: z.string().max(255).nullable(),
    })
    .nullable()
    .optional(),
  revokedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /** What the Home could prove about who asked, recorded at consent; null before it was kept. */
  identityAtConsent: AgentConnectionIdentityAtConsentSchema.nullable().optional(),
  identity: AgentConnectionIdentityPresentationSchema.optional(),

  createdAt: z.iso.datetime({ offset: true }),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type AgentConnection = z.infer<typeof AgentConnectionSchema>;
export const AgentConnectionConsentSchema = z.object({
  grantsAvailable: z.literal(true).optional(),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  clientName: z.string().min(1).max(100),
  redirectUri: z.url(),
  resource: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  identityAtConsent: AgentConnectionIdentityAtConsentSchema.optional(),
  identity: AgentConnectionIdentityPresentationSchema.optional(),
});
export type AgentConnectionConsent = z.infer<typeof AgentConnectionConsentSchema>;
/** Why a consent read is refused (`OpensteerError.reason`): answered and expired read differently. */
export const agentConnectionConsentRefusals = {
  answered: "consent-answered",
  expired: "consent-expired",
} as const;

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
