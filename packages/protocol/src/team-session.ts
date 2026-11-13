import { TeamIdentityAssertionSchema } from "@opensteer/control-plane-protocol";
import { IsoDateTimeSchema, TeamInviteSecretSchema } from "@opensteer/core";
import { z } from "zod";
import { TeamMemberViewSchema } from "./team-views.js";

/*
 * Routes a native app uses to enter a team without a browser hop. Both are public, version
 * gated like every team route, and advertised before use: the exchange by
 * `team-session-exchange-v1`, the preview by `team-reusable-invites-v1`.
 */
export const teamSessionExchangePath = "/v1/team/session/exchange";
export const teamInvitePreviewPath = "/v1/team/invites/preview";

/**
 * An active member gets a session. Anyone else must bring a valid invite, which admits them as a
 * member in the same transaction that issues the session.
 */
export const TeamSessionExchangeRequestSchema = z.strictObject({
  assertion: TeamIdentityAssertionSchema,
  invite: TeamInviteSecretSchema.optional(),
});
export type TeamSessionExchangeRequest = z.infer<typeof TeamSessionExchangeRequestSchema>;

/**
 * An RFC 6749 token response from the team Host's native OAuth server, issued to the client the
 * assertion's `surface` names, so the app stores and refreshes it like a browser sign-in.
 */
export const TeamSessionTokensSchema = z.object({
  access_token: z.string().min(16).max(65_536),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().min(1).max(31_536_000),
  refresh_token: z.string().min(16).max(65_536),
  scope: z.string().min(1).max(4_096),
});

export const TeamSessionExchangeResponseSchema = z.object({
  /** True when this exchange's invite made the person a member. */
  admitted: z.boolean(),
  member: TeamMemberViewSchema,
  tokens: TeamSessionTokensSchema,
});
export type TeamSessionExchangeResponse = z.infer<typeof TeamSessionExchangeResponseSchema>;

export const TeamInvitePreviewRequestSchema = TeamInviteSecretSchema;

/** What the join confirmation shows; previewing never consumes the invite. */
export const TeamInvitePreviewResponseSchema = z.object({
  teamName: z.string().min(1).max(160),
  expiresAt: IsoDateTimeSchema,
});
export type TeamInvitePreviewResponse = z.infer<typeof TeamInvitePreviewResponseSchema>;

/**
 * The `reason` a refused exchange or preview carries (`ProtocolError.reason`), so an app can tell
 * "ask for an invite" from "this invite no longer works". A removed member is not a member.
 */
export const TeamEntryRefusalReasonSchema = z.enum([
  "assertion-invalid",
  "assertion-expired",
  "authority-changed",
  "not-a-member",
  "invite-invalid",
  "invite-expired",
  "invite-used-up",
]);
export type TeamEntryRefusalReason = z.infer<typeof TeamEntryRefusalReasonSchema>;

/** Only a membership refusal authorizes deleting a viewer's local partition. */
export const teamEntryRefusalOutcomes = {
  "assertion-invalid": "retryable",
  "assertion-expired": "retryable",
  "authority-changed": "retryable",
  "not-a-member": "membership",
  "invite-invalid": "retryable",
  "invite-expired": "retryable",
  "invite-used-up": "retryable",
  removed: "membership",
} as const satisfies Record<TeamEntryRefusalReason | "removed", "membership" | "retryable">;

export function teamEntryRefusalOutcome(reason: string | null | undefined) {
  return reason && Object.hasOwn(teamEntryRefusalOutcomes, reason)
    ? teamEntryRefusalOutcomes[reason as keyof typeof teamEntryRefusalOutcomes]
    : undefined;
}
