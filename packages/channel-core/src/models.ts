import {
  HarnessInstanceIdSchema,
  MessageContentSchema,
  MessageIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import { z } from "zod";
import {
  IntegrationConnectionMethodSchema,
  IntegrationConnectionStatusReasonSchema,
} from "@opensteer/integration-core/models";
import {
  ChannelAccountIdSchema,
  ChannelBindingIdSchema,
  ChannelConversationIdSchema,
  ChannelDeliveryIdSchema,
  IntegrationConnectionIdSchema,
  PrincipalIdSchema,
} from "./ids.js";

const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const ExternalIdSchema = z.string().trim().min(1).max(512);
const OptionalExternalIdSchema = z.string().trim().min(1).max(512).nullable();

export const ChannelProviderSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u)
  .max(64);
export type ChannelProvider = z.infer<typeof ChannelProviderSchema>;

/**
 * How a messaging service reaches the provider. `computer` is a transport
 * that runs on one particular computer — iMessage through that Mac's
 * Messages — so its connection is pinned to that computer and never moves.
 */
export const ChannelTransportKindSchema = z.enum(["socket", "polling", "computer"]);
export type ChannelTransportKind = z.infer<typeof ChannelTransportKindSchema>;

export const ChannelProviderManifestSchema = z
  .object({
    /**
     * How this provider can reach one person privately. `in-conversation` means
     * the adapter can address the actor where they wrote (Slack's ephemeral
     * messages); `direct-message-only` means anything private has to move to a
     * direct message, so the Host never puts a secret — a link code — into a
     * conversation other people can read.
     */
    actorDelivery: z.enum(["in-conversation", "direct-message-only"]),
    availability: z.enum(["available", "unavailable"]),
    /**
     * For a computer transport, the computer app it is a use of — iMessage of
     * the Mac's `apple-messages` — whose connection at read and write the
     * channel needs and never outlives.
     */
    computerApp: z.string().min(1).max(64).optional(),
    // Providers can add independent connection alternatives; route only known ones.
    connectionMethods: z
      .array(z.string())
      .max(16)
      .transform((methods) =>
        methods.filter((method) => IntegrationConnectionMethodSchema.safeParse(method).success),
      )
      .pipe(z.array(IntegrationConnectionMethodSchema).min(1)),
    credentialFields: z
      .array(
        z.object({
          help: z.string().trim().min(1).max(240),
          key: z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/u),
          label: z.string().trim().min(1).max(80),
          placeholder: z.string().trim().min(1).max(80),
          secret: z.boolean(),
          uses: z
            .array(z.enum(["delivery", "transport"]))
            .min(1)
            .max(2),
        }),
      )
      .max(16),
    defaultTransportKind: ChannelTransportKindSchema,
    description: z.string().min(1).max(240),
    label: z.string().min(1).max(80),
    /**
     * The longest text one provider message may carry after rendering. The Host
     * splits a longer reply into ordered parts at Markdown boundaries before it
     * becomes deliveries, so the adapter never has to.
     */
    maxMessageChars: z.number().int().min(200).max(100_000),
    provider: ChannelProviderSchema,
    setupUrl: z.url().nullable(),
    setupArtifact: z
      .object({
        content: z
          .string()
          .min(1)
          .max(64 * 1_024),
        filename: z.string().min(1).max(160),
        mediaType: z.string().min(1).max(160),
      })
      .nullable()
      .default(null),
    /**
     * Who can write to the bot. `members` are people inside the provider's own
     * workspace (Slack); `anyone` means whoever knows the address (iMessage),
     * so the Host speaks only to senders it admitted and stays silent to
     * everybody else — a wrong number never learns the bot exists.
     */
    senders: z.enum(["members", "anyone"]),
    // Added transport choices must not disable understood transports.
    transportKinds: z
      .array(z.string())
      .max(8)
      .transform((kinds) =>
        kinds.filter((kind) => ChannelTransportKindSchema.safeParse(kind).success),
      )
      .pipe(z.array(ChannelTransportKindSchema).min(1)),
  })
  .superRefine((manifest, context) => {
    // A computer transport is reached through the computer it runs on, never
    // with a secret, and it is the only way that provider is reached.
    if (!manifest.transportKinds.includes("computer")) {
      if (manifest.computerApp !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Only a computer transport uses a computer app",
        });
      }
      return;
    }
    if (
      manifest.transportKinds.length !== 1 ||
      manifest.credentialFields.length > 0 ||
      manifest.computerApp === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A computer transport is the provider's only transport, takes no credentials, and names the computer app it uses",
      });
    }
  });
export type ChannelProviderManifest = z.infer<typeof ChannelProviderManifestSchema>;

/** A channel shares integration connections' status reasons: one column holds both. */
export const ChannelConnectionIssueKindSchema = IntegrationConnectionStatusReasonSchema;
export type ChannelConnectionIssueKind = z.infer<typeof ChannelConnectionIssueKindSchema>;

export const ChannelConnectionIssueSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u),
  kind: ChannelConnectionIssueKindSchema,
  message: z.string().trim().min(1).max(500),
  missing: z.array(z.string().trim().min(1).max(120)).max(128).default([]),
});
const ChannelConnectionIssueViewSchema = z.object(ChannelConnectionIssueSchema.shape);
export type ChannelConnectionIssue = z.infer<typeof ChannelConnectionIssueSchema>;

export const ChannelConnectionInspectionSchema = z
  .strictObject({
    capabilities: z.array(z.string().trim().min(1).max(120)).max(128),
    identity: z
      .strictObject({
        accountDisplayName: z.string().trim().min(1).max(160),
        connectionDisplayName: z.string().trim().min(1).max(160),
        externalAccountId: ExternalIdSchema,
        externalIdentityId: OptionalExternalIdSchema,
        handle: z.string().trim().min(1).max(160).nullable(),
        metadata: z.record(z.string().max(128), z.unknown()),
      })
      .nullable(),
    issues: z.array(ChannelConnectionIssueSchema).max(32),
    ready: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.ready !== (value.identity !== null && value.issues.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "A ready connection must have an identity and no setup issues",
      });
    }
  });
export const ChannelConnectionInspectionViewSchema = z
  .object({
    ...ChannelConnectionInspectionSchema.shape,
    identity: z.object(ChannelConnectionInspectionSchema.shape.identity.unwrap().shape).nullable(),
    issues: z.array(ChannelConnectionIssueViewSchema).max(32),
  })
  .superRefine((value, context) => {
    if (value.ready !== (value.identity !== null && value.issues.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "A ready connection must have an identity and no setup issues",
      });
    }
  });
export type ChannelConnectionInspection = z.infer<typeof ChannelConnectionInspectionSchema>;

const PrincipalSchema = z.strictObject({
  createdAt: IsoDateTimeSchema,
  displayName: z.string().trim().min(1).max(160),
  id: PrincipalIdSchema,
  kind: z.enum(["user", "channel-identity", "system"]),
  userId: UserIdSchema.nullable(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const IntegrationConnectionSchema = z.strictObject({
  capabilities: z.array(z.string().min(1).max(120)).max(128),
  connectionMethod: IntegrationConnectionMethodSchema,
  createdAt: IsoDateTimeSchema,
  displayName: z.string().trim().min(1).max(160),
  externalIdentityId: OptionalExternalIdSchema,
  externalTenantId: OptionalExternalIdSchema,
  id: IntegrationConnectionIdSchema,
  ownerUserId: UserIdSchema,
  provider: ChannelProviderSchema,
  status: z.enum(["pending", "connected", "needs-attention", "paused", "revoked"]),
  statusDetail: z.string().trim().min(1).max(500).nullable(),
  statusReason: ChannelConnectionIssueKindSchema.nullable().default(null),
  transportKind: ChannelTransportKindSchema,
  updatedAt: IsoDateTimeSchema,
});
export const IntegrationConnectionViewSchema = z.object(IntegrationConnectionSchema.shape);
export type IntegrationConnection = z.infer<typeof IntegrationConnectionSchema>;

export const ChannelRuntimeCapabilitySchema = z
  .object({
    manifest: ChannelProviderManifestSchema,
    provider: ChannelProviderSchema,
    // This runtime may implement only a subset of the provider's transports.
    transportKinds: z
      .array(z.string())
      .max(8)
      .transform((kinds) =>
        kinds.filter((kind) => ChannelTransportKindSchema.safeParse(kind).success),
      )
      .pipe(z.array(ChannelTransportKindSchema).min(1).max(8)),
  })
  .superRefine((value, context) => {
    if (value.provider !== value.manifest.provider) {
      context.addIssue({ code: "custom", message: "Capability and manifest providers must match" });
    }
    if (value.transportKinds.some((kind) => !value.manifest.transportKinds.includes(kind))) {
      context.addIssue({
        code: "custom",
        message: "Capability transport kinds must be declared by the provider manifest",
      });
    }
  });
export type ChannelRuntimeCapability = z.infer<typeof ChannelRuntimeCapabilitySchema>;

export const ChannelAccountSchema = z.strictObject({
  connectionId: IntegrationConnectionIdSchema,
  createdAt: IsoDateTimeSchema,
  displayName: z.string().trim().min(1).max(160),
  externalAccountId: ExternalIdSchema,
  handle: z.string().trim().min(1).max(160).nullable(),
  id: ChannelAccountIdSchema,
  metadata: z.record(z.string().max(128), z.unknown()),
  provider: ChannelProviderSchema,
  routingMode: z.enum(["dedicated", "shared"]),
  status: z.enum(["connected", "needs-attention", "paused", "revoked"]),
  updatedAt: IsoDateTimeSchema,
});
export const ChannelAccountViewSchema = z.object(ChannelAccountSchema.shape);
export type ChannelAccount = z.infer<typeof ChannelAccountSchema>;

export const ChannelConversationTypeSchema = z.enum(["dm", "group", "channel"]);

export const ChannelRouteSelectorSchema = z.strictObject({
  conversationId: OptionalExternalIdSchema.default(null),
  conversationType: ChannelConversationTypeSchema.nullable().default(null),
  scopeId: OptionalExternalIdSchema.default(null),
  threadId: OptionalExternalIdSchema.default(null),
});
const ChannelRouteSelectorViewSchema = z.object(ChannelRouteSelectorSchema.shape);
export type ChannelRouteSelector = z.infer<typeof ChannelRouteSelectorSchema>;

export const ChannelExecutionPolicySchema = z
  .strictObject({
    harness: z.enum(["default", "specific"]),
    harnessInstanceId: HarnessInstanceIdSchema.nullable(),
  })
  .superRefine((value, context) => {
    if ((value.harness === "specific") !== (value.harnessInstanceId !== null)) {
      context.addIssue({
        code: "custom",
        message: "A specific harness policy requires exactly one harness instance",
      });
    }
  });
const ChannelExecutionPolicyViewSchema = z
  .object(ChannelExecutionPolicySchema.shape)
  .superRefine((value, context) => {
    if ((value.harness === "specific") !== (value.harnessInstanceId !== null)) {
      context.addIssue({
        code: "custom",
        message: "A specific harness policy requires exactly one harness instance",
      });
    }
  });

/** Admission is independent of the external identity's optional Opensteer link. */
export const ChannelSenderPolicySchema = z.strictObject({
  allowedExternalUserIds: z.array(ExternalIdSchema).max(500).default([]),
  mode: z.enum(["off", "owner", "approved", "linked-members", "anyone"]),
});
const ChannelSenderPolicyViewSchema = z.object(ChannelSenderPolicySchema.shape);
export type ChannelSenderPolicy = z.infer<typeof ChannelSenderPolicySchema>;

const ChannelScopePolicySchema = z.strictObject({
  conversationIds: z.array(ExternalIdSchema).max(500),
  scope: z.enum(["off", "selected", "all"]),
  sender: ChannelSenderPolicySchema,
});
export const ChannelAccessPolicySchema = z.strictObject({
  channels: ChannelScopePolicySchema,
  directMessages: ChannelSenderPolicySchema,
});
const ChannelAccessPolicyViewSchema = z.object({
  channels: z.object({
    ...ChannelScopePolicySchema.shape,
    sender: ChannelSenderPolicyViewSchema,
  }),
  directMessages: ChannelSenderPolicyViewSchema,
});
export type ChannelAccessPolicy = z.infer<typeof ChannelAccessPolicySchema>;

export const ChannelAccessGrantSchema = z.strictObject({
  accountId: ChannelAccountIdSchema,
  bindingId: ChannelBindingIdSchema,
  externalUserId: ExternalIdSchema,
  displayName: z.string().trim().min(1).max(160),
  status: z.enum(["pending", "approved", "declined", "revoked"]),
  revision: z.number().int().positive(),
  requestedAt: IsoDateTimeSchema,
  decidedAt: IsoDateTimeSchema.nullable(),
  decidedBy: UserIdSchema.nullable(),
});
export const ChannelAccessGrantViewSchema = z.object(ChannelAccessGrantSchema.shape);
export type ChannelAccessGrant = z.infer<typeof ChannelAccessGrantSchema>;

export const ChannelBindingSchema = z.strictObject({
  accessPolicy: ChannelAccessPolicySchema,
  accountId: ChannelAccountIdSchema,
  createdAt: IsoDateTimeSchema,
  createdBy: UserIdSchema,
  executionPolicy: ChannelExecutionPolicySchema,
  id: ChannelBindingIdSchema,
  revision: z.number().int().positive(),
  selector: ChannelRouteSelectorSchema,
  status: z.enum(["active", "paused", "revoked"]),
  updatedAt: IsoDateTimeSchema,
  workspaceId: WorkspaceIdSchema,
});
export const ChannelBindingViewSchema = z.object({
  ...ChannelBindingSchema.shape,
  accessPolicy: ChannelAccessPolicyViewSchema,
  executionPolicy: ChannelExecutionPolicyViewSchema,
  selector: ChannelRouteSelectorViewSchema,
});
export type ChannelBinding = z.infer<typeof ChannelBindingSchema>;

export const NormalizedChannelEventSchema = z.strictObject({
  accountExternalId: ExternalIdSchema,
  actor: z.strictObject({
    displayName: z.string().trim().min(1).max(160),
    externalUserId: ExternalIdSchema,
  }),
  content: MessageContentSchema,
  conversation: z.strictObject({
    displayName: z.string().trim().min(1).max(240).nullable(),
    externalConversationId: ExternalIdSchema,
    externalScopeId: OptionalExternalIdSchema,
    externalThreadId: OptionalExternalIdSchema,
    type: ChannelConversationTypeSchema,
  }),
  eventId: ExternalIdSchema,
  occurredAt: IsoDateTimeSchema,
  provider: ChannelProviderSchema,
  providerMessageId: ExternalIdSchema,
  trigger: z.enum(["mention", "direct-message", "conversation-followup"]),
});
export type NormalizedChannelEvent = z.infer<typeof NormalizedChannelEventSchema>;

export const ChannelDeliveryStatusSchema = z.enum([
  "pending",
  "leased",
  "attempt-started",
  "sent",
  "retryable-failed",
  "unknown",
  "dead",
]);

/**
 * `reply` carries an agent message; `status` is the system speaking for
 * itself (a link code, a failed Run, a Run waiting on a person). `audience`
 * says who may see it: `conversation` posts where the conversation is,
 * `actor` reaches only the person whose message caused it, which is how a
 * link code stays private in a shared channel.
 */
export const ChannelDeliveryKindSchema = z.enum(["reply", "status"]);
export type ChannelDeliveryKind = z.infer<typeof ChannelDeliveryKindSchema>;
export const ChannelDeliveryAudienceSchema = z.enum(["conversation", "actor"]);
export type ChannelDeliveryAudience = z.infer<typeof ChannelDeliveryAudienceSchema>;

export const ChannelDeliverySchema = z.strictObject({
  accountId: ChannelAccountIdSchema,
  attempts: z.number().int().nonnegative(),
  audience: ChannelDeliveryAudienceSchema,
  content: MessageContentSchema,
  conversationId: ChannelConversationIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  id: ChannelDeliveryIdSchema,
  kind: ChannelDeliveryKindSchema,
  lastError: z.string().max(2_000).nullable(),
  messageId: MessageIdSchema.nullable(),
  receipt: z.record(z.string().max(128), z.unknown()).nullable(),
  status: ChannelDeliveryStatusSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ChannelDelivery = z.infer<typeof ChannelDeliverySchema>;

export const ChannelDashboardSchema = z.strictObject({
  accessGrants: z.array(ChannelAccessGrantSchema).max(10_000),
  accounts: z.array(ChannelAccountSchema).max(500),
  bindings: z.array(ChannelBindingSchema).max(2_000),
  connections: z.array(IntegrationConnectionSchema).max(500),
  deliveriesNeedingAttention: z.number().int().nonnegative(),
  providers: z.array(ChannelProviderManifestSchema),
});
export const ChannelDashboardViewSchema = z.object({
  ...ChannelDashboardSchema.shape,
  accessGrants: z.array(ChannelAccessGrantViewSchema).max(10_000),
  accounts: z.array(ChannelAccountViewSchema).max(500),
  bindings: z.array(ChannelBindingViewSchema).max(2_000),
  connections: z.array(IntegrationConnectionViewSchema).max(500),
  providers: z.array(ChannelProviderManifestSchema),
});
export type ChannelDashboard = z.infer<typeof ChannelDashboardSchema>;

const RouteCandidateSchema = z.strictObject({
  conversationId: ExternalIdSchema,
  conversationType: ChannelConversationTypeSchema,
  scopeId: OptionalExternalIdSchema,
  threadId: OptionalExternalIdSchema,
});
export type RouteCandidate = z.infer<typeof RouteCandidateSchema>;
