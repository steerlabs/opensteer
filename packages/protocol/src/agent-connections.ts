import { z } from "zod";
import { AgentConnectionIdentityAtConsentViewSchema } from "@opensteer/control-plane-protocol";
import {
  AgentGrantViewSchema,
  ThreadAccessModeSchema,
  UserIdSchema,
  DeploymentIdSchema,
} from "@opensteer/core";

import { ChromeTabGrantCatalogSchema } from "./browser-sources.js";

/** The Host's one MCP resource; an agent adds the Host's origin plus this path. */
export const agentConnectionMcpPath = "/internal/v1/mcp";
export const AgentConnectionIdSchema = z.string().regex(/^mcn_[0-9a-f-]{36}$/);

/**
 * Where a connection stands. `revoked` holds from the moment authority ends;
 * `stopping` while handed-off work in its lineage has not yet confirmed it
 * ended; `stopped` once every one of them has. `paused` is a chat whose account
 * is paused: it holds what it receives and makes until it is back.
 */
export const AgentConnectionStateSchema = z.enum([
  "active",
  "paused",
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

/** Who may message a bridge: the person's linked account only, or anyone in its one conversation. */
export const BridgeSendersSchema = z.enum(["owner", "anyone"]);
export type BridgeSenders = z.infer<typeof BridgeSendersSchema>;
/** Why a chat ended, in the person's terms. */
export const ChatEndedBySchema = z.enum(["you", "account", "computer"]);
export type ChatEndedBy = z.infer<typeof ChatEndedBySchema>;
export const AgentConnectionBridgeSchema = z.object({
  accountId: z.string().min(1).max(255),
  /** What the provider is called ("Slack", "iMessage"). */
  provider: z.string().min(1).max(100),
  conversationId: z.string().min(1).max(512).nullable(),
  senders: BridgeSendersSchema,
  /**
   * What its grant may contain (core's `chatGrantShape`): whether everything may be chosen,
   * which kinds of resource, and that Tasks is required. A screen offers only this.
   */
  grantShape: z
    .object({
      everything: z.boolean(),
      resources: z.array(z.string().min(1).max(64)).max(16),
      tasks: z.literal("required"),
    })
    .optional(),
  /** A one-time notice about how the update changed this bridge, until the person dismisses it. */
  // A notice from a newer Home reads as none: there is nothing this app could show for it.
  notice: z.enum(["converted", "converted-without-channels"]).optional().catch(undefined),
  /** The chat account it speaks through: the Slack workspace, or the Mac's iMessage address. */
  accountName: z.string().min(1).max(160).optional(),
  /** The channel's name, for a chat in one channel; null for direct messages. */
  conversationName: z.string().min(1).max(160).nullable().optional(),
  /** The chat account's channel connection, which pausing and resuming act on. */
  channelConnectionId: z.string().min(1).max(255).optional(),
  /** Who "me" is on the account: the one identity linked to the person, or null. */
  me: z
    .object({
      displayName: z.string().min(1).max(160),
      externalUserId: z.string().min(1).max(512),
    })
    .nullable()
    .optional(),
  /** Why a paused chat is paused: the person paused it, or its account needs attention. */
  // A value from a newer Home reads as not said, never as a list that can't be read.
  pausedBy: z.enum(["you", "needs-attention"]).optional().catch(undefined),
  /** What the account needs, when it needs attention, as the account reports it. */
  pauseDetail: z.string().max(500).nullable().optional(),
  /**
   * What happens to a message sent to a paused chat: `kept`, it arrives when the chat is back
   * (one more than an hour old is answered that it came too late); `lost`, it is not delivered.
   */
  pausedMessages: z.enum(["kept", "lost"]).optional().catch(undefined),
  /** Why an ended chat ended; a cause from a newer Home reads as not said. */
  endedBy: ChatEndedBySchema.optional().catch(undefined),
  /** Replies whose delivery is not known: they may have been sent, and are never sent again. */
  unknownReplies: z.number().int().nonnegative().optional(),
  /** Its most recent tasks, newest first: its recent work, and what Stop can stop. */
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).max(255),
        title: z.string().max(500),
        running: z.boolean(),
      }),
    )
    .max(5)
    .optional(),
});
export type AgentConnectionBridge = z.infer<typeof AgentConnectionBridgeSchema>;

export const AgentConnectionSchema = z.object({
  id: AgentConnectionIdSchema,
  userId: UserIdSchema,
  label: z.string().min(1).max(120),
  /** Self-asserted by the client; shown as what it says it is. */
  clientName: z.string().min(1).max(100),
  accessMode: ThreadAccessModeSchema,
  grant: AgentGrantViewSchema.optional(),
  grantRevision: z.number().int().min(1).optional(),
  consentVersion: z.number().int().min(1).optional(),
  /** What the Home can prove about the client: its registration and the consented redirect. */
  client: z
    .object({
      fingerprint: z.string().max(128).nullable(),
      redirectOrigin: z.string().max(2048).nullable(),
    })
    .optional(),
  /**
   * Where it stands. A state from a newer Home is kept as it was said, so the row reads as
   * unknown (`connectedAgentPhase`), never as active or ended, and the rest of the list still
   * reads; nothing here may turn it into undefined, which means active.
   */
  state: z.union([AgentConnectionStateSchema, z.string().min(1).max(64)]).optional(),
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
  identityAtConsent: AgentConnectionIdentityAtConsentViewSchema.nullable().optional(),
  verificationWithdrawnAt: z.iso.datetime({ offset: true }).optional(),
  identity: AgentConnectionIdentityPresentationSchema.optional(),

  /**
   * Present when this connection is a messaging bridge: reached through a chat, not over MCP.
   * A bridge covers direct messages (`conversationId` null) or one named channel or group.
   */
  bridge: AgentConnectionBridgeSchema.optional(),

  createdAt: z.iso.datetime({ offset: true }),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Null when it does not expire: a bridge ends only when it is disconnected. */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AgentConnection = z.infer<typeof AgentConnectionSchema>;
export const AgentConnectionConsentSchema = ChromeTabGrantCatalogSchema.extend({
  grantsAvailable: z.literal(true).optional(),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  clientName: z.string().min(1).max(100),
  redirectUri: z.url(),
  resource: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  identityAtConsent: AgentConnectionIdentityAtConsentViewSchema.optional(),
  verificationSnapshot: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  identity: AgentConnectionIdentityPresentationSchema.optional(),
});
export type AgentConnectionConsent = z.infer<typeof AgentConnectionConsentSchema>;
/** Why a consent read is refused (`OpensteerError.reason`): answered and expired read differently. */
export const agentConnectionConsentRefusals = {
  answered: "consent-answered",
  expired: "consent-expired",
  verificationChanged: "consent-verification-changed",
} as const;

export const agentConnectionVerificationChangedMessage =
  "This agent’s verification changed. Review it again.";

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
