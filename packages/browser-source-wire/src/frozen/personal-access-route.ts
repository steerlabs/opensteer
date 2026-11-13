import { z } from "zod";
import { HostDiscoveryDocumentSchema } from "./authority.js";
import { CanonicalOriginSchema } from "./primitives.js";

export const maximumPersonalHostAccessRouteSigningBytes = 8 * 1_024;

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

export const PersonalHostAccessAuthoritySchema = HostDiscoveryDocumentSchema.superRefine(
  (authority, context) => {
    const canonical = new URL(authority.canonicalOrigin);
    if (
      canonical.protocol !== "http:" ||
      !isRouteLoopbackHostname(canonical.hostname) ||
      !canonical.port
    ) {
      context.addIssue({
        code: "custom",
        message: "A Personal Host must retain an explicit HTTP loopback canonical origin",
        path: ["canonicalOrigin"],
      });
    }
    if (authority.deploymentShape.kind !== "personal") {
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

/** Narrower than `isLoopbackHostname`: the route document has always checked exactly this. */
function isRouteLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}
