import { isBareOrigin, isLoopbackHostname, isSecureOrLoopbackOrigin } from "@opensteer/core";
import { z } from "zod";

export const agentDirectoryPath = "/v1/agent-directory";
export const agentDirectoryTokenUse = "opensteer-agent-directory";
export const agentDirectoryJwtTyp = "opensteer-agent-directory+jwt";

export const embedderAssertionParam = "opensteer_embedder_assertion";
export const embedderAssertionJwtTyp = "opensteer-embedder-assertion+jwt";
export const embedderAssertionAlgorithms = ["EdDSA", "ES256"] as const;
export type EmbedderAssertionAlgorithm = (typeof embedderAssertionAlgorithms)[number];
export const embedderAssertionMaxLifetimeSeconds = 120;

export const maximumAgentDirectoryEntries = 256;
export const maximumAgentDirectoryOriginsPerEntry = 16;
export const maximumAgentDirectoryKeysPerEntry = 16;
export const maximumAgentDirectoryEmbedsViaPerEntry = 32;
export const maximumAgentDirectoryEnvelopeBytes = 512 * 1_024;
export const maximumEmbedderAssertionLength = 8_192;

const compactJwsPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const base64Url43Pattern = /^[A-Za-z0-9_-]{43}$/u;
const jtiPattern = /^[A-Za-z0-9._:~-]{1,256}$/u;
const entryIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const isoDateTime = z.iso.datetime({ offset: true });

export { isLoopbackHostname };

/** Exact public HTTPS origin without wildcards, credentials, path, query, fragment, or loopback. */
export const AgentDirectoryOriginSchema = z
  .url()
  .max(256)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Directory origins must use HTTPS" });
    }
    if (!isBareOrigin(url) || url.origin !== value) {
      context.addIssue({ code: "custom", message: "Expected a normalized bare HTTPS origin" });
    }
    if (url.hostname.includes("*") || value.includes("*")) {
      context.addIssue({ code: "custom", message: "Wildcard origins are not allowed" });
    }
    if (isLoopbackHostname(url.hostname)) {
      context.addIssue({ code: "custom", message: "Loopback origins are not allowed" });
    }
  });
export type AgentDirectoryOrigin = z.infer<typeof AgentDirectoryOriginSchema>;

const AccountIssuerOriginSchema = z
  .url()
  .max(256)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (!isBareOrigin(url) || url.origin !== value || !isSecureOrLoopbackOrigin(url)) {
      context.addIssue({ code: "custom", message: "Expected a bare Account issuer origin" });
    }
  });

export const AgentDirectoryEntryIdSchema = z.string().regex(entryIdPattern);
export type AgentDirectoryEntryId = z.infer<typeof AgentDirectoryEntryIdSchema>;

export const AgentDirectoryDisplayNameSchema = z.string().trim().min(1).max(100);

export const AgentDirectoryRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export type AgentDirectoryRevision = z.infer<typeof AgentDirectoryRevisionSchema>;

const Ed25519PublicJwkSchema = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().regex(base64Url43Pattern),
  kid: z.string().min(1).max(256),
  use: z.literal("sig").optional(),
  alg: z.literal("EdDSA").optional(),
});

const P256PublicJwkSchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(base64Url43Pattern),
  y: z.string().regex(base64Url43Pattern),
  kid: z.string().min(1).max(256),
  use: z.literal("sig").optional(),
  alg: z.literal("ES256").optional(),
});

export const AgentDirectoryPublicJwkSchema = z.discriminatedUnion("kty", [
  Ed25519PublicJwkSchema,
  P256PublicJwkSchema,
]);
export type AgentDirectoryPublicJwk = z.infer<typeof AgentDirectoryPublicJwkSchema>;

export const AgentDirectoryJwksSchema = z
  .strictObject({
    keys: z.array(AgentDirectoryPublicJwkSchema).min(1).max(maximumAgentDirectoryKeysPerEntry),
  })
  .superRefine((jwks, context) => {
    const seen = new Set<string>();
    for (const [index, key] of jwks.keys.entries()) {
      if (seen.has(key.kid)) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "kid"],
          message: `Duplicate key ID ${key.kid}`,
        });
      }
      seen.add(key.kid);
    }
  });
export type AgentDirectoryJwks = z.infer<typeof AgentDirectoryJwksSchema>;

export const AgentDirectoryEntrySchema = z
  .strictObject({
    id: AgentDirectoryEntryIdSchema,
    displayName: AgentDirectoryDisplayNameSchema,
    origins: z.array(AgentDirectoryOriginSchema).min(1).max(maximumAgentDirectoryOriginsPerEntry),
    keys: AgentDirectoryJwksSchema.optional(),
    embedsVia: z
      .array(AgentDirectoryEntryIdSchema)
      .min(1)
      .max(maximumAgentDirectoryEmbedsViaPerEntry)
      .optional(),
  })
  .superRefine((entry, context) => {
    if (new Set(entry.origins).size !== entry.origins.length) {
      context.addIssue({
        code: "custom",
        path: ["origins"],
        message: "Directory entry origins must be unique",
      });
    }
    if (entry.embedsVia) {
      if (new Set(entry.embedsVia).size !== entry.embedsVia.length) {
        context.addIssue({
          code: "custom",
          path: ["embedsVia"],
          message: "Directory entry embedsVia targets must be unique",
        });
      }
      if (entry.embedsVia.includes(entry.id)) {
        context.addIssue({
          code: "custom",
          path: ["embedsVia"],
          message: "Directory entry cannot embed via itself",
        });
      }
    }
  });
export type AgentDirectoryEntry = z.infer<typeof AgentDirectoryEntrySchema>;

export const AgentDirectoryDocumentSchema = z
  .strictObject({
    revision: AgentDirectoryRevisionSchema,
    issuedAt: isoDateTime,
    entries: z.array(AgentDirectoryEntrySchema).max(maximumAgentDirectoryEntries),
  })
  .superRefine((document, context) => {
    const ids = new Set<string>();
    const origins = new Set<string>();
    for (const [index, entry] of document.entries.entries()) {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: `Duplicate directory entry ID ${entry.id}`,
        });
      }
      ids.add(entry.id);
      for (const [originIndex, origin] of entry.origins.entries()) {
        if (origins.has(origin)) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "origins", originIndex],
            message: `Duplicate directory origin ${origin}`,
          });
        }
        origins.add(origin);
      }
    }
    for (const [index, entry] of document.entries.entries()) {
      if (!entry.embedsVia) continue;
      for (const [targetIndex, target] of entry.embedsVia.entries()) {
        if (!ids.has(target)) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "embedsVia", targetIndex],
            message: `Unknown platform entry ${target}`,
          });
        }
      }
    }
  });
export type AgentDirectoryDocument = z.infer<typeof AgentDirectoryDocumentSchema>;

export const AgentDirectoryClaimsSchema = AgentDirectoryDocumentSchema.extend({
  tokenUse: z.literal(agentDirectoryTokenUse),
  iss: AccountIssuerOriginSchema,
  iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type AgentDirectoryClaims = z.infer<typeof AgentDirectoryClaimsSchema>;

export const AgentDirectoryAssertionSchema = z
  .string()
  .min(64)
  .max(maximumAgentDirectoryEnvelopeBytes)
  .regex(compactJwsPattern);

export const AgentDirectoryResponseSchema = z.strictObject({
  assertion: AgentDirectoryAssertionSchema,
});
export type AgentDirectoryResponse = z.infer<typeof AgentDirectoryResponseSchema>;

export const EmbedderAssertionTokenSchema = z
  .string()
  .min(64)
  .max(maximumEmbedderAssertionLength)
  .regex(compactJwsPattern);

export const EmbedderAssertionClaimsSchema = z
  .strictObject({
    iss: AgentDirectoryOriginSchema,
    sub: z.string().min(1).max(16_384),
    aud: z.url().max(2_048),
    redirect_uri: z.url().max(2_048),
    code_challenge: z.string().regex(base64Url43Pattern),
    state: z.string().min(1).max(2_048),
    iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    exp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    jti: z.string().regex(jtiPattern),
  })
  .superRefine((claims, context) => {
    if (claims.exp <= claims.iat || claims.exp - claims.iat > embedderAssertionMaxLifetimeSeconds) {
      context.addIssue({
        code: "custom",
        path: ["exp"],
        message: "Embedder assertions may live for at most two minutes",
      });
    }
  });
export type EmbedderAssertionClaims = z.infer<typeof EmbedderAssertionClaimsSchema>;

export const AgentConnectionIdentityEvidenceKindSchema = z.enum([
  "platform-and-embedder",
  "platform",
  "unverified",
]);
export type AgentConnectionIdentityEvidenceKind = z.infer<
  typeof AgentConnectionIdentityEvidenceKindSchema
>;

/** Recorded once at consent time so later directory changes can be surfaced without rewriting history. */
export const AgentConnectionIdentityAtConsentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("platform-and-embedder"),
    platformOrigin: AgentDirectoryOriginSchema,
    platformDirectoryId: AgentDirectoryEntryIdSchema,
    platformName: AgentDirectoryDisplayNameSchema,
    embedderOrigin: AgentDirectoryOriginSchema,
    embedderDirectoryId: AgentDirectoryEntryIdSchema,
    embedderName: AgentDirectoryDisplayNameSchema,
    keyThumbprint: z.string().regex(base64Url43Pattern),
    directoryRevision: AgentDirectoryRevisionSchema,
    recordedAt: isoDateTime,
  }),
  z.strictObject({
    kind: z.literal("platform"),
    platformOrigin: AgentDirectoryOriginSchema,
    platformDirectoryId: AgentDirectoryEntryIdSchema,
    platformName: AgentDirectoryDisplayNameSchema,
    directoryRevision: AgentDirectoryRevisionSchema,
    recordedAt: isoDateTime,
  }),
  z.strictObject({
    kind: z.literal("unverified"),
    redirectOrigin: z.string().max(2_048).nullable(),
    isLoopback: z.boolean(),
    clientName: AgentDirectoryDisplayNameSchema,
    directoryRevision: AgentDirectoryRevisionSchema.nullable(),
    recordedAt: isoDateTime,
  }),
]);
export const AgentConnectionIdentityAtConsentViewSchema = z.discriminatedUnion("kind", [
  z.object(AgentConnectionIdentityAtConsentSchema.options[0].shape),
  z.object(AgentConnectionIdentityAtConsentSchema.options[1].shape),
  z.object(AgentConnectionIdentityAtConsentSchema.options[2].shape),
]);
export type AgentConnectionIdentityAtConsent = z.infer<
  typeof AgentConnectionIdentityAtConsentSchema
>;
