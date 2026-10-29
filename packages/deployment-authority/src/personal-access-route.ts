import { sha256 } from "@noble/hashes/sha2.js";
import { CanonicalOriginSchema } from "@opensteer/core";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { z } from "zod";
import { HostDiscoveryDocumentSchema } from "./authority.js";

export const maximumPersonalHostAccessRouteSigningBytes = 8 * 1_024;

export function isPersonalHost(
  discovery: Pick<z.infer<typeof HostDiscoveryDocumentSchema>, "deploymentShape">,
): boolean {
  return discovery.deploymentShape.kind === "personal";
}

export const PersonalAccessRouteGenerationSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export type PersonalAccessRouteGeneration = z.infer<typeof PersonalAccessRouteGenerationSchema>;

export const PersonalAccessRouteKindSchema = z.enum(["connect", "private"]);
export type PersonalAccessRouteKind = z.infer<typeof PersonalAccessRouteKindSchema>;

export const PersonalAccessRouteOriginSchema = CanonicalOriginSchema.superRefine(
  (value, context) => {
    if (new URL(value).protocol !== "https:") {
      context.addIssue({ code: "custom", message: "A Personal access route must use HTTPS" });
    }
  },
);
export type PersonalAccessRouteOrigin = z.infer<typeof PersonalAccessRouteOriginSchema>;

/**
 * Exact public authority carried in both Host discovery and a remote access
 * route attestation. It deliberately preserves the Personal Host's loopback
 * canonical origin; the separately signed route below never becomes canonical.
 */
export const PersonalHostAccessAuthoritySchema = HostDiscoveryDocumentSchema.superRefine(
  (authority, context) => {
    const canonical = new URL(authority.canonicalOrigin);
    if (
      canonical.protocol !== "http:" ||
      !isLoopbackHostname(canonical.hostname) ||
      !canonical.port
    ) {
      context.addIssue({
        code: "custom",
        message: "A Personal Host must retain an explicit HTTP loopback canonical origin",
        path: ["canonicalOrigin"],
      });
    }
    if (!isPersonalHost(authority)) {
      context.addIssue({
        code: "custom",
        message: "Expected a Personal deployment",
        path: ["deploymentShape"],
      });
    }
  },
);
export type PersonalHostAccessAuthority = z.infer<typeof PersonalHostAccessAuthoritySchema>;

export const PersonalHostAccessRouteDocumentSchema = z
  .strictObject({
    authority: PersonalHostAccessAuthoritySchema,
    documentVersion: z.literal(2),
    purpose: z.literal("opensteer-personal-access-route"),
    route: z.strictObject({
      generation: PersonalAccessRouteGenerationSchema,
      kind: PersonalAccessRouteKindSchema,
      origin: PersonalAccessRouteOriginSchema,
    }),
  })
  .superRefine((document, context) => {
    if (document.route.origin === document.authority.canonicalOrigin) {
      context.addIssue({
        code: "custom",
        message: "A Personal access route must remain distinct from canonical authority",
        path: ["route", "origin"],
      });
    }
  });
export type PersonalHostAccessRouteDocument = z.infer<typeof PersonalHostAccessRouteDocumentSchema>;

export const PersonalHostAccessRouteEnvelopeSchema = z.strictObject({
  document: PersonalHostAccessRouteDocumentSchema,
  publicKey: z.strictObject({
    algorithm: z.literal("Ed25519"),
    spki: z.string().regex(/^[A-Za-z0-9_-]{59}$/u),
  }),
  schemaVersion: z.literal(1),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export type PersonalHostAccessRouteEnvelope = z.infer<typeof PersonalHostAccessRouteEnvelopeSchema>;

/** Exact bytes signed by the durable Personal Host authority key. */
export function personalHostAccessRouteSigningBytes(
  documentInput: PersonalHostAccessRouteDocument,
): Uint8Array {
  const document = PersonalHostAccessRouteDocumentSchema.parse(documentInput);
  const bytes = new TextEncoder().encode(
    `opensteer-personal-access-route-v4\0${JSON.stringify({
      authority: {
        canonicalOrigin: document.authority.canonicalOrigin,
        deploymentId: document.authority.deploymentId,
        hostInstanceId: document.authority.hostInstanceId,
        hostKey: {
          algorithm: document.authority.hostKey.algorithm,
        },
        deploymentShape: document.authority.deploymentShape,
      },
      documentVersion: document.documentVersion,
      purpose: document.purpose,
      route: {
        generation: document.route.generation,
        kind: document.route.kind,
        origin: document.route.origin,
      },
    })}`,
  );
  if (bytes.byteLength > maximumPersonalHostAccessRouteSigningBytes) {
    throw new TypeError("Personal Host access-route signing payload is too large");
  }
  return bytes;
}

/**
 * Cross-runtime digest of the exact signed envelope bound into Account session
 * grants. The explicit field order makes Node, Desktop, Host and the phone
 * agree without relying on input object insertion order.
 *
 * The hash is taken with `@noble/hashes`, the way `hostKeyFingerprint` already
 * does it, because this runs in a React Native bundle where Hermes has no Web
 * Crypto at all — an Account directory sync verifies a Personal Deployment
 * through here. The bytes and the encoding are the same ones every grant
 * already issued was signed over, so this is a compatibility contract rather
 * than an implementation detail.
 */
export function personalHostAccessRouteEnvelopeSha256(
  envelopeInput: PersonalHostAccessRouteEnvelope,
): string {
  const envelope = PersonalHostAccessRouteEnvelopeSchema.parse(envelopeInput);
  const bytes = new TextEncoder().encode(
    `opensteer-personal-access-route-envelope-v4\0${JSON.stringify({
      document: {
        authority: {
          canonicalOrigin: envelope.document.authority.canonicalOrigin,
          deploymentId: envelope.document.authority.deploymentId,
          hostInstanceId: envelope.document.authority.hostInstanceId,
          hostKey: {
            algorithm: envelope.document.authority.hostKey.algorithm,
          },
          deploymentShape: envelope.document.authority.deploymentShape,
        },
        documentVersion: envelope.document.documentVersion,
        purpose: envelope.document.purpose,
        route: {
          generation: envelope.document.route.generation,
          kind: envelope.document.route.kind,
          origin: envelope.document.route.origin,
        },
      },
      publicKey: {
        algorithm: envelope.publicKey.algorithm,
        spki: envelope.publicKey.spki,
      },
      schemaVersion: envelope.schemaVersion,
      signature: envelope.signature,
    })}`,
  );
  if (bytes.byteLength > maximumPersonalHostAccessRouteSigningBytes + 1_024) {
    throw new TypeError("Personal Host access-route envelope is too large");
  }
  return encodeBase64Url(sha256(bytes));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}
