import {
  ChannelAccountIdSchema,
  ChannelConnectionInspectionSchema,
  ChannelConnectionIssueKindSchema,
  ChannelDeliveryIdSchema,
  ChannelDeliverySchema,
  ChannelProviderSchema,
  ChannelTransportKindSchema,
  IntegrationConnectionIdSchema,
  NormalizedChannelEventSchema,
} from "@opensteer/channel-core";
import {
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryHeartbeatSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  RunnerAuxiliaryRejectedSchema,
  RunnerAuxiliaryWelcomeSchema,
} from "@opensteer/protocol";
import { z } from "zod";

const RequestIdSchema = z.string().regex(/^crq_[A-Za-z0-9_-]{20,128}$/u);

export const ChannelCredentialPurposeSchema = z.enum(["delivery", "transport"]);
export type ChannelCredentialPurpose = z.infer<typeof ChannelCredentialPurposeSchema>;

/**
 * The secrets one runtime operation may use. No expiry: purpose scoping and
 * `credentialGeneration` are the fences, and a clock the two sides would have
 * to agree on is not one.
 */
export const ChannelCredentialLeaseSchema = z.strictObject({
  accountId: ChannelAccountIdSchema,
  externalAccountId: z.string().trim().min(1).max(512),
  purpose: ChannelCredentialPurposeSchema,
  secrets: z.record(z.string().max(128), z.string().min(1).max(65_536)),
});
export type ChannelCredentialLease = z.infer<typeof ChannelCredentialLeaseSchema>;

export const InspectChannelConnectionResponseSchema = ChannelConnectionInspectionSchema;

export const RuntimeConnectionDescriptorSchema = z.strictObject({
  accountId: ChannelAccountIdSchema,
  connectionId: IntegrationConnectionIdSchema,
  credentialGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  externalAccountId: z.string().trim().min(1).max(512),
  /** `ChannelConnectionAdapter.run`'s `initialCursor`. */
  initialCursor: z.string().trim().min(1).max(512).nullable(),
  provider: ChannelProviderSchema,
  transportKind: ChannelTransportKindSchema,
});
export type RuntimeConnectionDescriptor = z.infer<typeof RuntimeConnectionDescriptorSchema>;

const messagingFrameBase = { ...RunnerAuxiliaryFrameFenceSchema.shape } as const;

const HostRequestBaseSchema = z.strictObject({
  ...messagingFrameBase,
  requestId: RequestIdSchema,
  type: z.literal("host.request"),
});

export const HostChannelRequestSchema = z.discriminatedUnion("operation", [
  HostRequestBaseSchema.extend({
    operation: z.literal("connection.inspect"),
    payload: z.strictObject({
      credentials: z.record(z.string().max(128), z.string().min(1).max(65_536)),
      provider: ChannelProviderSchema,
      transportKind: ChannelTransportKindSchema,
    }),
  }),
  HostRequestBaseSchema.extend({
    operation: z.literal("connections.sync"),
    payload: z.strictObject({
      connections: z.array(RuntimeConnectionDescriptorSchema).max(10_000),
    }),
  }),
]);
export type HostChannelRequest = z.infer<typeof HostChannelRequestSchema>;

const RuntimeRequestBaseSchema = z.strictObject({
  ...messagingFrameBase,
  requestId: RequestIdSchema,
  type: z.literal("runtime.request"),
});

const CommitChannelIngressPayloadSchema = z.strictObject({
  connectionId: IntegrationConnectionIdSchema,
  event: NormalizedChannelEventSchema,
});

export const StartChannelDeliveryAttemptSchema = z.strictObject({
  claimToken: z.string().min(32).max(512),
  deliveryId: ChannelDeliveryIdSchema,
});

export const FinishChannelDeliveryAttemptSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    claimToken: z.string().min(32).max(512),
    deliveryId: ChannelDeliveryIdSchema,
    outcome: z.literal("sent"),
    receipt: z.record(z.string().max(128), z.unknown()),
  }),
  z.strictObject({
    claimToken: z.string().min(32).max(512),
    deliveryId: ChannelDeliveryIdSchema,
    error: z.string().min(1).max(2_000),
    outcome: z.literal("retryable-failed"),
    retryAfterSeconds: z.number().int().min(1).max(86_400).nullable(),
  }),
  z.strictObject({
    claimToken: z.string().min(32).max(512),
    deliveryId: ChannelDeliveryIdSchema,
    error: z.string().min(1).max(2_000),
    outcome: z.literal("unknown"),
  }),
  z.strictObject({
    claimToken: z.string().min(32).max(512),
    deliveryId: ChannelDeliveryIdSchema,
    error: z.string().min(1).max(2_000),
    outcome: z.literal("dead"),
  }),
]);
export type FinishChannelDeliveryAttempt = z.infer<typeof FinishChannelDeliveryAttemptSchema>;

export const RuntimeChannelRequestSchema = z.discriminatedUnion("operation", [
  RuntimeRequestBaseSchema.extend({
    operation: z.literal("credential.resolve"),
    payload: z.strictObject({
      connectionId: IntegrationConnectionIdSchema,
      provider: ChannelProviderSchema,
      purpose: ChannelCredentialPurposeSchema,
    }),
  }),
  RuntimeRequestBaseSchema.extend({
    operation: z.literal("ingress.commit"),
    payload: CommitChannelIngressPayloadSchema,
  }),
  RuntimeRequestBaseSchema.extend({
    operation: z.literal("delivery.claim"),
    payload: z.strictObject({ leaseSeconds: z.number().int().min(5).max(120).default(30) }),
  }),
  RuntimeRequestBaseSchema.extend({
    operation: z.literal("delivery.start"),
    payload: StartChannelDeliveryAttemptSchema,
  }),
  RuntimeRequestBaseSchema.extend({
    operation: z.literal("delivery.finish"),
    payload: FinishChannelDeliveryAttemptSchema,
  }),
  RuntimeRequestBaseSchema.extend({
    operation: z.literal("connection.health"),
    payload: z.strictObject({
      connectionId: IntegrationConnectionIdSchema,
      detail: z.string().trim().min(1).max(500).nullable(),
      reason: ChannelConnectionIssueKindSchema.nullable(),
      status: z.enum(["connecting", "connected", "needs-attention"]),
    }),
  }),
]);
export type RuntimeChannelRequest = z.infer<typeof RuntimeChannelRequestSchema>;

const ChannelRequestSuccessSchema = z.strictObject({
  ...messagingFrameBase,
  ok: z.literal(true),
  requestId: RequestIdSchema,
  result: z.unknown(),
  type: z.enum(["host.response", "runtime.response"]),
});

const ChannelRequestFailureSchema = z.strictObject({
  ...messagingFrameBase,
  error: z.strictObject({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
  }),
  ok: z.literal(false),
  requestId: RequestIdSchema,
  type: z.enum(["host.response", "runtime.response"]),
});

export const ChannelResponseSchema = z.discriminatedUnion("ok", [
  ChannelRequestSuccessSchema,
  ChannelRequestFailureSchema,
]);
export type ChannelResponse = z.infer<typeof ChannelResponseSchema>;

export const HostToMessagingRelayMessageSchema = z.union([
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerAuxiliaryRejectedSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  HostChannelRequestSchema,
  ChannelResponseSchema.refine((value) => value.type === "host.response"),
]);
export type HostToMessagingRelayMessage = z.infer<typeof HostToMessagingRelayMessageSchema>;

export const MessagingRelayToHostMessageSchema = z.union([
  RunnerAuxiliaryHeartbeatSchema,
  RuntimeChannelRequestSchema,
  ChannelResponseSchema.refine((value) => value.type === "runtime.response"),
]);
export type MessagingRelayToHostMessage = z.infer<typeof MessagingRelayToHostMessageSchema>;

export const ClaimedChannelDeliverySchema = z.strictObject({
  claimToken: z.string().min(32).max(512),
  delivery: ChannelDeliverySchema,
  destination: z.strictObject({
    externalConversationId: z.string().min(1).max(512),
    externalScopeId: z.string().min(1).max(512).nullable(),
    externalThreadId: z.string().min(1).max(512).nullable(),
    externalUserId: z.string().min(1).max(512).nullable(),
  }),
  lease: ChannelCredentialLeaseSchema,
  /**
   * An earlier attempt lost its outcome, so the provider may already hold
   * this message. The runtime reconciles before it sends again.
   */
  mayHaveBeenSent: z.boolean(),
  provider: ChannelProviderSchema,
});
export type ClaimedChannelDelivery = z.infer<typeof ClaimedChannelDeliverySchema>;

export const CommitChannelIngressResultSchema = z.strictObject({
  duplicate: z.boolean(),
  ingressId: z.string().min(1),
});

export const ClaimChannelDeliveryResultSchema = z.strictObject({
  claimed: ClaimedChannelDeliverySchema.nullable(),
});
