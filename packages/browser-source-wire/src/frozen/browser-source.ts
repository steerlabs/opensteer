import { z } from "zod";
import { HostDiscoveryEnvelopeSchema } from "./authority.js";
import { PersonalHostAccessRouteEnvelopeSchema } from "./personal-access-route.js";
import { CanonicalOriginSchema, IsoDateTimeSchema, isLoopbackHostname } from "./primitives.js";

export const browserSourceInvitationPrefix = "opensteer-browser-source:";
export const maximumBrowserSourceInvitationLength = 16_384;

export const BrowserSourceOriginSchema = CanonicalOriginSchema.refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  );
}, "Connect over HTTPS, or HTTP on the computer running Opensteer.");

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
