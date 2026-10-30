import { IsoDateTimeSchema, RunnerIdSchema } from "@opensteer/core";
import { z } from "zod";
import { ProtocolErrorSchema } from "./common.js";
import { BrowserAttachPublicKeysSchema } from "./browser.js";
import {
  RunnerAuxiliaryModuleSchema,
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerChallengeIdSchema,
  RunnerConnectionFenceSchema,
  RunnerConnectionIdSchema,
} from "./runner-identity.js";

export const RunnerAuxiliaryRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  .brand<"RunnerAuxiliaryRequestId">();
export type RunnerAuxiliaryRequestId = z.infer<typeof RunnerAuxiliaryRequestIdSchema>;

/**
 * What the Host signs into an auxiliary ticket.
 *
 * The ticket names the exact primary connection that asked for it, so a
 * credential minted for one socket cannot open a stream beside a later one.
 * It is a bearer value on its own, which is why the auxiliary socket must also
 * prove the Runner key over the challenge it is handed.
 */
export const RunnerAuxiliaryTicketClaimsSchema = z.strictObject({
  audience: z.literal("opensteer-runner-auxiliary"),
  bootId: RunnerBootIdSchema,
  connectionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  connectionId: RunnerConnectionIdSchema,
  expiresAt: IsoDateTimeSchema,
  issuedAt: IsoDateTimeSchema,
  module: RunnerAuxiliaryModuleSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,255}$/),
  runnerId: RunnerIdSchema,
});
export type RunnerAuxiliaryTicketClaims = z.infer<typeof RunnerAuxiliaryTicketClaimsSchema>;

export const RunnerAuxiliaryTicketSchema = z
  .string()
  .max(8_192)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

export const RunnerAuxiliaryChallengeSchema = z.strictObject({
  challengeId: RunnerChallengeIdSchema,
  expiresAt: IsoDateTimeSchema,
  hostSessionId: z.string().regex(/^[A-Za-z0-9_-]{32,255}$/),
  module: RunnerAuxiliaryModuleSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,255}$/),
  type: z.literal("host.auxiliary.challenge"),
});
export type RunnerAuxiliaryChallenge = z.infer<typeof RunnerAuxiliaryChallengeSchema>;

export const RunnerAuxiliaryAuthenticateSchema = z.strictObject({
  bootId: RunnerBootIdSchema,
  challengeId: RunnerChallengeIdSchema,
  module: RunnerAuxiliaryModuleSchema,
  runnerId: RunnerIdSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  ticket: RunnerAuxiliaryTicketSchema,
  type: z.literal("runner.auxiliary.authenticate"),
});
export type RunnerAuxiliaryAuthenticate = z.infer<typeof RunnerAuxiliaryAuthenticateSchema>;

export const RunnerAuxiliaryWelcomeSchema = z.strictObject({
  ...RunnerConnectionFenceSchema.shape,
  auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema,
  /**
   * Carried on the browser stream's welcome because the relay verifies attach
   * tickets itself; a messaging stream never receives them.
   */
  browserAttachPublicKeys: BrowserAttachPublicKeysSchema.optional(),
  /** Opt in only when the descriptor offers it; old Hosts receive no new status fields. */
  passkeys: z.literal(1).optional(),
  loginText: z.literal(1).optional(),
  passwordSignIn: z.literal(1).optional(),
  heartbeatIntervalMs: z.number().int().min(1_000).max(300_000),
  module: RunnerAuxiliaryModuleSchema,
  serverTime: IsoDateTimeSchema,
  streamLeaseExpiresAt: IsoDateTimeSchema,
  type: z.literal("host.auxiliary.welcome"),
});
export type RunnerAuxiliaryWelcome = z.infer<typeof RunnerAuxiliaryWelcomeSchema>;

export const RunnerAuxiliaryRejectedSchema = z.strictObject({
  error: ProtocolErrorSchema,
  type: z.literal("host.auxiliary.rejected"),
});

/** The fence every post-authentication auxiliary frame repeats, JSON or binary. */
export const RunnerAuxiliaryFrameFenceSchema = z.strictObject({
  ...RunnerConnectionFenceSchema.shape,
  auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema,
  module: RunnerAuxiliaryModuleSchema,
});
export type RunnerAuxiliaryFrameFence = z.infer<typeof RunnerAuxiliaryFrameFenceSchema>;

export const RunnerAuxiliaryHeartbeatSchema = z.strictObject({
  ...RunnerAuxiliaryFrameFenceSchema.shape,
  sentAt: IsoDateTimeSchema,
  type: z.literal("runner.auxiliary.heartbeat"),
});

export const RunnerAuxiliaryLeaseRenewedSchema = z.strictObject({
  ...RunnerAuxiliaryFrameFenceSchema.shape,
  browserAttachPublicKeys: BrowserAttachPublicKeysSchema.optional(),
  streamLeaseExpiresAt: IsoDateTimeSchema,
  type: z.literal("host.auxiliary.lease-renewed"),
});
export type RunnerAuxiliaryLeaseRenewed = z.infer<typeof RunnerAuxiliaryLeaseRenewedSchema>;

export function sameRunnerAuxiliaryFence(
  left: RunnerAuxiliaryFrameFence,
  right: RunnerAuxiliaryFrameFence,
): boolean {
  return (
    left.runnerId === right.runnerId &&
    left.bootId === right.bootId &&
    left.connectionId === right.connectionId &&
    left.connectionLeaseId === right.connectionLeaseId &&
    left.connectionGeneration === right.connectionGeneration &&
    left.auxiliaryStreamId === right.auxiliaryStreamId &&
    left.module === right.module
  );
}
