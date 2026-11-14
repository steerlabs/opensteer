import { z } from "zod";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
  IsoDateTimeSchema,
  TeamOriginSchema,
  UserIdSchema,
} from "@opensteer/core";
import { HostDiscoveryEnvelopeSchema } from "@opensteer/deployment-authority";

export type TeamPartnerAuthority = z.infer<typeof HostDiscoveryEnvelopeSchema>;

export const teamPartnerProtocolVersion = 3;
export const teamPartnerCapability = "team-partner-links-v1";
export const teamPartnerSocketPath = "/internal/v1/team/partner";
export const teamPartnerMaxFrameBytes = 300 * 1024;
export const TeamSharingPolicySchema = z.enum(["off", "admins", "members-propose", "members"]);
export type TeamSharingPolicy = z.infer<typeof TeamSharingPolicySchema>;
export const TeamPartnerOfferSchema = z.strictObject({
  teamId: DeploymentIdSchema,
  origin: TeamOriginSchema,
  hostKeyFingerprint: HostKeyFingerprintSchema,
  hostInstanceId: HostInstanceIdSchema,
  selector: z.uuid(),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  expiresAt: IsoDateTimeSchema,
});
export type TeamPartnerOffer = z.infer<typeof TeamPartnerOfferSchema>;
export const TeamPartnerOfferTextSchema = z.string().min(1).max(4096);
export function serializeTeamPartnerOffer(offer: TeamPartnerOffer): string {
  const parsed = TeamPartnerOfferSchema.parse(offer);
  return `${parsed.origin}/partner#${new URLSearchParams(parsed).toString()}`;
}
export function parseTeamPartnerOffer(text: string): TeamPartnerOffer {
  const url = new URL(TeamPartnerOfferTextSchema.parse(text));
  const values = new URLSearchParams(url.hash.slice(1));
  if (new Set(values.keys()).size !== [...values].length) throw new Error("Invalid partner invite");
  const offer = TeamPartnerOfferSchema.parse(Object.fromEntries(values));
  if (url.origin !== offer.origin || url.pathname !== "/partner" || url.search)
    throw new Error("Invalid partner invite");
  return offer;
}

export const TeamPartnerLinkSchema = z.object({
  id: z.uuid(),
  partnerTeamId: DeploymentIdSchema,
  partnerOrigin: TeamOriginSchema,
  partnerHostKeyFingerprint: HostKeyFingerprintSchema,
  partnerHostInstanceId: HostInstanceIdSchema,
  partnerName: z.string().min(1).max(160),
  role: z.enum(["dialer", "listener"]),
  state: z.enum(["pending", "active", "revoked"]),
  localApproved: z.boolean(),
  partnerApproved: z.boolean(),
  createdBy: UserIdSchema,
  approvedBy: UserIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  approvedAt: IsoDateTimeSchema.nullable(),
  lastSeenAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
  revokedBy: z.enum(["local", "partner"]).nullable(),
  lastError: z.enum(["identity-mismatch", "unsupported-partner-version", "unreachable"]).nullable(),
  connected: z.boolean(),
  canApprove: z.boolean(),
  canRevoke: z.boolean(),
});
export type TeamPartnerLink = z.infer<typeof TeamPartnerLinkSchema>;
export const TeamPartnerInviteSchema = z.object({
  id: z.uuid(),
  createdBy: UserIdSchema,
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  consumedAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
  canRevoke: z.boolean().optional(),
});

const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);
export const TeamPartnerHelloSchema = z.strictObject({
  type: z.literal("hello"),
  version: z.number().int().positive(),
  authority: HostDiscoveryEnvelopeSchema,
  name: z.string().min(1).max(160),
  nonce,
  approved: z.boolean(),
  selector: z.uuid().optional(),
});
export const TeamPartnerChallengeSchema = z.strictObject({
  type: z.literal("challenge"),
  name: z.string().min(1).max(160),
  authority: HostDiscoveryEnvelopeSchema,
  nonce,
  approved: z.boolean(),
  signature,
});
export const TeamPartnerProofSchema = z.strictObject({
  type: z.literal("proof"),
  signature,
  verifier: nonce.optional(),
});
export const TeamPartnerReadySchema = z.strictObject({
  type: z.literal("ready"),
  state: z.enum(["pending", "active", "revoked"]),
  approved: z.boolean(),
});
export const TeamPartnerControlSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("revoked") }),
  z.strictObject({ type: z.literal("approval") }),
]);

export interface TeamPartnerChallenge {
  readonly purpose: "pair" | "connect";
  readonly selector?: string;
  readonly listenerTeamId: string;
  readonly dialerTeamId: string;
  readonly listenerNonce: string;
  readonly dialerNonce: string;
  readonly listenerApproved: boolean;
  readonly dialerApproved: boolean;
  readonly version: number;
}
export function teamPartnerSigningBytes(
  value: TeamPartnerChallenge,
  role: "dialer" | "listener",
): Uint8Array {
  return new TextEncoder().encode(
    `opensteer-team-partner-v1\0${JSON.stringify([
      value.purpose,
      value.selector ?? null,
      value.listenerTeamId,
      value.dialerTeamId,
      value.listenerNonce,
      value.dialerNonce,
      value.listenerApproved,
      value.dialerApproved,
      value.version,
      role,
    ])}`,
  );
}
