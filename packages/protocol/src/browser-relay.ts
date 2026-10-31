import { IsoDateTimeSchema } from "@opensteer/core";
import { z } from "zod";
import {
  BrowserAttachPublicKeysSchema,
  BrowserBinaryFrameHeaderSchema,
  BrowserClientMessageSchema,
  BrowserServerMessageSchema,
  InitialPageReadySchema,
  BrowserEngineSchema,
  HeldLocalProfileSchema,
  LocalProfileBindingSchema,
} from "./browser.js";
import { ProtocolErrorSchema } from "./common.js";
import {
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryHeartbeatSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  RunnerAuxiliaryRejectedSchema,
  RunnerAuxiliaryRequestIdSchema,
  RunnerAuxiliaryWelcomeSchema,
  type RunnerAuxiliaryFrameFence,
} from "./runner-auxiliary.js";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const BrowserChannelIdSchema = z
  .string()
  .regex(new RegExp(`^bch_${uuid}$`, "i"))
  .brand<"BrowserChannelId">();
export type BrowserChannelId = z.infer<typeof BrowserChannelIdSchema>;

export const BrowserCapabilityLeaseIdSchema = z
  .string()
  .regex(new RegExp(`^bcl_${uuid}$`, "i"))
  .brand<"BrowserCapabilityLeaseId">();
export type BrowserCapabilityLeaseId = z.infer<typeof BrowserCapabilityLeaseIdSchema>;

/**
 * A time-bounded permission to serve browser sessions on one runtime. It is
 * separate from the stream lease: losing the grant stops new sessions without
 * tearing the module's transport down.
 */
export const BrowserCapabilityLeaseSchema = z.strictObject({
  capabilityGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  capabilityLeaseId: BrowserCapabilityLeaseIdSchema,
  expiresAt: IsoDateTimeSchema,
  runtimeId: z.string().min(1).max(255),
});
export type BrowserCapabilityLease = z.infer<typeof BrowserCapabilityLeaseSchema>;

export const BrowserCapabilityReferenceSchema = BrowserCapabilityLeaseSchema.pick({
  capabilityGeneration: true,
  capabilityLeaseId: true,
  runtimeId: true,
});
export type BrowserCapabilityReference = z.infer<typeof BrowserCapabilityReferenceSchema>;

export const BrowserRuntimeHealthSchema = z.strictObject({
  checkedAt: IsoDateTimeSchema,
  detail: z.string().max(1_000).nullable(),
  runtimeId: z.string().min(1).max(255),
  sessionId: z.string().max(255).nullable(),
  state: z.enum(["closed", "closing", "idle", "ready", "starting", "unavailable"]),
});
export type BrowserRuntimeHealth = z.infer<typeof BrowserRuntimeHealthSchema>;

const relayEventBase = { ...RunnerAuxiliaryFrameFenceSchema.shape } as const;
const relayRequestBase = {
  ...relayEventBase,
  requestId: RunnerAuxiliaryRequestIdSchema,
} as const;

export interface BrowserRelayNegotiation {
  readonly localProfiles?: 1;
  readonly initialNavigationVersion?: 1;
}

export const LocalProfileInventorySchema = z.strictObject({
  ...relayEventBase,
  module: z.literal("browser"),
  type: z.literal("browser.profile.inventory"),
  storageInstanceId: z.uuid(),
  engine: BrowserEngineSchema,
  profiles: z.array(HeldLocalProfileSchema).max(128),
  complete: z.boolean(),
});
export type LocalProfileInventory = z.infer<typeof LocalProfileInventorySchema>;

export const DeleteLocalProfileSchema = z.strictObject({
  ...relayRequestBase,
  module: z.literal("browser"),
  capability: BrowserCapabilityReferenceSchema,
  type: z.literal("browser.profile.delete"),
  binding: LocalProfileBindingSchema,
  deletionId: z.uuid(),
});
export type DeleteLocalProfile = z.infer<typeof DeleteLocalProfileSchema>;

export const LocalProfileDeletionResultSchema = DeleteLocalProfileSchema.extend({
  type: z.literal("browser.profile.delete.result"),
  state: z.enum(["pending-restart", "deleted"]),
});
export type LocalProfileDeletionResult = z.infer<typeof LocalProfileDeletionResultSchema>;

const HostToBrowserRelayWireSchema = z.discriminatedUnion("type", [
  DeleteLocalProfileSchema,
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerAuxiliaryRejectedSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  z.strictObject({
    ...relayRequestBase,
    lease: BrowserCapabilityLeaseSchema,
    type: z.literal("capability.grant"),
  }),
  z.strictObject({
    ...relayRequestBase,
    capability: BrowserCapabilityReferenceSchema,
    type: z.literal("capability.revoke"),
  }),
  z.strictObject({ ...relayRequestBase, type: z.literal("browser.health.request") }),
  z.strictObject({
    ...relayRequestBase,
    attachTicket: z
      .string()
      .max(16_384)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    capability: BrowserCapabilityReferenceSchema,
    channelId: BrowserChannelIdSchema,
    type: z.literal("browser.attach"),
  }),
  z.strictObject({
    ...relayRequestBase,
    capability: BrowserCapabilityReferenceSchema,
    channelId: BrowserChannelIdSchema,
    type: z.literal("browser.close"),
  }),
  z.strictObject({
    ...relayEventBase,
    capability: BrowserCapabilityReferenceSchema,
    channelId: BrowserChannelIdSchema,
    message: BrowserClientMessageSchema,
    type: z.literal("browser.client-message"),
  }),
]);
export function createHostToBrowserRelayMessageSchema(negotiation: BrowserRelayNegotiation = {}) {
  return HostToBrowserRelayWireSchema.refine(
    (message) => message.type !== "browser.profile.delete" || negotiation.localProfiles === 1,
    "Local profile maintenance requires browser auxiliary negotiation.",
  );
}
export const HostToBrowserRelayMessageSchema = createHostToBrowserRelayMessageSchema();
export type HostToBrowserRelayMessage = z.infer<typeof HostToBrowserRelayMessageSchema>;

/** Everything a routing call may send, which excludes the handshake itself. */
export type RoutedHostToBrowserRelayMessage = Extract<
  HostToBrowserRelayMessage,
  { readonly auxiliaryStreamId: unknown }
>;

const BrowserRelayToHostWireSchema = z.discriminatedUnion("type", [
  LocalProfileInventorySchema,
  LocalProfileDeletionResultSchema,
  RunnerAuxiliaryHeartbeatSchema,
  z.strictObject({
    ...relayRequestBase,
    browserRuntime: BrowserRuntimeHealthSchema.nullable(),
    type: z.literal("browser.health"),
  }),
  z.strictObject({
    ...relayRequestBase,
    capability: BrowserCapabilityReferenceSchema,
    type: z.literal("capability.accepted"),
  }),
  z.strictObject({
    ...relayRequestBase,
    capability: BrowserCapabilityReferenceSchema,
    type: z.literal("capability.revoked"),
  }),
  z.strictObject({
    ...relayRequestBase,
    capability: BrowserCapabilityReferenceSchema,
    channelId: BrowserChannelIdSchema,
    type: z.literal("browser.attached"),
    initialPage: InitialPageReadySchema.optional(),
  }),
  z.strictObject({
    ...relayEventBase,
    capability: BrowserCapabilityReferenceSchema,
    channelId: BrowserChannelIdSchema,
    message: BrowserServerMessageSchema,
    type: z.literal("browser.server-message"),
  }),
  z.strictObject({
    ...relayEventBase,
    capability: BrowserCapabilityReferenceSchema,
    channelId: BrowserChannelIdSchema,
    code: z.number().int().min(1_000).max(4_999),
    reason: z.string().max(1_000),
    requestId: RunnerAuxiliaryRequestIdSchema.optional(),
    type: z.literal("browser.closed"),
  }),
  z.strictObject({
    ...relayEventBase,
    capability: BrowserCapabilityReferenceSchema,
    channelId: BrowserChannelIdSchema,
    error: ProtocolErrorSchema,
    type: z.literal("browser.channel-error"),
  }),
  z.strictObject({
    ...relayRequestBase,
    channelId: BrowserChannelIdSchema.nullable(),
    error: ProtocolErrorSchema,
    type: z.literal("browser.command-error"),
  }),
]);
export function createBrowserRelayToHostMessageSchema(negotiation: BrowserRelayNegotiation = {}) {
  return BrowserRelayToHostWireSchema.superRefine((message, context) => {
    if (
      (message.type === "browser.profile.inventory" ||
        message.type === "browser.profile.delete.result") &&
      negotiation.localProfiles !== 1
    ) {
      context.addIssue({
        code: "custom",
        message: "Local profile maintenance requires browser auxiliary negotiation.",
      });
    }
    if (
      message.type === "browser.attached" &&
      message.initialPage !== undefined &&
      negotiation.initialNavigationVersion !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["initialPage"],
        message: "Initial page readiness requires browser auxiliary negotiation.",
      });
    }
  });
}
export const BrowserRelayToHostMessageSchema = createBrowserRelayToHostMessageSchema();
export type BrowserRelayToHostMessage = z.infer<typeof BrowserRelayToHostMessageSchema>;

export const BrowserRelayFrameHeaderSchema = z.strictObject({
  ...relayEventBase,
  capability: BrowserCapabilityReferenceSchema,
  channelId: BrowserChannelIdSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  type: z.literal("browser.frame"),
});
export type BrowserRelayFrameHeader = z.infer<typeof BrowserRelayFrameHeaderSchema>;

export { BrowserAttachPublicKeysSchema };

const maxHeaderBytes = 16 * 1_024;
export const maxRelayedBrowserFrameBytes = 8 * 1_024 * 1_024;
export const maxBrowserRelayEnvelopeBytes = maxRelayedBrowserFrameBytes + maxHeaderBytes + 4;

export class BrowserRelayFrameError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserRelayFrameError";
  }
}

export function encodeBrowserRelayFrame(header: BrowserRelayFrameHeader, frame: Buffer): Buffer {
  validateBrowserRuntimeFrame(frame);
  const headerBytes = Buffer.from(
    JSON.stringify(BrowserRelayFrameHeaderSchema.parse(header)),
    "utf8",
  );
  if (headerBytes.byteLength > maxHeaderBytes) throw invalidFrame();
  const output = Buffer.allocUnsafe(4 + headerBytes.byteLength + frame.byteLength);
  output.writeUInt32BE(headerBytes.byteLength, 0);
  headerBytes.copy(output, 4);
  frame.copy(output, 4 + headerBytes.byteLength);
  return output;
}

export function decodeBrowserRelayFrame(value: Buffer): {
  readonly frame: Buffer;
  readonly header: BrowserRelayFrameHeader;
} {
  if (value.byteLength > maxBrowserRelayEnvelopeBytes) throw invalidFrame();
  const split = splitEnvelope(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(split.header.toString("utf8"));
  } catch (error) {
    throw invalidFrame(error);
  }
  const header = BrowserRelayFrameHeaderSchema.safeParse(parsed);
  if (!header.success) throw invalidFrame(header.error);
  validateBrowserRuntimeFrame(split.payload);
  return { frame: split.payload, header: header.data };
}

export function validateBrowserRuntimeFrame(value: Buffer): void {
  if (value.byteLength > maxRelayedBrowserFrameBytes) throw invalidFrame();
  const split = splitEnvelope(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(split.header.toString("utf8"));
  } catch (error) {
    throw invalidFrame(error);
  }
  const header = BrowserBinaryFrameHeaderSchema.safeParse(parsed);
  if (!header.success || split.payload.byteLength < 1) throw invalidFrame(header.error);
}

export function sameBrowserCapability(
  left: BrowserCapabilityReference,
  right: BrowserCapabilityReference,
): boolean {
  return (
    left.capabilityLeaseId === right.capabilityLeaseId &&
    left.capabilityGeneration === right.capabilityGeneration &&
    left.runtimeId === right.runtimeId
  );
}

export function browserRelayFrameFence(header: BrowserRelayFrameHeader): RunnerAuxiliaryFrameFence {
  return {
    auxiliaryStreamId: header.auxiliaryStreamId,
    bootId: header.bootId,
    connectionGeneration: header.connectionGeneration,
    connectionId: header.connectionId,
    connectionLeaseId: header.connectionLeaseId,
    module: header.module,
    runnerId: header.runnerId,
  };
}

function splitEnvelope(value: Buffer): { readonly header: Buffer; readonly payload: Buffer } {
  if (value.byteLength < 7) throw invalidFrame();
  const headerLength = value.readUInt32BE(0);
  if (headerLength < 2 || headerLength > maxHeaderBytes || 4 + headerLength >= value.byteLength) {
    throw invalidFrame();
  }
  return {
    header: value.subarray(4, 4 + headerLength),
    payload: value.subarray(4 + headerLength),
  };
}

function invalidFrame(cause?: unknown): BrowserRelayFrameError {
  return new BrowserRelayFrameError("The relayed browser frame is invalid.", { cause });
}
