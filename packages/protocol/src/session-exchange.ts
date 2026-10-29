import {
  AccountHostSessionGrantSchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  type AccountHostSessionClientSurface,
} from "@opensteer/control-plane-protocol";
import {
  AuthenticatedSessionViewSchema,
  PersonalRemoteSessionCredentialSchema,
  PersonalRemoteSessionDeliverySchema,
  type PersonalRemoteSessionDelivery,
} from "@opensteer/core";
import { z } from "zod";
import { PersonalPairingCodeSchema } from "./personal-remote-access.js";

/**
 * The one route that turns an externally rooted proof into this Deployment's
 * own Host session. Browser sign-in (Host-native OAuth) and the same-machine
 * owner claim are deliberately not exchanges and keep their own routes: the
 * first mints the Deployment's own identity, and the second provisions the
 * first owner from a process-launch capability.
 */
export const sessionExchangePath = "/v1/auth/session-exchange" as const;

/**
 * The same Account signature over a different trust root: a Personal Host's own
 * Account link plus the Host-signed Connect route the client verified. The
 * expected route travels with the credential so a rotated generation fails
 * closed instead of admitting a client that trusts a stale origin.
 */
export const AccountConnectGrantCredentialSchema = z.strictObject({
  expectedRoute: PersonalHostAccessRouteEnvelopeSchema,
  grant: AccountHostSessionGrantSchema,
  kind: z.literal("account-connect-grant"),
});

/**
 * A Host-issued, high-entropy, one-use pairing code. No Account is involved:
 * the operator carried the code off the Personal computer themselves, and the
 * expected route document fences it to the exact Private route generation it
 * was issued under.
 */
export const PersonalPairingCodeCredentialSchema = z.strictObject({
  code: PersonalPairingCodeSchema,
  expectedRoute: PersonalHostAccessRouteDocumentSchema,
  kind: z.literal("personal-pairing-code"),
});
export type PersonalPairingCodeCredential = z.infer<typeof PersonalPairingCodeCredentialSchema>;

/**
 * One session, N trust roots. Every arm ends in the same Host session; they
 * differ only in what the Host must verify before issuing it. Modelling that
 * as a union rather than optional fields keeps "exactly one credential"
 * unrepresentable otherwise, and lets a Deployment that cannot honour an arm
 * say so structurally.
 */
export const SessionExchangeCredentialSchema = z.discriminatedUnion("kind", [
  AccountConnectGrantCredentialSchema,
  PersonalPairingCodeCredentialSchema,
]);
export type SessionExchangeCredential = z.infer<typeof SessionExchangeCredentialSchema>;

export const SessionExchangeCredentialKindSchema = z.enum([
  "account-connect-grant",
  "personal-pairing-code",
]);
export type SessionExchangeCredentialKind = z.infer<typeof SessionExchangeCredentialKindSchema>;

/**
 * Which delivery an Account grant of this signed surface authorises. Delivery
 * is never the client's to choose: it follows from the surface the Account
 * signed, so a desktop grant can only ever become a cookie and a phone's grant
 * can only ever become a header credential.
 */
export function sessionExchangeDeliveryForClientSurface(
  surface: AccountHostSessionClientSurface,
): PersonalRemoteSessionDelivery {
  return surface === "native" ? "header" : "cookie";
}

export const SessionExchangeRequestSchema = z.strictObject({
  credential: SessionExchangeCredentialSchema,
  credentialDelivery: PersonalRemoteSessionDeliverySchema,
  schemaVersion: z.literal(2),
});
export type SessionExchangeRequest = z.infer<typeof SessionExchangeRequestSchema>;

/**
 * The body carries a token only for header delivery, and then because there is
 * nowhere else to put it. Under cookie delivery the `Set-Cookie` header the
 * Host sets is the only credential a client keeps, so the body stays a
 * description of the session that cannot be replayed.
 *
 * The exchange is spoken between a store-distributed app and a self-hosted
 * Host that upgrade on their own schedules, so — exactly like the rpc graph —
 * a response tolerates fields a newer Host adds. The request above stays
 * strict: what a Host parses as input never widens.
 */
export const SessionExchangeResponseSchema = z.discriminatedUnion("credentialDelivery", [
  z.object({
    credentialDelivery: z.literal("cookie"),
    schemaVersion: z.literal(2),
    session: AuthenticatedSessionViewSchema,
  }),
  z.object({
    credential: z.object({
      absoluteExpiresAt: z.iso.datetime({ offset: true }),
      expiresAt: z.iso.datetime({ offset: true }),
      token: PersonalRemoteSessionCredentialSchema,
    }),
    credentialDelivery: z.literal("header"),
    schemaVersion: z.literal(2),
    session: AuthenticatedSessionViewSchema,
  }),
]);
export type SessionExchangeResponse = z.infer<typeof SessionExchangeResponseSchema>;
