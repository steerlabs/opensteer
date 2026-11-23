import { isBareOrigin, isLoopbackHostname, isSecureOrLoopbackOrigin } from "@opensteer/core";
import { z } from "zod";

export const agentDirectoryPath = "/v1/agent-directory";
export const agentDirectoryTokenUse = "opensteer-agent-directory";
export const agentDirectoryJwtTyp = "opensteer-agent-directory+jwt";

export const maximumAgentDirectoryEntries = 256;
export const maximumAgentDirectoryOriginsPerEntry = 16;
export const maximumAgentDirectoryEnvelopeBytes = 512 * 1_024;

const compactJwsPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
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

export const AgentDirectoryEntrySchema = z
  .strictObject({
    id: AgentDirectoryEntryIdSchema,
    displayName: AgentDirectoryDisplayNameSchema,
    origins: z.array(AgentDirectoryOriginSchema).min(1).max(maximumAgentDirectoryOriginsPerEntry),
  })
  .superRefine((entry, context) => {
    if (new Set(entry.origins).size !== entry.origins.length) {
      context.addIssue({
        code: "custom",
        path: ["origins"],
        message: "Directory entry origins must be unique",
      });
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

export const AgentConnectionIdentityEvidenceKindSchema = z.enum(["verified", "unverified"]);
export type AgentConnectionIdentityEvidenceKind = z.infer<
  typeof AgentConnectionIdentityEvidenceKindSchema
>;

/** Recorded once at consent time so later directory changes can be surfaced without rewriting history. */
export const AgentConnectionIdentityAtConsentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("verified"),
    origin: AgentDirectoryOriginSchema,
    directoryId: AgentDirectoryEntryIdSchema,
    displayName: AgentDirectoryDisplayNameSchema,
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
]);
export type AgentConnectionIdentityAtConsent = z.infer<
  typeof AgentConnectionIdentityAtConsentSchema
>;
