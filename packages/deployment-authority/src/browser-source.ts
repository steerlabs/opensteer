import {
  BrowserSourceIdSchema,
  CanonicalOriginSchema,
  IsoDateTimeSchema,
  isLoopbackHostname,
} from "@opensteer/core";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { z } from "zod";
import { HostDiscoveryEnvelopeSchema } from "./authority.js";
import {
  PersonalAccessRouteGenerationSchema,
  PersonalHostAccessRouteEnvelopeSchema,
} from "./personal-access-route.js";

export const browserSourceInvitationPrefix = "opensteer-browser-source:";
export const maximumBrowserSourceInvitationLength = 16_384;

export const BrowserSourceOriginSchema = CanonicalOriginSchema.refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  );
}, "Connect over HTTPS, or HTTP on the computer running Opensteer.");

export const BrowserSourceDestinationSchema = z.strictObject({
  origin: BrowserSourceOriginSchema,
  routeGeneration: PersonalAccessRouteGenerationSchema.nullable(),
});
export type BrowserSourceDestination = z.infer<typeof BrowserSourceDestinationSchema>;

export const BrowserSourceChallengeSchema = BrowserSourceDestinationSchema.extend({
  sourceId: BrowserSourceIdSchema,
  nonce: z.uuid(),
});
export type BrowserSourceChallenge = z.infer<typeof BrowserSourceChallengeSchema>;

/**
 * One way the extension may reach the Host. A Personal Deployment offers its
 * loopback origin (Chrome on the same Mac) and, when remote access is on, its
 * signed remote route (Chrome elsewhere); the extension keeps the first one
 * whose live identity matches.
 */
export const BrowserSourceInvitationDestinationSchema = z.strictObject({
  origin: BrowserSourceOriginSchema,
  route: PersonalHostAccessRouteEnvelopeSchema.nullable(),
});
export type BrowserSourceInvitationDestination = z.infer<
  typeof BrowserSourceInvitationDestinationSchema
>;

export const BrowserSourceInvitationDocumentSchema = z.strictObject({
  version: z.literal(2),
  destinations: z.array(BrowserSourceInvitationDestinationSchema).min(1).max(2),
  deploymentName: z.string().trim().min(1).max(120),
  code: z.string().min(32).max(128),
  expiresAt: IsoDateTimeSchema,
  authority: HostDiscoveryEnvelopeSchema,
});
export type BrowserSourceInvitationDocument = z.infer<typeof BrowserSourceInvitationDocumentSchema>;

export const BrowserSourceInvitationSchema = BrowserSourceInvitationDocumentSchema.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export type BrowserSourceInvitation = z.infer<typeof BrowserSourceInvitationSchema>;

/** Bind every destination, the display name and the one-use secret to the Host identity. */
export function browserSourceInvitationSigningBytes(
  input: BrowserSourceInvitationDocument,
): Uint8Array {
  const document = BrowserSourceInvitationDocumentSchema.parse(input);
  return new TextEncoder().encode(
    `opensteer/browser-source-invitation/v2\0${JSON.stringify([
      document.version,
      document.destinations.map((destination) => [
        destination.origin,
        destination.route?.signature ?? null,
      ]),
      document.deploymentName,
      document.code,
      document.expiresAt,
      document.authority.publicKey.spki,
      document.authority.signature,
    ])}`,
  );
}

export function encodeBrowserSourceInvitation(input: BrowserSourceInvitation): string {
  const invitation = BrowserSourceInvitationSchema.parse(input);
  return (
    browserSourceInvitationPrefix +
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(invitation)))
  );
}

/** Domain separation keeps a source connection proof from signing another Host protocol. */
export function browserSourceChallengeBytes(input: BrowserSourceChallenge): Uint8Array {
  const challenge = BrowserSourceChallengeSchema.parse(input);
  return new TextEncoder().encode(
    `opensteer/browser-source/v2\0${challenge.origin}\0${challenge.routeGeneration ?? 0}\0${challenge.sourceId}\0${challenge.nonce}`,
  );
}

/**
 * Proves the Host holds the invitation's key before the extension spends the
 * one-use code (or a replaced connection's token) on it. Loopback is tried
 * first, and any local process could answer there.
 */
export const BrowserSourcePairChallengeSchema = BrowserSourceDestinationSchema.extend({
  nonce: z.uuid(),
});
export type BrowserSourcePairChallenge = z.infer<typeof BrowserSourcePairChallengeSchema>;

export function browserSourcePairChallengeBytes(input: BrowserSourcePairChallenge): Uint8Array {
  const challenge = BrowserSourcePairChallengeSchema.parse(input);
  return new TextEncoder().encode(
    `opensteer/browser-source-pair/v1\0${challenge.origin}\0${challenge.routeGeneration ?? 0}\0${challenge.nonce}`,
  );
}

/**
 * A Host that no longer serves the address a source challenged on says so
 * before its connection proof, so the extension can trust the notice only
 * with this signature over the same challenge.
 */
export function browserSourceRouteChangedBytes(input: BrowserSourceChallenge): Uint8Array {
  const challenge = BrowserSourceChallengeSchema.parse(input);
  return new TextEncoder().encode(
    `opensteer/browser-source-route-changed/v1\0${challenge.origin}\0${challenge.routeGeneration ?? 0}\0${challenge.sourceId}\0${challenge.nonce}`,
  );
}
